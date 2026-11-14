export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function formatDate(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const KIND_LABEL = {
  raw: 'RAW',
  tiff: 'TIFF',
  vector: 'SVG',
  animated: 'GIF'
}

export function kindLabel(item) {
  if (!item) return ''
  if (item.kind === 'animated') return item.ext === '.apng' ? 'APNG' : 'GIF'
  return KIND_LABEL[item.kind] || ''
}

export function zoomLabel(scale) {
  return `${Math.round(scale * 100)}%`
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
