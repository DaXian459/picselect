'use strict'

/**
 * 外部程序探测测试（纯 Node）
 *   node scripts/test-external.js
 *
 * 用临时目录伪造 Adobe 安装结构，验证：版本倒序优先、exe 名匹配、手动路径优先。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const store = require('../src/main/store')
const external = require('../src/main/external')

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

async function fakeExe(dir, name) {
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fsp.writeFile(file, 'stub')
  return file
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'picselect-ext-'))
  const pf = path.join(tmp, 'PF')
  await store.init(path.join(tmp, 'userdata'))

  const oldPs = await fakeExe(path.join(pf, 'Adobe', 'Adobe Photoshop 2025'), 'Photoshop.exe')
  const newPs = await fakeExe(path.join(pf, 'Adobe', 'Adobe Photoshop 2026'), 'Photoshop.exe')
  // 干扰项：名字像但不是 Photoshop
  await fakeExe(path.join(pf, 'Adobe', 'Adobe Photoshop Elements 2026'), 'PhotoshopElements.exe')
  const lr = await fakeExe(path.join(pf, 'Adobe', 'Adobe Lightroom Classic'), 'Lightroom.exe')

  const foundPs = await external.findIn([pf], external.KINDS.photoshop)
  check('找到 Photoshop', foundPs === newPs, String(foundPs))
  check('多版本时选新版', foundPs !== oldPs, String(foundPs))
  check('不会误认 Elements', !/Elements/.test(foundPs || ''), String(foundPs))

  const foundLr = await external.findIn([pf], external.KINDS.lightroom)
  check('找到 Lightroom', foundLr === lr, String(foundLr))

  const foundInEmpty = await external.findIn([path.join(tmp, 'nowhere')], external.KINDS.photoshop)
  check('目录不存在时返回 null', foundInEmpty === null, String(foundInEmpty))

  // 手动指定的路径优先级最高
  external.setPath('lightroom', lr)
  const detected = await external.detect(true)
  check('手动路径被采纳', detected.lightroom.path === lr && detected.lightroom.source === 'manual', JSON.stringify(detected.lightroom))
  check('未装的产品标记为 missing', detected.photoshop.source === 'missing' || detected.photoshop.source === 'auto', detected.photoshop.source)

  // 手动路径失效（文件被删）应回落到自动探测
  external.setPath('lightroom', path.join(tmp, 'gone', 'Lightroom.exe'))
  await store.setPrefs({ external: { ...store.getPrefs().external, lightroom: path.join(tmp, 'gone', 'Lightroom.exe') } })
  const afterGone = await external.detect(true)
  check('手动路径失效后回落自动探测', afterGone.lightroom.path === null || afterGone.lightroom.source === 'auto', JSON.stringify(afterGone.lightroom))

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
