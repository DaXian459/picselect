'use strict'

/**
 * 解析器自检（普通 Node 运行，不依赖 Electron）：
 *   node scripts/test-parsers.js
 * 覆盖 EXIF 读取、方向注入、TIFF 解码、RAW 内嵌预览提取。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { readExifFromBuffer } = require('../src/main/exif/exif')
const { readOrientation, injectOrientation } = require('../src/main/exif/orientation')
const { decodeTiffBuffer } = require('../src/main/tiff/decode')
const { ifdPreviewCandidates } = require('../src/main/raw/ifd-preview')
const { scanJpegCandidates } = require('../src/main/raw/jpeg-scan')

const FIXTURES = path.resolve(__dirname, '..', 'fixtures')
const OUT = path.join(os.tmpdir(), 'picselect-test')
fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0

function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

function jpegSize(buf) {
  let off = 2
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null
    const marker = buf[off + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
    if (marker === 0xd9 || marker === 0xda) return null
    const len = buf.readUInt16BE(off + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) }
    }
    off += 2 + len
  }
  return null
}

console.log('\n== EXIF ==')
for (const name of ['photo-01.jpg', 'photo-03.jpg']) {
  const buf = fs.readFileSync(path.join(FIXTURES, name))
  const exif = readExifFromBuffer(buf)
  check(`${name} 解析出相机信息`, Boolean(exif && exif.model), JSON.stringify(exif))
  if (exif) {
    console.log(`    ${exif.make} ${exif.model} | ${exif.aperture} ${exif.exposure} ${exif.iso} ${exif.focal} | ${exif.date}`)
  }
}

console.log('\n== 方向 ==')
for (let o = 1; o <= 8; o++) {
  const buf = fs.readFileSync(path.join(FIXTURES, `orient-${o}.jpg`))
  const got = readOrientation(buf)
  check(`orient-${o}.jpg 读到方向 ${o}`, got === o, `实际 ${got}`)
}

// 无 EXIF 的 JPEG 应被注入方向
const plain = fs.readFileSync(path.join(FIXTURES, 'orient-1.jpg'))
const stripped = (() => {
  // 去掉 APP1
  let off = 2
  const parts = [plain.subarray(0, 2)]
  while (off + 4 < plain.length) {
    if (plain[off] !== 0xff) break
    const marker = plain[off + 1]
    const len = plain.readUInt16BE(off + 2)
    if (marker === 0xda) { parts.push(plain.subarray(off)); break }
    if (marker !== 0xe1) parts.push(plain.subarray(off, off + 2 + len))
    off += 2 + len
  }
  return Buffer.concat(parts)
})()
check('剥离 APP1 后无 EXIF', readOrientation(stripped) === 0)
const injected = injectOrientation(stripped, 6)
check('注入方向 6 成功', readOrientation(injected) === 6, `实际 ${readOrientation(injected)}`)
check('注入后仍是合法 JPEG', injected[0] === 0xff && injected[1] === 0xd8)

console.log('\n== TIFF ==')
const tiffCases = [
  ['tiff-strips.tif', 1800, 1013],
  ['tiff-deflate.tif', 1800, 1013],
  ['tiff-packbits.tif', 1800, 1013],
  ['tiff-16bit-gray.tif', 1800, 1013],
  ['tiff-cmyk.tif', 1800, 1013],
  ['tiff-orient6.tif', 1013, 1800]
]

for (const [name, w, h] of tiffCases) {
  const file = path.join(FIXTURES, name)
  const t0 = Date.now()
  try {
    const result = decodeTiffBuffer(fs.readFileSync(file))
    const ms = Date.now() - t0
    check(`${name} 解码成功 (${result.width}×${result.height}, ${result.kind}, ${ms}ms)`,
      result.kind === 'png' && result.width === w && result.height === h,
      `期望 ${w}×${h}`)
    if (result.kind === 'png') fs.writeFileSync(path.join(OUT, name.replace('.tif', '.png')), result.buffer)
  } catch (err) {
    check(`${name} 解码成功`, false, err.message)
  }
}

console.log('\n== RAW 预览 ==')
const rawCases = [
  ['fake-subifd.arw', 'subifd'],
  ['fake-ifd0.nef', 'ifd0'],
  ['fake-cr2.cr2', 'ifd0']
]

for (const [name, where] of rawCases) {
  const buf = fs.readFileSync(path.join(FIXTURES, name))
  const ifdCands = ifdPreviewCandidates(buf)
  const scanCands = scanJpegCandidates(buf)
  const best = [...ifdCands, ...scanCands].sort((a, b) => b.width * b.height - a.width * a.height)[0]
  check(`${name} IFD 候选 ${ifdCands.length} 个 / 扫描 ${scanCands.length} 个`, ifdCands.length > 0)
  check(`${name} 选中最大预览 ${best ? `${best.width}×${best.height}` : '无'}`,
    Boolean(best && best.width >= 1500), JSON.stringify(ifdCands.map(c => `${c.width}x${c.height}`)))

  if (best) {
    const slice = buf.subarray(best.offset, best.offset + best.length)
    const size = jpegSize(slice)
    check(`${name} 切片是完整 JPEG`, Boolean(size) && slice[0] === 0xff && slice[1] === 0xd8,
      size ? `${size.width}x${size.height}` : '无法解析')
    fs.writeFileSync(path.join(OUT, name.replace(/\.\w+$/, '-preview.jpg')), slice)

    const orientation = readOrientation(buf)
    const fixed = injectOrientation(slice, orientation)
    check(`${name} 预览方向 ${orientation}`, orientation >= 1 && orientation <= 8)
    if (readOrientation(slice) === 0 && orientation > 1) {
      check(`${name} 已注入方向`, readOrientation(fixed) === orientation)
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(`产物目录：${OUT}`)
process.exitCode = fail ? 1 : 0
