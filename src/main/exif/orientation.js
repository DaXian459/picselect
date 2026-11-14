'use strict'

const { readStructure } = require('./tiff-ifd')

const TAG_ORIENTATION = 0x0112

/** 在 JPEG 中定位 `Exif\0\0` 起始偏移；返回 TIFF 头在 buffer 内的绝对偏移 */
function findExifTiffOffset(buf, limit = 256 * 1024) {
  if (!buf || buf.length < 4) return -1
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return -1
  const end = Math.min(buf.length, limit)
  let off = 2
  while (off + 4 <= end) {
    if (buf[off] !== 0xff) return -1
    const marker = buf[off + 1]
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { off += 2; continue }
    if (marker === 0xd9 || marker === 0xda) return -1
    const len = buf.readUInt16BE(off + 2)
    if (len < 2) return -1
    if (marker === 0xe1) {
      const seg = off + 4
      if (seg + 6 <= buf.length && buf.toString('latin1', seg, seg + 6) === 'Exif\u0000\u0000') {
        return seg + 6
      }
    }
    off += 2 + len
  }
  return -1
}

function hasExifApp1(buf) {
  return findExifTiffOffset(buf) >= 0
}

/** 读取 JPEG（或 TIFF 文件）的 Orientation；无则返回 0 */
function readOrientation(buf) {
  let base = 0
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    base = findExifTiffOffset(buf)
    if (base < 0) return 0
  }
  const struct = readStructure(buf, base)
  if (!struct || !struct.ifd0) return 0
  const entry = struct.ifd0.get(TAG_ORIENTATION)
  if (!entry) return 0
  const le = struct.le
  const v = entry.size <= 4
    ? (le ? buf.readUInt16LE(entry.offset) : buf.readUInt16BE(entry.offset))
    : 0
  return v >= 1 && v <= 8 ? v : 0
}

/**
 * 给内嵌预览 JPEG 注入最小 APP1（仅含 Orientation）。
 * 用于：RAW 的 IFD0 声明了方向，但内嵌预览本身没有 EXIF，
 * 若不注入，Chromium 不会旋转，主图与缩略图方向会不一致。
 */
function injectOrientation(jpeg, orientation) {
  if (!orientation || orientation < 2 || orientation > 8) return jpeg
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg
  if (hasExifApp1(jpeg)) return jpeg

  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)      // IFD0 offset
  tiff.writeUInt16LE(1, 8)      // 1 个条目
  tiff.writeUInt16LE(TAG_ORIENTATION, 10)
  tiff.writeUInt16LE(3, 12)     // SHORT
  tiff.writeUInt32LE(1, 14)     // count
  tiff.writeUInt16LE(orientation, 18)
  tiff.writeUInt32LE(0, 22)     // next IFD

  const payload = Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff])
  const app1 = Buffer.alloc(4)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(payload.length + 2, 2)

  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)])
}

/** 像素级旋转 90/180/270 度（TIFF → PNG 时烘焙，避免依赖 EXIF 元数据） */
function rotateRgba(rgba, width, height, orientation) {
  if (!orientation || orientation === 1) return { data: rgba, width, height }
  const swap = orientation >= 5
  const outW = swap ? height : width
  const outH = swap ? width : height
  const out = Buffer.allocUnsafe(rgba.length)
  const bpp = 4

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx
      let ny
      switch (orientation) {
        case 2: nx = width - 1 - x; ny = y; break            // 水平镜像
        case 3: nx = width - 1 - x; ny = height - 1 - y; break // 180
        case 4: nx = x; ny = height - 1 - y; break            // 垂直镜像
        case 5: nx = y; ny = x; break                         // 转置
        case 6: nx = height - 1 - y; ny = x; break            // 顺时针 90
        case 7: nx = height - 1 - y; ny = width - 1 - x; break // 反转置
        case 8: nx = y; ny = width - 1 - x; break             // 逆时针 90
        default: nx = x; ny = y
      }
      const src = (y * width + x) * bpp
      const dst = (ny * outW + nx) * bpp
      out[dst] = rgba[src]
      out[dst + 1] = rgba[src + 1]
      out[dst + 2] = rgba[src + 2]
      out[dst + 3] = rgba[src + 3]
    }
  }
  return { data: out, width: outW, height: outH }
}

module.exports = { findExifTiffOffset, hasExifApp1, readOrientation, injectOrientation, rotateRgba }
