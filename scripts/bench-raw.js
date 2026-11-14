'use strict'

/**
 * RAW 解码基准（Electron）：
 *   electron scripts/bench-raw.js --open raw
 *
 * 拆开测三段耗时：读文件 / LibRaw open+imageData / 缩放转 JPEG。
 * 再对比不同解码参数与并发实例数，用来决定默认值。
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, protocol } = require('electron')

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

const { createWindow } = require('../src/main/window')
const { registerAppProtocol } = require('../src/main/protocol')
const { registerIpc } = require('../src/main/ipc')
const store = require('../src/main/store')
const raw = require('../src/main/raw')

const ROOT = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const dir = path.resolve(ROOT, argOf('open', 'raw'))

  await store.init(app.getPath('userData'))
  raw.init(app.getPath('userData'))
  registerAppProtocol(ROOT)
  registerIpc()

  const win = createWindow({ open: dir, width: 1200, height: 800, quiet: true })
  await new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve)
    else resolve()
  })
  await sleep(1500)

  const result = await win.webContents.executeJavaScript(`(async () => {
    try {
    const LibRaw = (await import('app://picselect/vendor/libraw/index.js')).default
    const items = window.__picselect.state.items.filter((it) => it.kind === 'raw')
    if (!items.length) return JSON.stringify({ error: '目录里没有 RAW' })

    const bytesUrl = (item) => {
      const u = new URL(item.url)
      u.pathname = u.pathname.replace('/media/', '/bytes/')
      return u.toString()
    }

    const readBytes = async (item) => {
      const t = performance.now()
      const buf = await (await fetch(bytesUrl(item))).arrayBuffer()
      return { bytes: new Uint8Array(buf), readMs: +(performance.now() - t).toFixed(0), sizeMB: +(buf.byteLength / 1048576).toFixed(1) }
    }

    const base = { useCameraWb: true, outputBps: 8, outputColor: 1, userFlip: -1 }
    const variants = [
      { name: 'A 现状 half+q3+flip', opts: { ...base, halfSize: true, userQual: 3 } },
      { name: 'B half+q0', opts: { ...base, halfSize: true, userQual: 0 } },
      { name: 'C half+q1', opts: { ...base, halfSize: true, userQual: 1 } },
      { name: 'D half+q0+noflip', opts: { ...base, halfSize: true, userQual: 0, userFlip: 0 } },
      { name: 'E half+q0+noBright', opts: { ...base, halfSize: true, userQual: 0, noAutoBright: true } },
      { name: 'F full+q3', opts: { ...base, halfSize: false, userQual: 3 } },
      { name: 'G full+q0', opts: { ...base, halfSize: false, userQual: 0 } }
    ]

    const sample = items[0]
    const loaded = await readBytes(sample)

    // 1) 参数对比：同一张、每个组合跑 2 次取第 2 次（wasm 已热身）
    // 注意 buffer 会被 transfer 给 worker，每次必须给新副本
    const params = []
    for (const v of variants) {
      const libraw = new LibRaw()
      const times = []
      let dims = null
      for (let i = 0; i < 2; i++) {
        const t = performance.now()
        await libraw.open(loaded.bytes.slice(), v.opts)
        const img = await libraw.imageData()
        times.push(performance.now() - t)
        dims = [img.width, img.height]
      }
      params.push({ name: v.name, ms: +times[1].toFixed(0), firstMs: +times[0].toFixed(0), dims })
      await libraw.close?.()
    }

    // 2) 缩放转 JPEG 的成本（从 A 的结果出发）
    const libraw = new LibRaw()
    await libraw.open(loaded.bytes.slice(), variants[0].opts)
    const img = await libraw.imageData()
    const toBlob = async (maxWidth) => {
      const { data, width, height, colors } = img
      const t = performance.now()
      const pixels = width * height
      const rgba = new Uint8ClampedArray(pixels * 4)
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 3, d += 4) {
        rgba[d] = data[s]; rgba[d + 1] = data[s + 1]; rgba[d + 2] = data[s + 2]; rgba[d + 3] = 255
      }
      const buildMs = performance.now() - t
      const t2 = performance.now()
      const imageData = new ImageData(rgba, width, height)
      const scale = Math.min(1, maxWidth / width)
      const bitmap = await createImageBitmap(imageData, {
        resizeWidth: Math.round(width * scale), resizeHeight: Math.round(height * scale), resizeQuality: 'high'
      })
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
      bitmap.close()
      return { maxWidth, totalMs: +(performance.now() - t).toFixed(0), buildMs: +buildMs.toFixed(0), scaleMs: +(performance.now() - t2).toFixed(0), kb: Math.round(blob.size / 1024) }
    }
    const blobs = []
    for (const w of [440, 880, 2048]) blobs.push(await toBlob(w))

    // 3) 批量吞吐：串行单实例 vs N 实例并行（全部 5 张，maxWidth 880）
    const runSerial = async () => {
      const inst = new LibRaw()
      const t = performance.now()
      for (const item of items) {
        const b = await readBytes(item)
        await inst.open(b.bytes, { ...base, halfSize: true, userQual: 0 })
        await inst.imageData()
      }
      return +(performance.now() - t).toFixed(0)
    }

    const runPool = async (size) => {
      const pool = Array.from({ length: size }, () => new LibRaw())
      const t = performance.now()
      let cursor = 0
      await Promise.all(pool.map(async (inst) => {
        while (cursor < items.length) {
          const item = items[cursor++]
          const b = await readBytes(item)
          await inst.open(b.bytes, { ...base, halfSize: true, userQual: 0 })
          await inst.imageData()
        }
      }))
      return +(performance.now() - t).toFixed(0)
    }

    const batch = []
    batch.push({ mode: '串行 1 实例', ms: await runSerial() })
    for (const n of [2, 3]) batch.push({ mode: '并行 ' + n + ' 实例', ms: await runPool(n) })

    // 4) 文件读取本身
    const reads = []
    for (const item of items.slice(0, 3)) {
      const b = await readBytes(item)
      reads.push({ name: item.name, sizeMB: b.sizeMB, readMs: b.readMs })
    }

    // 5) 真实管线（走 raw-develop.js，含实例池 / 像素复用 / 字节缓存）
    const P = window.__picselect
    const pipeline = []
    const time = async (label, fn) => {
      const t = performance.now()
      await fn()
      pipeline.push({ label, ms: +(performance.now() - t).toFixed(0) })
    }

    P.resetDevelopCache()
    await time('5 张缩略图并发（880 宽）', () =>
      Promise.all(items.map((it) => P.developRaw(it, { maxWidth: 880, quality: 0.82 })))
    )
    pipeline.push({ label: '池状态', detail: JSON.stringify(P.rawStats()) })

    // 先解一张、再换尺寸取同一张，确保测的是「像素复用」而不是碰运气
    await time('单张 880 首次解码', () => P.developRaw(items[0], { maxWidth: 880, quality: 0.82 }))
    await time('同张转 2048（像素复用）', () => P.developRaw(items[0], { maxWidth: 2048 }))
    await time('同张再取 880（像素复用）', () => P.developRaw(items[0], { maxWidth: 880, quality: 0.82 }))
    pipeline.push({ label: '池状态', detail: JSON.stringify(P.rawStats()) })

    return JSON.stringify({ sample: sample.name, count: items.length, params, blobs, batch, reads, pipeline, cores: navigator.hardwareConcurrency })
    } catch (err) {
      return JSON.stringify({ error: String(err && err.stack || err) })
    }
  })()`)

  const data = typeof result === 'string' ? JSON.parse(result) : result
  if (data.error) {
    console.error(data.error)
    app.quit()
    return
  }

  console.log(`\n样片: ${data.sample}（目录内共 ${data.count} 张）\n`)

  console.log('== 解码参数（open + imageData，已热身）==')
  for (const p of data.params) {
    console.log(`  ${p.name.padEnd(24)} ${String(p.ms).padStart(5)}ms   首跑 ${String(p.firstMs).padStart(5)}ms   ${p.dims.join('×')}`)
  }

  console.log('\n== 缩放 + 转 JPEG（从 3120 宽像素数组出发）==')
  for (const b of data.blobs) {
    console.log(`  目标 ${String(b.maxWidth).padStart(4)}px  ${String(b.totalMs).padStart(4)}ms（RGBA 组装 ${String(b.buildMs).padStart(3)}ms + 缩放编码 ${String(b.scaleMs).padStart(4)}ms）  ${b.kb}KB`)
  }

  console.log('\n== 批量吞吐（5 张全部解码）==')
  for (const b of data.batch) {
    console.log(`  ${b.mode.padEnd(14)} ${String(b.ms).padStart(6)}ms`)
  }

  console.log('\n== 文件读取 ==')
  for (const r of data.reads) {
    console.log(`  ${r.name}  ${r.sizeMB}MB  ${r.readMs}ms`)
  }

  if (data.pipeline) {
    console.log(`\n== 真实管线（raw-develop.js，${data.cores} 核）==`)
    for (const p of data.pipeline) {
      if (p.detail) console.log(`  ${p.label}: ${p.detail}`)
      else console.log(`  ${p.label.padEnd(28)} ${String(p.ms).padStart(5)}ms`)
    }
  }

  app.quit()
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('基准失败:', err)
    app.quit()
  })
})
