'use strict'

/**
 * 从文件头读取像素尺寸（用于没有 EXIF 的格式）。
 * 只读很小的文件头，不加载整图。
 */

function readPng(buf) {
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function readGif(buf) {
  if (buf.length < 10) return null
  const sig = buf.toString('latin1', 0, 3)
  if (sig !== 'GIF') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

function readBmp(buf) {
  if (buf.length < 26) return null
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return null
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
}

function readWebp(buf) {
  if (buf.length < 30) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('latin1', 12, 16)
  if (chunk === 'VP8X') {
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3)
    }
  }
  if (chunk === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff
    }
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    }
  }
  return null
}

function readJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let off = 2
  let guard = 0
  while (off + 9 < buf.length && guard++ < 512) {
    if (buf[off] !== 0xff) return null
    const marker = buf[off + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const len = buf.readUInt16BE(off + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) }
    }
    off += 2 + len
  }
  return null
}

function readDimensions(buf, ext) {
  try {
    switch (ext) {
      case '.png':
      case '.apng':
        return readPng(buf)
      case '.gif':
        return readGif(buf)
      case '.bmp':
        return readBmp(buf)
      case '.webp':
        return readWebp(buf)
      case '.jpg':
      case '.jpeg':
      case '.jpe':
      case '.jfif':
        return readJpeg(buf)
      default:
        // AVIF/ICO/SVG 交给渲染端 naturalWidth
        return null
    }
  } catch {
    return null
  }
}

module.exports = { readDimensions }
