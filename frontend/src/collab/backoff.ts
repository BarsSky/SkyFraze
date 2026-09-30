/**
 * Политика переподключения realtime-канала: экспоненциальная задержка с джиттером
 * и цикл, который её применяет.
 *
 * Зачем отдельный модуль. Раньше `onclose`/`onerror` в `yprovider.ts` только
 * ставили `setConnected(false)`, и после единственного разрыва (сон ноутбука,
 * смена сети, перезапуск бэкенда) клиент оставался без realtime до перезагрузки
 * страницы: чужие правки не приезжали, свои уходили только в БД по REST.
 *
 * Почему джиттер. Если сервер перезапустился, все вкладки проекта рвутся
 * одновременно. Без разброса они пошли бы на реконнект синхронной волной и
 * повторили ту же перегрузку. Джиттер разводит попытки по времени.
 *
 * Почему потолок. Задержка растёт только до предела (`maxDelayMs`): ждать
 * пятнадцать минут после получаса простоя бессмысленно — человек уже не смотрит
 * на страницу, а если смотрит, ему нужен реaltime сейчас, а не «когда-нибудь».
 *
 * Всё время и таймеры здесь инъектируются, поэтому политику можно проверить
 * юнит-тестом на искусственных часах — без `sleep` и без флаки.
 */

export interface BackoffOptions {
  /** Задержка первой повторной попытки. */
  baseDelayMs?: number
  /** Потолок задержки: дальше рост прекращается. */
  maxDelayMs?: number
  /** Разброс в долях от задержки: 0.25 — от -25% до +25%. */
  jitter?: number
}

export const DEFAULT_BASE_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 15000
export const DEFAULT_JITTER = 0.25

/**
 * Задержка перед попыткой номер `attempt` (0 — первая после обрыва).
 *
 * Двойка в степени ограничена заранее: `2 ** 1024` даёт Infinity, и задержка
 * стала бы NaN, а `setTimeout(NaN)` — мгновенным повтором в цикле. Ограничение
 * по потолку делает это невозможным даже при hundreds попыток.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitter = options.jitter ?? DEFAULT_JITTER

  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  // Показатель ограничен 30: 2**30 * base уже заведомо больше любого потолка.
  const exponent = Math.min(safeAttempt, 30)
  const raw = base * 2 ** exponent
  const capped = Math.min(Number.isFinite(raw) ? raw : max, max)
  if (jitter <= 0) return Math.round(capped)

  // Разброс симметричный и ограниченный: задержка остаётся в [base, 2*max].
  const spread = capped * jitter
  const value = capped - spread + random() * spread * 2
  return Math.round(Math.max(1, Math.min(max, value)))
}

export interface ReconnectOptions extends BackoffOptions {
  /**
   * Немедленная попытка. Может бросить (например, `new WebSocket` на HTTPS-
   * странице с `ws://`): это не конец цикла, а такой же неудачный заход, как
   * `onerror` — планируем следующую попытку.
   */
  connect: () => void
  /** Создать таймер. Инъекция — ради искусственных часов в тестах. */
  setTimeout?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void
  /** Источник случайности для джиттера. */
  random?: () => number
  /**
   * Сообщение об одной неудаче подряд. Цикл не пишет в консоль на каждую
   * попытку: при долгом обрыве это спам, от которого вкладка тормозит сильнее,
   * чем от самого обрыва. Вызывающий сам решает, что и как логировать.
   */
  onAttemptFailed?: (attempt: number, delayMs: number) => void
}

export interface ReconnectLoop {
  /** Разрыв соединения: сорвать запланированную попытку и начать серию заново. */
  schedule(): void
  /** Успешное открытие: счётчик попыток сбрасывается, ничего не запланировано. */
  reset(): void
  /** Остановка насовсем: после размонтирования или явного закрытия. */
  stop(): void
  /** Сколько попыток подряд уже сделано (0 — соединение живо). */
  attempt(): number
}

/**
 * Цикл переподключения. Состояние — только счётчик попыток и id таймера,
 * никаких ссылок на сокет: `connect` сам решает, что пересоздавать.
 */
export function createReconnectLoop(options: ReconnectOptions): ReconnectLoop {
  const scheduleTimeout = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms))
  const cancelTimeout = options.clearTimeout ?? ((id) => clearTimeout(id))
  const random = options.random ?? Math.random

  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const cancel = () => {
    if (timer !== null) {
      cancelTimeout(timer)
      timer = null
    }
  }

  const run = () => {
    timer = null
    if (stopped) return
    try {
      options.connect()
    } catch {
      // Неудачный заход равен неудачному onerror: следующий планируем сами,
      // потому что при исключении события close не будет.
      schedule()
    }
  }

  const schedule = () => {
    if (stopped) return
    cancel()
    const delay = backoffDelay(attempt, options, random)
    options.onAttemptFailed?.(attempt, delay)
    attempt += 1
    timer = scheduleTimeout(run, delay)
  }

  return {
    schedule,
    reset() {
      cancel()
      attempt = 0
    },
    stop() {
      stopped = true
      cancel()
    },
    attempt: () => attempt,
  }
}
