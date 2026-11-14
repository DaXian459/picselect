const DB_NAME = 'picselect'
const STORE = 'thumbs'
const DB_VERSION = 1

let openPromise = null

function openDb() {
  if (openPromise) return openPromise
  openPromise = new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      reject(err)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE)
        store.createIndex('t', 't')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'))
    req.onblocked = () => reject(new Error('IndexedDB 被占用'))
  })
  return openPromise
}

export async function idbGet(key) {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result && req.result.blob ? req.result.blob : null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function idbPut(key, blob) {
  try {
    const db = await openDb()
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ blob, t: Date.now(), bytes: blob.size }, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {}
}

export async function idbCount() {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).count()
      req.onsuccess = () => resolve(req.result || 0)
      req.onerror = () => resolve(0)
    })
  } catch {
    return 0
  }
}

export async function idbClear() {
  try {
    const db = await openDb()
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    return true
  } catch {
    return false
  }
}

/** 请求持久化存储，避免系统在磁盘紧张时清掉缩略图缓存 */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist()
    }
  } catch {}
}
