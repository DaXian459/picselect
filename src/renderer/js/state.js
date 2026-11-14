const listeners = new Set()

export const EMPTY_META = Object.freeze({ rating: 0, favorite: false, tags: [] })

export const state = {
  root: null,
  items: [],
  filtered: [],
  meta: {},
  query: '',
  filter: 'all',
  tag: '',
  sort: 'name',
  selected: -1,
  view: 'grid',
  infoOpen: false,
  themeMode: 'system',
  dark: true,
  thumbSize: 168,
  zoom: 1,
  stats: { total: 0, unsupported: 0, ms: 0 },
  scanning: false
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emit(type, detail) {
  for (const fn of [...listeners]) {
    try {
      fn(type, detail)
    } catch (err) {
      console.error('[state] 订阅回调出错:', err)
    }
  }
}

export function metaOf(item) {
  if (!item) return EMPTY_META
  return state.meta[item.path.toLowerCase()] || EMPTY_META
}

export function setMeta(path, meta) {
  if (!path) return
  state.meta[path.toLowerCase()] = meta
}

function sortItems(list) {
  switch (state.sort) {
    case 'date-desc':
      list.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      break
    case 'date-asc':
      list.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      break
    case 'size-desc':
      list.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      break
    default:
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))
  }
  return list
}

export function recompute() {
  const q = state.query.trim().toLowerCase()
  const out = []
  for (const item of state.items) {
    const meta = metaOf(item)
    if (state.filter === 'favorite' && !meta.favorite) continue
    if (state.filter === 'rated3' && meta.rating < 3) continue
    if (state.filter === 'untagged' && (meta.rating > 0 || meta.favorite || meta.tags.length > 0)) continue
    if (state.tag && !meta.tags.includes(state.tag)) continue
    if (q && !item.name.toLowerCase().includes(q)) continue
    out.push(item)
  }
  sortItems(out)
  state.filtered = out

  if (state.selected >= out.length) state.selected = out.length - 1
  return out
}

/** 收集全部已用标签（含使用次数），供筛选与自动补全 */
export function collectTags() {
  const counts = new Map()
  for (const item of state.items) {
    const meta = metaOf(item)
    for (const tag of meta.tags) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
}

export function counts() {
  let favorite = 0
  let rated = 0
  let untagged = 0
  for (const item of state.items) {
    const meta = metaOf(item)
    if (meta.favorite) favorite++
    if (meta.rating >= 3) rated++
    if (!meta.rating && !meta.favorite && !meta.tags.length) untagged++
  }
  return { total: state.items.length, favorite, rated, untagged }
}

export function currentItem() {
  return state.filtered[state.selected] || null
}
