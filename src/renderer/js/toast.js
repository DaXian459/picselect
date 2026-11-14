const wrap = () => document.getElementById('toastWrap')

export function toast(message, { level = 'info', duration = 2600 } = {}) {
  const host = wrap()
  if (!host) return

  const el = document.createElement('div')
  el.className = `toast${level === 'error' ? ' error' : ''}`
  el.textContent = message
  host.appendChild(el)

  const remove = () => {
    el.classList.add('is-out')
    setTimeout(() => el.remove(), 200)
  }
  setTimeout(remove, duration)

  while (host.children.length > 3) host.firstElementChild.remove()
}
