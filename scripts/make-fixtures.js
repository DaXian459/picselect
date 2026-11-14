'use strict'

/**
 * 生成测试素材（在 Electron 下运行：npm run fixtures）
 * - 8 张程序绘制的"照片"，覆盖不同长宽比
 * - 8 个方向的 EXIF 样本（验证不双重旋转）
 * - 多种 TIFF 编码（自写编码器 + GDI+ 交叉验证另见 scripts/gen-gdi-tiff.ps1）
 * - 3 个合成 RAW（ARW 走 SubIFD、NEF 走 IFD0、DNG 走 strip 拼接）
 * - 应用图标 assets/icon.png
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const zlib = require('node:zlib')
const { app, nativeImage } = require('electron')

const { encodePng } = require('../src/main/tiff/png-encode')
const { injectOrientation } = require('../src/main/exif/orientation')

const ROOT = path.resolve(__dirname, '..')
const FIXTURES = path.join(ROOT, 'fixtures')
const ASSETS = path.join(ROOT, 'assets')

/* ---------------- 绘图 ---------------- */

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

function smoothstep(t) {
  return t * t * (3 - 2 * t)
}

function paint(width, height, { from, to, accent, angle = 0.55, blobs = [], vignette = 0.35, grain = 5 }) {
  const c1 = hex(from)
  const c2 = hex(to)
  const ca = hex(accent)
  const buf = Buffer.allocUnsafe(width * height * 4)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const diag = Math.hypot(width, height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = smoothstep(Math.min(1, Math.max(0, ((x * cos + y * sin) / diag) * 0.5 + 0.5)))
      let r = c1[0] + (c2[0] - c1[0]) * t
      let g = c1[1] + (c2[1] - c1[1]) * t
      let b = c1[2] + (c2[2] - c1[2]) * t

      for (const blob of blobs) {
        const dx = (x - blob.x * width) / (blob.r * width)
        const dy = (y - blob.y * height) / (blob.r * height)
        const d = Math.sqrt(dx * dx + dy * dy)
        const k = Math.max(0, 1 - d)
        const w = smoothstep(k) * (blob.a ?? 0.5)
        r += (ca[0] - r) * w
        g += (ca[1] - g) * w
        b += (ca[2] - b) * w
      }

      const nx = (x / width - 0.5) * 2
      const ny = (y / height - 0.5) * 2
      const v = 1 - vignette * Math.min(1, (nx * nx + ny * ny) * 0.55)
      const n = grain ? ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * grain : 0

      const i = (y * width + x) * 4
      buf[i] = Math.max(0, Math.min(255, r * v + n))
      buf[i + 1] = Math.max(0, Math.min(255, g * v + n))
      buf[i + 2] = Math.max(0, Math.min(255, b * v + n))
      buf[i + 3] = 255
    }
  }
  return buf
}

/* ---------------- EXIF 构造 ---------------- */

const T_ASCII = 2
const T_SHORT = 3
const T_LONG = 4
const T_RATIONAL = 5

function asciiValue(str) {
  const b = Buffer.from(`${str}\u0000`, 'latin1')
  return { type: T_ASCII, count: b.length, data: b, size: b.length }
}
function shortValue(...nums) {
  const b = Buffer.alloc(nums.length * 2)
  nums.forEach((n, i) => b.writeUInt16LE(n, i * 2))
  return { type: T_SHORT, count: nums.length, data: b, size: b.length }
}
function longValue(...nums) {
  const b = Buffer.alloc(nums.length * 4)
  nums.forEach((n, i) => b.writeUInt32LE(n, i * 4))
  return { type: T_LONG, count: nums.length, data: b, size: b.length }
}
function rationalValue(pairs) {
  const b = Buffer.alloc(pairs.length * 8)
  pairs.forEach(([a, d], i) => {
    b.writeUInt32LE(a, i * 8)
    b.writeUInt32LE(d, i * 8 + 4)
  })
  return { type: T_RATIONAL, count: pairs.length, data: b, size: b.length }
}

/** 生成 EXIF APP1 段（含 IFD0 + ExifIFD，子数据外置） */
function buildExifApp1(ifd0Entries, exifEntries) {
  const EXIF_POINTER = 0x8769
  const ifd0 = [...ifd0Entries, { tag: EXIF_POINTER, value: { pointer: 'exif' } }]
  const sortFn = (a, b) => a.tag - b.tag
  ifd0.sort(sortFn)
  exifEntries.sort(sortFn)

  const ifd0Size = 2 + ifd0.length * 12 + 4
  const exifSize = 2 + exifEntries.length * 12 + 4
  const ifd0Offset = 8
  const exifOffset = ifd0Offset + ifd0Size
  let dataCursor = exifOffset + exifSize

  const layout = (entries, base) => {
    let cursor = dataCursor
    const placed = entries.map((entry) => {
      const value = entry.value
      if (value.pointer) {
        return { tag: entry.tag, type: T_LONG, count: 1, data: null, inline: exifOffset, size: 4 }
      }
      if (value.size <= 4) {
        return { tag: entry.tag, type: value.type, count: value.count, data: value.data, inline: null, size: value.size }
      }
      const at = cursor
      cursor += value.size + (value.size % 2)
      return { tag: entry.tag, type: value.type, count: value.count, data: value.data, offset: at, size: value.size }
    })
    dataCursor = cursor
    return { placed, base }
  }

  const l0 = layout(ifd0, ifd0Offset)
  const l1 = layout(exifEntries, exifOffset)
  const total = dataCursor

  const buf = Buffer.alloc(total)
  buf.write('II', 0, 'latin1')
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(ifd0Offset, 4)

  const writeIfd = (placed, base, next) => {
    buf.writeUInt16LE(placed.length, base)
    placed.forEach((entry, i) => {
      const at = base + 2 + i * 12
      buf.writeUInt16LE(entry.tag, at)
      buf.writeUInt16LE(entry.type, at + 2)
      buf.writeUInt32LE(entry.count, at + 4)
      if (entry.inline !== null && entry.inline !== undefined) {
        buf.writeUInt32LE(entry.inline, at + 8)
      } else if (entry.data && entry.size <= 4) {
        entry.data.copy(buf, at + 8)
      } else {
        buf.writeUInt32LE(entry.offset, at + 8)
        entry.data.copy(buf, entry.offset)
      }
    })
    buf.writeUInt32LE(next || 0, base + 2 + placed.length * 12)
  }

  writeIfd(l0.placed, ifd0Offset, 0)
  writeIfd(l1.placed, exifOffset, 0)

  const payload = Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), buf])
  const head = Buffer.alloc(4)
  head[0] = 0xff
  head[1] = 0xe1
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

function cameraExif(orientation, meta = {}) {
  const ifd0 = [
    { tag: 0x010f, value: asciiValue(meta.make || 'SONY') },
    { tag: 0x0110, value: asciiValue(meta.model || 'ILCE-7M4') },
    { tag: 0x0112, value: shortValue(orientation) },
    { tag: 0x0131, value: asciiValue('PicSelect Fixture') },
    { tag: 0x0132, value: asciiValue(meta.date || '2026:05:18 16:42:07') }
  ]
  const exif = [
    { tag: 0x829a, value: rationalValue([[meta.exposureNum || 1, meta.exposureDen || 250]]) },
    { tag: 0x829d, value: rationalValue([[Math.round((meta.fNumber || 2.8) * 10), 10]]) },
    { tag: 0x8827, value: shortValue(meta.iso || 400) },
    { tag: 0x9003, value: asciiValue(meta.date || '2026:05:18 16:42:07') },
    { tag: 0x920a, value: rationalValue([[meta.focal || 35, 1]]) },
    { tag: 0x9204, value: rationalValue([[0, 1]]) },
    { tag: 0xa434, value: asciiValue(meta.lens || 'FE 35mm F1.8') }
  ]
  return buildExifApp1(ifd0, exif)
}

/** 把 APP1 插到 SOI 之后 */
function withExif(jpeg, app1) {
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

/* ---------------- TIFF 编码（自写，用于 deflate/packbits/16bit/灰度/CMYK） ---------------- */

const TIFF_TAGS = {
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
  plannerConfig: 0x011c,
  predictor: 0x013d,
  colorMap: 0x0140,
  extraSamples: 0x0152
}

function encodePackBits(input) {
  const out = []
  let i = 0
  while (i < input.length) {
    let run = 1
    while (i + run < input.length && input[i + run] === input[i] && run < 128) run++
    if (run >= 3) {
      out.push(256 - (run - 1), input[i])
      i += run
      continue
    }
    let literalStart = i
    let literalLen = 0
    while (i < input.length && literalLen < 128) {
      let r = 1
      while (i + r < input.length && input[i + r] === input[i] && r < 128) r++
      if (r >= 3) break
      i += 1
      literalLen += 1
    }
    out.push(literalLen - 1)
    for (let k = 0; k < literalLen; k++) out.push(input[literalStart + k])
  }
  return Buffer.from(out)
}

function applyPredictor2(data, rowBytes, samples) {
  const out = Buffer.from(data)
  for (let i = rowBytes - 1; i >= samples; i--) {
    out[i] = (out[i] - out[i - samples]) & 0xff
  }
  return out
}

/**
 * 写一个 8/16bit 条带式 TIFF（小端）。
 * @param {{width:number,height:number,channels:number,bits:number,pixels:Buffer,
 *          compression:'none'|'deflate'|'packbits',predictor:number,
 *          photometric:number,orientation?:number,rowsPerStrip?:number}} opts
 */
function encodeTiff(opts) {
  const {
    width, height, channels, bits = 8, pixels,
    compression = 'none', predictor = 1, photometric = 2,
    orientation = 1, rowsPerStrip = height
  } = opts

  const rowBytes = Math.ceil((width * channels * bits) / 8)

  // 1) 逐条带编码
  const strips = []
  for (let y = 0; y < height; y += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - y)
    let body = pixels.subarray(y * rowBytes, (y + rows) * rowBytes)
    if (predictor === 2 && bits === 8) {
      const encoded = Buffer.alloc(body.length)
      for (let r = 0; r < rows; r++) {
        const base = r * rowBytes
        for (let i = 0; i < rowBytes; i++) {
          encoded[base + i] = i < channels
            ? body[base + i]
            : (body[base + i] - body[base + i - channels]) & 0xff
        }
      }
      body = encoded
    }
    if (compression === 'deflate') body = zlib.deflateSync(body)
    else if (compression === 'packbits') body = encodePackBits(body)
    strips.push(Buffer.from(body))
  }

  const ushorts = (...values) => {
    const b = Buffer.alloc(values.length * 2)
    values.forEach((v, i) => b.writeUInt16LE(v, i * 2))
    return b
  }
  const ulongs = (values) => {
    const b = Buffer.alloc(values.length * 4)
    values.forEach((v, i) => b.writeUInt32LE(v, i * 4))
    return b
  }

  const entries = []
  entries.push({ tag: 0x0100, type: 4, count: 1, data: ulongs([width]) })
  entries.push({ tag: 0x0101, type: 4, count: 1, data: ulongs([height]) })
  entries.push({ tag: 0x0102, type: 3, count: channels, data: ushorts(...Array(channels).fill(bits)) })
  entries.push({
    tag: 0x0103,
    type: 3,
    count: 1,
    data: ushorts(compression === 'none' ? 1 : compression === 'deflate' ? 8 : 32773)
  })
  entries.push({ tag: 0x0106, type: 3, count: 1, data: ushorts(photometric) })
  entries.push({ tag: 0x0112, type: 3, count: 1, data: ushorts(orientation) })
  entries.push({ tag: 0x0115, type: 3, count: 1, data: ushorts(channels) })
  entries.push({ tag: 0x0116, type: 4, count: 1, data: ulongs([rowsPerStrip]) })
  if (predictor !== 1) entries.push({ tag: 0x013d, type: 3, count: 1, data: ushorts(predictor) })
  entries.push({ tag: 0x0111, type: 4, count: strips.length, data: ulongs(strips.map(() => 0)) })
  entries.push({ tag: 0x0117, type: 4, count: strips.length, data: ulongs(strips.map((s) => s.length)) })
  entries.sort((a, b) => a.tag - b.tag)

  // 2) 布局：IFD → 外置值 → 条带数据
  const ifdOffset = 8
  const ifdSize = 2 + entries.length * 12 + 4
  let cursor = ifdOffset + ifdSize
  for (const entry of entries) {
    if (entry.data.length > 4) {
      entry.offset = cursor
      cursor += entry.data.length + (entry.data.length % 2)
    }
  }
  const stripOffsets = []
  for (const strip of strips) {
    stripOffsets.push(cursor)
    cursor += strip.length + (strip.length % 2)
  }

  const offsetEntry = entries.find((e) => e.tag === 0x0111)
  offsetEntry.data = ulongs(stripOffsets)

  const total = cursor
  const buf = Buffer.alloc(total)
  buf.write('II', 0, 'latin1')
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(ifdOffset, 4)
  buf.writeUInt16LE(entries.length, ifdOffset)

  entries.forEach((entry, i) => {
    const at = ifdOffset + 2 + i * 12
    buf.writeUInt16LE(entry.tag, at)
    buf.writeUInt16LE(entry.type, at + 2)
    buf.writeUInt32LE(entry.count, at + 4)
    if (entry.data.length <= 4) {
      entry.data.copy(buf, at + 8)
    } else {
      buf.writeUInt32LE(entry.offset, at + 8)
      entry.data.copy(buf, entry.offset)
    }
  })
  buf.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12)

  strips.forEach((strip, i) => strip.copy(buf, stripOffsets[i]))

  return buf
}

/* ---------------- 合成 RAW ---------------- */

const LONG = 4
const SHORT = 3
const ASCII = 2

/**
 * 组装一个 TIFF 系 RAW。
 * previewIn 决定大预览的存放位置，覆盖三类真实布局：
 *   subifd — ARW/ORF：IFD0 → SubIFDs → JPEGInterchangeFormat
 *   ifd0   — NEF/CR2：IFD0 → JPEGInterchangeFormat
 *   strip  — DNG：IFD0 → StripOffsets + Compression=7
 * IFD1 始终放一张小缩略图，用于验证「选最大预览」的取舍。
 */
function buildRawTiff({ width, height, orientation = 1, make, model, thumbJpeg, previewJpeg, previewIn = 'subifd' }) {
  const headerSize = 8
  const ptr = (tag, ref) => ({ tag, type: LONG, count: 1, ref })

  const ifd0Entries = [
    { tag: 0x0100, type: LONG, count: 1, value: width },
    { tag: 0x0101, type: LONG, count: 1, value: height },
    { tag: 0x0103, type: SHORT, count: 1, value: previewIn === 'strip' ? 7 : 6 },
    { tag: 0x010f, type: ASCII, count: make.length + 1, value: Buffer.from(`${make}\u0000`, 'latin1') },
    { tag: 0x0110, type: ASCII, count: model.length + 1, value: Buffer.from(`${model}\u0000`, 'latin1') },
    { tag: 0x0112, type: SHORT, count: 1, value: orientation },
    { tag: 0x0115, type: SHORT, count: 1, value: 3 },
    { tag: 0x0116, type: LONG, count: 1, value: height }
  ]

  if (previewIn === 'ifd0') {
    ifd0Entries.push(ptr(0x0201, 'preview'), ptr(0x0202, 'previewLen'))
  } else if (previewIn === 'strip') {
    ifd0Entries.push(ptr(0x0111, 'preview'), ptr(0x0117, 'previewLen'))
  } else {
    ifd0Entries.push(ptr(0x014a, 'subifd'))
  }
  ifd0Entries.sort((a, b) => a.tag - b.tag)

  const ifd0Size = 2 + ifd0Entries.length * 12 + 4
  const ifd1Size = 2 + 5 * 12 + 4
  const subSize = 2 + 5 * 12 + 4
  const ifd1Offset = headerSize + ifd0Size
  const subIfdOffset = ifd1Offset + ifd1Size
  const dataStart = subIfdOffset + subSize

  // ASCII 外置 → 缩略图 → 大预览
  let cursor = dataStart
  const asciiLayout = new Map()
  for (const entry of ifd0Entries) {
    if (entry.type === ASCII && entry.value.length > 4) {
      asciiLayout.set(entry.tag, cursor)
      cursor += entry.value.length
    }
  }
  const thumbOffset = cursor
  cursor += thumbJpeg.length
  const previewOffset = cursor
  cursor += previewJpeg.length

  const refValue = (name) => ({
    thumb: thumbOffset,
    thumbLen: thumbJpeg.length,
    preview: previewOffset,
    previewLen: previewJpeg.length,
    subifd: subIfdOffset
  }[name] || 0)

  const buf = Buffer.alloc(cursor)
  buf.write('II', 0, 'latin1')
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(headerSize, 4)

  const writeEntry = (at, tag, type, count, value) => {
    buf.writeUInt16LE(tag, at)
    buf.writeUInt16LE(type, at + 2)
    buf.writeUInt32LE(count, at + 4)
    if (type === SHORT && count === 1) buf.writeUInt16LE(value, at + 8)
    else buf.writeUInt32LE(value, at + 8)
  }

  // IFD0
  buf.writeUInt16LE(ifd0Entries.length, headerSize)
  ifd0Entries.forEach((entry, i) => {
    const at = headerSize + 2 + i * 12
    let value = entry.value
    if (entry.ref) {
      writeEntry(at, entry.tag, LONG, 1, refValue(entry.ref))
      return
    }
    if (entry.type === ASCII) {
      if (entry.value.length > 4) {
        const offset = asciiLayout.get(entry.tag)
        entry.value.copy(buf, offset)
        value = offset
      } else {
        const copy = Buffer.alloc(4)
        entry.value.copy(copy)
        buf.writeUInt32LE(copy.readUInt32LE(0), at + 8)
        return
      }
    }
    writeEntry(at, entry.tag, entry.type, entry.count, value)
  })
  buf.writeUInt32LE(ifd1Offset, headerSize + 2 + ifd0Entries.length * 12)

  // IFD1：小缩略图（应被跳过）
  const ifd1 = [
    [0x0100, SHORT, 1, Math.round(width / 8)],
    [0x0101, SHORT, 1, Math.round(height / 8)],
    [0x0103, SHORT, 1, 6],
    [0x0201, LONG, 1, thumbOffset],
    [0x0202, LONG, 1, thumbJpeg.length]
  ]
  buf.writeUInt16LE(ifd1.length, ifd1Offset)
  ifd1.forEach((entry, i) => writeEntry(ifd1Offset + 2 + i * 12, entry[0], entry[1], entry[2], entry[3]))
  buf.writeUInt32LE(0, ifd1Offset + 2 + ifd1.length * 12)

  // SubIFD：大预览
  const sub = [
    [0x0100, LONG, 1, width],
    [0x0101, LONG, 1, height],
    [0x0103, SHORT, 1, 7],
    [0x0201, LONG, 1, previewOffset],
    [0x0202, LONG, 1, previewJpeg.length]
  ]
  buf.writeUInt16LE(sub.length, subIfdOffset)
  sub.forEach((entry, i) => writeEntry(subIfdOffset + 2 + i * 12, entry[0], entry[1], entry[2], entry[3]))
  buf.writeUInt32LE(0, subIfdOffset + 2 + sub.length * 12)

  thumbJpeg.copy(buf, thumbOffset)
  previewJpeg.copy(buf, previewOffset)

  return buf
}

/* ---------------- 图标 ---------------- */

function roundedRectAlpha(x, y, w, h, r) {
  const dx = Math.min(x, w - x)
  const dy = Math.min(y, h - y)
  const d = Math.hypot(Math.max(0, r - dx), Math.max(0, r - dy))
  return Math.max(0, Math.min(1, r - d + 0.5))
}

function drawIcon(size = 256, scale = 2) {
  const S = size * scale
  const buf = Buffer.alloc(S * S * 4)
  const radius = S * 0.235

  const set = (x, y, r, g, b, a) => {
    if (a <= 0) return
    const i = (y * S + x) * 4
    const old = buf[i + 3] / 255
    const na = a + old * (1 - a)
    if (na <= 0) return
    buf[i] = (r * a + buf[i] * old * (1 - a)) / na
    buf[i + 1] = (g * a + buf[i + 1] * old * (1 - a)) / na
    buf[i + 2] = (b * a + buf[i + 2] * old * (1 - a)) / na
    buf[i + 3] = na * 255
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const alpha = roundedRectAlpha(x + 0.5, y + 0.5, S, S, radius)
      if (alpha <= 0) continue
      const t = (x / S) * 0.35 + (y / S) * 0.65
      const r = 108 + (124 - 108) * t
      const g = 168 + (91 - 168) * t
      const b = 255 + (255 - 255) * t
      set(x, y, r, g, b, alpha)
    }
  }

  // 白色相框
  const frame = { x: S * 0.2, y: S * 0.235, w: S * 0.6, h: S * 0.53, r: S * 0.075 }
  for (let y = Math.floor(frame.y); y < frame.y + frame.h; y++) {
    for (let x = Math.floor(frame.x); x < frame.x + frame.w; x++) {
      const ax = x - frame.x
      const ay = y - frame.y
      const inner = ax > S * 0.035 && ax < frame.w - S * 0.035 && ay > S * 0.035 && ay < frame.h - S * 0.035
      if (inner) continue
      const a = roundedRectAlpha(ax, ay, frame.w, frame.h, frame.r) * 0.96
      set(x, y, 255, 255, 255, a)
    }
  }

  // 山峦
  const px = S * 0.2
  const py = S * 0.235
  const pw = S * 0.6
  const ph = S * 0.53
  const inTri = (x, y, ax, ay, bx, by, cx, cy) => {
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    const neg = d1 < 0 || d2 < 0 || d3 < 0
    const pos = d1 > 0 || d2 > 0 || d3 > 0
    return !(neg && pos)
  }

  for (let y = Math.floor(py); y < py + ph; y++) {
    for (let x = Math.floor(px); x < px + pw; x++) {
      const insideFrame = roundedRectAlpha(x - px, y - py, pw, ph, S * 0.075) > 0.5
      if (!insideFrame) continue

      if (inTri(x, y, px + pw * 0.18, py + ph * 0.78, px + pw * 0.44, py + ph * 0.36, px + pw * 0.7, py + ph * 0.78)) {
        set(x, y, 255, 255, 255, 0.95)
      } else if (inTri(x, y, px + pw * 0.46, py + ph * 0.78, px + pw * 0.66, py + ph * 0.5, px + pw * 0.86, py + ph * 0.78)) {
        set(x, y, 255, 255, 255, 0.72)
      }

      const sx = px + pw * 0.29
      const sy = py + ph * 0.26
      if (Math.hypot(x - sx, y - sy) < S * 0.038) set(x, y, 255, 255, 255, 0.95)
    }
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy2 = 0; sy2 < scale; sy2++) {
        for (let sx2 = 0; sx2 < scale; sx2++) {
          const i = ((y * scale + sy2) * S + (x * scale + sx2)) * 4
          const al = buf[i + 3] / 255
          r += buf[i] * al
          g += buf[i + 1] * al
          b += buf[i + 2] * al
          a += al
        }
      }
      const n = scale * scale
      const o = (y * size + x) * 4
      out[o] = a > 0 ? Math.round(r / a) : 0
      out[o + 1] = a > 0 ? Math.round(g / a) : 0
      out[o + 2] = a > 0 ? Math.round(b / a) : 0
      out[o + 3] = Math.round((a / n) * 255)
    }
  }
  return out
}

/* ---------------- 主流程 ---------------- */

const PALETTES = [
  { from: '#ff9a6b', to: '#f5487f', accent: '#ffd6a5', angle: 0.5 },
  { from: '#5ee7df', to: '#7a6bd1', accent: '#b8fff2', angle: 0.9 },
  { from: '#f6d365', to: '#fda085', accent: '#fff6d8', angle: 0.35 },
  { from: '#84fab0', to: '#8fd3f4', accent: '#e8fff5', angle: 0.7 },
  { from: '#a18cd1', to: '#fbc2eb', accent: '#efe6ff', angle: 0.45 },
  { from: '#20303d', to: '#0d1b24', accent: '#3d6b7a', angle: 0.8 },
  { from: '#ffecd2', to: '#e8a598', accent: '#fff8ee', angle: 0.6 },
  { from: '#4facfe', to: '#0b3d91', accent: '#8fe2ff', angle: 0.42 }
]

async function main() {
  await fsp.mkdir(FIXTURES, { recursive: true })
  await fsp.mkdir(ASSETS, { recursive: true })

  const sizes = [
    [1600, 1067], [1200, 1600], [1440, 1440], [1800, 1013],
    [1500, 1000], [1600, 900], [1280, 1600], [1920, 1080]
  ]

  const basePngs = []
  for (let i = 0; i < PALETTES.length; i++) {
    const [w, h] = sizes[i]
    const palette = PALETTES[i]
    const pixels = paint(w, h, {
      ...palette,
      blobs: [
        { x: 0.25 + (i % 3) * 0.2, y: 0.3, r: 0.4, a: 0.55 },
        { x: 0.75, y: 0.72 - (i % 2) * 0.25, r: 0.32, a: 0.4 }
      ]
    })
    const png = encodePng(w, h, pixels, 4)
    basePngs.push({ w, h, png, pixels, palette })
  }

  const written = []
  const save = async (name, data) => {
    await fsp.writeFile(path.join(FIXTURES, name), data)
    written.push(name)
  }

  // 主图：JPEG（带相机 EXIF）
  for (let i = 0; i < basePngs.length; i++) {
    const { png, w, h } = basePngs[i]
    const img = nativeImage.createFromBuffer(png)
    const jpeg = img.toJPEG(92)
    const app1 = cameraExif(1, {
      make: ['SONY', 'NIKON CORPORATION', 'Canon', 'FUJIFILM'][i % 4],
      model: ['ILCE-7M4', 'NIKON Z 6_2', 'Canon EOS R6', 'X-T5'][i % 4],
      lens: ['FE 35mm F1.8', 'NIKKOR Z 50mm f/1.8', 'RF 24-70mm F2.8', 'XF 23mm F1.4'][i % 4],
      date: `2026:0${(i % 9) + 1}:1${i % 9} 1${i % 9}:2${i % 9}:0${i % 9}`,
      fNumber: [1.8, 2.8, 4, 2][i % 4],
      iso: [100, 400, 800, 200][i % 4],
      exposureNum: 1,
      exposureDen: [125, 250, 500, 320][i % 3],
      focal: [35, 50, 24, 23][i % 4]
    })
    await save(`photo-${String(i + 1).padStart(2, '0')}.jpg`, withExif(jpeg, app1))
    if (i < 3) await save(`photo-${String(i + 1).padStart(2, '0')}.png`, png)
  }

  // 8 种方向
  const orientBase = basePngs[0]
  const orientJpeg = nativeImage.createFromBuffer(orientBase.png).toJPEG(90)
  for (let o = 1; o <= 8; o++) {
    await save(`orient-${o}.jpg`, withExif(orientJpeg, cameraExif(o, { make: 'SONY', model: 'ILCE-7M4' })))
  }

  // 各种 TIFF 编码
  const t = basePngs[3]
  const rgb = Buffer.alloc(t.w * t.h * 3)
  for (let i = 0, j = 0; i < t.pixels.length; i += 4, j += 3) {
    rgb[j] = t.pixels[i]
    rgb[j + 1] = t.pixels[i + 1]
    rgb[j + 2] = t.pixels[i + 2]
  }

  await save('tiff-deflate.tif', encodeTiff({
    width: t.w, height: t.h, channels: 3, pixels: rgb, compression: 'deflate',
    predictor: 2, rowsPerStrip: Math.ceil(t.h / 4)
  }))
  await save('tiff-packbits.tif', encodeTiff({
    width: t.w, height: t.h, channels: 3, pixels: rgb, compression: 'packbits',
    rowsPerStrip: Math.ceil(t.h / 3)
  }))
  await save('tiff-strips.tif', encodeTiff({
    width: t.w, height: t.h, channels: 3, pixels: rgb, compression: 'none',
    rowsPerStrip: 64
  }))

  // 16bit 灰度
  const gray16 = Buffer.alloc(t.w * t.h * 2)
  for (let i = 0, j = 0; i < t.pixels.length; i += 4, j += 2) {
    const v = Math.round((t.pixels[i] * 0.299 + t.pixels[i + 1] * 0.587 + t.pixels[i + 2] * 0.114) * 257)
    gray16.writeUInt16LE(v, j)
  }
  await save('tiff-16bit-gray.tif', encodeTiff({
    width: t.w, height: t.h, channels: 1, bits: 16, pixels: gray16, photometric: 1
  }))

  // CMYK
  const cmyk = Buffer.alloc(t.w * t.h * 4)
  for (let i = 0, j = 0; i < t.pixels.length; i += 4, j += 4) {
    const r = t.pixels[i] / 255
    const g = t.pixels[i + 1] / 255
    const b = t.pixels[i + 2] / 255
    const k = 1 - Math.max(r, g, b)
    cmyk[j] = k >= 1 ? 0 : Math.round((1 - r - k) / (1 - k) * 255)
    cmyk[j + 1] = k >= 1 ? 0 : Math.round((1 - g - k) / (1 - k) * 255)
    cmyk[j + 2] = k >= 1 ? 0 : Math.round((1 - b - k) / (1 - k) * 255)
    cmyk[j + 3] = Math.round(k * 255)
  }
  await save('tiff-cmyk.tif', encodeTiff({
    width: t.w, height: t.h, channels: 4, pixels: cmyk, photometric: 5
  }))

  // 带方向的 TIFF（像素层烘焙验证）
  await save('tiff-orient6.tif', encodeTiff({
    width: t.w, height: t.h, channels: 3, pixels: rgb, compression: 'deflate', orientation: 6
  }))

  // 合成 RAW
  const previewJpeg = orientJpeg
  const thumbImg = nativeImage.createFromBuffer(orientBase.png).resize({ width: 160 })
  const thumbJpeg = thumbImg.toJPEG(70)

  await save('fake-subifd.arw', buildRawTiff({
    width: t.w, height: t.h, orientation: 6, make: 'SONY', model: 'ILCE-7M4',
    thumbJpeg, previewJpeg, previewIn: 'subifd'
  }))
  await save('fake-ifd0.nef', buildRawTiff({
    width: t.w, height: t.h, orientation: 1, make: 'NIKON CORPORATION', model: 'NIKON Z 6_2',
    thumbJpeg, previewJpeg, previewIn: 'ifd0'
  }))
  await save('fake-cr2.cr2', buildRawTiff({
    width: t.w, height: t.h, orientation: 8, make: 'Canon', model: 'Canon EOS R6',
    thumbJpeg, previewJpeg, previewIn: 'strip'
  }))

  // 图标
  const icon = drawIcon(256, 2)
  await fsp.writeFile(path.join(ASSETS, 'icon.png'), encodePng(256, 256, icon, 4))

  console.log(`已生成 ${written.length} 个素材到 fixtures/`)
  console.log(written.join('  '))
}

app.whenReady().then(() => {
  main()
    .catch((err) => {
      console.error('生成素材失败:', err)
      process.exitCode = 1
    })
    .finally(() => app.quit())
})
