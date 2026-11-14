'use strict'

/**
 * 导出功能测试（纯 Node，不需要 Electron）
 *   node scripts/test-export.js
 *
 * 覆盖：文件复制、同名冲突改名、CSV 内容与 BOM、越权路径被过滤、元数据落进清单。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const library = require('../src/main/library')
const store = require('../src/main/store')
const exporter = require('../src/main/exporter')

const ROOT = path.resolve(__dirname, '..')
const FIXTURES = path.join(ROOT, 'fixtures')

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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'picselect-export-'))
  await store.init(path.join(tmp, 'userdata'))

  const state = await library.scan(FIXTURES)
  const sample = state.items.slice(0, 3)
  check('扫描到测试素材', sample.length === 3, `实际 ${sample.length}`)

  // 给第一张打标记，验证清单能带出来
  store.setMeta(sample[0].path, { rating: 4, favorite: true, tags: ['人像', '蓝调'] })

  const out1 = path.join(tmp, 'out1')
  const res1 = await exporter.exportSelection(sample.map((i) => i.path), out1)
  check('导出数量正确', res1.copied === 3 && res1.failed === 0, JSON.stringify(res1))
  check('CSV 已生成', fs.existsSync(path.join(out1, res1.csv)), res1.csv)

  const csv = await fsp.readFile(path.join(out1, res1.csv), 'utf8')
  check('CSV 带 UTF-8 BOM', csv.charCodeAt(0) === 0xfeff)
  const lines = csv.replace(/^\ufeff/, '').trim().split(/\r\n/)
  check('CSV 行数 = 表头 + 3', lines.length === 4, `实际 ${lines.length}`)
  check('CSV 表头正确', lines[0].startsWith('文件名,星级,收藏,标签'))
  check('清单带出星级与标签', lines[1].includes(',4,是,人像 / 蓝调,'), lines[1].slice(0, 60))

  const copiedNames = (await fsp.readdir(out1)).filter((n) => !n.endsWith('.csv')).sort()
  check('复制的文件名与源一致', copiedNames.join('|') === sample.map((i) => i.name).sort().join('|'), copiedNames.join('|'))

  // 二次导出到同一目录：同名要改成 "name (1).ext"
  const res2 = await exporter.exportSelection(sample.map((i) => i.path), out1)
  check('二次导出成功', res2.copied === 3)
  const allFiles = (await fsp.readdir(out1)).filter((n) => !n.endsWith('.csv'))
  check('冲突文件已改名而不是覆盖', allFiles.length === 6, `实际 ${allFiles.length}`)
  check('改名符合 name (1).ext 规则', allFiles.some((n) => / \(1\)\.[^.]+$/.test(n)), allFiles.join('|'))

  // 越权路径（画册以外）应被过滤掉，最终无可导出内容
  const outside = path.join(os.tmpdir(), 'not-in-library.jpg')
  let rejected = false
  try {
    await exporter.exportSelection([outside], path.join(tmp, 'out2'))
  } catch (err) {
    rejected = /没有可导出的照片/.test(err.message)
  }
  check('目录外路径被拒绝', rejected)

  await fsp.rm(tmp, { recursive: true, force: true })

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
