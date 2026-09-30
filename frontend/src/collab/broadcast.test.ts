import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  CHANNEL_PREFIX,
  applyChannelMessage,
  base64ToBytes,
  bytesToBase64,
  channelName,
  connectTabChannel,
  createTabChannel,
  defaultChannelFactory,
  type ChannelLike,
} from './broadcast'
import { yAddEvent } from './yprovider'

/**
 * Обмен между вкладками одного пользователя. Канал подменяем моком: проверяем
 * именно логику доставки, дедупликации и защиты от эха, а не браузерный
 * BroadcastChannel.
 */
function mockChannel() {
  const sent: unknown[] = []
  const channel: ChannelLike = {
    onmessage: null,
    postMessage: (message) => sent.push(message),
    close: () => { closed = true },
  }
  let closed = false
  return {
    channel,
    sent,
    isClosed: () => closed,
    /** Доставить сообщение «в эту вкладку» так, как это сделал бы браузер. */
    receive: (data: unknown) => channel.onmessage?.({ data }),
  }
}

describe('имя канала и кодирование', () => {
  it('канал привязан к проекту: два проекта в одном браузере не смешиваются', () => {
    expect(channelName('p1')).toBe(`${CHANNEL_PREFIX}p1`)
    expect(channelName('p1')).not.toBe(channelName('p2'))
  })

  it('base64 переживает круговой обход любого набора байт', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42, 7])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
    // Большой буфер: кодирование не должно падать на разворачивании аргументов.
    const big = new Uint8Array(200_000)
    big[199_999] = 9
    const round = base64ToBytes(bytesToBase64(big))
    expect(round.length).toBe(big.length)
    expect(round[199_999]).toBe(9)
  })
})

describe('applyChannelMessage', () => {
  const makeDoc = () => {
    const doc = new Y.Doc()
    const events = doc.getArray<Y.Map<unknown>>('events')
    return { doc, events }
  }

  it('применяет чужой апдейт и сообщает об этом', () => {
    const source = makeDoc()
    yAddEvent(source.events, 'Глава из первой вкладки', 'текст')
    const update = Y.encodeStateAsUpdate(source.doc)

    const target = makeDoc()
    const applied = applyChannelMessage(target.doc, 'tab-target', {
      tabId: 'tab-source',
      update: bytesToBase64(update),
    })

    expect(applied).toBe(true)
    expect(target.events.length).toBe(1)
    expect(target.events.get(0).get('title')).toBe('Глава из первой вкладки')
  })

  it('своё же сообщение (эхо канала) игнорирует', () => {
    const { doc, events } = makeDoc()
    yAddEvent(events, 'Глава')
    const applied = applyChannelMessage(doc, 'tab-1', {
      tabId: 'tab-1',
      update: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    })
    expect(applied).toBe(false)
  })

  it('повторно пришедший апдейт не считается изменением', () => {
    const source = makeDoc()
    const events = docEvents(source.doc)
    yAddEvent(events, 'Глава')
    const envelope = { tabId: 'tab-source', update: bytesToBase64(Y.encodeStateAsUpdate(source.doc)) }

    const target = makeDoc()
    expect(applyChannelMessage(target.doc, 'tab-target', envelope)).toBe(true)
    // Повторная доставка того же апдейта (перезагрузка канала) — уже не новость,
    // иначе вкладка зря сохраняла бы снапшот.
    expect(applyChannelMessage(target.doc, 'tab-target', envelope)).toBe(false)
  })

  it('мусор в канале не роняет вкладку', () => {
    const { doc } = makeDoc()
    for (const data of [null, undefined, 42, 'строка', {}, { tabId: 1 }, { tabId: 'x' }, { tabId: 'x', update: '###' }]) {
      expect(applyChannelMessage(doc, 'tab-1', data)).toBe(false)
    }
  })

  it('несовместимый апдейт (чужой/битый) не применяется молча', () => {
    const { doc } = makeDoc()
    const garbage = bytesToBase64(new Uint8Array([255, 255, 255, 255, 255]))
    expect(applyChannelMessage(doc, 'tab-1', { tabId: 'tab-2', update: garbage })).toBe(false)
  })
})

describe('createTabChannel', () => {
  it('пересылает локальные апдейты соседям и применяет чужие', () => {
    const { doc, events } = makeDoc()
    const received: Uint8Array[] = []
    const mock = mockChannel()
    const channel = createTabChannel('p1', (update) => received.push(update), doc, () => mock.channel, 'tab-a')
    // Без моста «документ → канал» публиковать нечего: подписка на doc.on('update')
    // живёт в connectTabChannel, и это ровно то, что делает yprovider.
    const detach = connectTabChannel(doc, channel)

    expect(channel.available).toBe(true)
    yAddEvent(events, 'Локальная глава')

    expect(mock.sent).toHaveLength(1)
    const envelope = mock.sent[0] as { tabId: string; update: string }
    expect(envelope.tabId).toBe('tab-a')

    // Соседняя вкладка получает тот же апдейт и видит главу.
    const peer = makeDoc()
    expect(applyChannelMessage(peer.doc, 'tab-b', envelope)).toBe(true)
    expect(peer.events.length).toBe(1)

    // А входящее сообщение от соседа применяется к нашему документу.
    const fromPeer = new Y.Doc()
    yAddEvent(docEvents(fromPeer), 'Глава соседа')
    mock.receive({ tabId: 'tab-b', update: bytesToBase64(Y.encodeStateAsUpdate(fromPeer)) })
    expect(events.length).toBe(2)
    expect(received).toHaveLength(1)

    // Главное про эхо: применённый чужой апдейт НЕ рассылается обратно. Если бы
    // рассылался, `sent` вырос бы на каждое принятое сообщение и две вкладки
    // гоняли бы один апдейт по кругу.
    expect(mock.sent).toHaveLength(1)
    expect(mock.sent[0]).toMatchObject({ tabId: 'tab-a' })

    detach()
    expect(mock.isClosed()).toBe(true)
  })

  it('не пересылает обратно то, что пришло от других вкладок или сервера', () => {
    const { doc } = makeDoc()
    const mock = mockChannel()
    const channel = createTabChannel('p1', () => {}, doc, () => mock.channel, 'tab-a')

    channel.publish(Y.encodeStateAsUpdate(doc), 'peer')
    channel.publish(Y.encodeStateAsUpdate(doc), 'remote')
    expect(mock.sent).toHaveLength(0)

    // А своё локальное (origin — строка транзакции или undefined) — уходит.
    channel.publish(Y.encodeStateAsUpdate(doc), 'local')
    expect(mock.sent).toHaveLength(1)
  })

  it('пустой апдейт не гоняем по каналу', () => {
    const { doc } = makeDoc()
    const mock = mockChannel()
    const channel = createTabChannel('p1', () => {}, doc, () => mock.channel, 'tab-a')
    channel.publish(new Uint8Array(0), 'local')
    expect(mock.sent).toHaveLength(0)
  })

  it('закрытие канала снимает обработчик и закрывает его', () => {
    const { doc } = makeDoc()
    const mock = mockChannel()
    const channel = createTabChannel('p1', () => {}, doc, () => mock.channel, 'tab-a')
    channel.close()
    expect(mock.isClosed()).toBe(true)
    expect(mock.channel.onmessage).toBeNull()
  })

  it('недоступный BroadcastChannel — тихий откат, а не падение', () => {
    const { doc } = makeDoc()
    const channel = createTabChannel('p1', () => {}, doc, () => null, 'tab-a')
    expect(channel.available).toBe(false)
    // Публикация и закрытие на пустом канале не должны ничего ронять.
    expect(() => {
      channel.publish(Y.encodeStateAsUpdate(doc), 'local')
      channel.close()
    }).not.toThrow()
  })

  it('упавший конструктор канала тоже даёт тихий откат', () => {
    const { doc } = makeDoc()
    const channel = createTabChannel('p1', () => {}, doc, () => {
      throw new Error('приватный режим')
    }, 'tab-a')
    expect(channel.available).toBe(false)
  })
})

describe('connectTabChannel', () => {
  it('подписка на документ отписывается и закрывает канал', () => {
    const { doc, events } = makeDoc()
    const mock = mockChannel()
    const channel = createTabChannel('p1', () => {}, doc, () => mock.channel, 'tab-a')
    const detach = connectTabChannel(doc, channel)

    yAddEvent(events, 'Раз')
    expect(mock.sent).toHaveLength(1)

    detach()
    yAddEvent(events, 'Два')
    expect(mock.sent).toHaveLength(1)
    expect(mock.isClosed()).toBe(true)
  })

  it('на недоступном канале подписка ничего не делает и не держит ресурсы', () => {
    const { doc, events } = makeDoc()
    const channel = createTabChannel('p1', () => {}, doc, () => null, 'tab-a')
    const detach = connectTabChannel(doc, channel)
    expect(() => {
      yAddEvent(events, 'Глава')
      detach()
    }).not.toThrow()
  })
})

describe('defaultChannelFactory', () => {
  it('без BroadcastChannel в окружении возвращает null', () => {
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
    // @ts-expect-error — намеренно убираем глобал, как в старом webview
    delete globalThis.BroadcastChannel
    try {
      expect(defaultChannelFactory('skyfraze-collab:p1')).toBeNull()
    } finally {
      ;(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original
    }
  })

  it('в jsdom создаёт настоящий канал и закрывается без ошибок', () => {
    const channel = defaultChannelFactory('skyfraze-collab:test')
    if (channel) {
      expect(() => channel.close()).not.toThrow()
    }
  })
})

function makeDoc() {
  const doc = new Y.Doc()
  const events = doc.getArray<Y.Map<unknown>>('events')
  return { doc, events }
}

function docEvents(doc: Y.Doc) {
  return doc.getArray<Y.Map<unknown>>('events')
}
