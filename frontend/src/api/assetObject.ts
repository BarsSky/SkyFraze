import { useEffect, useState } from 'react'
import { http } from './client'

/**
 * Загрузка ассетов для <img>.
 *
 * Эндпоинт /api/assets/{id} требует JWT, а тег <img> не умеет передавать
 * заголовок Authorization — поэтому прямая ссылка на ассет отдаёт 401 и картинки
 * нигде не показывались. Здесь файл скачивается авторизованным запросом и
 * отдаётся как blob-URL (кэш на сессию, один запрос на ассет).
 */

const cache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

export async function loadAssetObjectUrl(id: string): Promise<string | null> {
  const cached = cache.get(id)
  if (cached) return cached
  let task = pending.get(id)
  if (!task) {
    task = (async () => {
      try {
        const response = await http.get(`assets/${id}`)
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        cache.set(id, url)
        return url
      } catch {
        return null
      } finally {
        pending.delete(id)
      }
    })()
    pending.set(id, task)
  }
  return task
}

/** Blob-URL одного ассета (null пока не загружен). */
export function useAssetObjectUrl(id?: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (id ? cache.get(id) ?? null : null))
  useEffect(() => {
    let alive = true
    if (!id) {
      setUrl(null)
      return () => { alive = false }
    }
    const cached = cache.get(id)
    if (cached) {
      setUrl(cached)
      return () => { alive = false }
    }
    void loadAssetObjectUrl(id).then((resolved) => {
      if (alive) setUrl(resolved)
    })
    return () => { alive = false }
  }, [id])
  return url
}

/** Готовые blob-URL для набора ассетов (id → url). */
export function useAssetObjectUrls(ids: string[]): Record<string, string> {
  const key = ids.join('|')
  const [map, setMap] = useState<Record<string, string>>(() => collect(ids))
  useEffect(() => {
    let alive = true
    const list = key.length > 0 ? key.split('|') : []
    const missing = list.filter((id) => !cache.has(id))
    if (missing.length === 0) {
      setMap(collect(list))
      return () => { alive = false }
    }
    void Promise.all(missing.map((id) => loadAssetObjectUrl(id))).then(() => {
      if (alive) setMap(collect(list))
    })
    return () => { alive = false }
  }, [key])
  return map
}

function collect(ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const url = cache.get(id)
    if (url) out[id] = url
  }
  return out
}
