'use strict'

/**
 * 端到端交互测试（在 Electron 下运行：node scripts/test-ui.js → 实际用 electron 启动）
 * 覆盖：网格渲染 → 打星/收藏/标签 → 筛选 → 查看器键盘切换 → JSON 落盘 → 重载后恢复
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { app, protocol, net, nativeTheme } = require('electron')

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

  console.log('\n== 导出 / 外部程序 ==')
  const exportDir = path.join(os.tmpdir(), `picselect-ui-export-${Date.now()}`)
  const exported = JSON.parse(await evalJs(`(async () => {
    const s = window.__picselect.state
    const files = s.filtered.slice(0, 2).map((i) => i.path)
    const res = await window.picselect.runExport(files, ${JSON.stringify(exportDir)})
    return JSON.stringify(res)
  })()`))
  check('IPC 导出复制了 2 个文件', exported.copied === 2 && exported.failed === 0, JSON.stringify(exported))
  check('导出生成 CSV 清单', Boolean(exported.csv) && fs.existsSync(path.join(exportDir, exported.csv)))
  const diskFiles = fs.readdirSync(exportDir)
  check('目录内 = 2 张照片 + 1 份清单', diskFiles.length === 3, diskFiles.join('|'))

  const external = JSON.parse(await evalJs(`(async () => JSON.stringify(await window.picselect.detectExternal()))()`))
  check('能探测 Photoshop / Lightroom', Boolean(external.photoshop && external.lightroom), JSON.stringify(external))
  const glyphs = JSON.parse(await evalJs(`JSON.stringify({
    ps: Boolean(document.querySelector('#vPs')), lr: Boolean(document.querySelector('#vLr')),
    exportBtn: Boolean(document.getElementById('btnExport'))
  })`))
  check('Ps / Lr / 导出 入口都已渲染', glyphs.ps && glyphs.lr && glyphs.exportBtn, JSON.stringify(glyphs))

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

  try { fs.rmSync(exportDir, { recursive: true, force: true }) } catch {}

  await testRawPipeline(evalJs)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
  app.quit()
}

/**
 * RAW 解码链路。前半段（vendor 资源、原始字节路由）任何环境都能跑；
 * 后半段需要 raw/ 里有真实样片，没有就跳过——这部分依赖本机素材，不进版本控制。
 */
async function testRawPipeline(evalJs) {
  console.log('\n== RAW 解码 ==')

  const vendor = await net.fetch('app://picselect/vendor/libraw/index.js')
  check('vendor 路由供出 libraw ESM', vendor.ok, `HTTP ${vendor.status}`)

  const wasm = await net.fetch('app://picselect/vendor/libraw/libraw.wasm')
  const wasmType = wasm.headers.get('content-type') || ''
  const wasmBytes = wasm.ok ? (await wasm.arrayBuffer()).byteLength : 0
  check('wasm 以 application/wasm 供出', wasm.ok && wasmType.includes('application/wasm'), wasmType)
  check('wasm 体积合理（>1MB）', wasmBytes > 1024 * 1024, `${wasmBytes} bytes`)

  // 越界路径必须被挡住，否则任意文件都能通过 app:// 读出来
  const escape = await net.fetch('app://picselect/vendor/libraw/../../../package.json')
  check('vendor 越界路径被拒绝', escape.status === 403 || escape.status === 404, `HTTP ${escape.status}`)

  const rawDir = process.env.PICSELECT_RAW_DIR || path.join(ROOT, 'raw')
  const samples = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((f) => /\.(arw|cr2|cr3|nef|dng|raf|rw2|orf)$/i.test(f))
    : []
  if (!samples.length) {
    console.log(`  · 跳过真实样片解码（${rawDir} 内没有 RAW，这不是失败）`)
    return
  }

  // 先清掉缩略图缓存，保证下面的统计反映的是「这次真的解了图」
  await evalJs('window.__picselect.clearThumbCache()')
  await sleep(300)
  const before = JSON.parse(await evalJs('JSON.stringify(window.__picselect.thumbStats)'))

  await evalJs(`window.__picselect.openDir(${JSON.stringify(rawDir)})`)
  await sleep(7000)

  const after = JSON.parse(await evalJs('JSON.stringify(window.__picselect.thumbStats)'))
  const list = JSON.parse(await evalJs(`JSON.stringify(
    window.__picselect.state.items.filter((it) => window.__picselect.isRaw(it)).map((it) => it.name)
  )`))
  const loaded = JSON.parse(await evalJs(
    `document.querySelectorAll('.tile-thumb.is-loaded').length`
  ))

  check(`扫描出 ${samples.length} 个 RAW`, list.length === samples.length, JSON.stringify(list))
  if (!list.length) return

  check('每张 RAW 都走了解码分支', after.misses - before.misses === samples.length,
    `misses ${before.misses} → ${after.misses}`)
  check('解码无一失败', after.failed - before.failed === 0, `failed ${before.failed} → ${after.failed}`)
  check('瓦片全部出图', loaded >= samples.length, `${loaded}/${samples.length}`)

  // 真正解一张：断言尺寸、JPEG 头、耗时
  const t0 = Date.now()
  const decoded = JSON.parse(await evalJs(`(async () => {
    const item = window.__picselect.state.items.find((it) => window.__picselect.isRaw(it))
    const res = await window.__picselect.developRaw(item, { maxWidth: 2048 })
    const buf = new Uint8Array(await res.blob.slice(0, 3).arrayBuffer())
    return JSON.stringify({
      name: item.name,
      width: res.width,
      height: res.height,
      bytes: res.blob.size,
      magic: [...buf].map((b) => b.toString(16).padStart(2, '0')).join(''),
      type: res.blob.type
    })
  })()`))
  const ms = Date.now() - t0

  check('LibRaw 解出传感器像素', decoded.width > 1000 && decoded.height > 1000, JSON.stringify(decoded))
  check('输出是 JPEG（ffd8ff）', decoded.magic === 'ffd8ff', decoded.magic)
  check('输出声明 image/jpeg', decoded.type === 'image/jpeg', decoded.type)
  check('输出体积 > 20KB', decoded.bytes > 20 * 1024, `${decoded.bytes} bytes`)
  console.log(`    （${decoded.name} → ${decoded.width}×${decoded.height}，${(decoded.bytes / 1024).toFixed(0)}KB，耗时 ${ms}ms）`)

  // 相机内嵌预览是文件里现成的另一张 JPEG：体积、尺寸都应与解码结果不同
  const embedded = await raw.extractPreview(path.join(rawDir, decoded.name), { prefer: 'best' })
  const embeddedSize = embedded.buffer.length
  check('结果是重新解码而非内嵌预览', embeddedSize > 0 && Math.abs(embeddedSize - decoded.bytes) > 4096,
    `内嵌 ${(embeddedSize / 1024).toFixed(0)}KB vs 解码 ${(decoded.bytes / 1024).toFixed(0)}KB`)

  // 缓存：同一张再解一次应命中 IndexedDB
  const t1 = Date.now()
  const cachedUrl = await evalJs(`(async () => {
    const item = window.__picselect.state.items.find((it) => window.__picselect.isRaw(it))
    return await window.__picselect.developUrl(item, { maxWidth: 2048 })
  })()`)
  const cacheMs = Date.now() - t1
  check('二次取图返回 blob URL', typeof cachedUrl === 'string' && cachedUrl.startsWith('blob:'), String(cachedUrl))
  check('缓存命中快于首次解码', cacheMs < ms, `${cacheMs}ms vs 首次 ${ms}ms`)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('测试异常:', err)
    process.exitCode = 1
    app.quit()
  })
})
