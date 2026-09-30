/**
 * Отложенное состояние: страховка на случай, когда вкладку закрыли раньше, чем
 * снапшот успел уехать на сервер.
 *
 * Что было. На `pagehide` уходил `keepalive`-PUT с базовой ревизией, ответ никто
 * не читал. Если сервер отвечал 409 (соавтор успел записать снапшот первее),
 * последняя правка человека исчезала молча: и в БД её нет, и в браузере её
 * больше нет — вкладка закрыта. То же самое при обрыве сети в момент ухода.
 *
 * Что стало. Перед отправкой состояние (`Y.encodeStateAsUpdate`) и базовая
 * ревизия кладутся в `localStorage`. При следующем открытии проекта после
 * серверного снапшота применяется отложенный апдейт (`Y.applyUpdate` — это
 * CRDT-слияние, а не перезапись), и он сохраняется. Запас стирается ТОЛЬКО
 * после успешной записи: если и вторая попытка не удалась, данные остаются
 * ждать следующего открытия.
 *
 * Почему localStorage, а не IndexedDB: нужна синхронная запись внутри
 * `pagehide`, где асинхронная транзакция может не успеть завершиться.
 */

import { base64ToBytes, bytesToBase64 } from './broadcast'

export function deferredStateKey(projectId: string): string {
  return `skyfraze-collab-pending:${projectId}`
}

/**
 * Потолок запаса. У `localStorage` квота порядка 5 МБ на весь origin, и она
 * общая с токенами приложения и интерфейсными настройками; один снапшот в
 * base64 (то есть +33% к размеру) на несколько сотен событий уже весит сотни
 * килобайт. Пишем только то, что заведомо влезает, иначе риск `QuotaExceeded`
 * на каждом уходе со страницы, а вместе с ним — потеря токена сессии, которая
 * гораздо дороже одной правки. Большое состояние в этот путь просто не попадает:
 * его успевает записать обычный debounce-save.
 */
export const MAX_DEFERRED_BYTES = 2 * 1024 * 1024

export interface PendingState {
  /** CRDT-апдейт, который не успели сохранить. */
  update: Uint8Array
  /** Ревизия снапшота, на которой он построен: с ней пойдёт повторная запись. */
  baseRevision: number
}

/** Минимум от `Storage`, чтобы тест мог подсунуть мок. */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

interface StoredShape {
  v: 1
  base64: string
  revision: number
}

/**
 * Складывает апдейт и базовую ревизию. Возвращает `false`, если сохранить не
 * удалось (нет storage, квота, слишком большой апдейт) — вызывающий не должен
 * считать это ошибкой: обычный путь сохранения остаётся.
 */
export function saveDeferredState(
  projectId: string,
  update: Uint8Array,
  baseRevision: number,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false
  if (update.byteLength === 0) return false
  if (update.byteLength > MAX_DEFERRED_BYTES) return false

  const payload: StoredShape = {
    v: 1,
    base64: bytesToBase64(update),
    revision: Number.isFinite(baseRevision) && baseRevision > 0 ? Math.floor(baseRevision) : 0,
  }
  try {
    storage.setItem(deferredStateKey(projectId), JSON.stringify(payload))
    return true
  } catch {
    // Приватный режим и переполненная квота кидают именно здесь.
    return false
  }
}

/**
 * Читает запас. Битые/чужие данные (другая версия схемы, испорченный base64)
 * не должны ронять страницу проекта — просто считаем, что запаса нет.
 */
export function readDeferredState(
  projectId: string,
  storage: StorageLike | null = defaultStorage(),
): PendingState | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(deferredStateKey(projectId))
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape>
    if (!parsed || parsed.v !== 1 || typeof parsed.base64 !== 'string') return null
    const update = base64ToBytes(parsed.base64)
    if (update.byteLength === 0) return null
    const revision = Number(parsed.revision)
    return { update, baseRevision: Number.isFinite(revision) && revision > 0 ? revision : 0 }
  } catch {
    return null
  }
}

/** Убирает запас. Вызывается только после успешной записи снапшота. */
export function clearDeferredState(
  projectId: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.removeItem(deferredStateKey(projectId))
  } catch {
    /* ignore: не убрать запас не так страшно, как упасть на уходе со страницы */
  }
}

/**
 * `localStorage` может быть недоступен целиком: Safari в приватном режиме
 * бросает уже на обращении к свойству, поэтому и здесь `try`.
 */
export function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}
