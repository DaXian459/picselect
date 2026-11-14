'use strict'

const fsp = require('node:fs/promises')
const zlib = require('node:zlib')
const { readStructure, readNumbers, num } = require('../exif/tiff-ifd')
const { decodeLzw } = require('./lzw')
const { decodePackBits } = require('./packbits')
const { encodePng } = require('./png-encode')
const { rotateRgba } = require('../exif/orientation')

const MAX_PIXELS = 80 * 1000 * 1000
const FULL_READ_LIMIT = 400 * 1024 * 1024

const TAG = {
  width: 0x0100,
  height: 0x0101,
  bitsPerSample: 0x0102,
  compression: 0x0103,
  photometric: 0x0106,
  stripOffsets: 0x0111,
  orientation: 0x0112,
  samplesPerPixel: 0x0115,
  rowsPerStrip: 0x0116,
  stripByteCounts: 0x0117,
  planarConfig: 0x011c,
  predictor: 0x013d,
  colorMap: 0x0140,
  tileWidth: 0x0142,
  tileLength: 0x0143,
  tileOffsets: 0x0144,
  tileByteCounts: 0x0145,
  extraSamples: 0x0152,
  planaCount: 0x0152,
  jpegOffset: 0x0201,
  jpegLength: 0x0202
}

function pickMainIfd(struct, buf) {
  const candidates = [struct.ifd0, ...(struct.subIfds || [])]
  let best = null
  let bestArea = -1
  for (const tags of candidates) {
    if (!tags) continue
    const w = num(buf, tags.get(TAG.width), struct.le)
    const h = num(buf, tags.get(TAG.height), struct.le)
    if (!w || !h) continue
    const hasData = tags.has(TAG.stripOffsets) || tags.has(TAG.jpegOffset) || tags.has(TAG.tileOffsets)
    if (!hasData) continue
    const area = w * h
    if (area > bestArea) {
      bestArea = area
      best = tags
    }
  }
  return best
}

function inflateStrip(input, compression, expected) {
  switch (compression) {
    case 1:
      return input
    case 5:
      return decodeLzw(input, expected)
    case 8:
    case 32946:
      try {
        return zlib.inflateSync(input)
      } catch {
        try {
          return zlib.inflateRawSync(input)
        } catch {
          throw new Error('Deflate 解压失败')
        }
      }
    case 32773:
      return decodePackBits(input, expected)
    default:
      throw new Error(`不支持的压缩方式 ${compression}`)
  }
}

function applyPredictor2(data, rows, rowBytes, samplesPerPixel) {
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes
    for (let i = samplesPerPixel; i < rowBytes; i++) {
      data[base + i] = (data[base + i] + data[base + i - samplesPerPixel]) & 0xff
    }
  }
}

/** 读取 strip / tile 数据并拼成完整样本缓冲（planarConfig 1）或逐平面缓冲（planarConfig 2） */
function readRaster(buf, tags, le, { width, height, samples, bps, compression, predictor, rowsPerStrip }) {
  const bytesPerSample = bps / 8
  const rowBytes = width * samples * bytesPerSample
  const totalBytes = rowBytes * height
  const planar = num(buf, tags.get(TAG.planarConfig), le) || 1

  const offsets = readNumbers(buf, tags.get(TAG.stripOffsets), le)
  const counts = readNumbers(buf, tags.get(TAG.stripByteCounts), le)
  if (!offsets || !counts || offsets.length === 0) throw new Error('TIFF 缺少 strip 数据')

  const decodeStrips = (stripOffsets, stripCounts, destRowStart, rowsTotalHtml) => {
    const out = Buffer.alloc(rowsTotalHtml * rowBytes)
    let destRow = 0
    for (let s = 0; s < stripOffsets.length; s++) {
      const rows = Math.min(rowsPerStrip, rowsTotalHtml - destRow)
      if (rows <= 0) break
      const expected = rows * rowBytes
      const start = stripOffsets[s]
      const len = stripCounts[s] || 0
      if (start + len > buf.length) throw new Error('TIFF strip 越界')
      let strip = inflateStrip(buf.subarray(start, start + len), compression, expected)
      if (strip.length < expected) {
        const padded = Buffer.alloc(expected)
        strip.copy(padded)
        strip = padded
      }
      if (predictor === 2) applyPredictor2(strip, rows, rowBytes, samples)
      strip.copy(out, destRow * rowBytes, 0, expected)
      destRow += rows
    }
    return out
  }

  if (planar === 2) {
    const stripsPerPlane = Math.ceil(height / rowsPerStrip)
    if (offsets.length < stripsPerPlane * samples) throw new Error('平面数据不完整')
    const planes = []
    for (let p = 0; p < samples; p++) {
      const start = p * stripsPerPlane
      planes.push(decodeStrips(
        offsets.slice(start, start + stripsPerPlane),
        counts.slice(start, start + stripsPerPlane),
        0,
        height
      ))
    }
    // 交错回 RGBA 前的样本序列
    const out = Buffer.alloc(width * height * samples * bytesPerSample)
    for (let p = 0; p < samples; p++) {
      const plane = planes[p]
      for (let i = 0; i < width * height; i++) {
        for (let b = 0; b < bytesPerSample; b++) {
          out[(i * samples + p) * bytesPerSample + b] = plane[i * bytesPerSample + b]
        }
      }
    }
    return out
  }

  const raster = decodeStrips(offsets, counts, 0, height)
  if (raster.length < totalBytes) throw new Error('TIFF 数据长度不足')
  return raster
}

/** 16bit → 8bit：取高位字节（按文件字节序） */
function normalize8(raster, bps, le) {
  if (bps !== 16) return raster
  const out = Buffer.allocUnsafe(raster.length >> 1)
  const hi = le ? 1 : 0
  for (let i = 0; i < out.length; i++) out[i] = raster[i * 2 + hi]
  return out
}

function samplesToRgba(raster, { width, height, samples, photometric, colorMap, hasAlpha }) {
  const px = width * height
  const out = Buffer.allocUnsafe(px * 4)

  if (photometric === 3 && colorMap) {
    const n = colorMap.length / 3
    for (let i = 0; i < px; i++) {
      const idx = Math.min(raster[i * samples], n - 1)
      out[i * 4] = colorMap[idx] >> 8
      out[i * 4 + 1] = colorMap[n + idx] >> 8
      out[i * 4 + 2] = colorMap[2 * n + idx] >> 8
      out[i * 4 + 3] = 255
    }
    return out
  }

  if (photometric === 5 && samples >= 4) {
    for (let i = 0; i < px; i++) {
      const c = raster[i * samples]
      const m = raster[i * samples + 1]
      const y = raster[i * samples + 2]
      const k = raster[i * samples + 3]
      out[i * 4] = 255 - Math.min(255, c + k)
      out[i * 4 + 1] = 255 - Math.min(255, m + k)
      out[i * 4 + 2] = 255 - Math.min(255, y + k)
      out[i * 4 + 3] = 255
    }
    return out
  }

  if (photometric === 0 || (photometric === 1 && samples < 3)) {
    const invert = photometric === 0 // WhiteIsZero
    for (let i = 0; i < px; i++) {
      let g = raster[i * samples]
      if (invert) g = 255 - g
      out[i * 4] = g
      out[i * 4 + 1] = g
      out[i * 4 + 2] = g
      out[i * 4 + 3] = 255
    }
    return out
  }

  // RGB（含可选的 alpha）
  for (let i = 0; i < px; i++) {
    const si = i * samples
    out[i * 4] = raster[si]
    out[i * 4 + 1] = raster[si + 1]
    out[i * 4 + 2] = raster[si + 2]
    out[i * 4 + 3] = hasAlpha && samples > 3 ? raster[si + 3] : 255
  }
  return out
}

/** TIFF 缓冲 → { kind:'png', buffer } 或 { kind:'jpeg', buffer } */
function decodeTiffBuffer(buf) {
  const struct = readStructure(buf)
  if (!struct) throw new Error('无法解析 TIFF 结构')
  const le = struct.le
  const tags = pickMainIfd(struct, buf)
  if (!tags) throw new Error('TIFF 缺少图像数据')

  const width = num(buf, tags.get(TAG.width), le)
  const height = num(buf, tags.get(TAG.height), le)
  if (!width || !height) throw new Error('TIFF 尺寸缺失')
  if (width * height > MAX_PIXELS) throw new Error('图像尺寸过大')

  const compression = num(buf, tags.get(TAG.compression), le) ?? 1
  const orientation = num(buf, tags.get(TAG.orientation), le) || 1

  // JPEG 压缩的 TIFF：直接把内嵌 JPEG 交给 Chromium
  if (compression === 7) {
    const jo = num(buf, tags.get(TAG.jpegOffset), le)
    const jl = num(buf, tags.get(TAG.jpegLength), le)
    let jpeg = null
    if (jo && jl) {
      jpeg = buf.subarray(jo, jo + jl)
    } else {
      const offsets = readNumbers(buf, tags.get(TAG.stripOffsets), le)
      const counts = readNumbers(buf, tags.get(TAG.stripByteCounts), le)
      if (offsets && counts && offsets.length === counts.length) {
        jpeg = Buffer.concat(offsets.map((o, i) => buf.subarray(o, o + counts[i])))
      }
    }
    if (jpeg && jpeg[0] === 0xff && jpeg[1] === 0xd8) return { kind: 'jpeg', buffer: jpeg }
    throw new Error('JPEG-in-TIFF 结构无法解析')
  }

  if (tags.has(TAG.tileOffsets)) throw new Error('分块(Tiled) TIFF 暂不支持')

  const bits = readNumbers(buf, tags.get(TAG.bitsPerSample), le) || [8]
  const bps = bits[0]
  if (bps !== 8 && bps !== 16) throw new Error(`不支持的位深 ${bps}`)

  const samples = num(buf, tags.get(TAG.samplesPerPixel), le) || 1
  const predictor = num(buf, tags.get(TAG.predictor), le) || 1
  if (predictor === 3) throw new Error('不支持浮点预测器')
  if (predictor === 2 && bps !== 8) throw new Error('16bit 预测器暂不支持')

  const photometric = num(buf, tags.get(TAG.photometric), le) ?? (tags.has(TAG.colorMap) ? 3 : (samples >= 3 ? 2 : 1))
  if (photometric === 6) throw new Error('YCbCr TIFF 仅支持 JPEG 压缩')

  const rowsPerStripTag = num(buf, tags.get(TAG.rowsPerStrip), le)
  const rowsPerStrip = rowsPerStripTag && rowsPerStripTag < height ? rowsPerStripTag : height

  const raster = readRaster(buf, tags, le, {
    width, height, samples, bps, compression, predictor, rowsPerStrip
  })

  const colorMap = readNumbers(buf, tags.get(TAG.colorMap), le)
  const extra = readNumbers(buf, tags.get(TAG.extraSamples), le)
  const hasAlpha = Boolean(extra && extra.length && samples === 4)

  const raster8 = normalize8(raster, bps, le)
  let rgba = samplesToRgba(raster8, { width, height, samples, photometric, colorMap, hasAlpha })
  let outW = width
  let outH = height

  if (orientation !== 1) {
    const rotated = rotateRgba(rgba, width, height, orientation)
    rgba = rotated.data
    outW = rotated.width
    outH = rotated.height
  }

  return { kind: 'png', buffer: encodePng(outW, outH, rgba, 4), width: outW, height: outH }
}

async function decodeTiffFile(file, size) {
  if (size && size > FULL_READ_LIMIT) throw new Error('TIFF 文件过大')
  const buf = await fsp.readFile(file)
  return decodeTiffBuffer(buf)
}

module.exports = { decodeTiffFile, decodeTiffBuffer, TAG, MAX_PIXELS }
