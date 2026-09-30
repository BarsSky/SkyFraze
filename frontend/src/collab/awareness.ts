/**
 * Присутствие: кто сейчас в проекте, какое событие правит и печатает ли.
 *
 * Зачем свой формат, а не `y-protocols/awareness`. Хаб — «глупый» релей: он
 * рассылает байты всем, кроме отправителя, и всегда помечает их binary
 * (`backend/internal/collab/hub.go`), а при подключении сам присылает CRDT-снапшот.
 * Поэтому даже со стандартным awareness всё равно пришлось бы придумывать
 * обрамление кадра. Здесь оно и живёт: текстовый префикс `sfp1:` + JSON. Это
 * читается в devtools, проверяется структурно и не требует новых зависимостей
 * (`y-protocols` лежит только транзитивно, объявлять его ради одного класса —
 * лишний риск в lockfile).
 *
 * Присутствие эфемерно и НЕ пишется ни в снапшот, ни в базу: участие живёт
 * `timeoutMs`, продлевается ударом раз в `heartbeatMs`, удаление себя рассылается
 * явно при уходе. Призраков снимает тот же таймаут, что и в CRDT-мире.
 *
 * Логика намеренно оторвана от WebSocket и React: `createPresence` ничего не
 * знает про сокет, а только отдаёт кадры наружу и принимает их внутрь. Поэтому
 * её поведение проверяется юнит-тестами с подменённым временем.
 */

import { randomId } from '../lib/uuid'

/** Личность человека: id из профиля и отображаемое имя. */
export interface PresenceUser {
  id: string
  name: string
}

/** Что человек сообщает о себе соседям. */
export interface LocalPresence {
  userId: string
  name: string
  /** Событие, которое он сейчас правит (открытая форма в панели редакторов). */
  eventId: string | null
  /** Печатает прямо сейчас (поле в фокусе и есть свежие нажатия). */
  typing: boolean
}

/** Состояние соседа: локальное состояние плюс то, что нужно интерфейсу. */
export interface PeerState extends LocalPresence {
  /** Идентификатор соединения (вкладки), а не человека: их может быть несколько. */
  clientId: string
  /** Инициалы для аватарки. */
  initials: string
  /** Стабильный цвет аватарки: один и тот же человек в любом браузере. */
  color: string
}

/** Одна запись кадра: `k` — счётчик (LWW), `s` — состояние или null (ушёл). */
export interface PresenceFrameEntry {
  c: string
  k: number
  s: LocalPresence | null
}

/** Кадр присутствия целиком (экспортирован ради тестов формата). */
export interface PresenceFrame {
  v: 1
  peers: PresenceFrameEntry[]
}

/**
 * Префикс кадра присутствия. Выбран так, чтобы валидный Yjs-апдейт не мог пройти
 * разбор: помимо префикса требуются корректный JSON, версия, массив записей,
 * строковый id вкладки вида UUID и объявленная длина. Для Yjs-апдейта всё это
 * вместе невозможно, а разойдись что-то одно — кадр уходит в CRDT как обычно.
 */
export const PRESENCE_PREFIX = 'sfp1:'

const DEFAULT_HEARTBEAT_MS = 15_000
/** Три пропущенных удара: столько живёт запись соседа без обновлений. */
const DEFAULT_TIMEOUT_MS = 45_000

export interface PresenceOptions {
  user: PresenceUser
  /** Идентификатор вкладки; по умолчанию случайный. */
  clientId?: string
  /** Время, мс. Подменяется в тестах. */
  now?: () => number
  heartbeatMs?: number
  timeoutMs?: number
  setIntervalFn?: (handler: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
}

export interface Presence {
  readonly clientId: string
  /** Текущее локальное состояние. */
  local(): LocalPresence
  /** Какое событие правим (и печатаем ли). Повторные вызовы с тем же значением бесплатны. */
  setEditing(eventId: string | null, typing?: boolean): void
  /** Сообщить о себе немедленно: после подключения, переподключения, смены имени. */
  announce(): void
  /** Живые соседи, отсортированные для показа. */
  peers(): PeerState[]
  /** Кадры, которые надо отправить в сокет. */
  onOutgoing(handler: (frame: Uint8Array) => void): () => void
  /** Принять кадр. `true` — кадр был наш (и уже применён). */
  receive(data: Uint8Array | string): boolean
  /** Подписка на изменения присутствия; возвращает отписку. */
  subscribe(listener: (peers: PeerState[]) => void): () => void
  /** Уйти: разослать удаление себя и забыть соседей. */
  leave(): void
  /** Остановить таймеры и снять подписчиков. */
  close(): void
}

/** Догоняющий счётчик (clock) монотонен и никогда не уменьшается. */
interface PeerRecord {
  key: number
  state: LocalPresence | null
  updatedAt: number
}

function writeFrame(message: PresenceFrame): Uint8Array {
  const json = JSON.stringify(message)
  const text = `${PRESENCE_PREFIX}${json.length}:${json}`
  return new TextEncoder().encode(text)
}

/** Байты префикса: по ним кадр отсеивается до декодирования в строку. */
const PREFIX_BYTES = new TextEncoder().encode(PRESENCE_PREFIX)

function hasPresencePrefix(data: Uint8Array): boolean {
  if (data.byteLength < PREFIX_BYTES.byteLength) return false
  for (let i = 0; i < PREFIX_BYTES.byteLength; i += 1) {
    if (data[i] !== PREFIX_BYTES[i]) return false
  }
  return true
}

/**
 * Разбирает кадр присутствия. `null` — это не наш кадр (значит, это Yjs-апдейт),
 * повреждённый или чужой формат: вызывающий просто передаёт байты дальше.
 *
 * Байтовый префикс проверяется ДО декодирования: через этот же сокет приходит
 * снапшот состояния, и превращать его в строку на каждом кадре незачем.
 */
export function decodePresenceFrame(data: Uint8Array | string): PresenceFrame | null {
  if (typeof data !== 'string') {
    if (!hasPresencePrefix(data)) return null
  }
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  if (!text.startsWith(PRESENCE_PREFIX)) return null

  const rest = text.slice(PRESENCE_PREFIX.length)
  const split = rest.indexOf(':')
  if (split <= 0) return null

  const declared = Number(rest.slice(0, split))
  const json = rest.slice(split + 1)
  // Объявленная длина обязана совпасть: так кадр нельзя «притвориться» текстом
  // случайного Yjs-апдейта, у которого совпал префикс.
  if (!Number.isInteger(declared) || declared !== json.length) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const message = parsed as Partial<PresenceFrame>
  if (message.v !== 1 || !Array.isArray(message.peers)) return null

  const peers: PresenceFrameEntry[] = []
  for (const raw of message.peers) {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Partial<PresenceFrameEntry>
    if (typeof entry.c !== 'string' || entry.c.length === 0) return null
    if (typeof entry.k !== 'number' || !Number.isFinite(entry.k)) return null
    if (entry.s === null || entry.s === undefined) {
      peers.push({ c: entry.c, k: entry.k, s: null })
      continue
    }
    const state = entry.s as Partial<LocalPresence>
    if (typeof state.userId !== 'string' || typeof state.name !== 'string') return null
    peers.push({
      c: entry.c,
      k: entry.k,
      s: {
        userId: state.userId,
        name: state.name,
        eventId: typeof state.eventId === 'string' ? state.eventId : null,
        typing: state.typing === true,
      },
    })
  }
  return { v: 1, peers }
}

/** Инициалы для аватарки: «Аня Ваар» → «АВ», «Аня» → «А». */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0] ?? '?'
  const second = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''
  return (first + second).toUpperCase()
}

/**
 * Цвет человека: стабильный хеш от id. Одинаковый в любом браузере и без
 * согласования между клиентами — иначе «Аня» была бы зелёной у себя и синей у
 * соседа, и легенда теряла бы смысл.
 */
export function colorFor(userId: string): string {
  let hash = 2166136261
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 62% 42%)`
}

/** Соседи, которые сейчас правят указанное событие. */
export function editingPeers(peers: PeerState[], eventId: string): PeerState[] {
  return peers.filter((peer) => peer.eventId === eventId)
}

/**
 * Подпись «печатает…» для события. Одна на всё приложение: формулировка не должна
 * разъезжаться между панелью редакторов и кадром.
 */
export function typingLabel(peers: PeerState[], eventId: string): string | null {
  const typing = editingPeers(peers, eventId).filter((peer) => peer.typing)
  if (typing.length === 0) return null
  if (typing.length === 1) return `${typing[0].name} печатает…`
  if (typing.length === 2) return `${typing[0].name} и ${typing[1].name} печатают…`
  return `печатают ${typing.length} человека`
}

/** Порядок показа: сначала те, кто печатает, затем по имени, затем по соединению. */
function sortPeers(peers: PeerState[]): PeerState[] {
  return [...peers].sort((a, b) => {
    if (a.typing !== b.typing) return a.typing ? -1 : 1
    const byName = a.name.localeCompare(b.name, 'ru')
    if (byName !== 0) return byName
    return a.clientId.localeCompare(b.clientId)
  })
}

/**
 * Присутствие одной вкладки. Таймеры (удар и уборка призраков) живут внутри и
 * снимаются в `close`, поэтому размонтирование страницы не оставляет интервалов.
 */
export function createPresence(options: PresenceOptions): Presence {
  const now = options.now ?? (() => Date.now())
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const setIntervalFn =
    options.setIntervalFn ?? ((handler: () => void, ms: number) => setInterval(handler, ms))
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))

  const clientId = options.clientId ?? randomId()
  const peers = new Map<string, PeerRecord>()
  const outgoing = new Set<(frame: Uint8Array) => void>()
  const listeners = new Set<(peers: PeerState[]) => void>()
  let closed = false
  let key = 0

  let local: LocalPresence = {
    userId: options.user.id,
    name: options.user.name,
    eventId: null,
    typing: false,
  }

  const send = (message: PresenceFrame) => {
    if (closed) return
    const frame = writeFrame(message)
    for (const handler of outgoing) handler(frame)
  }

  const broadcastLocal = () => {
    key += 1
    send({ v: 1, peers: [{ c: clientId, k: key, s: local }] })
  }

  const snapshot = (): PeerState[] => {
    // Одного человека может быть видно из нескольких вкладок: в карточке он один,
    // иначе «Аня» появлялась бы дважды. Побеждает та вкладка, где он печатает,
    // иначе — где состояние свежее.
    const byUser = new Map<string, { record: PeerRecord; clientId: string }>()
    for (const [id, record] of peers) {
      const userId = record.state?.userId || id
      const current = byUser.get(userId)
      const better =
        !current ||
        (record.state?.typing === true && current.record.state?.typing !== true) ||
        (record.state?.typing === current.record.state?.typing && record.updatedAt > current.record.updatedAt)
      if (better) byUser.set(userId, { record, clientId: id })
    }
    return sortPeers(
      [...byUser.values()].map(({ record, clientId: id }) => ({
        clientId: id,
        userId: record.state?.userId ?? '',
        name: record.state?.name ?? '',
        eventId: record.state?.eventId ?? null,
        typing: record.state?.typing === true,
        initials: initialsOf(record.state?.name ?? ''),
        color: colorFor(record.state?.userId ?? id),
      })),
    )
  }

  /**
   * Подписчиков дёргаем только на видимое изменение: удар сердца обновляет
   * `updatedAt` у соседа каждые 15 с, но в интерфейсе от этого не меняется
   * ничего, а лишняя перерисовка панели редакторов на ровном месте не нужна.
   */
  let lastSignature = ''
  const notify = () => {
    const list = snapshot()
    const signature = list
      .map((peer) => `${peer.clientId}:${peer.userId}:${peer.name}:${peer.eventId ?? ''}:${peer.typing ? 1 : 0}`)
      .join('|')
    if (signature === lastSignature) return
    lastSignature = signature
    for (const listener of listeners) listener(list)
  }

  /** Соседи без обновлений дольше таймаута — призраки: соединение умерло молча. */
  const sweep = () => {
    const limit = now() - timeoutMs
    let changed = false
    for (const [id, record] of peers) {
      if (record.updatedAt < limit) {
        peers.delete(id)
        changed = true
      }
    }
    if (changed) notify()
  }

  const timer = setIntervalFn(() => {
    sweep()
    broadcastLocal()
  }, heartbeatMs)

  return {
    clientId,
    local: () => ({ ...local }),

    setEditing(nextEventId: string | null, typing = false) {
      if (closed) return
      const eventId = nextEventId === '' ? null : nextEventId
      if (local.eventId === eventId && local.typing === typing) return
      local = { ...local, eventId, typing }
      broadcastLocal()
    },

    peers: snapshot,

    announce() {
      broadcastLocal()
    },

    onOutgoing(handler) {
      outgoing.add(handler)
      return () => outgoing.delete(handler)
    },

    receive(data) {
      if (closed) return false
      const message = decodePresenceFrame(data)
      if (!message) return false

      let changed = false
      let sawNewPeer = false
      for (const entry of message.peers) {
        // Себя в списке соседей не держим: хаб не возвращает кадр отправителю, но
        // защита от собственного эха не должна зависеть от этого.
        if (entry.c === clientId) continue
        const record = peers.get(entry.c)
        if (record && record.key >= entry.k) continue // устаревшая запись: игнорируем
        if (entry.s === null) {
          if (record) {
            peers.delete(entry.c)
            changed = true
          }
          continue
        }
        if (!record) sawNewPeer = true
        peers.set(entry.c, { key: entry.k, state: entry.s, updatedAt: now() })
        changed = true
      }
      if (changed) notify()
      // Новый сосед не знает про нас: его первый кадр — повод отправить своё
      // состояние сразу, не дожидаясь удара (иначе «кто в проекте» появлялся бы
      // с задержкой до heartbeatMs).
      if (sawNewPeer) broadcastLocal()
      return true
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    leave() {
      if (closed) return
      // Явное «я ушёл»: соседи убирают нас сразу, а не через таймаут.
      key += 1
      send({ v: 1, peers: [{ c: clientId, k: key, s: null }] })
      peers.clear()
      notify()
    },

    close() {
      if (closed) return
      closed = true
      clearIntervalFn(timer)
      outgoing.clear()
      listeners.clear()
      peers.clear()
    },
  }
}
