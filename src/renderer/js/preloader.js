const CACHE_LIMIT = 12
const cache = new Map()

/**
 * 预加载并解码图片。
 * 必须保留 HTMLImageElement 引用，Chromium 才不会回收已解码的位图，
 * 切换时才能做到"零等待"。
 */
export function preload(url) {
  if (!url) return Promise.resolve(null)

  const hit = cache.get(url)
  if (hit) {
    cache.delete(url)
    cache.set(url, hit)
    return hit.ready
  }

  const img = new Image()
  img.decoding = 'async'
  const entry = { img, ready: null }
  entry.ready = new Promise((resolve) => {
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
    if (img.decode) {
      img.decode().then(() => resolve(img)).catch(() => resolve(null))
    }
  })

  cache.set(url, entry)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
  return entry.ready
}

export function isPreloaded(url) {
  return cache.has(url)
}

/** 预热一组相邻图片（不等待） */
export function preloadAround(list, index, radius = 2) {
  for (let offset = 1; offset <= radius; offset++) {
    for (const i of [index + offset, index - offset]) {
      const item = list[i]
      if (item) preload(item.url)
    }
  }
}

export function clearPreload() {
  cache.clear()
}
