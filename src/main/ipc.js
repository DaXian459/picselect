'use strict'

const path = require('node:path')
const fsp = require('node:fs/promises')
const { ipcMain, dialog, nativeTheme, shell, app, BrowserWindow } = require('electron')
const library = require('./library')
const store = require('./store')
const { readExif } = require('./exif/exif')
const { readDimensions } = require('./exif/dimensions')
const { mediaUrl, isSupported } = require('./util/paths')
const { applyThemeToWindow } = require('./window')

const exifCache = new Map()
const EXIF_CACHE_LIMIT = 1200

function decorate(state) {
  return {
    root: state.root,
    stats: state.stats,
    items: state.items.map(i => ({
      path: i.path,
      name: i.name,
      ext: i.ext,
      kind: i.kind,
      size: i.size,
      mtimeMs: i.mtimeMs,
      url: mediaUrl(i.path, i.mtimeMs)
    }))
  }
}

function assertAllowed(file) {
  if (typeof file !== 'string' || !library.isAllowed(file)) {
    throw new Error('路径不在当前目录内')
  }
  return path.resolve(file)
}

async function openDirectory(dir) {
  const state = await library.scan(dir)
  store.pushRecent(state.root)
  return decorate(state)
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData: app.getPath('userData')
  }))

  ipcMain.handle('dialog:openFolder', async (event, payload = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const prefs = store.getPrefs()
    const res = await dialog.showOpenDialog(win, {
      title: '选择照片文件夹',
      defaultPath: payload.defaultPath || prefs.lastDir || app.getPath('pictures'),
      properties: ['openDirectory'],
      buttonLabel: '打开'
    })
    if (res.canceled || !res.filePaths.length) return null
    return openDirectory(res.filePaths[0])
  })

  ipcMain.handle('lib:open', async (_event, payload = {}) => {
    const dir = payload.dir || store.getPrefs().lastDir
    if (!dir) return null
    try {
      return await openDirectory(dir)
    } catch (err) {
      throw new Error(`无法读取目录：${err.message}`)
    }
  })

  ipcMain.handle('lib:rescan', async () => {
    const root = library.getRoot()
    if (!root) return null
    return openDirectory(root)
  })

  ipcMain.handle('lib:openPath', async (_event, payload = {}) => {
    const target = payload.path
    if (typeof target !== 'string' || !target) throw new Error('路径无效')
    let dir = target
    let focus = null
    try {
      const st = await fsp.stat(target)
      if (st.isFile()) {
        if (!isSupported(target)) throw new Error('不是支持的图片格式')
        dir = path.dirname(target)
        focus = path.resolve(target)
      }
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('路径不存在')
      throw err
    }
    const state = await openDirectory(dir)
    return { ...state, focus }
  })

  ipcMain.handle('lib:allMeta', () => store.getAllMeta())

  ipcMain.handle('meta:set', (_event, payload = {}) => {
    const file = assertAllowed(payload.path)
    return store.setMeta(file, payload.patch || {}, { name: path.basename(file) })
  })

  ipcMain.handle('prefs:get', () => store.getPrefs())
  ipcMain.handle('prefs:set', (_event, patch = {}) => store.setPrefs(patch || {}))

  ipcMain.handle('exif:get', async (_event, payload = {}) => {
    const file = assertAllowed(payload.path)
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      return null
    }
    const key = `${file}|${stat.mtimeMs}|${stat.size}`
    const hit = exifCache.get(key)
    if (hit) return hit

    const exif = await readExif(file, stat.size)

    // 没有 EXIF 的格式：从文件头补出像素尺寸
    let dims = null
    if (!exif || !exif.width || !exif.height) {
      try {
        const head = await fsp.open(file, 'r')
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024)
          const { bytesRead } = await head.read(buffer, 0, buffer.length, 0)
          dims = readDimensions(buffer.subarray(0, bytesRead), path.extname(file).toLowerCase())
        } finally {
          await head.close()
        }
      } catch {}
    }

    const result = {
      exif: exif || (dims ? { width: dims.width, height: dims.height, orientation: 1 } : null),
      dims,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      name: path.basename(file),
      ext: path.extname(file).toLowerCase(),
      dir: path.dirname(file)
    }
    if (exifCache.size > EXIF_CACHE_LIMIT) {
      const first = exifCache.keys().next().value
      if (first) exifCache.delete(first)
    }
    exifCache.set(key, result)
    return result
  })

  ipcMain.handle('img:url', (_event, payload = {}) => {
    if (typeof payload.path !== 'string') throw new Error('路径无效')
    return mediaUrl(payload.path, payload.mtimeMs)
  })

  ipcMain.handle('theme:get', () => ({
    mode: nativeTheme.themeSource,
    dark: nativeTheme.shouldUseDarkColors
  }))

  ipcMain.handle('theme:set', (_event, payload = {}) => {
    const mode = ['system', 'light', 'dark'].includes(payload.mode) ? payload.mode : 'system'
    nativeTheme.themeSource = mode
    store.setPrefs({ theme: mode })
    for (const win of BrowserWindow.getAllWindows()) applyThemeToWindow(win)
    broadcastTheme()
    return { mode, dark: nativeTheme.shouldUseDarkColors }
  })

  ipcMain.handle('shell:reveal', (_event, payload = {}) => {
    const file = assertAllowed(payload.path)
    shell.showItemInFolder(file)
    return true
  })

  ipcMain.handle('win:fullscreen', (event, payload = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const next = typeof payload.value === 'boolean' ? payload.value : !win.isFullScreen()
    win.setFullScreen(next)
    return next
  })
}

function broadcastTheme() {
  const payload = { dark: nativeTheme.shouldUseDarkColors, mode: nativeTheme.themeSource }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('theme:updated', payload)
  }
}

function broadcastToast(level, message) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('toast', { level, message })
  }
}

function broadcastOpen(dir) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('lib:changed', { dir })
  }
}

module.exports = { registerIpc, broadcastTheme, broadcastToast, broadcastOpen }
