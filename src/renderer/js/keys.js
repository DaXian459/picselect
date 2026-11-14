export function initKeys(handlers) {
  window.addEventListener('keydown', (event) => {
    const el = event.target
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    const mod = event.ctrlKey || event.metaKey
    const key = event.key

    if (mod && key.toLowerCase() === 'o') {
      event.preventDefault()
      handlers.openFolder()
      return
    }

    if (mod && key === '0') {
      event.preventDefault()
      handlers.resetZoom()
      return
    }

    if (key === 'F5') {
      event.preventDefault()
      handlers.rescan()
      return
    }

    if (key === 'Escape') {
      if (typing) {
        el.blur()
        return
      }
      handlers.escape()
      return
    }

    if (typing) return

    switch (key) {
      case 'ArrowLeft':
      case 'j':
      case 'J':
        event.preventDefault()
        handlers.prev()
        break
      case 'ArrowRight':
      case 'k':
      case 'K':
        event.preventDefault()
        handlers.next()
        break
      case ' ':
        event.preventDefault()
        if (event.shiftKey) handlers.prev()
        else handlers.space()
        break
      case 'Home':
        event.preventDefault()
        handlers.first()
        break
      case 'End':
        event.preventDefault()
        handlers.last()
        break
      case 'f':
      case 'F':
        handlers.favorite()
        break
      case 'i':
      case 'I':
        handlers.info()
        break
      case 'g':
      case 'G':
        handlers.toggleView()
        break
      case 't':
      case 'T':
        handlers.tag()
        break
      case '/':
        event.preventDefault()
        handlers.search()
        break
      case '+':
      case '=':
        handlers.zoom(1.25)
        break
      case '-':
      case '_':
        handlers.zoom(1 / 1.25)
        break
      default:
        if (/^[0-5]$/.test(key)) handlers.rate(Number(key))
    }
  })
}
