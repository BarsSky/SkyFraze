/**
 * Обмен правками между вкладками одного пользователя через `BroadcastChannel`.
 *
 * Зачем. У CRDT-транспорта было ровно два пути: WebSocket до сервера и REST-снапшот.
 * Две вкладки одного человека не видели друг друга вообще — правка в первой
 * появлялась во второй только после перезагрузки или после того, как её вернёт
 * сервер. Хуже: вторая вкладка со своим (пустым) представлением могла сохранить
 * снапшот и «откатить» правку первой.
 *
 * Как. Канал с именем проекта получает локальные Y-апдейты с меткой вкладки и
 * применяет чужие. Апдейт — это не состояние, а CRDT-дельта: даже если каналы
 * пришли не по порядку, `Y.applyUpdate` сходится к одному документу.
 *
 * Что важно не сломать: эхо. Раскладываем зеркало из двух шагов —
 *  1. апдейт, пришедший от другой вкладки или от сервера, НЕ пересылается обратно
 *     (иначе две вкладки гоняли бы один и тот же апдейт по кругу);
 *  2. апдейт, пришедший из канала, применяется к доку, но не считается «своим»,
 *     поэтому обработчик `doc.on('update')` его не перешлёт.
 */

import * as Y from 'yjs'

/** Префикс имени канала: в одном браузере могут быть открыты разные проекты. */
export const CHANNEL_PREFIX = 'skyfraze-collab:'

export function channelName(projectId: string): string {
  return `${CHANNEL_PREFIX}${projectId}`
}

/** Один апдейт в канале: `tabId` нужен только для «свой/чужой». */
interface Envelope {
  tabId: string
  update: string // base64
}

/**
 * Минимум возможностей `BroadcastChannel`, который нам нужен. Своим интерфейсом
 * (а не встроенным типом) это сделано ради теста: канал подменяется моком, и
 * проверяется именно логика доставки.
 */
export interface ChannelLike {
  postMessage: (message: unknown) => void
  close: () => void
  onmessage: ((event: { data: unknown }) => void) | null
}

export type ChannelFactory = (name: string) => ChannelLike | null

/** Метка вкладки: по ней отсеиваем собственные сообщения. */
function newTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* не защищённый контекст — идём дальше */
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** base64 без spread: большой снапшот иначе разворачивается в аргументы и падает на стеке. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Применить сообщение канала к документу.
 *
 * Возвращает `true`, только если это был чужой корректный апдейт — вызывающий по
 * этому признаку решает, надо ли сохранять снапшот. Своё сообщение (эхо канала),
 * мусор и апдейт без изменений возвращают `false`.
 */
export function applyChannelMessage(doc: Y.Doc, tabId: string, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const envelope = data as Partial<Envelope>
  if (typeof envelope.tabId !== 'string' || typeof envelope.update !== 'string') return false
  if (envelope.tabId === tabId) return false

  let update: Uint8Array
  try {
    update = base64ToBytes(envelope.update)
  } catch {
    return false // повреждённое сообщение: молча пропускаем, документ важнее
  }

  const before = Y.encodeStateVector(doc)
  try {
    Y.applyUpdate(doc, update, 'peer')
  } catch {
    return false // чужой/несовместимый апдейт не должен ронять вкладку
  }
  // Пустой (или уже применённый) апдейт не меняет состояние: сохранять нечего.
  return !equalStateVectors(before, Y.encodeStateVector(doc))
}

function equalStateVectors(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Доступен ли `BroadcastChannel`. В старых браузерах и в части webview его нет —
 * тогда вкладки просто работают как раньше (через сервер), без ошибок в консоли.
 */
export function defaultChannelFactory(name: string): ChannelLike | null {
  try {
    if (typeof BroadcastChannel !== 'function') return null
    return new BroadcastChannel(name) as unknown as ChannelLike
  } catch {
    // Приватный режим/политика браузера могут запретить сам конструктор.
    return null
  }
}

export interface TabChannel {
  /**
   * Отправить локальный апдейт другим вкладкам.
   *
   * Апдейты с origin 'remote'/'peer' НЕ пересылаются: они уже пришли извне, и
   * рассылать их обратно — это эхо, которое крутится между вкладками бесконечно.
   */
  publish: (update: Uint8Array, origin: unknown) => void
  /** Закрыть канал. После размонтирования он не должен держать вкладку живой. */
  close: () => void
  /** Доступен ли канал (для тестов и диагностики). */
  readonly available: boolean
  /** Метка этой вкладки — по ней отсеиваются свои сообщения. */
  readonly tabId: string
}

/**
 * Канал вкладки для проекта. Ничего не бросает: если `BroadcastChannel` нет или
 * конструктор упал, возвращается «пустышка» с `available: false`.
 */
export function createTabChannel(
  projectId: string,
  onRemoteUpdate: (update: Uint8Array) => void,
  doc: Y.Doc,
  factory: ChannelFactory = defaultChannelFactory,
  tabId: string = newTabId(),
): TabChannel {
  const outboundOrigins = new Set(['remote', 'peer'])
  let channel: ChannelLike | null = null
  try {
    channel = factory(channelName(projectId))
  } catch {
    channel = null
  }

  if (channel) {
    channel.onmessage = (event) => {
      // Применяем сами: обработчик канала живёт вне React и не должен зависеть
      // от того, отрисован ли компонент.
      if (applyChannelMessage(doc, tabId, event.data)) {
        onRemoteUpdate(Y.encodeStateAsUpdate(doc))
      }
    }
  }

  return {
    available: channel !== null,
    tabId,
    publish(update, origin) {
      if (!channel) return
      if (outboundOrigins.has(origin as string)) return
      if (update.byteLength === 0) return
      try {
        const envelope: Envelope = { tabId, update: bytesToBase64(update) }
        channel.postMessage(envelope)
      } catch {
        // Квота/сериализация: realtime-канал вкладок — бонус, а не источник правды.
      }
    },
    close() {
      if (!channel) return
      channel.onmessage = null
      try {
        channel.close()
      } catch {
        /* ignore */
      }
      channel = null
    },
  }
}

/**
 * Мост «документ ↔ канал».
 *
 * Возвращает функцию отписки. Подписка на `doc.on('update')` нужна, а не вызов
 * `publish` из `yprovider`: апдейты приходят и из мест, которые про канал не
 * знают (перенос поддерева, сид из REST, применение чужого снапшота).
 */
export function connectTabChannel(doc: Y.Doc, channel: TabChannel): () => void {
  if (!channel.available) return () => {}
  const onUpdate = (update: Uint8Array, origin: unknown) => channel.publish(update, origin)
  doc.on('update', onUpdate)
  return () => {
    doc.off('update', onUpdate)
    channel.close()
  }
}
