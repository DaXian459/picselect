'use strict'

const path = require('node:path')
const { app, protocol, Menu, nativeTheme, BrowserWindow } = require('electron')

const APP_ROOT = path.resolve(__dirname, '..', '..')

// 固定应用名，保证用户数据始终落在 %APPDATA%\PicSelect，
// 而不是随启动方式（electron . / electron scripts/xxx.js）漂移到 %APPDATA%\Electron。
app.setName('PicSelect')

// 便携版（portable.exe）会把自身解压到临时目录运行，并注入 PORTABLE_EXECUTABLE_DIR。
// 此时把数据放到 exe 同级，实现「拷走整个文件夹标记也跟着走」的绿色版行为。
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
if (portableDir) {
  try {
    app.setPath('userData', path.join(portableDir, 'PicSelectData'))
  } catch {
    // exe 放在只读位置（如 Program Files）时退回默认位置
  }
}

// 必须在 app ready 之前执行，且只能调用一次：
// standard 让页面获得正常 origin（localStorage / IndexedDB 可用），
// supportFetchAPI 让 renderer 能 fetch('app://...')。
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true
  }
}])

if (app.isReady()) {
  console.warn('[main] registerSchemesAsPrivileged 调用过晚，自定义协议可能失效')
}

const { createWindow } = require('./window')
const { registerAppProtocol } = require('./protocol')
const { registerIpc, broadcastTheme, broadcastOpen } = require('./ipc')
const store = require('./store')
const raw = require('./raw')

function parseArgs(argv) {
  const out = { dev: false }
  // 打包后 process.argv 是 [exe, ...args]，开发时是 [electron, '.', ...args]，
  // 起始下标差一位；写死 2 会导致打包版吞掉 --open 等参数。
  const start = process.defaultApp ? 2 : 1
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dev') out.dev = true
    else if (arg === '--open') out.open = argv[++i]
    else if (arg === '--select') out.select = argv[++i]
    else if (arg === '--scene') out.scene = argv[++i]
    else if (arg === '--theme') out.theme = argv[++i]
    else if (arg === '--size') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] || '')
      if (m) { out.width = Number(m[1]); out.height = Number(m[2]) }
    }
  }
  return out
}

const argv = parseArgs(process.argv)
let mainWindow = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argvOther) => {
    const other = parseArgs(argvOther)
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      if (other.open) broadcastOpen(other.open)
    }
  })

  app.whenReady().then(boot)
}

async function boot() {
  const userData = app.getPath('userData')
  await store.init(userData)
  raw.init(userData)

  const prefs = store.getPrefs()
  nativeTheme.themeSource = argv.theme || prefs.theme || 'system'

  Menu.setApplicationMenu(null)
  app.setAppUserModelId('com.picselect.app')

  registerAppProtocol(APP_ROOT)
  registerIpc()
  nativeTheme.on('updated', broadcastTheme)
  raw.pruneCache().catch(() => {})

  mainWindow = createWindow({
    open: argv.open,
    select: argv.select,
    scene: argv.scene,
    width: argv.width,
    height: argv.height,
    dev: argv.dev,
    quiet: argv.dev !== true
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow({ dev: argv.dev })
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  store.flush()
    .catch(() => {})
    .finally(() => app.quit())
})
