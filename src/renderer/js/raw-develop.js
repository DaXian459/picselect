/**
 * RAW 解码：在渲染进程里用 libraw-wasm 解出传感器数据，而不是读相机写入的 JPEG 预览。
 *
 * 为什么放在渲染进程：
 *   libraw-wasm 依赖 Web Worker + fetch 加载 wasm，是浏览器形态的包。
 *   主进程（Node）里没有 Worker/self，垫兼容层要改到 emscripten 内部，不可靠。
 *   放到渲染进程后解码天然在 worker 线程上跑，不卡 UI。
 *
 * 性能设计（实测数据见 scripts/bench-raw.js）：
 *   单张 33MB ARW 的半尺寸解码约 470ms，其中大头是 unpack（熵解码），
 *   换插值算法（userQual 3→0）只能省 20ms，所以不在画质上做妥协。
 *   真正的杠杆是下面四条：
 *     1. 实例池：LibRaw 单实例不可重入，多个实例并行才能吃满多核
 *        （5 张串行 2875ms → 3 实例 1361ms）
 *     2. 像素复用：缩略图和查看器是同一张图、同一 halfSize，
 *        解一次像素、各自缩放（查看器首帧从 ~670ms 降到 ~130ms）
 *     3. 字节缓存：原始文件读一次 80ms，来回翻页不重复读盘
 *     4. wasm 预热：首张比热态多约 190ms，启动空闲时先编译掉
 */

import { idbGet, idbPut } from './idb.js'

// 解码参数或管线变化时改版本号，旧缓存自然失效
const CACHE_VERSION = 'libraw-3'
const MODULE_URL = 'app://picselect/vendor/libraw/index.js'

// 目标宽度不超过这个值就走半尺寸解码
const HALF_SIZE_CEILING = 2048

// 并行解码实例数：每个实例一个 worker + 独立 wasm 堆。
// 实测 4 个并不比 3 个快（瓶颈在 unpack 的单线程与内存带宽），所以取 3 省内存。
const POOL_SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2))

// 最近一张原始字节的缓存上限（一张 33MB 的 ARW 值得留在内存里）
const BYTES_CACHE_LIMIT = 64 * 1024 * 1024

const DECODE_SETTINGS = {
  useCameraWb: true,
  outputBps: 8,
  outputColor: 1,
  userQual: 3,
  userFlip: -1
}

// 最近解码的像素（LRU）：一张 3120×2084 的 RGB 约 19MB，留 4 张覆盖「刚翻过的那几张」
const PIXEL_CACHE_LIMIT = 4

const urlCache = new Map()
const URL_CACHE_LIMIT = 24
const pending = new Map()
const pixelPending = new Map()
const pixelCache = new Map()
// 解不出来的文件（异常容器、损坏文件）记下来，避免每翻到一次就重试一遍
const unsupported = new Set()

let librawPromise = null
let lastBytes = null
let warmed = false

/* ---------------- 实例池 ---------------- */

const pool = []
const waiters = []
let total = 0

function loadLibRaw() {
  if (!librawPromise) {
    librawPromise = import(MODULE_URL).then((mod) => mod.default || mod.LibRaw)
  }
  return librawPromise
}

/**
 * 取一个空闲实例；不够就按需新建，到上限后排队。
 * high 优先级的等待者插队——用户正在看的那张不该排在后台预热后面。
 */
async function acquire(priority) {
  const free = pool.find((slot) => !slot.busy)
  if (free) {
    free.busy = true
    return free
  }

  if (total < POOL_SIZE) {
    total++
    try {
      const LibRaw = await loadLibRaw()
      const slot = { lib: new LibRaw(), busy: true }
      pool.push(slot)
      return slot
    } catch (err) {
      total--
      throw err
    }
  }

  return new Promise((resolve) => {
    const waiter = { resolve }
    if (priority === 'high') waiters.unshift(waiter)
    else waiters.push(waiter)
  })
}

function release(slot) {
  const next = waiters.shift()
  if (next) {
    // 直接转交给等待者，保持 busy
    next.resolve(slot)
    return
  }
  slot.busy = false
}

/** 启动空闲时调用：把 wasm 编译和第一个实例的开销提前付掉 */
export async function warmup() {
  if (warmed) return
  warmed = true
  try {
    const slot = await acquire('low')
    release(slot)
  } catch {}
}

/* ---------------- 原始字节 ---------------- */

function bytesUrl(item) {
  const url = new URL(item.url)
  url.pathname = url.pathname.replace('/media/', '/bytes/')
  return url.toString()
}

function bytesKey(item) {
  return `${item.path}|${item.mtimeMs || 0}`
}

/**
 * 取原始文件字节。
 * 注意：open() 会把 ArrayBuffer transfer 给 worker，调用方拿到的必须是独立副本。
 */
async function loadBytes(item) {
  const key = bytesKey(item)
  if (lastBytes && lastBytes.key === key) return lastBytes.buf.slice()

  const response = await fetch(bytesUrl(item))
  if (!response.ok) throw new Error(`读取原始数据失败：HTTP ${response.status}`)
  const buf = await response.arrayBuffer()

  if (buf.byteLength <= BYTES_CACHE_LIMIT) {
    lastBytes = { key, buf }
    return buf.slice()
  }
  lastBytes = null
  return buf
}

/* ---------------- 像素 ---------------- */

function pixelKey(item, halfSize) {
  // halfSize 由目标宽度决定，两种分辨率的像素不能混用
  return `${bytesKey(item)}|h${halfSize ? 1 : 0}`
}

/** 解出像素（不做缩放编码）。同一张图并发请求只跑一次 */
async function decodePixels(item, halfSize, priority) {
  const key = pixelKey(item, halfSize)

  const hit = pixelCache.get(key)
  if (hit) {
    // LRU 触碰
    pixelCache.delete(key)
    pixelCache.set(key, hit)
    return hit
  }
  if (pixelPending.has(key)) return pixelPending.get(key)

  const task = (async () => {
    const bytes = await loadBytes(item)
    const slot = await acquire(priority)
    try {
      await slot.lib.open(bytes, { ...DECODE_SETTINGS, halfSize })
      const image = await slot.lib.imageData()
      pixelCache.set(key, image)
      if (pixelCache.size > PIXEL_CACHE_LIMIT) {
        pixelCache.delete(pixelCache.keys().next().value)
      }
      return image
    } finally {
      release(slot)
    }
  })()

  pixelPending.set(key, task)
  task.then(
    () => pixelPending.delete(key),
    () => pixelPending.delete(key)
  )
  return task
}

/**
 * RGB / RGBA 平面 → 按目标宽度缩放后的 JPEG Blob。
 * canvas 只认 RGBA，补 alpha 时按 32 位整字写（每个像素一次写），比逐通道写快一倍。
 */
async function toJpegBlob(image, maxWidth, quality) {
  const { data, width, height, colors } = image
  if (!width || !height || !data) throw new Error('解码结果为空')

  const pixels = width * height
  let rgba
  if (colors === 3) {
    rgba = new Uint8ClampedArray(pixels * 4)
    const out = new Uint32Array(rgba.buffer)
    // 小端：一个 32 位写 → 内存里的 R,G,B,A
    for (let i = 0, s = 0; i < pixels; i++, s += 3) {
      out[i] = 0xff000000 | (data[s + 2] << 16) | (data[s + 1] << 8) | data[s]
    }
  } else {
    rgba = new Uint8ClampedArray(
      data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + pixels * 4) : data
    )
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

/* ---------------- 对外接口 ---------------- */

function cacheKey(item, maxWidth) {
  return `${CACHE_VERSION}|${item.path}|${item.mtimeMs || 0}|${maxWidth}`
}

/**
 * 解码一张 RAW。
 * @param {{maxWidth?: number, quality?: number, priority?: 'high'|'normal'|'low'}} options
 * @returns {Promise<{blob: Blob, width: number, height: number}>} width/height 是解码像素尺寸
 */
export async function developRaw(item, { maxWidth = 2048, quality = 0.9, priority = 'normal' } = {}) {
  const key = cacheKey(item, maxWidth)
  if (unsupported.has(item.path)) throw new Error(`LibRaw 无法解码：${item.name}`)
  if (pending.has(key)) return pending.get(key)

  const task = (async () => {
    const image = await decodePixels(item, maxWidth <= HALF_SIZE_CEILING, priority)
    const blob = await toJpegBlob(image, maxWidth, quality)
    return { blob, width: image.width, height: image.height }
  })()

  pending.set(key, task)
  task.then(
    () => pending.delete(key),
    () => {
      pending.delete(key)
      unsupported.add(item.path)
    }
  )
  return task
}

/** 带 IndexedDB 与对象 URL 缓存的版本，查看器用 */
export async function developUrl(item, { maxWidth = 2048, quality = 0.9, priority = 'high' } = {}) {
  const key = cacheKey(item, maxWidth)

  const cached = urlCache.get(key)
  if (cached) {
    urlCache.delete(key)
    urlCache.set(key, cached)
    return cached
  }

  let blob = await idbGet(key)
  if (!blob) {
    const result = await developRaw(item, { maxWidth, quality, priority })
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

/**
 * 只解像素、不编码导出，供查看器预取相邻照片。
 * 低优先级排队：用户正在等的那张永远排在前面。
 */
export function prefetchPixels(item, priority = 'low') {
  if (!item || !isRaw(item) || unsupported.has(item.path)) return
  const key = pixelKey(item, true)
  if (pixelCache.has(key) || pixelPending.has(key)) return
  decodePixels(item, true, priority).catch(() => {})
}

export function resetDevelopCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
  pending.clear()
  pixelPending.clear()
  pixelCache.clear()
  unsupported.clear()
  lastBytes = null
}

/** 调试用：池与缓存状态 */
export function stats() {
  return {
    poolSize: pool.length,
    poolCap: POOL_SIZE,
    busy: pool.filter((s) => s.busy).length,
    waiting: waiters.length,
    bytesCached: Boolean(lastBytes),
    pixelsCached: pixelCache.size
  }
}
