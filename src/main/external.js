'use strict'

/**
 * 外部程序：用 Photoshop / Lightroom 打开当前照片。
 *
 * Windows 上 Adobe 的安装路径没有稳定规律，探测走两条路：
 *   1) 扫 %ProgramFiles%\Adobe\Adobe <产品>* 目录（覆盖默认安装）
 *   2) 找不到时让用户手动指定 exe（非标准安装、绿色版）
 *
 * 早期版本还会查 HKLM\SOFTWARE\Adobe 注册表，但那样每次启动都要 spawn 一个
 * reg.exe —— 在限制型环境里会被拦（AV / 组策略），收益也很小，故去掉。
 *
 * 探测结果按会话缓存，手动指定过的路径优先（先校验存在性）。
 */

const path = require('node:path')
const fsp = require('node:fs/promises')
const { spawn } = require('node:child_process')
const store = require('./store')
const { isSupported } = require('./util/paths')

// 延迟引入 electron：让本模块能在纯 Node 下被测试（探测逻辑与窗口无关）
const electron = () => require('electron')

const KINDS = {
  photoshop: {
    label: 'Photoshop',
    dirPrefix: 'Adobe Photoshop',
    exe: ['Photoshop.exe']
  },
  lightroom: {
    label: 'Lightroom',
    dirPrefix: 'Adobe Lightroom',
    exe: ['Lightroom.exe', 'lightroom.exe']
  }
}

const PROGRAM_ROOTS = [
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
]

const cache = new Map()

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** 扫 Program Files 下的 Adobe 目录，按版本号倒序（新版优先） */
async function scannedDirs(spec, roots = PROGRAM_ROOTS) {
  const found = []
  for (const root of roots) {
    const adobe = path.join(root, 'Adobe')
    let entries = []
    try {
      entries = await fsp.readdir(adobe, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.toLowerCase().startsWith(spec.dirPrefix.toLowerCase())) continue
      found.push(path.join(adobe, entry.name))
    }
  }
  // "Adobe Photoshop 2026" > "Adobe Photoshop 2025"，直接按名字倒序够用
  return found.sort((a, b) => b.localeCompare(a))
}

/**
 * 在一组根目录里找可执行文件。
 * 抽出来是为了能被测试直接调用（真实环境不一定装了 Adobe）。
 */
async function findIn(roots, spec) {
  for (const dir of await scannedDirs(spec, roots)) {
    for (const exe of spec.exe) {
      const candidate = path.join(dir, exe)
      if (await exists(candidate)) return candidate
    }
  }
  return null
}

async function detectOne(kind) {
  const spec = KINDS[kind]
  if (!spec) return null

  const configured = (store.getPrefs().external || {})[kind]
  if (configured && await exists(configured)) {
    return { kind, label: spec.label, path: configured, source: 'manual' }
  }

  // 扫目录：不依赖外部进程，最快也最稳
  const scanned = await findIn(PROGRAM_ROOTS, spec)
  if (scanned) return { kind, label: spec.label, path: scanned, source: 'auto' }

  return { kind, label: spec.label, path: null, source: 'missing' }
}

async function detect(force = false) {
  if (force) cache.clear()
  const out = {}
  for (const kind of Object.keys(KINDS)) {
    if (cache.has(kind)) {
      out[kind] = cache.get(kind)
      continue
    }
    const result = await detectOne(kind)
    cache.set(kind, result)
    out[kind] = result
  }
  return out
}

function setPath(kind, exePath) {
  if (!KINDS[kind]) throw new Error('未知的程序')
  const external = { ...(store.getPrefs().external || {}), [kind]: exePath || null }
  store.setPrefs({ external })
  cache.delete(kind)
  return store.getPrefs().external
}

/** 弹窗让用户挑 exe；返回新路径或 null */
async function pick(kind, win) {
  const spec = KINDS[kind]
  if (!spec) throw new Error('未知的程序')
  const { dialog } = electron()
  const res = await dialog.showOpenDialog(win || null, {
    title: `选择 ${spec.label} 的可执行文件`,
    properties: ['openFile'],
    buttonLabel: '使用',
    filters: [{ name: '可执行文件', extensions: ['exe'] }]
  })
  if (res.canceled || !res.filePaths.length) return null
  const chosen = res.filePaths[0]
  setPath(kind, chosen)
  return { kind, label: spec.label, path: chosen, source: 'manual' }
}

/**
 * 打开文件。kind: photoshop | lightroom | default
 * 返回实际使用的程序信息，供界面提示。
 */
async function openWith(kind, file, win) {
  if (typeof file !== 'string' || !file) throw new Error('路径无效')
  if (!isSupported(file)) throw new Error('不是支持的图片格式')

  if (kind === 'default') {
    const err = await electron().shell.openPath(file)
    if (err) throw new Error(err)
    return { kind, label: '系统默认程序', path: null, source: 'shell' }
  }

  let app = (await detect())[kind]
  if (!app || !app.path) {
    // 没探到就让用户选一次，选完接着打开
    const { BrowserWindow } = electron()
    const picked = await pick(kind, win || BrowserWindow.getFocusedWindow())
    if (!picked) throw Object.assign(new Error(`未找到 ${KINDS[kind] ? KINDS[kind].label : kind}`), { code: 'CANCELED' })
    app = picked
  }

  const child = spawn(app.path, [path.resolve(file)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return app
}

module.exports = { detect, openWith, pick, setPath, findIn, KINDS, PROGRAM_ROOTS }
