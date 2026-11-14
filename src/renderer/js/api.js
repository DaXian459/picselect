export const api = window.picselect || null

export const hasBridge = Boolean(api)

export function requireBridge() {
  if (!api) {
    throw new Error('未运行在 PicSelect 桌面环境（缺少 preload 桥接）')
  }
  return api
}
