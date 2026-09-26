import * as Y from 'yjs'
import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/auth'

export type YArray = Y.Array<Y.Map<unknown>>
export type YMap = Y.Map<unknown>

export interface CollabHandle {
  doc: Y.Doc
  events: YArray
  wsUrl: (projectId: string) => string
  save: () => Promise<void>
  flushNow: () => Promise<void>
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const tok = useAuthStore.getState().accessToken
  return {
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    ...(extra ?? {}),
  }
}

/**
 * Подключение к Yjs-серверу + REST snapshot.
 * Без guard: каждый useEffect создаёт свой doc/WS; cleanup не уничтожает данные сразу — только при реальной отмонтировке.
 */
export function useCollab(projectId: string): CollabHandle | null {
  const [handle, setHandle] = useState<CollabHandle | null>(null)

  useEffect(() => {
    const doc = new Y.Doc()
    const events = doc.getArray<Y.Map<unknown>>('events')
    if (typeof window !== 'undefined') {
      ;(window as any).__yjsDoc = doc
    }

    const tok = useAuthStore.getState().accessToken
    const wsUrl = `ws://${window.location.host}/api/projects/${projectId}/collab`
    const ws = new WebSocket(wsUrl + '?token=' + encodeURIComponent(tok ?? ''))
    ws.binaryType = 'arraybuffer'
    let wsOpened = false

    ws.onopen = async () => {
      wsOpened = true
      console.log('[yprovider] ws opened for project', projectId)
      try {
        const resp = await fetch(`/api/projects/${projectId}/events/state`, {
          headers: authHeaders({ Accept: 'application/octet-stream' }),
        })
        console.log('[yprovider] snapshot GET status=', resp.status, 'bytes=', (await resp.clone().arrayBuffer()).byteLength)
        if (resp.ok) {
          const buf = await resp.arrayBuffer()
          if (buf.byteLength > 0) {
            Y.applyUpdate(doc, new Uint8Array(buf), 'remote')
            console.log('[yprovider] snapshot applied, bytes=', buf.byteLength, 'events.length=', events.length)
          }
        }
      } catch (e) {
        console.log('[yprovider] snapshot fetch error:', String(e))
      }
      const update = Y.encodeStateAsUpdate(doc)
      if (update.byteLength > 0) ws.send(update)
    }
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        try {
          Y.applyUpdate(doc, new Uint8Array(ev.data), 'remote')
        } catch {
          /* ignore malformed */
        }
      }
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let pendingPromise: Promise<void> = Promise.resolve()
    let active = true

    const flushNow = async () => {
      if (!active) return
      const state = Y.encodeStateAsUpdate(doc)
      const safe = new Uint8Array(new ArrayBuffer(state.byteLength))
      safe.set(state)
      try {
        await fetch(`/api/projects/${projectId}/events/state`, {
          method: 'PUT',
          headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
          body: new Blob([safe]),
        })
      } catch {
        /* offline ok */
      }
    }
    const save = (): Promise<void> => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        pendingPromise = flushNow()
        pendingPromise.finally(() => { pendingPromise = Promise.resolve() })
      }, 300)
      return pendingPromise
    }

    doc.on('update', (update, origin) => {
      if (origin === 'remote') return
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(update) } catch { /* ignore */ }
      }
      void save()
    })

    const safetyNet = setInterval(() => {
      if (!active) return
      if (pendingPromise !== Promise.resolve()) return
      void flushNow()
    }, 30000)

    const onUnload = () => {
      if (!active) return
      const state = Y.encodeStateAsUpdate(doc)
      const safe = new Uint8Array(new ArrayBuffer(state.byteLength))
      safe.set(state)
      try {
        const ok = navigator.sendBeacon?.(
          `/api/projects/${projectId}/events/state`,
          new Blob([safe], { type: 'application/octet-stream' })
        )
        if (!ok) {
          void fetch(`/api/projects/${projectId}/events/state`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
            body: new Blob([safe]),
            keepalive: true,
          }).catch(() => {/* ignore */})
        }
      } catch { /* ignore */ }
    }
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('pagehide', onUnload)

    setHandle({ doc, events, wsUrl: () => wsUrl, save, flushNow })

    return () => {
      active = false
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(safetyNet)
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('pagehide', onUnload)
      // закрываем WS — события в doc ещё есть, но без новой mount мы теряем лайв
      // flush делаем ТОЛЬКО если WS-соединение успешно открылось (значит, мы доверенный клиент)
      if (wsOpened) void flushNow()
      try { ws.close() } catch { /* ignore */ }
      // не уничтожаем doc, чтобы handle.getState() снаружи ещё мог читать,
      // но если нужно освободить память — вызывающий код должен handle.flushNow() перед unmount
    }
  }, [projectId])

  return handle
}

/**
 * Хелпер: добавить новое событие в YArray.
 */
export function yAddEvent(events: YArray, title = 'Новое событие', body = '') {
  const m = new Y.Map<unknown>()
  m.set('id', crypto.randomUUID())
  m.set('title', title)
  m.set('body', body)
  m.set('created_at', new Date().toISOString())
  events.push([m])
  return m
}
