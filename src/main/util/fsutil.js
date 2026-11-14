'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 并发受限的 map：Windows 上无节制并发 stat 会 EMFILE/EBUSY */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, list.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++
      if (i >= list.length) return
      out[i] = await fn(list[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** 原子写：tmp + rename，Windows 上被杀软/索引占用时退避重试 */
async function writeFileAtomic(file, data, { retries = 3 } = {}) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, data)
  for (let i = 0; i <= retries; i++) {
    try {
      await fsp.rename(tmp, file)
      return true
    } catch (err) {
      if (i === retries) {
        try { await fsp.unlink(tmp) } catch {}
        throw err
      }
      await new Promise(r => setTimeout(r, 40 * Math.pow(2, i)))
    }
  }
  return false
}

async function writeJsonAtomic(file, obj) {
  return writeFileAtomic(file, JSON.stringify(obj))
}

/** 读文件的一段，用于只解析 IFD 头 */
function readSlice(file, offset, length) {
  return new Promise((resolve, reject) => {
    fs.open(file, 'r', (err, fd) => {
      if (err) return reject(err)
      const buf = Buffer.allocUnsafe(length)
      fs.read(fd, buf, 0, length, offset, (readErr, bytes) => {
        fs.close(fd, () => {})
        if (readErr) return reject(readErr)
        resolve(buf.subarray(0, bytes))
      })
    })
  })
}

async function fileSize(file) {
  const st = await fsp.stat(file)
  return st.size
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ])
}

/** 目录容量统计（缓存清理用） */
async function dirSize(dir) {
  let total = 0
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return { total, entries }
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    try {
      const st = await fsp.stat(path.join(dir, e.name))
      total += st.size
    } catch {}
  }
  return { total, entries }
}

module.exports = {
  mapLimit, ensureDir, readJson, writeFileAtomic, writeJsonAtomic,
  readSlice, fileSize, withTimeout, dirSize
}
