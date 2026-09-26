import * as Y from 'yjs'
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../store/auth'

export type YArray = Y.Array<Y.Map<unknown>>
export type YMap = Y.Map<unknown>

export interface CollabHandle {
  doc: Y.Doc
  events: YArray
  wsUrl: (projectId: string) => string
  save: () => Promise<void>
}

/**
 * Хук подключения к Yjs-серверу.
 * Протокол: y-protocols/sync через WebSocket binary. Упрощённо — обмен Update-сообщениями.
 * MVP: используем простой y-websocket или нашу минимальную обёртку.
 */
export function useCollab(projectId: string): CollabHandle | null {
  const [handle, setHandle] = useState<CollabHandle | null>(null)
  const created = useRef(false)

  useEffect(() => {
    if (created.current) return
    created.current = true

    const doc = new Y.Doc()
    const events = doc.getArray<YMap>('events')

    const wsUrl = `ws://${window.location.host}/api/projects/${projectId}/collab`

    // простая relay-логика без y-websocket — шлём апдейты на сервер через WS
    const ws = new WebSocket(wsUrl + '?token=' + encodeURIComponent(useAuthStore.getState().accessToken ?? ''))
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      // отправим текущее состояние как апдейт
      const update = Y.encodeStateAsUpdate(doc)
      ws.send(update)
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

    // отправка локальных апдейтов
    doc.on('update', (update, origin) => {
      if (origin === 'remote') return
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(update)
      }
    })

    const save = async () => {
      const state = Y.encodeStateAsUpdate(doc)
      const safe = new Uint8Array(new ArrayBuffer(state.byteLength))
      safe.set(state)
      try {
        await fetch(`/api/projects/${projectId}/events/state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Blob([safe]),
        })
      } catch {
        /* offline ok */
      }
    }

    // periodic save
    const t = setInterval(() => { void save() }, 30000)

    setHandle({ doc, events, wsUrl: () => wsUrl, save })

    return () => {
      clearInterval(t)
      try { ws.close() } catch { /* ignore */ }
      doc.destroy()
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
