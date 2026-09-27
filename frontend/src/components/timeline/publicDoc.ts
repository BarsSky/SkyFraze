import * as Y from 'yjs'
import type { PublicStory } from '../../api/feed'

export interface PublicDoc {
  doc: Y.Doc
  events: Y.Array<Y.Map<unknown>>
}

/**
 * Локальный read-only документ для публичной страницы.
 *
 * Публичный просмотр НЕ подключается к realtime-серверу и ничего никуда не
 * отправляет: содержимое приезжает одним ответом API и разворачивается в
 * отдельный Y.Doc, который живёт только в этой вкладке. Стадия читает из него
 * те же поля, что и в редакторском режиме, поэтому вид истории совпадает,
 * а возможности что-либо изменить нет по построению — писать некуда.
 *
 * Приоритет источников: CRDT-снапшот (тексты, вложения, фон кадров), а если его
 * нет — плоское дерево events из БД (у проекта, который ни разу не открывали
 * в редакторе).
 */
export function buildPublicDoc(story: Pick<PublicStory, 'events'> & { state?: string }): PublicDoc {
  const doc = new Y.Doc()
  const events = doc.getArray<Y.Map<unknown>>('events')

  if (story.state) {
    Y.applyUpdate(doc, base64ToBytes(story.state), 'public')
    return { doc, events }
  }

  const maps: Array<Y.Map<unknown>> = []
  for (const row of story.events ?? []) {
    const m = new Y.Map<unknown>()
    m.set('id', row.id)
    if (row.parent_id) m.set('parent_id', row.parent_id)
    m.set('title', row.title ?? '')
    m.set('body', row.body ?? '')
    maps.push(m)
  }
  if (maps.length > 0) events.push(maps)
  return { doc, events }
}

/** base64 → байты. atob + посимвольный разбор: снапшот небольшой, буфер не нужен. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Байты → base64 (используется в тестах и при отладке публичной выдачи). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
