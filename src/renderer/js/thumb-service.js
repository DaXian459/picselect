import { idbGet, idbPut } from './idb.js'
import { developRaw, isRaw } from './raw-develop.js'

const THUMB_WIDTH = 440
const MAX_CONCURRENT = 4
const URL_CACHE_LIMIT = 360

const urlCache = new Map()
const pending = new Map()

let active = 0
const waiters = []

export const stats = { hits: 0, misses: 0, failed: 0 }

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiters.push(resolve))
}

function release() {
  const next = waiters.shift()
  if (next) next()
  else active--
}

function cacheUrl(key, url) {
  urlCache.set(key, url)
  if (urlCache.size > URL_CACHE_LIMIT) {
    const oldestKey = urlCache.keys().next().value
    const oldestUrl = urlCache.get(oldestKey)
    urlCache.delete(oldestKey)
    if (oldestUrl) URL.revokeObjectURL(oldestUrl)
  }
}

async function makeThumbnail(blob, ext) {
  // SVG 无内在尺寸时 createImageBitmap 会失败，直接交给 <img> 渲染
  if (ext === '.svg') return blob

  const bitmap = await createImageBitmap(blob, {
    resizeWidth: THUMB_WIDTH,
    resizeQuality: 'high'
  })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
  } finally {
    bitmap.close()
  }
}

/**
 * RAW 缩略图：先走 LibRaw 解码传感器数据；
 * LibRaw 不认的机型、损坏文件、非标准 RAW 容器则回退主进程提取的内嵌预览。
 */
async function developOrPreview(item, key) {
  try {
    const res = await developRaw(item, { maxWidth: THUMB_WIDTH * 2, quality: 0.82 })
    return res.blob
  } catch {
    const res = await fetch(key)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return makeThumbnail(await res.blob(), item.ext)
  }
}

/** 缩略图请求 URL：带宽度提示；RAW 额外带解码版本号，让旧的「内嵌 JPEG 预览」缓存失效 */
function thumbUrl(item) {
  const sep = item.url.includes('?') ? '&' : '?'
  const tag = isRaw(item) ? '&src=develop1' : ''
  return `${item.url}${sep}w=${THUMB_WIDTH}${tag}`
}

/**
 * 取缩略图的对象 URL。
 * 命中 IndexedDB → 秒出；未命中 → fetch 原图（或服务端预览）+ 线程池解码降采样 → 回写缓存。
 */
export function getThumbnail(item) {
  const key = thumbUrl(item)

  const cached = urlCache.get(key)
  if (cached) {
    // LRU 触碰
    urlCache.delete(key)
    urlCache.set(key, cached)
    stats.hits++
    return Promise.resolve(cached)
  }

  if (pending.has(key)) return pending.get(key)

  const task = (async () => {
    await acquire()
    try {
      let blob = await idbGet(key)
      if (blob) {
        stats.hits++
      } else if (isRaw(item)) {
        // RAW：优先自己解传感器数据；LibRaw 不认识的机型/损坏文件回退内嵌预览
        blob = await developOrPreview(item, key)
        stats.misses++
        idbPut(key, blob)
      } else {
        const res = await fetch(key)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        blob = await makeThumbnail(await res.blob(), item.ext)
        stats.misses++
        idbPut(key, blob)
      }
      const url = URL.createObjectURL(blob)
      cacheUrl(key, url)
      return url
    } catch (err) {
      stats.failed++
      throw err
    } finally {
      release()
    }
  })()

  pending.set(key, task)
  task.finally(() => pending.delete(key)).catch(() => {})
  return task
}

export function isThumbCached(item) {
  return urlCache.has(thumbUrl(item))
}

/** 同步取已缓存的缩略图 URL（没有就返回 null），查看器用来先垫一张低清图 */
export function peekThumbnail(item) {
  return urlCache.get(thumbUrl(item)) || null
}

export function resetThumbCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
  pending.clear()
  stats.hits = 0
  stats.misses = 0
  stats.failed = 0
}
