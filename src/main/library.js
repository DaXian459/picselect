'use strict'

const fsp = require('node:fs/promises')
const path = require('node:path')
const { extOf, isSupported, isUnsupported, kindOf, normalizeKey } = require('./util/paths')
const { mapLimit } = require('./util/fsutil')

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

let root = null
let items = []
let allowed = new Set()
let lastStats = { total: 0, unsupported: 0, ms: 0 }

/**
 * 扫描单个目录（非递归）。
 * stat 必须做（Dirent 不含 size/mtime），并发限制 24 避免 Windows 上 EMFILE/EBUSY。
 */
async function scan(dir) {
  const t0 = Date.now()
  const resolved = path.resolve(dir)
  const dirents = await fsp.readdir(resolved, { withFileTypes: true })

  const names = []
  let unsupported = 0
  for (const d of dirents) {
    if (!d.isFile()) continue
    const lower = d.name.toLowerCase()
    if (IGNORED_NAMES.has(lower) || d.name.startsWith('.')) continue
    if (isUnsupported(d.name)) { unsupported++; continue }
    if (!isSupported(d.name)) continue
    names.push(d.name)
  }

  const scanned = await mapLimit(names, 24, async (name) => {
    const full = path.join(resolved, name)
    try {
      const st = await fsp.stat(full)
      return {
        path: full,
        name,
        ext: extOf(name),
        kind: kindOf(name),
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs)
      }
    } catch {
      return null
    }
  })

  items = scanned.filter(Boolean).sort((a, b) => collator.compare(a.name, b.name))
  root = resolved
  allowed = new Set(items.map(i => normalizeKey(i.path)))
  lastStats = { total: items.length, unsupported, ms: Date.now() - t0 }

  return getState()
}

function getState() {
  return { root, items, stats: lastStats }
}

function getItems() {
  return items
}

function getRoot() {
  return root
}

function isAllowed(file) {
  if (typeof file !== 'string' || !file) return false
  return allowed.has(normalizeKey(file))
}

function indexOf(file) {
  const key = normalizeKey(file)
  return items.findIndex(i => normalizeKey(i.path) === key)
}

module.exports = { scan, getState, getItems, getRoot, isAllowed, indexOf }
