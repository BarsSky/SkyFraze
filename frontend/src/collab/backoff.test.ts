import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  backoffDelay,
  createReconnectLoop,
} from './backoff'

/**
 * Политика переподключения проверяется на искусственных часах: `sleep` в тестах
 * и флаки от таймингов нам не нужны, а всю задержку считает чистая функция.
 */
describe('backoffDelay — экспонента с джиттером и потолком', () => {
  it('растёт вдвое без джиттера и упирается в потолок', () => {
    const plain = { jitter: 0 }
    expect(backoffDelay(0, plain)).toBe(500)
    expect(backoffDelay(1, plain)).toBe(1000)
    expect(backoffDelay(2, plain)).toBe(2000)
    expect(backoffDelay(3, plain)).toBe(4000)
    expect(backoffDelay(4, plain)).toBe(8000)
    // Потолок: 16 c превратились бы в 15 c, дальше — только 15 c.
    expect(backoffDelay(5, plain)).toBe(DEFAULT_MAX_DELAY_MS)
    expect(backoffDelay(20, plain)).toBe(DEFAULT_MAX_DELAY_MS)
  })

  it('джиттер уводит задержку от точной степени, но в известные границы', () => {
    // random() = 0 — нижняя граница, random() = 1 — верхняя.
    expect(backoffDelay(2, {}, () => 0)).toBe(2000 - 2000 * 0.25)
    expect(backoffDelay(2, {}, () => 1)).toBe(2000 + 2000 * 0.25)
    expect(backoffDelay(0, {}, () => 1)).toBe(500 + 500 * 0.25)
  })

  it('разброс не выводит задержку за потолок даже на границе', () => {
    for (const attempt of [0, 3, 8, 40]) {
      const low = backoffDelay(attempt, {}, () => 0)
      const high = backoffDelay(attempt, {}, () => 1)
      expect(low).toBeGreaterThanOrEqual(1)
      expect(high).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS)
    }
  })

  it('большие и мусорные номера попыток не дают NaN и бесконечности', () => {
    // 2 ** 1024 = Infinity: без ограничения показателя задержка стала бы NaN,
    // а setTimeout(NaN) — это мгновенный повтор в цикле.
    for (const attempt of [31, 1024, Number.POSITIVE_INFINITY, Number.NaN, -5]) {
      const delay = backoffDelay(attempt, {}, () => 0.5)
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS)
    }
  })

  it('настройки по умолчанию: первая попытка около 0.5 с, потолок 15 с', () => {
    expect(DEFAULT_BASE_DELAY_MS).toBe(500)
    expect(DEFAULT_MAX_DELAY_MS).toBe(15000)
  })
})

/**
 * Искусственные часы: `setTimeout` ничего не запускает сам, время двигаем вручную
 * и видим, сколько попыток и с какой задержкой запланировал цикл.
 */
function fakeTimers() {
  const pending: Array<{ id: number; delay: number; run: () => void }> = []
  let nextId = 1
  return {
    pending,
    setTimeout: (handler: () => void, ms: number) => {
      const id = nextId++
      pending.push({ id, delay: ms, run: handler })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      const at = pending.findIndex((timer) => timer.id === (id as unknown as number))
      if (at >= 0) pending.splice(at, 1)
    },
    /** Прокрутить: выполняем последний запланированный таймер. */
    tick() {
      const timer = pending.shift()
      if (!timer) throw new Error('нет запланированных таймеров')
      timer.run()
    },
  }
}

describe('createReconnectLoop', () => {
  it('планирует повторы с растущей задержкой и считает попытки', () => {
    const clock = fakeTimers()
    const connect = vi.fn()
    const failed: Array<[number, number]> = []
    const loop = createReconnectLoop({
      connect,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5, // джиттер симметричный: задержка равна точной степени
      onAttemptFailed: (attempt, delay) => failed.push([attempt, delay]),
    })

    loop.schedule()
    expect(clock.pending[0].delay).toBe(500)
    clock.tick()
    expect(connect).toHaveBeenCalledTimes(1)

    loop.schedule()
    expect(clock.pending[0].delay).toBe(1000)
    clock.tick()
    loop.schedule()
    expect(clock.pending[0].delay).toBe(2000)
    clock.tick()

    expect(connect).toHaveBeenCalledTimes(3)
    expect(failed).toEqual([[0, 500], [1, 1000], [2, 2000]])
    expect(loop.attempt()).toBe(3)
  })

  it('успешное открытие сбрасывает серию: следующая задержка снова минимальная', () => {
    const clock = fakeTimers()
    const loop = createReconnectLoop({
      connect: () => {},
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
    })

    loop.schedule()
    clock.tick()
    loop.schedule()
    clock.tick()
    loop.schedule()
    expect(loop.attempt()).toBe(3)

    loop.reset()
    expect(loop.attempt()).toBe(0)
    // Запланированное до reset уже снято, поэтому после обрыва — снова 500 мс.
    loop.schedule()
    expect(clock.pending[0].delay).toBe(500)
  })

  it('reset снимает запланированный повтор, не дожидаясь таймера', () => {
    const clock = fakeTimers()
    const connect = vi.fn()
    const loop = createReconnectLoop({
      connect,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
    })
    loop.schedule()
    loop.reset()
    expect(clock.pending).toHaveLength(0)
    expect(connect).not.toHaveBeenCalled()
  })

  it('stop после размонтирования отменяет повторы навсегда', () => {
    const clock = fakeTimers()
    const connect = vi.fn()
    const loop = createReconnectLoop({
      connect,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
    })
    loop.schedule()
    loop.stop()
    expect(clock.pending).toHaveLength(0)
    // Даже если кто-то вызовет schedule после stop — таймера не будет.
    loop.schedule()
    expect(clock.pending).toHaveLength(0)
    expect(connect).not.toHaveBeenCalled()
  })

  it('исключение внутри connect не рвёт цикл: следующая попытка планируется', () => {
    const clock = fakeTimers()
    const connect = vi.fn(() => {
      throw new Error('SecurityError: ws:// на https-странице')
    })
    const failed: number[] = []
    const loop = createReconnectLoop({
      connect,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
      onAttemptFailed: (attempt) => failed.push(attempt),
    })

    loop.schedule()
    clock.tick()
    expect(connect).toHaveBeenCalledTimes(1)
    // Заход упал, но цикл жив: следующая попытка уже запланирована.
    expect(clock.pending).toHaveLength(1)
    clock.tick()
    expect(connect).toHaveBeenCalledTimes(2)
    // Колбэк вызывается перед каждой попыткой: [0] — для первой, [1] — для
    // второй, [2] — для уже запланированной третьей.
    expect(failed).toEqual([0, 1, 2])
  })

  it('джиттер разводит одновременные вкладки по времени', () => {
    // Разные вкладки получают разные random — задержки не совпадают, значит
    // после перезапуска сервера клиенты не бьют по нему одной волной.
    const clock = fakeTimers()
    const loopFor = (random: () => number) =>
      createReconnectLoop({
        connect: () => {},
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        random,
      })
    loopFor(() => 0).schedule()
    loopFor(() => 1).schedule()
    const [first, second] = clock.pending.map((timer) => timer.delay)
    expect(Math.abs(first - second)).toBeGreaterThan(0)
  })
})
