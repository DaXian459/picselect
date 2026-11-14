'use strict'

/**
 * 端到端交互测试（在 Electron 下运行：node scripts/test-ui.js → 实际用 electron 启动）
 * 覆盖：网格渲染 → 打星/收藏/标签 → 筛选 → 查看器键盘切换 → JSON 落盘 → 重载后恢复
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, protocol, nativeTheme } = require('electron')

// 与 main.js 保持一致，避免测试数据写到 %APPDATA%\Electron
app.setName('PicSelect')

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
}])

const { createWindow } = require('../src/main/window')
const { registerAppProtocol } = require('../src/main/protocol')
const { registerIpc } = require('../src/main/ipc')
const store = require('../src/main/store')
const raw = require('../src/main/raw')

const ROOT = path.resolve(__dirname, '..')
const FIXTURES = path.join(ROOT, 'fixtures')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

async function main() {
  nativeTheme.themeSource = 'dark'

  const userData = app.getPath('userData')
  const libPath = path.join(userData, 'library.json')
  try { fs.unlinkSync(libPath) } catch {}

  await store.init(userData)
  raw.init(userData)
  registerAppProtocol(ROOT)
  registerIpc()

  const win = createWindow({ open: FIXTURES, width: 1280, height: 820, quiet: true })
  const evalJs = (code) => win.webContents.executeJavaScript(code)

  await new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve)
    else resolve()
  })
  await sleep(2200)

  console.log('\n== 网格 ==')
  const gridState = JSON.parse(await evalJs(`JSON.stringify({
    items: window.__picselect.state.items.length,
    tiles: document.querySelectorAll('.tile').length,
    loaded: document.querySelectorAll('.tile-thumb.is-loaded').length,
    errors: document.querySelectorAll('.tile.is-error').length
  })`))
  check(`加载 ${gridState.items} 个项目`, gridState.items >= 29, JSON.stringify(gridState))
  check('可见瓦片都已出图', gridState.loaded > 0 && gridState.errors === 0, JSON.stringify(gridState))

  console.log('\n== 标记 ==')
  await evalJs(`document.querySelectorAll('.tile')[0].querySelector('.star[data-value="4"]').click()`)
  await sleep(320)
  const rated = JSON.parse(await evalJs(`(() => {
    const s = window.__picselect.state
    const item = s.filtered[0]
    return JSON.stringify({ path: item.path, meta: s.meta[item.path.toLowerCase()] || null })
  })()`))
  check('点击第 4 星写入 rating=4', rated.meta && rated.meta.rating === 4, JSON.stringify(rated))

  await evalJs(`document.querySelectorAll('.tile')[1].querySelector('.tile-fav').click()`)
  await sleep(320)
  const fav = JSON.parse(await evalJs(`(() => {
    const s = window.__picselect.state
    const item = s.filtered[1]
    return JSON.stringify({ path: item.path, meta: s.meta[item.path.toLowerCase()] || null })
  })()`))
  check('点击爱心置 favorite=true', fav.meta && fav.meta.favorite === true, JSON.stringify(fav))

  await evalJs(`document.getElementById('btnInfo').click()`)
  await sleep(400)
  await evalJs(`(() => {
    const input = document.getElementById('tagInput')
    input.value = '风景,精选'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(400)
  const tagged = JSON.parse(await evalJs(`(() => {
    const s = window.__picselect.state
    const item = s.filtered[0]
    return JSON.stringify({ meta: s.meta[item.path.toLowerCase()] || null, chips: document.querySelectorAll('.info-tags .tag-chip').length })
  })()`))
  check('标签写入两条', tagged.meta && tagged.meta.tags.length === 2, JSON.stringify(tagged))
  check('标签 chip 渲染', tagged.chips === 2, `chips=${tagged.chips}`)

  console.log('\n== 筛选 ==')
  await evalJs(`document.querySelector('[data-filter="favorite"]').click()`)
  await sleep(500)
  const filtered = JSON.parse(await evalJs(`JSON.stringify({
    filtered: window.__picselect.state.filtered.length,
    tiles: document.querySelectorAll('.tile').length,
    count: document.getElementById('countChip').textContent
  })`))
  check('收藏筛选只剩 1 张', filtered.filtered === 1, JSON.stringify(filtered))
  check('计数显示筛选结果', /1/.test(filtered.count), filtered.count)

  await evalJs(`document.querySelector('[data-filter="all"]').click()`)
  await sleep(400)

  console.log('\n== 查看器 ==')
  await evalJs(`document.querySelectorAll('.tile')[0].click()`)
  await sleep(700)
  const viewerState = JSON.parse(await evalJs(`JSON.stringify({
    view: window.__picselect.state.view,
    index: window.__picselect.state.selected,
    name: document.getElementById('vName').textContent,
    visibleLayers: document.querySelectorAll('.viewer-img.is-visible').length,
    natural: (() => { const i = document.querySelector('.viewer-img.is-visible'); return i ? [i.naturalWidth, i.naturalHeight] : null })()
  })`))
  check('进入查看器且只显示一个图层', viewerState.view === 'viewer' && viewerState.visibleLayers === 1, JSON.stringify(viewerState))
  check('主图已解码', Boolean(viewerState.natural && viewerState.natural[0] > 0), JSON.stringify(viewerState.natural))

  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
  await sleep(600)
  const afterKey = JSON.parse(await evalJs(`JSON.stringify({
    index: window.__picselect.state.selected,
    name: document.getElementById('vName').textContent,
    pos: document.getElementById('sbPos').textContent
  })`))
  check('→ 键切到下一张', afterKey.index === 1, JSON.stringify(afterKey))
  check('状态栏索引同步', afterKey.pos.startsWith('2 /'), afterKey.pos)

  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }))`)
  await sleep(350)
  const keyRated = JSON.parse(await evalJs(`(() => {
    const s = window.__picselect.state
    const item = s.filtered[s.selected]
    return JSON.stringify(s.meta[item.path.toLowerCase()] || null)
  })()`))
  check('数字键 5 打 5 星', keyRated && keyRated.rating === 5, JSON.stringify(keyRated))

  console.log('\n== 持久化 ==')
  await sleep(700)
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(libPath, 'utf8')) } catch (err) { saved = null }
  check('library.json 已原子写入', Boolean(saved), libPath)
  const photos = saved ? Object.keys(saved.photos || {}) : []
  check('落盘 2 条记录', photos.length === 2, `实际 ${photos.length}`)
  check('无残留 .tmp 文件', !fs.existsSync(`${libPath}.${process.pid}.tmp`))

  win.webContents.reload()
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  await sleep(2400)
  const afterReload = JSON.parse(await evalJs(`(() => {
    const s = window.__picselect.state
    const withRating = s.items.filter(i => (s.meta[i.path.toLowerCase()] || {}).rating > 0).length
    const withFav = s.items.filter(i => (s.meta[i.path.toLowerCase()] || {}).favorite).length
    const withTags = s.items.filter(i => ((s.meta[i.path.toLowerCase()] || {}).tags || []).length).length
    return JSON.stringify({ withRating, withFav, withTags, tiles: document.querySelectorAll('.tile').length })
  })()`))
  check('重载后评分恢复', afterReload.withRating === 2, JSON.stringify(afterReload))
  check('重载后收藏恢复', afterReload.withFav === 1, JSON.stringify(afterReload))
  check('重载后标签恢复', afterReload.withTags === 1, JSON.stringify(afterReload))

  console.log('\n== 缩略图缓存 ==')
  const cache1 = JSON.parse(await evalJs(`(async () => {
    const { idbCount } = await import('app://picselect/renderer/js/idb.js')
    return JSON.stringify({ count: await idbCount() })
  })()`))
  check('IndexedDB 已缓存缩略图', cache1.count > 0, JSON.stringify(cache1))

  const t0 = Date.now()
  win.webContents.reload()
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  await sleep(1200)
  const secondLoad = JSON.parse(await evalJs(`JSON.stringify({
    loaded: document.querySelectorAll('.tile-thumb.is-loaded').length,
    tiles: document.querySelectorAll('.tile').length
  })`))
  check('二次加载 1.2s 内出图', secondLoad.loaded > 0, JSON.stringify(secondLoad))
  console.log(`    （第二次加载耗时 ${Date.now() - t0}ms，已出图 ${secondLoad.loaded}/${secondLoad.tiles}）`)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
  app.quit()
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('测试异常:', err)
    process.exitCode = 1
    app.quit()
  })
})
