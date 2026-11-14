'use strict'

const path = require('node:path')
const { BrowserWindow, nativeTheme, shell } = require('electron')

const APP_ROOT = path.resolve(__dirname, '..', '..')
const TITLEBAR_HEIGHT = 40

const THEME_COLORS = {
  dark: { bg: '#0d0f12', symbol: '#e6e9ef' },
  light: { bg: '#f7f8fa', symbol: '#171a1f' }
}

function currentColors() {
  return nativeTheme.shouldUseDarkColors ? THEME_COLORS.dark : THEME_COLORS.light
}

function applyThemeToWindow(win) {
  if (!win || win.isDestroyed()) return
  const c = currentColors()
  try {
    win.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: TITLEBAR_HEIGHT })
  } catch {}
  try {
    win.setBackgroundColor(c.bg)
  } catch {}
}

function buildUrl(params = {}) {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    query.set(k, String(v))
  }
  const qs = query.toString()
  return `app://picselect/index.html${qs ? `?${qs}` : ''}`
}

function createWindow(opts = {}) {
  const c = currentColors()

  const win = new BrowserWindow({
    width: opts.width || 1360,
    height: opts.height || 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: c.bg,
    title: 'PicSelect',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.symbol, height: TITLEBAR_HEIGHT },
    autoHideMenuBar: true,
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true
    }
  })

  win.setMenuBarVisibility(false)

  const quiet = opts.quiet === true
  win.webContents.on('console-message', (...args) => {
    if (quiet) return
    const detail = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null
    const message = detail ? detail.message : args[2]
    const level = detail ? detail.level : args[1]
    const source = detail ? `${detail.sourceId}:${detail.lineNumber}` : `${args[4]}:${args[3]}`
    console.log(`[renderer:${level}] ${message} (${source})`)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 渲染进程退出:', details.reason)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://picselect/')) event.preventDefault()
  })

  win.loadURL(buildUrl({
    open: opts.open,
    select: opts.select,
    scene: opts.scene,
    theme: opts.theme
  }))

  win.once('ready-to-show', () => {
    win.show()
    if (opts.dev) win.webContents.openDevTools({ mode: 'detach' })
  })

  return win
}

module.exports = {
  createWindow,
  applyThemeToWindow,
  buildUrl,
  APP_ROOT,
  TITLEBAR_HEIGHT,
  THEME_COLORS
}
