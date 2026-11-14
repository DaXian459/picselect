import { state, metaOf } from '../state.js'
import { getThumbnail } from '../thumb-service.js'
import { kindLabel } from '../lib/format.js'

const GAP = 10
const RATIO = 0.75
const BUFFER_ROWS = 2

let scrollEl = null
let canvasEl = null
let callbacks = {}
const tiles = new Map()

let cols = 1
let tileW = 168
let tileH = 126
let rowH = 136
let range = { start: -1, end: -1 }
let rafId = 0

function starRow() {
  const wrap = document.createElement('div')
  wrap.className = 'tile-stars stars is-interactive'
  for (let value = 1; value <= 5; value++) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'star'
    btn.dataset.value = String(value)
    btn.tabIndex = -1
    btn.innerHTML = '<svg><use href="#i-star"/></svg>'
    wrap.appendChild(btn)
  }
  return wrap
}

function createTile(index) {
  const el = document.createElement('div')
  el.className = 'tile is-loading'
  el.dataset.index = String(index)

  const img = document.createElement('img')
  img.className = 'tile-thumb'
  img.alt = ''
  img.decoding = 'async'
  img.draggable = false
  el.appendChild(img)

  const badge = document.createElement('span')
  badge.className = 'tile-badge'
  badge.hidden = true
  el.appendChild(badge)

  const fav = document.createElement('button')
  fav.type = 'button'
  fav.className = 'tile-fav'
  fav.title = '收藏 (F)'
  fav.innerHTML = '<svg><use href="#i-heart"/></svg>'
  el.appendChild(fav)

  const bottom = document.createElement('div')
  bottom.className = 'tile-bottom'
  const name = document.createElement('span')
  name.className = 'tile-name'
  bottom.appendChild(name)
  const stars = starRow()
  bottom.appendChild(stars)
  el.appendChild(bottom)

  const rec = { el, img, badge, fav, name, stars, url: null, token: 0 }
  tiles.set(index, rec)
  canvasEl.appendChild(el)
  return rec
}

function loadThumb(rec, item, index) {
  if (rec.url === item.url) return
  rec.url = item.url
  rec.token++
  const token = rec.token

  rec.el.classList.add('is-loading')
  rec.el.classList.remove('is-error')
  rec.img.classList.remove('is-loaded')
  rec.img.removeAttribute('src')

  getThumbnail(item)
    .then((url) => {
      if (rec.token !== token) return
      rec.img.onload = () => {
        rec.img.classList.add('is-loaded')
        rec.el.classList.remove('is-loading')
      }
      rec.img.src = url
      if (rec.img.complete && rec.img.naturalWidth) {
        rec.img.classList.add('is-loaded')
        rec.el.classList.remove('is-loading')
      }
    })
    .catch(() => {
      if (rec.token !== token) return
      rec.el.classList.remove('is-loading')
      rec.el.classList.add('is-error')
    })

  rec.el.dataset.index = String(index)
}

function position(rec, index) {
  const row = Math.floor(index / cols)
  const col = index % cols
  rec.el.style.width = `${Math.round(tileW)}px`
  rec.el.style.height = `${Math.round(tileH)}px`
  rec.el.style.transform = `translate3d(${Math.round(col * (tileW + GAP))}px, ${Math.round(row * rowH)}px, 0)`
}

function updateTile(rec, index) {
  const item = state.filtered[index]
  if (!item) return
  const meta = metaOf(item)

  rec.name.textContent = item.name
  const label = kindLabel(item)
  rec.badge.hidden = !label
  if (label) rec.badge.textContent = label

  rec.el.classList.toggle('is-fav', meta.favorite)
  rec.el.classList.toggle('has-rating', meta.rating > 0)
  rec.el.classList.toggle('is-selected', index === state.selected)

  const stars = rec.stars.children
  for (let i = 0; i < stars.length; i++) {
    stars[i].classList.toggle('on', i < meta.rating)
  }

  position(rec, index)
  loadThumb(rec, item, index)
}

export function computeLayout() {
  const width = canvasEl ? canvasEl.clientWidth : 0
  if (!width) return
  const thumb = state.thumbSize
  cols = Math.max(1, Math.floor((width + GAP) / (thumb + GAP)))
  tileW = (width - GAP * (cols - 1)) / cols
  tileH = tileW * RATIO
  rowH = tileH + GAP

  const rows = Math.ceil(state.filtered.length / cols)
  canvasEl.style.height = rows > 0 ? `${Math.round(rows * rowH - GAP)}px` : '0px'
  range = { start: -1, end: -1 }
}

function visibleRange() {
  const total = state.filtered.length
  if (!total) return { start: 0, end: 0 }
  const top = scrollEl.scrollTop
  const viewH = scrollEl.clientHeight || 600
  const totalRows = Math.ceil(total / cols)
  const firstRow = Math.max(0, Math.floor(top / rowH) - BUFFER_ROWS)
  const lastRow = Math.min(totalRows - 1, Math.ceil((top + viewH) / rowH) + BUFFER_ROWS)
  return { start: firstRow * cols, end: Math.min(total, (lastRow + 1) * cols) }
}

export function renderRange(force = false) {
  if (!canvasEl || !scrollEl) return
  const next = visibleRange()
  if (!force && next.start === range.start && next.end === range.end) return
  range = next

  for (const [index, rec] of tiles) {
    if (index < next.start || index >= next.end) {
      rec.el.remove()
      tiles.delete(index)
    }
  }

  for (let index = next.start; index < next.end; index++) {
    const rec = tiles.get(index) || createTile(index)
    updateTile(rec, index)
  }
}

function scheduleRender() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    renderRange()
  })
}

export function relayout() {
  computeLayout()
  renderRange(true)
}

export function refresh({ keepScroll = false } = {}) {
  for (const rec of tiles.values()) rec.el.remove()
  tiles.clear()
  range = { start: -1, end: -1 }
  if (!keepScroll && scrollEl) scrollEl.scrollTop = 0
  computeLayout()
  renderRange(true)
  updateEmptyState()
}

/** 标记变化时只更新可见瓦片，不重排 */
export function refreshMeta() {
  for (const [index, rec] of tiles) {
    const item = state.filtered[index]
    if (!item) continue
    const meta = metaOf(item)
    rec.el.classList.toggle('is-fav', meta.favorite)
    rec.el.classList.toggle('has-rating', meta.rating > 0)
    const stars = rec.stars.children
    for (let i = 0; i < stars.length; i++) stars[i].classList.toggle('on', i < meta.rating)
  }
  for (const [index, rec] of tiles) {
    rec.el.classList.toggle('is-selected', index === state.selected)
  }
}

export function scrollToIndex(index) {
  if (!scrollEl || index < 0) return
  const row = Math.floor(index / cols)
  const top = row * rowH
  const bottom = top + rowH
  const viewTop = scrollEl.scrollTop
  const viewBottom = viewTop + scrollEl.clientHeight
  if (top < viewTop + 40) scrollEl.scrollTop = Math.max(0, top - 40)
  else if (bottom > viewBottom - 40) scrollEl.scrollTop = bottom - scrollEl.clientHeight + 40
}

function updateEmptyState() {
  const empty = document.getElementById('emptyState')
  if (!empty) return
  const hasItems = state.filtered.length > 0
  const hasRoot = Boolean(state.root)
  empty.hidden = hasItems

  const title = document.getElementById('emptyTitle')
  const desc = document.getElementById('emptyDesc')
  const action = document.getElementById('emptyOpen')

  if (!hasRoot) {
    title.textContent = '还没有打开任何目录'
    desc.textContent = '选择一个照片文件夹，PicSelect 会快速建立缩略图索引。'
    action.hidden = false
  } else if (!hasItems) {
    title.textContent = state.items.length ? '当前筛选没有匹配的照片' : '这个目录里没有可显示的图片'
    desc.textContent = state.items.length
      ? '试试切换筛选条件或清空搜索关键词。'
      : '支持 JPEG、PNG、GIF、WebP、BMP、AVIF、TIFF 以及常见 RAW 格式。'
    action.hidden = true
  }
}

function previewStars(starsEl, upTo) {
  const stars = starsEl.children
  for (let i = 0; i < stars.length; i++) {
    stars[i].classList.toggle('on', i < upTo)
  }
}

export function initGrid({ scroll, canvas, onOpen, onRate, onToggleFav }) {
  scrollEl = scroll
  canvasEl = canvas
  callbacks = { onOpen, onRate, onToggleFav }

  scrollEl.addEventListener('scroll', scheduleRender, { passive: true })

  canvasEl.addEventListener('click', (event) => {
    const star = event.target.closest('.star')
    if (star) {
      const index = Number(star.closest('.tile').dataset.index)
      callbacks.onRate(index, Number(star.dataset.value))
      return
    }
    const fav = event.target.closest('.tile-fav')
    if (fav) {
      const index = Number(fav.closest('.tile').dataset.index)
      callbacks.onToggleFav(index)
      return
    }
    const tile = event.target.closest('.tile')
    if (tile) callbacks.onOpen(Number(tile.dataset.index))
  })

  canvasEl.addEventListener('dblclick', (event) => {
    const tile = event.target.closest('.tile')
    if (tile) callbacks.onOpen(Number(tile.dataset.index))
  })

  canvasEl.addEventListener('mouseover', (event) => {
    const star = event.target.closest('.star')
    if (!star) return
    if (event.relatedTarget && star.parentElement.contains(event.relatedTarget)) return
    previewStars(star.parentElement, Number(star.dataset.value))
  })

  canvasEl.addEventListener('mouseout', (event) => {
    const stars = event.target.closest('.tile-stars')
    if (!stars) return
    if (event.relatedTarget && stars.contains(event.relatedTarget)) return
    const tile = stars.closest('.tile')
    const item = state.filtered[Number(tile.dataset.index)]
    if (item) previewStars(stars, metaOf(item).rating)
  })

  const resizeObserver = new ResizeObserver(() => relayout())
  resizeObserver.observe(canvasEl.parentElement)
}
