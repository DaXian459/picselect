import { state, metaOf } from '../state.js'
import { api } from '../api.js'
import { formatBytes, formatDate } from '../lib/format.js'

let bodyEl = null
let handlers = {}
let renderSeq = 0
let currentItem = null
let currentImageSize = null
let currentExif = null
const refs = { sub: null, dims: null }

function dimsText() {
  if (currentImageSize && currentImageSize.width) {
    return `${currentImageSize.width} × ${currentImageSize.height}`
  }
  if (currentExif && currentExif.width && currentExif.height) {
    return `${currentExif.width} × ${currentExif.height}`
  }
  return '—'
}

function subText(item) {
  return `${item.ext.replace('.', '').toUpperCase()} · ${dimsText()} · ${formatBytes(item.size)}`
}

function section(title) {
  const el = document.createElement('div')
  el.className = 'info-section'
  if (title) {
    const h = document.createElement('div')
    h.className = 'info-section-title'
    h.textContent = title
    el.appendChild(h)
  }
  return el
}

function row(label, value) {
  if (value === null || value === undefined || value === '') return null
  const dl = document.createElement('div')
  dl.className = 'info-row'
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.textContent = String(value)
  dd.title = String(value)
  dl.append(dt, dd)
  return dl
}

function rowsEl(pairs) {
  const wrap = document.createElement('div')
  wrap.className = 'info-rows'
  let count = 0
  for (const [label, value] of pairs) {
    const r = row(label, value)
    if (r) {
      wrap.appendChild(r)
      count++
    }
  }
  if (!count) {
    const empty = document.createElement('div')
    empty.className = 'info-empty'
    empty.textContent = '没有可用信息'
    wrap.appendChild(empty)
  }
  return wrap
}

function tagInput() {
  const listId = 'tagSuggestions'
  let datalist = document.getElementById(listId)
  if (!datalist) {
    datalist = document.createElement('datalist')
    datalist.id = listId
    document.body.appendChild(datalist)
  }
  const tags = new Set()
  for (const item of state.items) {
    for (const tag of metaOf(item).tags) tags.add(tag)
  }
  datalist.replaceChildren()
  for (const tag of [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const option = document.createElement('option')
    option.value = tag
    datalist.appendChild(option)
  }
  return listId
}

function renderMarks(item, meta) {
  const box = section('标记')
  box.classList.add('info-marks')

  const stars = document.createElement('div')
  stars.className = 'stars is-interactive'
  stars.style.marginBottom = '10px'
  for (let value = 1; value <= 5; value++) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `star${value <= meta.rating ? ' on' : ''}`
    btn.dataset.value = String(value)
    btn.title = `${value} 星`
    btn.innerHTML = '<svg><use href="#i-star"/></svg>'
    stars.appendChild(btn)
  }
  stars.addEventListener('click', (event) => {
    const star = event.target.closest('.star')
    if (star) handlers.onRate?.(Number(star.dataset.value))
  })
  box.appendChild(stars)

  const actions = document.createElement('div')
  actions.className = 'info-actions'
  const favBtn = document.createElement('button')
  favBtn.type = 'button'
  favBtn.className = 'btn'
  favBtn.style.borderColor = 'var(--border)'
  favBtn.innerHTML = `<svg><use href="#i-heart"/></svg><span>${meta.favorite ? '已收藏' : '收藏'}</span>`
  if (meta.favorite) favBtn.style.color = 'var(--danger)'
  favBtn.addEventListener('click', () => handlers.onToggleFav?.())
  actions.appendChild(favBtn)
  box.appendChild(actions)

  const tagsBox = document.createElement('div')
  tagsBox.className = 'info-tags'
  tagsBox.style.marginTop = '12px'
  if (!meta.tags.length) {
    const hint = document.createElement('span')
    hint.className = 'info-empty'
    hint.style.padding = '0'
    hint.textContent = '还没有标签'
    tagsBox.appendChild(hint)
  } else {
    for (const tag of meta.tags) {
      const chip = document.createElement('span')
      chip.className = 'tag-chip is-removable'
      chip.textContent = `${tag} ×`
      chip.title = '点击移除'
      chip.addEventListener('click', () => handlers.onRemoveTag?.(tag))
      tagsBox.appendChild(chip)
    }
  }
  box.appendChild(tagsBox)

  const inputRow = document.createElement('div')
  inputRow.className = 'tag-input-row'
  const input = document.createElement('input')
  input.className = 'tag-input'
  input.type = 'text'
  input.placeholder = '输入标签后回车'
  input.id = 'tagInput'
  input.setAttribute('list', tagInput())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const value = input.value.trim()
      if (value) {
        const tags = value.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)
        if (tags.length) handlers.onAddTag?.(tags)
      }
      input.value = ''
    }
  })
  inputRow.appendChild(input)
  box.appendChild(inputRow)

  return box
}

function render(item, exifPayload) {
  const meta = metaOf(item)
  const exif = exifPayload && exifPayload.exif
  currentExif = exif

  bodyEl.replaceChildren()
  refs.sub = null
  refs.dims = null

  // 头部
  const head = section()
  const thumb = document.createElement('img')
  thumb.className = 'info-thumb'
  thumb.alt = ''
  thumb.src = item.url
  head.appendChild(thumb)

  const name = document.createElement('div')
  name.className = 'info-filename'
  name.textContent = item.name
  head.appendChild(name)

  const sub = document.createElement('div')
  sub.className = 'info-sub'
  sub.textContent = subText(item)
  head.appendChild(sub)
  refs.sub = sub
  bodyEl.appendChild(head)

  // 文件
  const fileBox = section('文件')
  const dimsRow = row('尺寸', dimsText())
  if (dimsRow) {
    dimsRow.classList.add('info-dims-row')
    fileBox.appendChild(dimsRow)
    refs.dims = dimsRow.querySelector('dd')
  }
  fileBox.appendChild(rowsEl([
    ['体积', formatBytes(item.size)],
    ['修改时间', formatDate(item.mtimeMs)],
    ['格式', item.ext.replace('.', '').toUpperCase()],
    ...(item.kind === 'raw' ? [['预览来源', 'RAW 内嵌 JPEG 预览']] : []),
    ...(item.kind === 'tiff' ? [['预览来源', '主进程 TIFF 解码']] : [])
  ]))
  bodyEl.appendChild(fileBox)

  // 拍摄参数（仅当真的有相机信息时）
  if (exif && (exif.make || exif.model || exif.exposure || exif.aperture || exif.iso || exif.date)) {
    const shot = section('拍摄参数')
    const camera = [exif.make, exif.model].filter(Boolean).join(' ')
    shot.appendChild(rowsEl([
      ['相机', camera],
      ['镜头', exif.lens],
      ['光圈', exif.aperture],
      ['快门', exif.exposure],
      ['ISO', exif.iso],
      ['焦距', exif.focal ? (exif.focal35 && exif.focal35 !== exif.focal ? `${exif.focal} (等效 ${exif.focal35})` : exif.focal) : null],
      ['拍摄时间', exif.date],
      ['方向', exif.orientationLabel && exif.orientation !== 1 ? exif.orientationLabel : null]
    ]))
    bodyEl.appendChild(shot)
  }

  bodyEl.appendChild(renderMarks(item, meta))

  // 操作
  const ops = section('操作')
  const revealBtn = document.createElement('button')
  revealBtn.type = 'button'
  revealBtn.className = 'btn'
  revealBtn.style.borderColor = 'var(--border)'
  revealBtn.innerHTML = '<svg><use href="#i-folder"/></svg><span>在资源管理器中显示</span>'
  revealBtn.addEventListener('click', () => handlers.onReveal?.())
  const opsRow = document.createElement('div')
  opsRow.className = 'info-actions'
  opsRow.appendChild(revealBtn)
  ops.appendChild(opsRow)
  bodyEl.appendChild(ops)
}

export function initInfo(options) {
  bodyEl = document.getElementById('infoBody')
  handlers = options
}

/** 图片解码完成后再回填真实像素尺寸（避免信息面板显示 "—"） */
export function updateInfoSize(width, height) {
  if (!bodyEl || !currentItem || !width) return
  currentImageSize = { width, height }
  if (refs.sub) refs.sub.textContent = subText(currentItem)
  if (refs.dims) refs.dims.textContent = dimsText()
}

export async function renderInfo(item, imageSize) {
  currentItem = item
  currentImageSize = imageSize || null
  if (!bodyEl) return

  if (!item) {
    bodyEl.replaceChildren()
    refs.sub = null
    refs.dims = null
    return
  }

  const token = ++renderSeq
  let payload = null
  try {
    payload = await api.getExif(item.path)
  } catch {}
  if (token !== renderSeq) return
  render(item, payload)
}

/** 只刷新标记区域（打星/标签后调用，避免整块闪烁） */
export function refreshInfoMarks() {
  if (!bodyEl || !currentItem) return
  const old = bodyEl.querySelector('.info-marks')
  const meta = metaOf(currentItem)
  const draft = renderMarks(currentItem, meta)
  if (old) old.replaceWith(draft)
}
