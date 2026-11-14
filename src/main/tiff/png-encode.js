'use strict'

const zlib = require('node:zlib')

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * 最小 PNG 编码器（filter 0 + zlib）。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} data RGB 或 RGBA 交错的像素
 * @param {3|4} channels
 */
function encodePng(width, height, data, channels = 4) {
  if (!width || !height) throw new Error('PNG 尺寸非法')
  const rowBytes = width * channels
  if (data.length < rowBytes * height) throw new Error('PNG 像素数据不足')

  const raw = Buffer.allocUnsafe((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const dst = y * (rowBytes + 1)
    raw[dst] = 0
    data.copy(raw, dst + 1, y * rowBytes, y * rowBytes + rowBytes)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8                       // bit depth
  ihdr[9] = channels === 4 ? 6 : 2  // color type: RGBA / RGB
  ihdr[10] = 0                      // compression
  ihdr[11] = 0                      // filter
  ihdr[12] = 0                      // interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
  return png
}

module.exports = { encodePng, crc32 }
