'use strict'

/**
 * 导出：把当前筛选出来的照片复制到目标目录，并附一份 CSV 清单。
 *
 * 为什么不复用渲染层的标记数据：主进程直接读 store 更可信，
 * 也避免渲染层伪造任意路径。所有待导出路径都必须先过 library.isAllowed。
 */

const path = require('node:path')
const fsp = require('node:fs/promises')
const library = require('./library')
const store = require('./store')
const { readExif } = require('./exif/exif')
const { mapLimit } = require('./util/fsutil')
const { formatBytes, formatDate, formatExposure, formatAperture, formatIso, formatFocal } = require('./exif/tags')

const COPY_CONCURRENCY = 4
const EXIF_CONCURRENCY = 4

const HEADER = [
  '文件名', '星级', '收藏', '标签', '宽', '高', '体积',
  '修改时间', '拍摄时间', '相机', '镜头', '光圈', '快门', 'ISO', '焦距', '导出文件名', '原路径'
]

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`
}

/** photo.jpg → photo (1).jpg，最多试到 999 */
async function uniqueTarget(dir, name, taken) {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 0; i <= 999; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`
    if (taken.has(candidate.toLowerCase())) continue
    try {
      await fsp.access(path.join(dir, candidate))
    } catch {
      taken.add(candidate.toLowerCase())
      return candidate
    }
  }
  throw new Error(`同名文件过多：${name}`)
}

async function describe(file) {
  const key = path.resolve(file).toLowerCase()
  const meta = store.getMeta(key) || { rating: 0, favorite: false, tags: [] }
  let stat = null
  try {
    stat = await fsp.stat(file)
  } catch {}

  let exif = null
  try {
    exif = await readExif(file, stat ? stat.size : 0)
  } catch {}

  return { file, meta, stat, exif }
}

async function exportSelection(files, targetDir) {
  const list = []
  for (const file of files) {
    if (typeof file !== 'string' || !library.isAllowed(file)) continue
    const resolved = path.resolve(file)
    if (!list.includes(resolved)) list.push(resolved)
  }
  if (!list.length) throw new Error('没有可导出的照片')

  const dir = path.resolve(targetDir)
  await fsp.mkdir(dir, { recursive: true })

  const taken = new Set()
  const copied = []
  const failed = []

  await mapLimit(list, COPY_CONCURRENCY, async (file) => {
    const name = path.basename(file)
    try {
      const target = await uniqueTarget(dir, name, taken)
      await fsp.copyFile(file, path.join(dir, target))
      copied.push({ file, target })
    } catch (err) {
      failed.push({ file, error: err.message })
    }
  })

  // 按源文件名顺序整理，保证清单和目录浏览顺序一致
  copied.sort((a, b) => list.indexOf(a.file) - list.indexOf(b.file))

  const rows = await mapLimit(copied, EXIF_CONCURRENCY, async (entry) => {
    const info = await describe(entry.file)
    const exif = info.exif || {}
    const meta = info.meta || {}
    return [
      path.basename(entry.file),
      meta.rating || 0,
      meta.favorite ? '是' : '',
      Array.isArray(meta.tags) ? meta.tags.join(' / ') : '',
      exif.width || '',
      exif.height || '',
      info.stat ? formatBytes(info.stat.size) : '',
      info.stat ? new Date(info.stat.mtimeMs).toLocaleString('zh-CN', { hour12: false }) : '',
      formatDate(exif.date) || '',
      [exif.make, exif.model].filter(Boolean).join(' ') || '',
      exif.lens || '',
      formatAperture(exif.aperture) || '',
      formatExposure(exif.exposure) || '',
      formatIso(exif.iso) || '',
      formatFocal(exif.focal) || '',
      entry.target,
      entry.file
    ]
  })

  const csvName = `PicSelect-导出清单-${stamp()}.csv`
  const lines = [HEADER.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))]
  // BOM 让 Excel 直接按 UTF-8 打开，中文不乱码
  await fsp.writeFile(path.join(dir, csvName), '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8')

  return {
    dir,
    csv: csvName,
    total: list.length,
    copied: copied.length,
    failed: failed.length,
    failures: failed.slice(0, 10)
  }
}

/** 导出目录单独存一份，下次默认就用它 */
function rememberDir(dir) {
  if (dir) store.setPrefs({ exportDir: dir })
}

module.exports = { exportSelection, rememberDir }
