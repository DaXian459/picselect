'use strict'

/**
 * RAW 结构探针：把 ARW/NEF/CR2 里「真正的图像 IFD」dump 出来，
 * 用来看压缩方式、位深、CFA 排列、黑白电平、白平衡系数。
 *   node scripts/probe-raw.js raw/DSC01835.ARW
 */

const fs = require('node:fs')
const path = require('node:path')
const { parseHeader, readIfd, num, readNumbers } = require('../src/main/exif/tiff-ifd')

const NAMES = {
  0x0100: 'ImageWidth',
  0x0101: 'ImageLength',
  0x0102: 'BitsPerSample',
  0x0103: 'Compression',
  0x0106: 'PhotometricInterpretation',
  0x010F: 'Make',
  0x0110: 'Model',
  0x0111: 'StripOffsets',
  0x0115: 'SamplesPerPixel',
  0x0116: 'RowsPerStrip',
  0x0117: 'StripByteCounts',
  0x011c: 'PlanarConfiguration',
  0x0131: 'Software',
  0x014a: 'SubIFDs',
  0x828d: 'CFARepeatPatternDim',
  0x828e: 'CFAPattern',
  0x828f: 'BatteryLevel',
  0x8827: 'ISOSpeedRatings',
  0x9207: 'MeteringMode',
  0x927c: 'MakerNote',
  0xc612: 'DNGVersion',
  0xc614: 'UniqueCameraModel',
  0xc61a: 'BlackLevel',
  0xc61d: 'WhiteLevel',
  0xc61f: 'DefaultCropOrigin',
  0xc620: 'DefaultCropSize',
  0xc621: 'ColorMatrix1',
  0xc628: 'AsShotNeutral',
  0xc65a: 'CalibrationIlluminant1',
  0xc68d: 'ActiveArea',
  0x7310: 'BlackLevelRepeatDim',
  0x7313: 'WhiteLevel2',
  0x74c7: 'SonyRawImageSize',
  0x74c8: 'SonyCropSize',
  0x9400: 'Temperature',
  0x9401: 'Exposure2012',
  0x7010: 'SonyRawFileType'
}

function dumpIfd(buf, base, offset, le, label) {
  const ifd = readIfd(buf, base, offset, le)
  if (!ifd) {
    console.log(`\n[${label}] offset=${offset} 读取失败`)
    return null
  }
  console.log(`\n[${label}] offset=${offset}  条目 ${ifd.tags.size}`)
  const rows = []
  for (const [tag, entry] of ifd.tags) {
    const name = NAMES[tag] || '0x' + tag.toString(16)
    let value = ''
    if (entry.count <= 8 && ![0x927c].includes(tag)) {
      try {
        const nums = readNumbers(buf, entry, le)
        value = nums.length > 1 ? nums.join(', ') : String(num(buf, entry, le))
      } catch {
        value = `<type ${entry.type} count ${entry.count}>`
      }
    } else {
      value = `<${entry.count} 项, type ${entry.type}>`
    }
    rows.push({ tag, name, value })
  }
  for (const r of rows.sort((a, b) => a.tag - b.tag)) {
    console.log(`  ${String(r.tag).padStart(5)} ${r.name.padEnd(26)} ${r.value}`)
  }
  return ifd
}

function main() {
  const file = path.resolve(process.argv[2] || 'raw/DSC01835.ARW')
  const buf = fs.readFileSync(file)
  const header = parseHeader(buf)
  console.log(`文件 ${path.basename(file)}  ${(buf.length / 1048576).toFixed(1)} MB  ${header.le ? '小端' : '大端'}`)
  console.log(`IFD0 @ ${header.ifd0Offset}`)

  const ifd0 = dumpIfd(buf, 0, header.ifd0Offset, header.le, 'IFD0')

  const sub = ifd0 && ifd0.tags.get(0x014a)
  if (sub) {
    const offsets = readNumbers(buf, sub, header.le)
    console.log(`\nSubIFDs: ${offsets.join(', ')}`)
    for (const off of offsets) {
      dumpIfd(buf, 0, off, header.le, `SubIFD@${off}`)
    }
  }

  // IFD1（通常是缩略图）
  const next = ifd0 ? ifd0.next : 0
  if (next) dumpIfd(buf, 0, next, header.le, `IFD1@${next}`)
}

main()
