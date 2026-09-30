import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  PRESENCE_PREFIX,
  colorFor,
  createPresence,
  decodePresenceFrame,
  editingPeers,
  initialsOf,
  typingLabel,
  type PeerState,
  type PresenceFrame,
} from './awareness'

/**
 * Присутствие живёт поверх того же сокета, что и CRDT, и делит с ним канал.
 * Поэтому проверяется ровно две вещи: кадр присутствия нельзя спутать с
 * Yjs-апдейтом, и состояние соседей сходится (LWW по счётчику, призраки — по
 * таймауту). Время и таймеры подменяются, поэтому тест детерминированный.
 */
function harness(clientId = 'tab-1', name = 'Аня Ваар', userId = 'u1') {
  let current = 1_000_000
  const timers: { handler: () => void; ms: number }[] = []
  const frames: PresenceFrame[] = []
  const presence = createPresence({
    user: { id: userId, name },
    clientId,
    now: () => current,
    heartbeatMs: 15_000,
    timeoutMs: 45_000,
    setIntervalFn: (handler, ms) => {
      timers.push({ handler, ms })
      return timers.length - 1
    },
    clearIntervalFn: () => {
      timers.length = 0
    },
  })
  presence.onOutgoing((frame) => {
    const parsed = decodePresenceFrame(frame)
    if (parsed) frames.push(parsed)
  })
  return {
    presence,
    frames,
    /** Сдвинуть время и дать сработать удару/уборке. */
    tick(ms: number) {
      current += ms
      for (const timer of [...timers]) timer.handler()
    },
    intervalMs: () => timers[0]?.ms ?? 0,
    timersAlive: () => timers.length > 0,
  }
}

describe('кадр присутствия', () => {
  it('переживает круговой обход, включая кириллицу и id вкладки', () => {
    const frame = { v: 1 as const, peers: [{ c: 'tab-7', k: 3, s: { userId: 'u9', name: 'Борис Ёж', eventId: 'e1', typing: true } }] }
    const bytes = new TextEncoder().encode(`${PRESENCE_PREFIX}${JSON.stringify(frame).length}:${JSON.stringify(frame)}`)
    expect(decodePresenceFrame(bytes)).toEqual(frame)
    expect(decodePresenceFrame(new TextDecoder().decode(bytes))).toEqual(frame)
  })

  it('настоящий Yjs-апдейт за присутствие не принимается', () => {
    const doc = new Y.Doc()
    doc.getArray('events').push([new Y.Map()])
    const update = Y.encodeStateAsUpdate(doc)
    expect(decodePresenceFrame(update)).toBeNull()
    // И даже если у апдейта случайно совпал префикс — разбор не пройдёт.
    const fake = new Uint8Array([...new TextEncoder().encode(PRESENCE_PREFIX), 1, 2, 3, 255])
    expect(decodePresenceFrame(fake)).toBeNull()
  })

  it('битые кадры отвергаются, а не «примерно» разбираются', () => {
    const bad = [
      `${PRESENCE_PREFIX}5:{"v":1,"peers":[]}`, // длина не совпала
      `${PRESENCE_PREFIX}18:{"v":2,"peers":[]}`, // чужая версия
      `${PRESENCE_PREFIX}17:{"v":1,"peers":{}}`, // peers не массив
      `${PRESENCE_PREFIX}20:{"v":1,"peers":[{"k":1}]}`, // нет id вкладки
      `${PRESENCE_PREFIX}26:{"v":1,"peers":[{"c":"x","k":1,"s":{"userId":1}}]}`,
      `${PRESENCE_PREFIX}без длины`,
      'sfp2:1:{"v":1,"peers":[]}',
      '',
    ]
    for (const text of bad) expect(decodePresenceFrame(text)).toBeNull()
  })

  it('null в записи — это «сосед ушёл», и он остаётся валидным кадром', () => {
    const json = '{"v":1,"peers":[{"c":"tab-2","k":4,"s":null}]}'
    expect(decodePresenceFrame(`${PRESENCE_PREFIX}${json.length}:${json}`)).toEqual({
      v: 1,
      peers: [{ c: 'tab-2', k: 4, s: null }],
    })
  })
})

describe('присутствие вкладки', () => {
  it('сообщает о себе по запросу и по удару сердца', () => {
    const h = harness()
    expect(h.frames).toHaveLength(0)
    h.presence.announce()
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].peers[0]).toMatchObject({ c: 'tab-1', k: 1, s: { userId: 'u1', name: 'Аня Ваар', eventId: null, typing: false } })

    h.tick(15_000)
    expect(h.frames).toHaveLength(2)
    expect(h.frames[1].peers[0].k).toBe(2)
    expect(h.intervalMs()).toBe(15_000)
  })

  it('setEditing рассылает состояние только при реальном изменении', () => {
    const h = harness()
    h.presence.announce()
    h.presence.setEditing('e1', true)
    expect(h.frames).toHaveLength(2)
    expect(h.frames[1].peers[0].s).toMatchObject({ eventId: 'e1', typing: true })

    h.presence.setEditing('e1', true)
    h.presence.setEditing('')
    expect(h.frames).toHaveLength(3)
    expect(h.frames[2].peers[0].s).toMatchObject({ eventId: null, typing: false })
  })

  it('сосед появляется, обновляется по счётчику и уходит по null', () => {
    const h = harness()
    const seen: PeerState[][] = []
    h.presence.subscribe((peers) => seen.push(peers))

    const peer = (k: number, s: unknown) => `${PRESENCE_PREFIX}${JSON.stringify({ v: 1, peers: [{ c: 'tab-2', k, s }] }).length}:${JSON.stringify({ v: 1, peers: [{ c: 'tab-2', k, s }] })}`

    expect(h.presence.receive(peer(1, { userId: 'u2', name: 'Борис', eventId: 'e1', typing: true }))).toBe(true)
    expect(h.presence.peers()).toHaveLength(1)
    expect(h.presence.peers()[0]).toMatchObject({ name: 'Борис', eventId: 'e1', typing: true })
    expect(h.presence.peers()[0].initials).toBe('Б')
    expect(h.presence.peers()[0].color).toBe(colorFor('u2'))

    // Устаревший счётчик не откатывает состояние назад.
    h.presence.receive(peer(1, { userId: 'u2', name: 'Старое имя', eventId: null, typing: false }))
    expect(h.presence.peers()[0].name).toBe('Борис')

    // Новый счётчик обновляет.
    h.presence.receive(peer(2, { userId: 'u2', name: 'Борис Ёж', eventId: null, typing: false }))
    expect(h.presence.peers()[0].name).toBe('Борис Ёж')

    // Явный уход убирает сразу, без ожидания таймаута.
    h.presence.receive(peer(3, null))
    expect(h.presence.peers()).toHaveLength(0)
    expect(seen.length).toBeGreaterThanOrEqual(3)
  })

  it('новый сосед получает наше состояние сразу, не дожидаясь удара', () => {
    const h = harness()
    h.presence.announce()
    const before = h.frames.length
    const msg = { v: 1, peers: [{ c: 'tab-9', k: 1, s: { userId: 'u9', name: 'Новый', eventId: null, typing: false } }] }
    h.presence.receive(`${PRESENCE_PREFIX}${JSON.stringify(msg).length}:${JSON.stringify(msg)}`)
    expect(h.frames.length).toBe(before + 1)
    expect(h.frames[h.frames.length - 1].peers[0].c).toBe('tab-1')
  })

  it('себя в списке соседей не показывает, даже если кадр вернулся эхом', () => {
    const h = harness('tab-1')
    const msg = { v: 1, peers: [{ c: 'tab-1', k: 5, s: { userId: 'u1', name: 'Аня Ваар', eventId: null, typing: false } }] }
    expect(h.presence.receive(`${PRESENCE_PREFIX}${JSON.stringify(msg).length}:${JSON.stringify(msg)}`)).toBe(true)
    expect(h.presence.peers()).toHaveLength(0)
  })

  it('две вкладки одного человека — одна карточка, побеждает печатающая', () => {
    const h = harness()
    const frameOf = (entries: unknown[]) => {
      const msg = { v: 1, peers: entries }
      return `${PRESENCE_PREFIX}${JSON.stringify(msg).length}:${JSON.stringify(msg)}`
    }
    h.presence.receive(frameOf([
      { c: 'tab-a', k: 1, s: { userId: 'u2', name: 'Борис', eventId: 'e1', typing: false } },
      { c: 'tab-b', k: 1, s: { userId: 'u2', name: 'Борис', eventId: 'e2', typing: true } },
    ]))
    const peers = h.presence.peers()
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ clientId: 'tab-b', eventId: 'e2', typing: true })
  })

  it('удар сердца не перерисовывает интерфейс, если видимое состояние не изменилось', () => {
    const h = harness()
    const seen: number[] = []
    h.presence.subscribe((peers) => seen.push(peers.length))
    const state = { userId: 'u2', name: 'Борис', eventId: 'e1', typing: false }
    const frame = (k: number) => {
      const msg = { v: 1, peers: [{ c: 'tab-2', k, s: state }] }
      return `${PRESENCE_PREFIX}${JSON.stringify(msg).length}:${JSON.stringify(msg)}`
    }
    h.presence.receive(frame(1))
    expect(seen).toHaveLength(1)
    // Тот же сосед с тем же состоянием, но новым счётчиком — это пульс, а не новость.
    h.presence.receive(frame(2))
    h.presence.receive(frame(3))
    expect(seen).toHaveLength(1)
    // А смена состояния — новость.
    const typing = { v: 1, peers: [{ c: 'tab-2', k: 4, s: { ...state, typing: true } }] }
    h.presence.receive(`${PRESENCE_PREFIX}${JSON.stringify(typing).length}:${JSON.stringify(typing)}`)
    expect(seen).toHaveLength(2)
  })

  it('призрак без обновлений снимается по таймауту', () => {    const h = harness()
    const msg = { v: 1, peers: [{ c: 'tab-2', k: 1, s: { userId: 'u2', name: 'Борис', eventId: null, typing: false } }] }
    h.presence.receive(`${PRESENCE_PREFIX}${JSON.stringify(msg).length}:${JSON.stringify(msg)}`)
    expect(h.presence.peers()).toHaveLength(1)

    h.tick(44_000)
    expect(h.presence.peers()).toHaveLength(1)
    h.tick(2_000)
    expect(h.presence.peers()).toHaveLength(0)
  })

  it('leave рассылает уход, close снимает таймеры', () => {
    const h = harness()
    h.presence.announce()
    h.presence.leave()
    const last = h.frames[h.frames.length - 1]
    expect(last.peers[0].c).toBe('tab-1')
    expect(last.peers[0].s).toBeNull()

    h.presence.close()
    expect(h.timersAlive()).toBe(false)
    const after = h.frames.length
    h.presence.announce()
    h.presence.setEditing('e1', true)
    expect(h.frames.length).toBe(after)
  })
})

describe('подписи и цвета', () => {
  it('инициалы берутся из имени, а не из одного слова', () => {
    expect(initialsOf('Аня Ваар')).toBe('АВ')
    expect(initialsOf('Борис')).toBe('Б')
    expect(initialsOf('  ')).toBe('?')
  })

  it('цвет зависит только от id человека: у всех клиентов одинаковый', () => {
    expect(colorFor('u1')).toBe(colorFor('u1'))
    expect(colorFor('u1')).not.toBe(colorFor('u2'))
    expect(colorFor('u1')).toMatch(/^hsl\(/)
  })

  it('«печатает…» формулируется в одном месте и не дублирует имена', () => {
    const peer = (name: string, typing: boolean, eventId = 'e1'): PeerState => ({
      clientId: name, userId: name, name, eventId, typing, initials: initialsOf(name), color: colorFor(name),
    })
    expect(typingLabel([], 'e1')).toBeNull()
    expect(typingLabel([peer('Аня', false)], 'e1')).toBeNull()
    expect(typingLabel([peer('Аня', true)], 'e1')).toBe('Аня печатает…')
    expect(typingLabel([peer('Аня', true), peer('Борис', true)], 'e1')).toBe('Аня и Борис печатают…')
    expect(typingLabel([peer('Аня', true), peer('Борис', true), peer('Вера', true)], 'e1')).toBe('печатают 3 человека')
    // Чужое событие не считается.
    expect(typingLabel([peer('Аня', true, 'e2')], 'e1')).toBeNull()
  })

  it('editingPeers отдаёт тех, кто правит это событие', () => {
    const peer = (name: string, eventId: string | null): PeerState => ({
      clientId: name, userId: name, name, eventId, typing: false, initials: initialsOf(name), color: colorFor(name),
    })
    expect(editingPeers([peer('Аня', 'e1'), peer('Борис', null), peer('Вера', 'e1')], 'e1').map((p) => p.name)).toEqual(['Аня', 'Вера'])
  })
})
