'use strict'

const path = require('node:path')

// 浏览器/Chromium 可原生解码的格式
const RASTER_EXT = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif',
  '.png', '.apng', '.gif', '.webp', '.bmp', '.avif', '.ico', '.svg'
])

// 需要主进程解码的 TIFF 系
const TIFF_EXT = new Set(['.tif', '.tiff'])

// RAW：统一走"内嵌预览提取"
const RAW_EXT = new Set([
  '.arw', '.srf', '.sr2',   // Sony
  '.cr2', '.cr3', '.crw',   // Canon
  '.nef', '.nrw',           // Nikon
  '.dng', '.orf', '.rw2', '.raf', '.pef', '.srw', '.raw', '.rwl', '.x3f', '.3fr', '.erf', '.mrw'
])

// 暂不支持（Chromium 无 HEVC 解码，纯 JS 解不划算）
const UNSUPPORTED_EXT = new Set(['.heic', '.heif', '.hif'])

const ALL_EXT = new Set([...RASTER_EXT, ...TIFF_EXT, ...RAW_EXT])

function extOf(file) {
  return path.extname(file).toLowerCase()
}

function isSupported(file) {
  return ALL_EXT.has(extOf(file))
}

function isUnsupported(file) {
  return UNSUPPORTED_EXT.has(extOf(file))
}

function kindOf(file) {
  const ext = extOf(file)
  if (RAW_EXT.has(ext)) return 'raw'
  if (TIFF_EXT.has(ext)) return 'tiff'
  if (ext === '.svg') return 'vector'
  if (ext === '.gif') return 'animated'
  if (ext === '.apng') return 'animated'
  if (ext === '.webp') return 'raster'
  return 'raster'
}

/**
 * 图片 URL：路径用 base64url 整串编码，绕开 Windows 反斜杠 / 中文 / #?% 的 URL 解析坑。
 * 版本号用 mtime，使 immutable 缓存安全。
 */
function mediaUrl(file, mtimeMs) {
  const key = Buffer.from(path.resolve(file), 'utf8').toString('base64url')
  const v = mtimeMs ? `?v=${Math.round(mtimeMs)}` : ''
  return `app://picselect/media/${key}${v}`
}

function decodeMediaKey(key) {
  return Buffer.from(key, 'base64url').toString('utf8')
}

/** 统一大小写，Windows 文件系统大小写不敏感 */
function normalizeKey(file) {
  return path.resolve(file).toLowerCase()
}

module.exports = {
  RASTER_EXT, TIFF_EXT, RAW_EXT, UNSUPPORTED_EXT, ALL_EXT,
  extOf, isSupported, isUnsupported, kindOf,
  mediaUrl, decodeMediaKey, normalizeKey
}
