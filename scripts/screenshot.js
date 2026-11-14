'use strict'

/**
 * 截图验证（在 Electron 下运行）
 *   npx electron scripts/screenshot.js --out shots/grid-dark.png --scene grid --theme dark --size 1440x900 --open fixtures
 *   --scene: grid | viewer | info | favorite | empty
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, protocol, nativeTheme } = require('electron')

// 与 main.js 保持一致，避免截图产物写到 %APPDATA%\Electron
app.setName('PicSelect')

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
}])

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const hasFlag = (name) => argv.includes(`--${name}`)

if (hasFlag('no-gpu')) app.disableHardwareAcceleration()

const { createWindow } = require('../src/main/window')
const { registerAppProtocol } = require('../src/main/protocol')
const { registerIpc } = require('../src/main/ipc')
const store = require('../src/main/store')
const raw = require('../src/main/raw')

const ROOT = path.resolve(__dirname, '..')

function parseSize(value, fallbackW, fallbackH) {
  const m = /^(\d+)x(\d+)$/.exec(value || '')
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: fallbackW, height: fallbackH }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const scene = argOf('scene', 'grid')
  const theme = argOf('theme', 'dark')
  const out = path.resolve(ROOT, argOf('out', `shots/${scene}-${theme}.png`))
  const dir = argOf('open', path.join(ROOT, 'fixtures'))
  const select = argOf('select', '2')
  const size = parseSize(argOf('size', '1440x900'), 1440, 900)
  const delay = Number(argOf('delay', '2200'))

  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark'

  await store.init(app.getPath('userData'))
  raw.init(app.getPath('userData'))
  registerAppProtocol(ROOT)
  registerIpc()

  const openDir = scene === 'empty' ? '' : dir
  const sceneParam = scene === 'favorite' ? 'grid' : scene

  const win = createWindow({
    open: openDir,
    select: scene === 'viewer' || scene === 'info' ? select : '0',
    scene: scene === 'empty' ? '' : sceneParam,
    width: size.width,
    height: size.height,
    quiet: hasFlag('quiet')
  })

  await new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve)
    else resolve()
  })

  if (scene === 'favorite') {
    await sleep(900)
    await win.webContents.executeJavaScript(`
      (() => {
        const pill = document.querySelector('[data-filter="favorite"]')
        if (pill) pill.click()
        return true
      })()
    `).catch(() => {})
  }

  await sleep(delay)

  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const s = window.__picselect && window.__picselect.state
      const sb = document.getElementById('statusbar')
      const tb = document.getElementById('titlebar')
      const cs = getComputedStyle(tb)
      return JSON.stringify({
        hasBridge: Boolean(window.picselect),
        root: s ? s.root : null,
        items: s ? s.items.length : -1,
        filtered: s ? s.filtered.length : -1,
        tiles: document.querySelectorAll('.tile').length,
        canvasH: document.getElementById('gridCanvas').style.height,
        emptyHidden: document.getElementById('emptyState').hidden,
        vw: window.innerWidth,
        dpr: window.devicePixelRatio,
        tbPaddingRight: cs.paddingRight,
        sbScrollW: sb.scrollWidth,
        sbClientW: sb.clientWidth,
        bodyScrollW: document.body.scrollWidth,
        img: (() => {
          const img = document.querySelector('.viewer-img.is-visible')
          if (!img) return null
          const r = img.getBoundingClientRect()
          const st = document.getElementById('stage').getBoundingClientRect()
          return {
            natural: [img.naturalWidth, img.naturalHeight],
            rect: [Math.round(r.width), Math.round(r.height)],
            stage: [Math.round(st.width), Math.round(st.height)],
            ratioNat: +(img.naturalWidth / img.naturalHeight).toFixed(3),
            ratioRect: +(r.width / r.height).toFixed(3)
          }
        })()
      })
    })()
  `).catch((err) => `probe failed: ${err.message}`)
  console.log('probe:', probe)

  fs.mkdirSync(path.dirname(out), { recursive: true })
  const image = await win.webContents.capturePage()
  fs.writeFileSync(out, image.toPNG())
  console.log(`已保存 ${out} (${image.getSize().width}×${image.getSize().height})`)

  if (hasFlag('webp')) {
    const dataUrl = await win.webContents.executeJavaScript(`
      (() => {
        const c = document.createElement('canvas')
        c.width = 1200
        c.height = 800
        const ctx = c.getContext('2d')
        const g = ctx.createLinearGradient(0, 0, 1200, 800)
        g.addColorStop(0, '#0f5b7a')
        g.addColorStop(0.55, '#1f9bb5')
        g.addColorStop(1, '#7be0c8')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, 1200, 800)
        for (let i = 0; i < 7; i++) {
          ctx.beginPath()
          ctx.arc(180 + i * 140, 300 + Math.sin(i) * 160, 60 + i * 34, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(255,255,255,' + (0.05 + i * 0.022) + ')'
          ctx.fill()
        }
        return c.toDataURL('image/webp', 0.92)
      })()
    `)
    const target = path.join(ROOT, 'fixtures', 'photo-09.webp')
    fs.writeFileSync(target, Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log(`已生成 ${target}`)
  }

  app.quit()
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('截图失败:', err)
    process.exitCode = 1
    app.quit()
  })
})
