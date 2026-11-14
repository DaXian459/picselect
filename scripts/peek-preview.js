'use strict'
// 抽取指定 RAW 的内嵌 JPEG 预览到文件，用于与传感器解码结果做目视对照
const fs = require('node:fs')
const path = require('node:path')
const { ifdPreviewCandidates } = require('../src/main/raw/ifd-preview')
const { scanJpegCandidates } = require('../src/main/raw/jpeg-scan')

const file = process.argv[2]
const out = process.argv[3]
if (!file || !out) {
  console.error('用法: node scripts/peek-preview.js <raw文件> <输出jpg>')
  process.exit(1)
}

const buf = fs.readFileSync(file)
const cands = ifdPreviewCandidates(buf).concat(scanJpegCandidates(buf))
if (!cands.length) {
  console.error('未找到内嵌 JPEG')
  process.exit(2)
}
cands.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))
const best = cands[0]
const outBuf = Buffer.from(buf.subarray(best.offset, best.offset + best.length))
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, outBuf)
console.log(
  JSON.stringify(
    {
      file: path.basename(file),
      candidates: cands.length,
      picked: { width: best.width, height: best.height, bytes: best.length },
      saved: out
    },
    null,
    2
  )
)
