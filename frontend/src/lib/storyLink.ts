/**
 * Ссылка на фразу в публичной истории (0.136.0).
 *
 * Зачем отдельный модуль. Ссылку формирует сам читатель: он выделяет фразу на публичной
 * странице и получает адрес, который открывает ту же историю на том же кадре с подсвеченной
 * фразой. Строка адреса — единственный носитель, который переживает мессенджеры и перезагрузку:
 * у публичной страницы нет ни чата, ни якорей CRDT.
 *
 * Формат — обычные параметры запроса, а не hash: их видно и правят руками, они не ломают
 * кэш/аналитику и переживают пересылку целиком.
 *
 *   /s/<slug>?frame=<eventId>&q=<фраза>
 */

export interface StoryQuoteTarget {
  /** id кадра: тот же id события, что и в проекте. */
  frameId: string
  /** Выделенная фраза. */
  quote: string
}

/** Адрес публичной истории на конкретном кадре с подсвеченной фразой. */
export function buildStoryQuoteUrl(origin: string, slug: string, target: StoryQuoteTarget): string {
  const base = `${origin.replace(/\/+$/, '')}/s/${encodeURIComponent(slug)}`
  const params = new URLSearchParams()
  params.set('frame', target.frameId)
  const quote = target.quote.trim()
  if (quote !== '') params.set('q', quote)
  return `${base}?${params.toString()}`
}

/**
 * Что просили открыть: кадр и фразу из адреса страницы.
 *
 * `null` — в адресе нет кадра: страница открывается как обычно. Если кадр есть, а фразы нет —
 * кадр всё равно открывается (это осмысленная ссылка), поэтому `quote` в таком случае пустая.
 */
export function readStoryQuoteTarget(search: string): StoryQuoteTarget | null {
  const params = new URLSearchParams(search)
  const frameId = (params.get('frame') ?? '').trim()
  if (frameId === '') return null
  return { frameId, quote: (params.get('q') ?? '').trim() }
}
