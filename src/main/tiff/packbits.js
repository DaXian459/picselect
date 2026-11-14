'use strict'

/** PackBits (TIFF 32773) 解压 */
function decodePackBits(input, expectedLength) {
  const out = Buffer.allocUnsafe(Math.max(expectedLength, 1))
  let op = 0
  let i = 0
  while (i < input.length && op < expectedLength) {
    let n = input[i++]
    n = n > 127 ? n - 256 : n
    if (n >= 0) {
      const count = n + 1
      for (let k = 0; k < count && i < input.length && op < expectedLength; k++) {
        out[op++] = input[i++]
      }
    } else if (n !== -128) {
      const count = 1 - n
      if (i >= input.length) break
      const b = input[i++]
      for (let k = 0; k < count && op < expectedLength; k++) out[op++] = b
    }
  }
  return out.subarray(0, op)
}

module.exports = { decodePackBits }
