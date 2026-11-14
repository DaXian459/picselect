'use strict'

/**
 * 打包脚本
 *   node scripts/dist.js --dir   只生成免安装目录（dist/win-unpacked），用于快速验证
 *   node scripts/dist.js         生成安装包 + 单文件便携版
 *
 * 国内网络下 electron-builder 默认从 GitHub 拉 winCodeSign / nsis，
 * 这里统一改走 npmmirror 镜像，避免卡在下载。
 */

const { build, Platform, Arch } = require('electron-builder')

const MIRRORS = {
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/'
}

for (const [key, value] of Object.entries(MIRRORS)) {
  if (!process.env[key]) process.env[key] = value
}

const dirOnly = process.argv.includes('--dir')

async function main() {
  const t0 = Date.now()
  const targets = dirOnly
    ? Platform.WINDOWS.createTarget('dir', Arch.x64)
    : Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64)

  const artifacts = await build({
    targets,
    // 不压缩成 asar：app:// 协议直接用文件路径喂给 net.fetch，
    // 保持与开发时完全一致的行为，避免 asar 虚拟路径取不到图片。
    config: {
      asar: false
    }
  })

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n打包完成，用时 ${secs}s`)
  for (const file of artifacts) console.log('  ' + file)
}

main().catch((err) => {
  console.error('\n打包失败：', err && err.message ? err.message : err)
  process.exitCode = 1
})
