import type { Mention } from '../collab/mentions'

/**
 * «Открой этот кадр в редакторе» (0.79.0).
 *
 * Зачем событие, а не пропсы. Хронология карточки живёт в области «Связи», а сам редактор
 * кадров — в панели «Редакторы», и обе панели рендерит страница проекта. Протаскивать колбэк
 * через страницу пришлось бы с регистрацией ссылки внутри панели редакторов («когда будешь
 * готов, отдай функцию») — лишний хрупкий контракт ради одного перехода.
 *
 * Событие — тот же приём, что `skyfraze:entities-changed` у карточек: одно действие, мало
 * связей, легко проверить.
 */
export const OPEN_FRAME_EVENT = 'skyfraze:open-frame'

export interface OpenFrameRequest {
  frameId: string
  /** Упоминание, которое надо подсветить: из хронологии и матрицы приходит именно оно. */
  mention?: Mention
}

/** Попросить редактор открыть кадр. */
export function requestOpenFrame(frameId: string, mention?: Mention): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<OpenFrameRequest>(OPEN_FRAME_EVENT, { detail: { frameId, mention } }),
  )
}

/** Подписаться на просьбы открыть кадр. Возвращает функцию отписки. */
export function onOpenFrameRequest(handler: (request: OpenFrameRequest) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<OpenFrameRequest>).detail
    if (detail?.frameId) handler(detail)
  }
  window.addEventListener(OPEN_FRAME_EVENT, listener)
  return () => window.removeEventListener(OPEN_FRAME_EVENT, listener)
}
