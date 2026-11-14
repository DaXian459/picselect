'use strict'

/**
 * 通用 TIFF/IFD 读取器。
 * EXIF（JPEG 的 APP1）与 RAW 文件（ARW/CR2/NEF/DNG…）本质都是 TIFF 结构，
 * 这里是全项目唯一的 IFD 解析实现，两边共用。
 */

const TYPES = {
  1: { name: 'BYTE', size: 1 },
  2: { name: 'ASCII', size: 1 },
  3: { name: 'SHORT', size: 2 },
  4: { name: 'LONG', size: 4 },
  5: { name: 'RATIONAL', size: 8 },
  6: { name: 'SBYTE', size: 1 },
  7: { name: 'UNDEFINED', size: 1 },
  8: { name: 'SSHORT', size: 2 },
  9: { name: 'SLONG', size: 4 },
  10: { name: 'SRATIONAL', size: 8 },
  11: { name: 'FLOAT', size: 4 },
  12: { name: 'DOUBLE', size: 8 },
  13: { name: 'IFD', size: 4 }
}

const MAX_IFD_ENTRIES = 512
const MAX_DEPTH = 8

function isTiff(buf, base = 0) {
  if (!buf || buf.length < base + 8) return false
  const b0 = buf[base]
  const b1 = buf[base + 1]
  if (!((b0 === 0x49 && b1 === 0x49) || (b0 === 0x4d && b1 === 0x4d))) return false
  const le = b0 === 0x49
  const magic = le ? buf.readUInt16LE(base + 2) : buf.readUInt16BE(base + 2)
  return magic === 42
}

function parseHeader(buf, base = 0) {
  if (!isTiff(buf, base)) return null
  const le = buf[base] === 0x49
  const ifd0Offset = le ? buf.readUInt32LE(base + 4) : buf.readUInt32BE(base + 4)
  return { le, ifd0Offset }
}

function readIfd(buf, base, offset, le) {
  const abs = base + offset
  if (offset <= 0 || abs + 2 > buf.length) return null
  let count = le ? buf.readUInt16LE(abs) : buf.readUInt16BE(abs)
  const tags = new Map()
  if (count > MAX_IFD_ENTRIES) {
    // 异常 IFD：不是合法 TIFF，直接放弃，避免读到越界
    if (abs + 2 + count * 12 > buf.length) count = Math.floor((buf.length - abs - 2) / 12)
  }
  for (let i = 0; i < count; i++) {
    const e = abs + 2 + i * 12
    if (e + 12 > buf.length) break
    const tag = le ? buf.readUInt16LE(e) : buf.readUInt16BE(e)
    const type = le ? buf.readUInt16LE(e + 2) : buf.readUInt16BE(e + 2)
    const cnt = le ? buf.readUInt32LE(e + 4) : buf.readUInt32BE(e + 4)
    const t = TYPES[type]
    if (!t) continue
    const size = t.size * cnt
    let valueOffset
    if (size <= 4) {
      valueOffset = e + 8
    } else {
      const rel = le ? buf.readUInt32LE(e + 8) : buf.readUInt32BE(e + 8)
      valueOffset = base + rel
    }
    tags.set(tag, { tag, type, typeName: t.name, count: cnt, size, offset: valueOffset })
  }
  const nextPos = abs + 2 + count * 12
  let next = 0
  if (nextPos + 4 <= buf.length) next = le ? buf.readUInt32LE(nextPos) : buf.readUInt32BE(nextPos)
  return { tags, next }
}

function readNumbers(buf, entry, le) {
  if (!entry || entry.offset < 0) return null
  const end = entry.offset + entry.size
  if (end > buf.length) return null
  const out = []
  const n = entry.count
  switch (entry.typeName) {
    case 'BYTE':
    case 'SBYTE':
    case 'UNDEFINED':
      for (let i = 0; i < n; i++) out.push(buf[entry.offset + i])
      return out
    case 'SHORT':
      for (let i = 0; i < n; i++) out.push(le ? buf.readUInt16LE(entry.offset + i * 2) : buf.readUInt16BE(entry.offset + i * 2))
      return out
    case 'SSHORT':
      for (let i = 0; i < n; i++) out.push(le ? buf.readInt16LE(entry.offset + i * 2) : buf.readInt16BE(entry.offset + i * 2))
      return out
    case 'LONG':
    case 'IFD':
      for (let i = 0; i < n; i++) out.push(le ? buf.readUInt32LE(entry.offset + i * 4) : buf.readUInt32BE(entry.offset + i * 4))
      return out
    case 'SLONG':
      for (let i = 0; i < n; i++) out.push(le ? buf.readInt32LE(entry.offset + i * 4) : buf.readInt32BE(entry.offset + i * 4))
      return out
    case 'RATIONAL':
      for (let i = 0; i < n; i++) {
        const a = le ? buf.readUInt32LE(entry.offset + i * 8) : buf.readUInt32BE(entry.offset + i * 8)
        const b = le ? buf.readUInt32LE(entry.offset + i * 8 + 4) : buf.readUInt32BE(entry.offset + i * 8 + 4)
        out.push(b === 0 ? 0 : a / b)
      }
      return out
    case 'SRATIONAL':
      for (let i = 0; i < n; i++) {
        const a = le ? buf.readInt32LE(entry.offset + i * 8) : buf.readInt32BE(entry.offset + i * 8)
        const b = le ? buf.readInt32LE(entry.offset + i * 8 + 4) : buf.readInt32BE(entry.offset + i * 8 + 4)
        out.push(b === 0 ? 0 : a / b)
      }
      return out
    case 'FLOAT':
      for (let i = 0; i < n; i++) out.push(le ? buf.readFloatLE(entry.offset + i * 4) : buf.readFloatBE(entry.offset + i * 4))
      return out
    case 'DOUBLE':
      for (let i = 0; i < n; i++) out.push(le ? buf.readDoubleLE(entry.offset + i * 8) : buf.readDoubleBE(entry.offset + i * 8))
      return out
    default:
      return null
  }
}

function readString(buf, entry) {
  if (!entry) return null
  const end = Math.min(entry.offset + entry.size, buf.length)
  if (entry.offset < 0 || entry.offset >= end) return null
  let s = buf.toString('latin1', entry.offset, end)
  const nul = s.indexOf('\u0000')
  if (nul >= 0) s = s.slice(0, nul)
  return s.trim() || null
}

function readBuffer(buf, entry) {
  if (!entry) return null
  const end = Math.min(entry.offset + entry.size, buf.length)
  if (entry.offset < 0 || entry.offset >= end) return null
  return buf.subarray(entry.offset, end)
}

function num(buf, entry, le, index = 0) {
  const v = readNumbers(buf, entry, le)
  return v && v.length > index ? v[index] : null
}

/**
 * 解析整棵 IFD 树。
 * @returns {{le:boolean, ifds: Array<{offset:number, tags:Map, path:string}>, ifd0:Map|null,
 *            subIfds: Array<Map>, exif: Map|null, ifd1: Map|null}}
 */
function readStructure(buf, base = 0, { maxDepth = MAX_DEPTH } = {}) {
  const header = parseHeader(buf, base)
  if (!header) return null
  const { le } = header

  const ifds = []
  const subIfds = []
  const visited = new Set()

  const walk = (offset, depth) => {
    if (!offset || depth > maxDepth || visited.has(offset) || ifds.length > 32) return null
    visited.add(offset)
    const ifd = readIfd(buf, base, offset, le)
    if (!ifd) return null
    ifds.push({ offset, tags: ifd.tags })

    // SubIFDs (0x014A) —— RAW 的高清预览常在这里
    const sub = ifd.tags.get(0x014a)
    if (sub) {
      const offsets = readNumbers(buf, sub, le) || []
      for (const o of offsets) {
        const child = walk(o, depth + 1)
        if (child) subIfds.push(child)
      }
    }
    return ifd.tags
  }

  const ifd0 = walk(header.ifd0Offset, 0)

  let exif = null
  const exifPtr = ifd0 && ifd0.get(0x8769)
  if (exifPtr) {
    const eo = num(buf, exifPtr, le)
    if (eo) {
      const parsed = readIfd(buf, base, eo, le)
      if (parsed) exif = parsed.tags
    }
  }

  // IFD1：通常存放缩略图
  const first = readIfd(buf, base, header.ifd0Offset, le)
  let ifd1 = null
  if (first && first.next) {
    const parsed = readIfd(buf, base, first.next, le)
    if (parsed) ifd1 = parsed.tags
  }

  return { le, header, ifd0, ifd1, exif, subIfds, ifds }
}

module.exports = {
  TYPES,
  isTiff,
  parseHeader,
  readIfd,
  readNumbers,
  readString,
  readBuffer,
  num,
  readStructure
}
