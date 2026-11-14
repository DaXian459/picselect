'use strict'

/**
 * TIFF 变体 LZW 解码（MSB-first 位打包 + early change）。
 * 与标准 GIF LZW 的差别：码宽在 nextCode === (1<<width)-1 时提前增长。
 */
function decodeLzw(input, expectedLength) {
  const out = Buffer.allocUnsafe(Math.max(expectedLength, 1))
  let outPos = 0
  let bytePos = 0
  let bitBuffer = 0
  let bitCount = 0
  let codeWidth = 9
  let nextCode = 258
  let dict = []

  const resetDict = () => {
    dict = new Array(258)
    for (let i = 0; i < 256; i++) dict[i] = Buffer.from([i])
    nextCode = 258
    codeWidth = 9
  }

  const readCode = () => {
    while (bitCount < codeWidth) {
      if (bytePos >= input.length) return -1
      bitBuffer = ((bitBuffer << 8) | input[bytePos++]) & 0xffffffff
      bitCount += 8
    }
    const shift = bitCount - codeWidth
    const code = (bitBuffer >>> shift) & ((1 << codeWidth) - 1)
    bitCount -= codeWidth
    bitBuffer &= (1 << bitCount) - 1
    return code
  }

  resetDict()
  let prev = null

  for (;;) {
    const code = readCode()
    if (code < 0 || code === 257) break
    if (code === 256) {
      resetDict()
      prev = null
      continue
    }

    let entry
    if (code < nextCode && dict[code]) {
      entry = dict[code]
    } else if (code === nextCode && prev) {
      entry = Buffer.concat([prev, prev.subarray(0, 1)])
    } else {
      break
    }

    if (outPos + entry.length > out.length) break
    entry.copy(out, outPos)
    outPos += entry.length

    if (prev && nextCode < 4096) {
      dict[nextCode++] = Buffer.concat([prev, entry.subarray(0, 1)])
    }
    prev = entry

    if (nextCode === (1 << codeWidth) - 1 && codeWidth < 12) codeWidth++

    if (outPos >= expectedLength) break
  }

  return out.subarray(0, outPos)
}

module.exports = { decodeLzw }
