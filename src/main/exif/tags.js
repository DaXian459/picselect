'use strict'

function formatExposure(v) {
  if (!v || !Number.isFinite(v)) return null
  if (v >= 1) return `${Number(v.toFixed(1))} s`
  const denom = Math.round(1 / v)
  return denom > 0 ? `1/${denom} s` : `${v.toFixed(4)} s`
}

function formatAperture(v) {
  if (!v || !Number.isFinite(v)) return null
  return `f/${Number(v.toFixed(1))}`
}

function formatIso(v) {
  if (!v) return null
  return `ISO ${Math.round(v)}`
}

function formatFocal(v) {
  if (!v || !Number.isFinite(v)) return null
  return `${Math.round(v)} mm`
}

function formatDate(raw) {
  if (!raw || typeof raw !== 'string') return null
  // "2024:05:01 12:33:10" → "2024-05-01 12:33:10"
  const m = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return raw
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

const ORIENTATION_LABEL = {
  1: '正常',
  2: '水平镜像',
  3: '旋转 180°',
  4: '垂直镜像',
  5: '转置',
  6: '顺时针 90°',
  7: '反转置',
  8: '逆时针 90°'
}

module.exports = {
  formatExposure, formatAperture, formatIso, formatFocal, formatDate, formatBytes, ORIENTATION_LABEL
}
