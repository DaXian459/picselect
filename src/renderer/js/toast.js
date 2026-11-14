const wrap = () => document.getElementById('toastWrap')

export function toast(message, { level = 'info', duration = 2600, action = null } = {}) {
  const host = wrap()
  if (!host) return

  const el = document.createElement('div')
  el.className = `toast${level === 'error' ? ' error' : ''}`
  const text = document.createElement('span')
  text.textContent = message
  el.appendChild(text)

  const remove = () => {
    if (el.classList.contains('is-out')) return
    el.classList.add('is-out')
    setTimeout(() => el.remove(), 200)
  }

  if (action && action.label && typeof action.run === 'function') {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'toast-action'
    btn.textContent = action.label
    btn.addEventListener('click', () => {
      remove()
      try {
        action.run()
      } catch {}
    })
    el.appendChild(btn)
    // 带操作按钮的提示留久一点，别用户还没看到就消失
    duration = Math.max(duration, 5200)
  }

  host.appendChild(el)
  setTimeout(remove, duration)

  while (host.children.length > 3) host.firstElementChild.remove()
}
