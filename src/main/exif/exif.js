'use strict'

const fsp = require('node:fs/promises')
const { readStructure, readNumbers, readString, num } = require('./tiff-ifd')
const { findExifTiffOffset } = require('./orientation')
const T = require('./tags')

const HEAD_BYTES = 4 * 1024 * 1024
const FULL_READ_LIMIT = 64 * 1024 * 1024

const IFD0_TAGS = {
  make: 0x010f,
  model: 0x0110,
  software: 0x0131,
  orientation: 0x0112,
  width: 0x0100,
  height: 0x0101
}

const EXIF_TAGS = {
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  dateTimeOriginal: 0x9003,
  dateTimeDigitized: 0x9004,
  focalLength: 0x920a,
  lensModel: 0xa434,
  focalLength35: 0xa405,
  pixelX: 0xa002,
  pixelY: 0xa003,
  exposureBias: 0x9204
}

function pickString(buf, ifd, tag) {
  if (!ifd) return null
  return readString(buf, ifd.get(tag))
}

function pickNumber(buf, ifd, le, tag) {
  if (!ifd) return null
  return num(buf, ifd.get(tag), le)
}

/** 从一段缓冲区解析 EXIF（支持 JPEG 的 APP1 与 TIFF/RAW 直接以 TIFF 头开头） */
function readExifFromBuffer(buf) {
  let base = 0
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    base = findExifTiffOffset(buf)
    if (base < 0) return null
  }
  const struct = readStructure(buf, base)
  if (!struct) return null
  const { le, ifd0, exif } = struct

  const make = pickString(buf, ifd0, IFD0_TAGS.make)
  const model = pickString(buf, ifd0, IFD0_TAGS.model)
  const software = pickString(buf, ifd0, IFD0_TAGS.software)
  const orientation = pickNumber(buf, ifd0, le, IFD0_TAGS.orientation) || 1

  const exposureRaw = pickNumber(buf, exif, le, EXIF_TAGS.exposureTime)
  const fNumberRaw = pickNumber(buf, exif, le, EXIF_TAGS.fNumber)
  const isoRaw = pickNumber(buf, exif, le, EXIF_TAGS.iso)
  const focalRaw = pickNumber(buf, exif, le, EXIF_TAGS.focalLength)
  const focal35 = pickNumber(buf, exif, le, EXIF_TAGS.focalLength35)
  const dateRaw = pickString(buf, exif, EXIF_TAGS.dateTimeOriginal) ||
    pickString(buf, exif, EXIF_TAGS.dateTimeDigitized)

  const width = pickNumber(buf, exif, le, EXIF_TAGS.pixelX) || pickNumber(buf, ifd0, le, IFD0_TAGS.width)
  const height = pickNumber(buf, exif, le, EXIF_TAGS.pixelY) || pickNumber(buf, ifd0, le, IFD0_TAGS.height)

  // RAW 的 IFD0 通常是原始分辨率，取其宽高更准确
  let rawWidth = pickNumber(buf, ifd0, le, IFD0_TAGS.width)
  let rawHeight = pickNumber(buf, ifd0, le, IFD0_TAGS.height)
  if (struct.subIfds && struct.subIfds.length) {
    for (const sub of struct.subIfds) {
      const w = pickNumber(buf, sub, le, IFD0_TAGS.width)
      const h = pickNumber(buf, sub, le, IFD0_TAGS.height)
      if (w && h && w * h > (rawWidth || 0) * (rawHeight || 0)) { rawWidth = w; rawHeight = h }
    }
  }

  const hasAny = Boolean(make || model || exposureRaw || dateRaw || orientation > 1)
  if (!hasAny) return null

  return {
    make,
    model,
    lens: pickString(buf, exif, EXIF_TAGS.lensModel),
    software,
    date: T.formatDate(dateRaw),
    exposure: T.formatExposure(exposureRaw),
    aperture: T.formatAperture(fNumberRaw),
    iso: T.formatIso(isoRaw),
    focal: T.formatFocal(focalRaw),
    focal35: focal35 ? `${Math.round(focal35)} mm` : null,
    exposureBias: pickNumber(buf, exif, le, EXIF_TAGS.exposureBias),
    orientation,
    orientationLabel: T.ORIENTATION_LABEL[orientation] || null,
    width: width || rawWidth || null,
    height: height || rawHeight || null
  }
}

async function readExif(file, size) {
  let buf
  try {
    if (size && size > FULL_READ_LIMIT) {
      const fd = await fsp.open(file, 'r')
      try {
        const b = Buffer.allocUnsafe(HEAD_BYTES)
        const { bytesRead } = await fd.read(b, 0, HEAD_BYTES, 0)
        buf = b.subarray(0, bytesRead)
      } finally {
        await fd.close()
      }
    } else {
      buf = await fsp.readFile(file)
    }
  } catch {
    return null
  }
  try {
    return readExifFromBuffer(buf)
  } catch {
    return null
  }
}

module.exports = { readExif, readExifFromBuffer }
