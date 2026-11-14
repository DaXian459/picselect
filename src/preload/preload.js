'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

function on(channel, callback) {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('picselect', {
  appInfo: () => invoke('app:info'),

  openFolder: (options) => invoke('dialog:openFolder', options || {}),
  loadLibrary: (dir) => invoke('lib:open', { dir }),
  rescan: () => invoke('lib:rescan'),
  openPath: (target) => invoke('lib:openPath', { path: target }),

  getAllMeta: () => invoke('lib:allMeta'),
  setMeta: (path, patch) => invoke('meta:set', { path, patch }),
  getExif: (path) => invoke('exif:get', { path }),

  mediaUrl: (path, mtimeMs) => invoke('img:url', { path, mtimeMs }),

  getPrefs: () => invoke('prefs:get'),
  setPrefs: (patch) => invoke('prefs:set', patch),

  getTheme: () => invoke('theme:get'),
  setTheme: (mode) => invoke('theme:set', { mode }),

  reveal: (path) => invoke('shell:reveal', { path }),
  setFullscreen: (value) => invoke('win:fullscreen', { value }),

  // 唯一需要触碰 File 对象的地方：Electron 32+ 用 webUtils 取代已移除的 File.path
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  onTheme: (callback) => on('theme:updated', callback),
  onToast: (callback) => on('toast', callback),
  onOpenDir: (callback) => on('lib:changed', callback)
})
