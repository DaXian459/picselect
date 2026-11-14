'use strict'
// 通过 CDP 在运行中的 Electron 里执行一段 JS（用于验证打包产物）
// 用法: node scripts/cdp-eval.js "window.__picselect.state.items.length"

const expression = process.argv[2] || '1+1'
const port = process.argv[3] || '9222'
const timeoutMs = Number(process.argv[4] || 240000)

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('app://picselect'))
  if (!page) throw new Error('没找到页面 target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('执行超时')), timeoutMs)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== 1) return
      clearTimeout(timer)
      resolve(msg)
    })
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }
    }))
  })

  ws.close()

  if (result.result && result.result.exceptionDetails) {
    console.error('异常:', JSON.stringify(result.result.exceptionDetails, null, 2))
    process.exitCode = 1
    return
  }
  const value = result.result && result.result.result && result.result.result.value
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

main().catch((err) => {
  console.error('失败:', err.message)
  process.exitCode = 1
})
