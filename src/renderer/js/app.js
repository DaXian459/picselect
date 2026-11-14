import { api, hasBridge } from './api.js'
import { state, recompute, setMeta, metaOf, collectTags, currentItem } from './state.js'
import * as grid from './views/grid.js'
import * as viewer from './views/viewer.js'
import { initInfo, renderInfo, refreshInfoMarks, updateInfoSize } from './views/infolist.js'
import { toast } from './toast.js'
import { initKeys } from './keys.js'
import { requestPersistence, idbClear, idbCount } from './idb.js'
import { clearPreload } from './preloader.js'
import { stats as thumbStats } from './thumb-service.js'
import { developRaw, developUrl, isRaw, resetDevelopCache, warmup, stats as rawStats } from './raw-develop.js'

const THUMB_STEPS = [132, 168, 208, 256, 300]
const THEME_CYCLE = ['system', 'light', 'dark']

const $ = (id) => document.getElementById(id)

let cacheCount = 0
let searchTimer = 0
let ticker = 0
let busyLabel = ''

/* ---------------- 启动 ---------------- */

async function boot() {
  if (!hasBridge) {
    $('emptyTitle').textContent = '需要在 PicSelect 桌面环境中运行'
    $('emptyDesc').textContent = '请通过 start.bat 或 npm start 启动应用。'
    return
  }

  requestPersistence()

  // 空闲时把 libraw 的 wasm 编译掉，首张 RAW 能省近 200ms
  const idle = window.requestIdleCallback || ((fn) => window.setTimeout(fn, 1200))
  idle(() => warmup())

  initGrid()
  initViewer()
  initInfoPanel()
  initKeys(keyHandlers)
  bindToolbar()
  bindDragDrop()
  bindBridge()

  await applyPrefs()
  await loadInitial()
  refreshExternalApps()

  ticker = window.setInterval(updateStatus, 1000)
  window.setInterval(refreshCacheCount, 8000)
}

async function applyPrefs() {
  const [prefs, theme] = await Promise.all([
    api.getPrefs().catch(() => ({})),
    api.getTheme().catch(() => ({ mode: 'system', dark: true }))
  ])

  state.themeMode = theme.mode || prefs.theme || 'system'
  state.dark = Boolean(theme.dark)
  applyTheme()

  const thumb = Number(prefs.thumbSize)
  applyThumbSize(THUMB_STEPS.includes(thumb) ? thumb : 168, false)

  state.sort = prefs.sort || 'name'
  $('sortSelect').value = state.sort

  if (prefs.infoOpen) toggleInfo(true)
}

async function loadInitial() {
  const params = new URLSearchParams(location.search)
  const prefs = await api.getPrefs().catch(() => ({}))
  const dir = params.get('open') || prefs.lastDir
  const select = Number(params.get('select') || 0)
  const scene = params.get('scene') || ''

  if (scene === 'empty' || !dir) {
    grid.refresh()
    updateStatus()
    return
  }

  await loadDir(dir, { select, scene })
  refreshCacheCount()
}

/* ---------------- 目录加载 ---------------- */

async function loadDir(dir, opts = {}) {
  state.scanning = true
  updateStatus()

  let payload
  try {
    payload = opts.path ? await api.openPath(opts.path) : await api.loadLibrary(dir)
  } catch (err) {
    state.scanning = false
    updateStatus()
    toast(err.message || '打开目录失败', { level: 'error' })
    return
  }

  state.scanning = false
  if (!payload) {
    updateStatus()
    return
  }

  await hydrate(payload, opts)
}

async function hydrate(payload, opts = {}) {
  state.root = payload.root
  state.items = payload.items || []
  state.stats = payload.stats || {}
  state.selected = -1
  state.meta = (await api.getAllMeta().catch(() => ({}))) || {}

  recompute()
  clearPreload()
  grid.refresh()
  updateTagOptions()
  updateStatus()
  refreshCacheCount()

  document.title = `${state.root} — PicSelect`

  if (payload.focus) {
    const idx = state.filtered.findIndex((i) => i.path === payload.focus)
    if (idx >= 0) state.selected = idx
  } else if (state.filtered.length) {
    state.selected = Math.min(Math.max(opts.select || 0, 0), state.filtered.length - 1)
  }

  grid.refreshMeta()
  refreshInfoPanel()
  updateStatus()

  if (state.stats.unsupported) {
    toast(`已跳过 ${state.stats.unsupported} 个 HEIC/HEIF 文件（暂不支持该编码）`, { duration: 3800 })
  }

  if ((opts.scene === 'viewer' || opts.scene === 'info') && state.selected >= 0) {
    openViewer(state.selected)
    if (opts.scene === 'info') toggleInfo(true)
  }
}

/* ---------------- 视图切换 ---------------- */

function openViewer(index) {
  if (typeof index === 'number') state.selected = index
  if (state.selected < 0 || !state.filtered.length) return

  state.view = 'viewer'
  $('gridPane').hidden = true
  $('viewerPane').hidden = false
  document.body.classList.add('is-viewing')

  viewer.show(state.selected)
  grid.refreshMeta()
  refreshInfoPanel()
  updateStatus()
}

function closeViewer() {
  if (state.view !== 'viewer') return
  state.view = 'grid'
  $('viewerPane').hidden = true
  $('gridPane').hidden = false
  document.body.classList.remove('is-viewing')

  grid.refreshMeta()
  grid.scrollToIndex(state.selected)
  refreshInfoPanel()
  updateStatus()
}

function navigate(delta) {
  if (state.view !== 'viewer') {
    if (delta > 0) openViewer(Math.min(state.selected + 1, state.filtered.length - 1))
    else if (delta < 0) openViewer(Math.max(state.selected - 1, 0))
    return
  }
  const next = state.selected + delta
  if (next < 0 || next >= state.filtered.length) return
  state.selected = next
  viewer.show(next)
  refreshInfoPanel()
  updateStatus()
}

function jumpTo(index) {
  if (!state.filtered.length) return
  const next = Math.max(0, Math.min(index, state.filtered.length - 1))
  if (state.view === 'viewer') {
    state.selected = next
    viewer.show(next)
    refreshInfoPanel()
  } else {
    state.selected = next
    grid.scrollToIndex(next)
    grid.refreshMeta()
    refreshInfoPanel()
  }
  updateStatus()
}

/* ---------------- 标记 ---------------- */

/**
 * 标记写入队列：同一张照片的写操作串行化。
 * 连续操作（如一次输入多个标签）必须基于上一次写入后的最新状态，
 * 否则会对同一个旧快照做覆盖写。
 */
const metaQueue = new Map()

function commitMeta(item, patchFactory) {
  const key = item.path.toLowerCase()
  const prev = metaQueue.get(key) || Promise.resolve()

  const task = prev
    .catch(() => {})
    .then(async () => {
      const patch = patchFactory(metaOf(item))
      if (!patch) return null
      const updated = await api.setMeta(item.path, patch)
      setMeta(item.path, updated)
      afterMetaChange()
      return updated
    })
    .catch((err) => {
      toast(err.message || '保存标记失败', { level: 'error' })
      return null
    })

  metaQueue.set(key, task)
  task.finally(() => {
    if (metaQueue.get(key) === task) metaQueue.delete(key)
  })
  return task
}

function afterMetaChange() {
  const activePath = state.filtered[state.selected] ? state.filtered[state.selected].path : null
  const wasViewer = state.view === 'viewer'

  recompute()
  updateTagOptions()
  grid.refresh({ keepScroll: true })

  if (wasViewer) {
    const idx = activePath ? state.filtered.findIndex((i) => i.path === activePath) : -1
    if (idx >= 0) {
      state.selected = idx
      viewer.refreshMeta()
      grid.refreshMeta()
    } else {
      toast('该照片已不符合当前筛选条件')
      closeViewer()
    }
  }

  if (state.infoOpen) refreshInfoMarks()
  updateStatus()
}

function rate(index, value) {
  const item = state.filtered[index]
  if (!item) return
  commitMeta(item, (meta) => ({ rating: meta.rating === value ? 0 : value }))
}

function toggleFavorite(index) {
  const item = state.filtered[index]
  if (!item) return
  commitMeta(item, (meta) => ({ favorite: !meta.favorite }))
}

function addTags(tags) {
  const item = currentItem()
  if (!item || !tags || !tags.length) return
  commitMeta(item, (meta) => {
    const next = [...meta.tags]
    for (const tag of tags) if (tag && !next.includes(tag)) next.push(tag)
    return next.length === meta.tags.length ? null : { tags: next }
  })
}

function removeTag(tag) {
  const item = currentItem()
  if (!item) return
  commitMeta(item, (meta) => (
    meta.tags.includes(tag) ? { tags: meta.tags.filter((t) => t !== tag) } : null
  ))
}

/* ---------------- 筛选 / 排序 / 搜索 ---------------- */

function applyFilters(resetScroll = true) {
  recompute()
  grid.refresh({ keepScroll: !resetScroll })
  updateTagOptions()
  updateStatus()

  if (state.view === 'viewer') {
    if (!state.filtered.length) {
      closeViewer()
    } else {
      state.selected = Math.min(state.selected, state.filtered.length - 1)
      state.selected = Math.max(state.selected, 0)
      viewer.show(state.selected)
      refreshInfoPanel()
    }
  } else if (state.selected >= state.filtered.length) {
    state.selected = state.filtered.length - 1
  }
  grid.refreshMeta()
}

function bindToolbar() {
  $('btnOpen').addEventListener('click', openFolder)
  $('emptyOpen').addEventListener('click', openFolder)
  $('btnRescan').addEventListener('click', rescan)

  $('search').addEventListener('input', (event) => {
    const value = event.target.value
    $('searchClear').hidden = !value
    clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      state.query = value
      applyFilters()
    }, 140)
  })

  $('searchClear').addEventListener('click', () => {
    $('search').value = ''
    $('searchClear').hidden = true
    state.query = ''
    applyFilters()
    $('search').focus()
  })

  $('filterPills').addEventListener('click', (event) => {
    const pill = event.target.closest('.pill')
    if (!pill) return
    for (const p of $('filterPills').children) p.classList.toggle('is-active', p === pill)
    state.filter = pill.dataset.filter
    applyFilters()
  })

  $('tagSelect').addEventListener('change', (event) => {
    state.tag = event.target.value
    applyFilters()
  })

  $('sortSelect').addEventListener('change', (event) => {
    state.sort = event.target.value
    api.setPrefs({ sort: state.sort })
    applyFilters()
  })

  $('btnThumbSize').addEventListener('click', () => {
    const i = THUMB_STEPS.indexOf(state.thumbSize)
    const next = THUMB_STEPS[(i + 1) % THUMB_STEPS.length]
    applyThumbSize(next, true)
  })

  $('btnTheme').addEventListener('click', cycleTheme)
  $('btnInfo').addEventListener('click', () => toggleInfo())
  $('infoClose').addEventListener('click', () => toggleInfo(false))

  $('btnExport').addEventListener('click', doExport)
  $('vPs').addEventListener('click', () => openWithApp('photoshop'))
  $('vLr').addEventListener('click', () => openWithApp('lightroom'))
}

async function openFolder() {
  try {
    const payload = await api.openFolder({ defaultPath: state.root || undefined })
    if (payload) await hydrate(payload)
  } catch (err) {
    toast(err.message || '无法打开文件夹', { level: 'error' })
  }
}

async function rescan() {
  if (!state.root) {
    openFolder()
    return
  }
  const scrollTop = $('gridScroll').scrollTop
  try {
    const payload = await api.rescan()
    if (payload) {
      await hydrate(payload, { select: state.selected })
      $('gridScroll').scrollTop = scrollTop
      toast('已重新扫描')
    }
  } catch (err) {
    toast(err.message || '重新扫描失败', { level: 'error' })
  }
}

/* ---------------- 导出 / 外部程序 ---------------- */

let externalApps = {}

function errText(err, fallback) {
  const raw = (err && err.message) || ''
  const stripped = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  return stripped || fallback
}

async function doExport() {
  const items = state.filtered
  if (!items.length) {
    toast('当前筛选结果为空，没有可导出的照片', { level: 'error' })
    return
  }

  let dir = ''
  try {
    dir = await api.pickExportDir()
  } catch (err) {
    toast(errText(err, '无法选择导出目录'), { level: 'error' })
    return
  }
  if (!dir) return

  const btn = $('btnExport')
  const label = btn.querySelector('span')
  const original = label ? label.textContent : ''
  btn.classList.add('is-busy')
  if (label) label.textContent = '导出中'
  busyLabel = `正在导出 ${items.length} 张…`
  updateStatus()

  try {
    const res = await api.runExport(items.map((item) => item.path), dir)
    const summary = res.failed
      ? `已导出 ${res.copied} 张，${res.failed} 张失败`
      : `已导出 ${res.copied} 张照片`
    toast(`${summary} · ${res.csv}`, {
      level: res.failed ? 'error' : 'info',
      action: { label: '打开目录', run: () => api.revealExportDir(res.dir) }
    })
    refreshCacheCount()
  } catch (err) {
    toast(errText(err, '导出失败'), { level: 'error' })
  } finally {
    btn.classList.remove('is-busy')
    if (label) label.textContent = original
    busyLabel = ''
    updateStatus()
  }
}

async function refreshExternalApps() {
  try {
    externalApps = await api.detectExternal()
  } catch {
    externalApps = {}
  }
  paintExternalButtons()
}

function paintExternalButtons() {
  for (const [id, kind] of [['vPs', 'photoshop'], ['vLr', 'lightroom']]) {
    const btn = $(id)
    if (!btn) continue
    const app = externalApps[kind]
    const label = kind === 'photoshop' ? 'Photoshop' : 'Lightroom'
    const key = kind === 'photoshop' ? 'P' : 'L'
    const missing = !app || !app.path
    btn.classList.toggle('is-missing', missing)
    btn.title = missing
      ? `未找到 ${label}，点击选择程序路径 (${key})`
      : `用 ${label} 打开 (${key})\n${app.path}`
  }
}

async function openWithApp(kind) {
  const item = currentItem()
  if (!item) {
    toast('还没有选中照片', { level: 'error' })
    return
  }
  const label = kind === 'photoshop' ? 'Photoshop' : 'Lightroom'
  try {
    const app = await api.openExternal(kind, item.path)
    if (app && app.source === 'manual') {
      toast(`已用 ${label} 打开`)
      refreshExternalApps()
    }
  } catch (err) {
    const message = errText(err, `无法用 ${label} 打开`)
    if (/取消|cancel/i.test(message)) return
    toast(message, { level: 'error' })
  }
}

function applyThumbSize(size, persist) {
  state.thumbSize = size
  document.documentElement.style.setProperty('--thumb', `${size}px`)
  grid.relayout()
  if (persist) {
    api.setPrefs({ thumbSize: size })
    toast(`缩略图 ${size}px`)
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light'
  const use = $('btnTheme').querySelector('use')
  const icon = state.themeMode === 'system' ? '#i-auto' : state.dark ? '#i-moon' : '#i-sun'
  use.setAttribute('href', icon)
  const label = state.themeMode === 'system' ? '跟随系统' : state.dark ? '深色' : '浅色'
  $('btnTheme').title = `主题：${label}（点击切换）`
}

async function cycleTheme() {
  const index = THEME_CYCLE.indexOf(state.themeMode)
  const next = THEME_CYCLE[(index + 1) % THEME_CYCLE.length]
  const result = await api.setTheme(next).catch(() => null)
  if (result) {
    state.themeMode = result.mode
    state.dark = result.dark
    applyTheme()
  }
}

function toggleInfo(force) {
  const next = typeof force === 'boolean' ? force : !state.infoOpen
  state.infoOpen = next
  $('app').classList.toggle('info-open', next)
  $('infoPane').hidden = !next
  $('btnInfo').classList.toggle('is-on', next)
  api.setPrefs({ infoOpen: next })

  if (next) refreshInfoPanel()
  requestAnimationFrame(() => {
    grid.relayout()
    if (state.view === 'viewer') viewer.resetZoom()
  })
}

/* ---------------- 信息面板 ---------------- */

function initInfoPanel() {
  initInfo({
    onRate: (value) => {
      if (state.selected >= 0) rate(state.selected, value)
    },
    onToggleFav: () => {
      if (state.selected >= 0) toggleFavorite(state.selected)
    },
    onAddTag: (tags) => addTags(tags),
    onRemoveTag: (tag) => removeTag(tag),
    onReveal: () => {
      const item = currentItem()
      if (item) api.reveal(item.path)
    }
  })
}

function refreshInfoPanel() {
  if (!state.infoOpen) return
  const item = state.selected >= 0 ? state.filtered[state.selected] : null
  let size = null
  if (state.view === 'viewer') {
    const img = viewer.getVisibleImage()
    if (img && img.naturalWidth) size = { width: img.naturalWidth, height: img.naturalHeight }
  }
  renderInfo(item, size)
}

/* ---------------- 视图初始化 ---------------- */

function initGrid() {
  grid.initGrid({
    scroll: $('gridScroll'),
    canvas: $('gridCanvas'),
    onOpen: (index) => openViewer(index),
    onRate: (index, value) => rate(index, value),
    onToggleFav: (index) => toggleFavorite(index)
  })
}

function initViewer() {
  viewer.initViewer({
    onRate: (index, value) => rate(index, value),
    onToggleFav: (index) => toggleFavorite(index),
    onNavigate: (delta) => navigate(delta),
    onClose: () => closeViewer(),
    onToggleInfo: () => toggleInfo(),
    onTag: () => focusTagInput(),
    onShow: () => {
      if (state.infoOpen) refreshInfoPanel()
    },
    onReady: ({ width, height }) => {
      if (state.infoOpen) updateInfoSize(width, height)
    },
    onError: () => toast('这张图片无法显示', { level: 'error' })
  })
}

function focusTagInput() {
  if (!state.infoOpen) toggleInfo(true)
  window.setTimeout(() => {
    const input = $('tagInput')
    if (input) input.focus()
  }, 60)
}

/* ---------------- 键盘 ---------------- */

const keyHandlers = {
  openFolder,
  rescan,
  resetZoom: () => viewer.resetZoom(),
  escape: () => {
    if (state.view === 'viewer') closeViewer()
    else if (state.infoOpen) toggleInfo(false)
  },
  prev: () => navigate(-1),
  next: () => navigate(1),
  space: () => {
    if (state.view === 'viewer') navigate(1)
    else openViewer(state.selected)
  },
  first: () => jumpTo(0),
  last: () => jumpTo(state.filtered.length - 1),
  favorite: () => {
    if (state.selected >= 0) toggleFavorite(state.selected)
  },
  info: () => toggleInfo(),
  toggleView: () => {
    if (state.view === 'viewer') closeViewer()
    else openViewer(state.selected)
  },
  tag: () => focusTagInput(),
  search: () => $('search').focus(),
  exportSel: () => doExport(),
  photoshop: () => openWithApp('photoshop'),
  lightroom: () => openWithApp('lightroom'),
  zoom: (factor) => {
    if (state.view === 'viewer') viewer.zoomBy(factor)
  },
  rate: (value) => {
    if (state.selected >= 0) rate(state.selected, value)
  }
}

/* ---------------- 拖拽 ---------------- */

function bindDragDrop() {
  window.addEventListener('dragover', (event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })

  window.addEventListener('drop', async (event) => {
    event.preventDefault()
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
    if (!file) return
    let target = ''
    try {
      target = api.pathForFile(file)
    } catch {
      target = ''
    }
    if (!target) {
      toast('无法获取拖入文件的位置', { level: 'error' })
      return
    }
    await loadDir(target, { path: target })
  })
}

/* ---------------- 桥接事件 ---------------- */

function bindBridge() {
  api.onTheme((payload) => {
    if (!payload) return
    state.dark = Boolean(payload.dark)
    state.themeMode = payload.mode || state.themeMode
    applyTheme()
  })
  api.onToast((payload) => {
    if (payload && payload.message) toast(payload.message, { level: payload.level })
  })
  api.onOpenDir((payload) => {
    if (payload && payload.dir) loadDir(payload.dir)
  })
}

/* ---------------- 状态栏 ---------------- */

function updateTagOptions() {
  const tags = collectTags()
  const select = $('tagSelect')
  select.replaceChildren(new Option('全部标签', ''))
  for (const [tag, count] of tags) select.appendChild(new Option(`${tag} (${count})`, tag))

  const stillExists = tags.some(([tag]) => tag === state.tag)
  if (!stillExists) state.tag = ''
  select.value = state.tag
}

function updateStatus() {
  const total = state.filtered.length
  const all = state.items.length

  $('countChip').textContent = total === all ? `${total} 张` : `${total} / ${all} 张`
  $('sbLeft').textContent = busyLabel
    || (state.scanning ? '正在扫描目录…' : state.root || '就绪')

  $('sbPos').textContent = total ? `${state.selected + 1} / ${total}` : '—'
  $('sbZoom').textContent = state.view === 'viewer'
    ? `${Math.round(viewer.currentZoom() * 100)}%`
    : '—'
  $('sbCache').textContent = `缓存 ${cacheCount} · 命中 ${thumbStats.hits}`
}

async function refreshCacheCount() {
  cacheCount = await idbCount()
  updateStatus()
}

/* ---------------- 对外暴露（调试用） ---------------- */

window.__picselect = {
  state,
  grid,
  viewer,
  developRaw,
  developUrl,
  isRaw,
  resetDevelopCache,
  openDir: (dir) => loadDir(dir),
  thumbStats,
  rawStats,
  clearThumbCache: async () => {
    await idbClear()
    clearPreload()
    cacheCount = 0
    grid.refresh({ keepScroll: true })
    toast('缩略图缓存已清空')
    updateStatus()
  }
}

/* ---------------- 入口（放在文件末尾，确保所有 const 已初始化） ---------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
