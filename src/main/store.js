'use strict'

const path = require('node:path')
const { readJson, writeJsonAtomic } = require('./util/fsutil')
const { normalizeKey } = require('./util/paths')

const DEFAULTS = {
  version: 1,
  photos: {},
  prefs: {
    lastDir: null,
    theme: 'system',
    thumbSize: 168,
    filter: 'all',
    sort: 'name',
    infoOpen: false,
    recent: []
  }
}

let filePath = null
let data = null
let saveTimer = null
let saving = Promise.resolve()

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

async function init(dir) {
  filePath = path.join(dir, 'library.json')
  const loaded = await readJson(filePath, null)
  data = cloneDefaults()
  if (loaded && typeof loaded === 'object') {
    data.photos = loaded.photos && typeof loaded.photos === 'object' ? loaded.photos : {}
    data.prefs = { ...DEFAULTS.prefs, ...(loaded.prefs || {}) }
    data.version = loaded.version || 1
  }
  return data
}

function normalizeMeta(raw) {
  const rating = Math.max(0, Math.min(5, Math.round(Number(raw && raw.rating) || 0)))
  const favorite = Boolean(raw && raw.favorite)
  const tags = Array.isArray(raw && raw.tags)
    ? [...new Set(raw.tags.filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean))].slice(0, 24)
    : []
  return { rating, favorite, tags }
}

function isEmptyMeta(m) {
  return !m.rating && !m.favorite && m.tags.length === 0
}

function getMeta(file) {
  const key = normalizeKey(file)
  const stored = data.photos[key]
  if (stored) return normalizeMeta(stored)
  return { rating: 0, favorite: false, tags: [] }
}

function getAllMeta() {
  const out = {}
  for (const [key, value] of Object.entries(data.photos)) {
    const m = normalizeMeta(value)
    if (!isEmptyMeta(m)) out[key] = m
  }
  return out
}

function setMeta(file, patch, extra = {}) {
  const key = normalizeKey(file)
  const current = normalizeMeta(data.photos[key] || {})
  const next = normalizeMeta({
    rating: patch && patch.rating !== undefined ? patch.rating : current.rating,
    favorite: patch && patch.favorite !== undefined ? patch.favorite : current.favorite,
    tags: patch && patch.tags !== undefined ? patch.tags : current.tags
  })
  if (isEmptyMeta(next)) delete data.photos[key]
  else data.photos[key] = { ...next, ...extra, updatedAt: Date.now() }
  scheduleSave()
  return next
}

function getPrefs() {
  return { ...data.prefs }
}

function setPrefs(patch) {
  data.prefs = { ...data.prefs, ...patch }
  scheduleSave()
  return getPrefs()
}

function pushRecent(dir) {
  const list = Array.isArray(data.prefs.recent) ? data.prefs.recent.filter(d => d !== dir) : []
  list.unshift(dir)
  data.prefs.recent = list.slice(0, 8)
  data.prefs.lastDir = dir
  scheduleSave()
  return getPrefs()
}

function scheduleSave() {
  if (!filePath) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeNow()
  }, 220)
}

function writeNow() {
  saving = saving.then(async () => {
    if (!filePath || !data) return
    try {
      await writeJsonAtomic(filePath, data)
    } catch (err) {
      console.error('[store] 保存失败:', err.message)
    }
  })
  return saving
}

async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    await writeNow()
  }
  await saving
}

module.exports = {
  init, getMeta, getAllMeta, setMeta, getPrefs, setPrefs, pushRecent, flush, normalizeMeta
}
