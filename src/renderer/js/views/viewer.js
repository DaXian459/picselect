import { state, metaOf } from '../state.js'
import { preloadAround } from '../preloader.js'
import { clamp, zoomLabel } from '../lib/format.js'

const MIN_SCALE = 0.15
const MAX_SCALE = 12
const IDLE_DELAY = 2600

let pane = null
let stage = null
let zoomWrap = null
let layers = {}
let activeLayer = null
let els = {}
let handlers = {}

let seq = 0
let scale = 1
let tx = 0
let ty = 0
let dragging = null
let idleTimer = 0

function buildStars() {
  els.rate.replaceChildren()
  for (let value = 1; value <= 5; value++) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'star'
    btn.dataset.value = String(value)
    btn.title = `${value} 星`
    btn.innerHTML = '<svg><use href="#i-star"/></svg>'
    els.rate.appendChild(btn)
  }
}

function applyTransform() {
  if (!zoomWrap) return
  zoomWrap.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`
  pane.classList.toggle('is-zoomed', scale > 1.001)
  els.zoom.textContent = zoomLabel(scale)
  state.zoom = scale
}

export function resetZoom() {
  scale = 1
  tx = 0
  ty = 0
  applyTransform()
}

function zoomAt(cx, cy, factor) {
  const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE)
  if (Math.abs(next - scale) < 0.0001) return
  const k = next / scale
  tx = cx - (cx - tx) * k
  ty = cy - (cy - ty) * k
  scale = next
  applyTransform()
}

export function zoomBy(factor) {
  const rect = stage.getBoundingClientRect()
  zoomAt(rect.width / 2, rect.height / 2, factor)
}

export function toggleActualSize() {
  if (scale > 1.001) {
    resetZoom()
  } else {
    const rect = stage.getBoundingClientRect()
    zoomAt(rect.width / 2, rect.height / 2, 2)
  }
}

function renderMeta() {
  const item = state.filtered[state.selected]
  if (!item) return
  const meta = metaOf(item)

  const stars = els.rate.children
  for (let i = 0; i < stars.length; i++) stars[i].classList.toggle('on', i < meta.rating)

  els.fav.classList.toggle('is-on', meta.favorite)
  els.fav.title = meta.favorite ? '取消收藏 (F)' : '收藏 (F)'

  els.tags.replaceChildren()
  for (const tag of meta.tags) {
    const chip = document.createElement('span')
    chip.className = 'tag-chip'
    chip.textContent = tag
    els.tags.appendChild(chip)
  }
}

export function refreshMeta() {
  renderMeta()
}

export function show(index) {
  const item = state.filtered[index]
  if (!item) return

  state.selected = index
  els.name.textContent = item.name
  els.name.title = item.name
  els.index.textContent = `${index + 1} / ${state.filtered.length}`
  els.prev.disabled = index <= 0
  els.next.disabled = index >= state.filtered.length - 1
  renderMeta()
  resetZoom()

  const target = activeLayer === layers.a ? layers.b : layers.a
  const other = activeLayer
  const token = ++seq

  target.src = item.url
  const reveal = () => {
    if (token !== seq) return
    target.classList.add('is-visible')
    other.classList.remove('is-visible')
    activeLayer = target
    window.setTimeout(() => {
      if (other !== activeLayer) other.removeAttribute('src')
    }, 240)
    if (target.naturalWidth) {
      handlers.onReady?.({ width: target.naturalWidth, height: target.naturalHeight, item })
    }
  }

  target.decode()
    .then(reveal)
    .catch(() => {
      if (token !== seq) return
      reveal()
      handlers.onError?.(item)
    })

  preloadAround(state.filtered, index, 2)
  handlers.onShow?.(item, index)}

function bumpIdle() {
  pane.classList.remove('is-idle')
  clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => pane.classList.add('is-idle'), IDLE_DELAY)
}

export function initViewer(options) {
  handlers = options
  pane = document.getElementById('viewerPane')
  stage = document.getElementById('stage')
  zoomWrap = document.getElementById('zoomWrap')
  layers = {
    a: document.getElementById('layerA'),
    b: document.getElementById('layerB')
  }
  activeLayer = layers.a

  els = {
    name: document.getElementById('vName'),
    index: document.getElementById('vIndex'),
    rate: document.getElementById('vRate'),
    fav: document.getElementById('vFav'),
    tags: document.getElementById('vTags'),
    zoom: document.getElementById('vZoom'),
    prev: document.getElementById('navPrev'),
    next: document.getElementById('navNext')
  }

  buildStars()

  els.rate.addEventListener('click', (event) => {
    const star = event.target.closest('.star')
    if (!star) return
    handlers.onRate?.(state.selected, Number(star.dataset.value))
  })

  els.fav.addEventListener('click', () => handlers.onToggleFav?.(state.selected))
  document.getElementById('vInfo').addEventListener('click', () => handlers.onToggleInfo?.())
  document.getElementById('vTag').addEventListener('click', () => handlers.onTag?.())
  document.getElementById('btnBackToGrid').addEventListener('click', () => handlers.onClose?.())
  els.prev.addEventListener('click', () => handlers.onNavigate?.(-1))
  els.next.addEventListener('click', () => handlers.onNavigate?.(1))
  document.getElementById('vZoomIn').addEventListener('click', () => zoomBy(1.25))
  document.getElementById('vZoomOut').addEventListener('click', () => zoomBy(1 / 1.25))
  document.getElementById('vFit').addEventListener('click', resetZoom)

  stage.addEventListener('wheel', (event) => {
    event.preventDefault()
    const rect = stage.getBoundingClientRect()
    const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor)
  }, { passive: false })

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = { x: event.clientX, y: event.clientY, tx, ty }
    stage.setPointerCapture(event.pointerId)
    zoomWrap.classList.add('is-dragging')
  })

  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return
    tx = dragging.tx + (event.clientX - dragging.x)
    ty = dragging.ty + (event.clientY - dragging.y)
    applyTransform()
  })

  const endDrag = (event) => {
    if (!dragging) return
    dragging = null
    zoomWrap.classList.remove('is-dragging')
    try {
      stage.releasePointerCapture(event.pointerId)
    } catch {}
  }

  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)

  stage.addEventListener('dblclick', (event) => {
    const rect = stage.getBoundingClientRect()
    if (scale > 1.001) {
      resetZoom()
    } else {
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, 2)
    }
  })

  pane.addEventListener('pointermove', bumpIdle)
  pane.addEventListener('pointerleave', () => {
    clearTimeout(idleTimer)
    pane.classList.add('is-idle')
  })
  bumpIdle()
}

export function currentZoom() {
  return scale
}

export function getVisibleImage() {
  return activeLayer
}
