'use strict'

const fsp = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { protocol, net } = require('electron')
const { decodeMediaKey, extOf, RAW_EXT, TIFF_EXT } = require('./util/paths')
const { mimeOf } = require('./util/mime')
const library = require('./library')
const raw = require('./raw')
const tiff = require('./tiff/decode')

const LONG_CACHE = 'private, max-age=31536000, immutable'
let appRoot = ''

function registerAppProtocol(root) {
  appRoot = root
  protocol.handle('app', handleRequest)
}

function staticResponse(type, cache = 'no-cache') {
  return { 'content-type': type, 'cache-control': cache }
}

async function serveFile(file, type, cache = 'no-cache') {
  try {
    const res = await net.fetch(pathToFileURL(file).toString())
    if (!res.ok) return new Response('not found', { status: 404 })
    return new Response(res.body, { status: 200, headers: staticResponse(type, cache) })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

function isInside(base, target) {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function handleRequest(request) {
  let url
  try {
    url = new URL(request.url)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  if (url.host !== 'picselect') return new Response('not found', { status: 404 })

  const pathname = url.pathname

  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(path.join(appRoot, 'src', 'renderer', 'index.html'), mimeOf('.html'))
  }

  if (pathname.startsWith('/renderer/')) {
    const target = path.resolve(appRoot, 'src', pathname.slice(1))
    if (!isInside(path.join(appRoot, 'src'), target)) return new Response('forbidden', { status: 403 })
    return serveFile(target, mimeOf(extOf(target)))
  }

  if (pathname.startsWith('/assets/')) {
    const target = path.resolve(appRoot, 'assets', pathname.slice('/assets/'.length))
    if (!isInside(path.join(appRoot, 'assets'), target)) return new Response('forbidden', { status: 403 })
    return serveFile(target, mimeOf(extOf(target)))
  }

  if (pathname.startsWith('/media/')) {
    let width = 0
    try {
      width = Number(url.searchParams.get('w')) || 0
    } catch {}
    return serveMedia(pathname.slice('/media/'.length), width)
  }

  return new Response('not found', { status: 404 })
}

async function serveMedia(key, requestWidth = 0) {
  let file
  try {
    file = path.resolve(decodeMediaKey(key))
  } catch {
    return new Response('bad key', { status: 400 })
  }

  // 只允许访问最近一次扫描到的文件，天然阻断目录穿越与任意读取
  if (!library.isAllowed(file)) return new Response('forbidden', { status: 403 })

  const ext = extOf(file)

  try {
    if (RAW_EXT.has(ext)) {
      // 缩略图请求走中等分辨率预览，避免为 168px 瓦片解码 24MP 全图
      const prefer = requestWidth > 0 && requestWidth <= 900 ? 'small' : 'best'
      const { buffer, quality } = await raw.extractPreview(file, { prefer })
      return new Response(buffer, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'cache-control': LONG_CACHE,
          'x-preview-quality': quality
        }
      })
    }

    if (TIFF_EXT.has(ext)) {
      const stat = await fsp.stat(file)
      const decoded = await tiff.decodeTiffFile(file, stat.size)
      return new Response(decoded.buffer, {
        status: 200,
        headers: {
          'content-type': decoded.kind === 'jpeg' ? 'image/jpeg' : 'image/png',
          'cache-control': LONG_CACHE
        }
      })
    }

    return await serveFile(file, mimeOf(ext), LONG_CACHE)
  } catch (err) {
    // 解码失败：退回系统缩略图（RAW/TIFF 通用兜底）
    try {
      const { buffer } = await raw.extractPreview(file)
      return new Response(buffer, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'cache-control': LONG_CACHE,
          'x-preview-quality': 'system'
        }
      })
    } catch {
      return new Response(`无法解码该图片：${err.message}`, { status: 422 })
    }
  }
}

module.exports = { registerAppProtocol }
