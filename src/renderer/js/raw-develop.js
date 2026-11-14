/**
 * RAW 解码：在渲染进程里用 libraw-wasm 解出传感器数据，而不是读相机写入的 JPEG 预览。
 *
 * 为什么放在渲染进程：
 *   libraw-wasm 依赖 Web Worker + fetch 加载 wasm，是浏览器形态的包。
 *   主进程（Node）里没有 Worker/self，垫兼容层要改到 emscripten 内部，不可靠。
 *   放到渲染进程后解码天然在 worker 线程上跑，不卡 UI。
 *
 * 解码参数意味着「怎么把 CFA 数据变成可见图像」：
 *   useCameraWb 用机内白平衡，outputColor=1 输出 sRGB，userQual=3（AHD）足够做预览。
 */

import { idbGet, idbPut } from './idb.js'

// 解码参数变化时改版本号，旧缓存自然失效
const CACHE_VERSION = 'libraw-2'
const MODULE_URL = 'app://picselect/vendor/libraw/index.js'

// 目标宽度不超过这个值就走半尺寸解码
const HALF_SIZE_CEILING = 2048

const urlCache = new Map()
const URL_CACHE_LIMIT = 24
const pending = new Map()
// 解不出来的文件（异常容器、损坏文件）记下来，避免每翻到一次就重试一遍
const unsupported = new Set()

let librawPromise = null
let instancePromise = null
let chain = Promise.resolve()

function loadLibRaw() {
  if (!librawPromise) {
    librawPromise = import(MODULE_URL).then((mod) => mod.default || mod.LibRaw)
  }
  return librawPromise
}

/** 一个 LibRaw 实例内部是串行队列，复用它避免反复起 worker */
async function instance() {
  if (!instancePromise) {
    instancePromise = loadLibRaw().then((LibRaw) => new LibRaw())
  }
  return instancePromise
}

/** 同一个实例不能并发 open()，这里再加一层串行保险 */
function serialize(task) {
  const next = chain.then(task, task)
  chain = next.then(() => {}, () => {})
  return next
}

function bytesUrl(item) {
  const url = new URL(item.url)
  url.pathname = url.pathname.replace('/media/', '/bytes/')
  return url.toString()
}

function cacheKey(item, maxWidth) {
  return `${CACHE_VERSION}|${item.path}|${item.mtimeMs || 0}|${maxWidth}`
}

/** RGB / RGBA 平面 → 按目标宽度缩放后的 JPEG Blob */
async function toJpegBlob(image, maxWidth, quality) {
  const { data, width, height, colors } = image
  if (!width || !height || !data) throw new Error('解码结果为空')

  // canvas 只认 RGBA，RGB 要先补 alpha
  let rgba
  if (colors === 3) {
    const pixels = width * height
    rgba = new Uint8ClampedArray(pixels * 4)
    for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 3, d += 4) {
      rgba[d] = data[s]
      rgba[d + 1] = data[s + 1]
      rgba[d + 2] = data[s + 2]
      rgba[d + 3] = 255
    }
  } else {
    rgba = new Uint8ClampedArray(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + width * height * 4) : data)
  }

  const imageData = new ImageData(rgba, width, height)
  const scale = Math.min(1, maxWidth / width)
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  const bitmap = await createImageBitmap(imageData, {
    resizeWidth: targetW,
    resizeHeight: targetH,
    resizeQuality: 'high'
  })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality })
  } finally {
    bitmap.close()
  }
}

/**
 * 解码一张 RAW。
 * @returns {Promise<{blob: Blob, width: number, height: number}>} width/height 是原始像素尺寸
 */
export async function developRaw(item, { maxWidth = 2048, quality = 0.9 } = {}) {
  const key = cacheKey(item, maxWidth)
  if (unsupported.has(item.path)) throw new Error(`LibRaw 无法解码：${item.name}`)
  if (pending.has(key)) return pending.get(key)

  const task = (async () => {
    const response = await fetch(bytesUrl(item))
    if (!response.ok) throw new Error(`读取原始数据失败：HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    const libraw = await instance()

    const image = await serialize(async () => {
      await libraw.open(new Uint8Array(bytes), {
        // 缩略图与大图都用半尺寸：常见 6000px 级传感器半尺寸约 3000px，
        // 仍高于 2048 的输出宽度，白拿 4 倍速度。小传感器会略微上采样，肉眼不可辨。
        halfSize: HALF_SIZE_CEILING >= maxWidth,
        useCameraWb: true,
        outputBps: 8,
        outputColor: 1,
        userQual: 3,
        userFlip: -1
      })
      return libraw.imageData()
    })

    const blob = await toJpegBlob(image, maxWidth, quality)
    return { blob, width: image.width, height: image.height }
  })()

  pending.set(key, task)
  task.finally(() => pending.delete(key)).catch(() => {})
  task.catch(() => unsupported.add(item.path))
  return task
}

/** 带 IndexedDB 与对象 URL 缓存的版本，查看器用 */
export async function developUrl(item, { maxWidth = 2048, quality = 0.9 } = {}) {
  const key = cacheKey(item, maxWidth)

  const cached = urlCache.get(key)
  if (cached) {
    urlCache.delete(key)
    urlCache.set(key, cached)
    return cached
  }

  let blob = await idbGet(key)
  if (!blob) {
    const result = await developRaw(item, { maxWidth, quality })
    blob = result.blob
    idbPut(key, blob)
  }

  const url = URL.createObjectURL(blob)
  urlCache.set(key, url)
  if (urlCache.size > URL_CACHE_LIMIT) {
    const oldest = urlCache.keys().next().value
    const oldestUrl = urlCache.get(oldest)
    urlCache.delete(oldest)
    if (oldestUrl) URL.revokeObjectURL(oldestUrl)
  }
  return url
}

export function isRaw(item) {
  return Boolean(item && item.kind === 'raw')
}

export function resetDevelopCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
  pending.clear()
  unsupported.clear()
}
