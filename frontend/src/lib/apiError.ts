import { translate } from '../i18n'
import type { Lang } from '../store/lang'
/**
 * Человеческое описание ошибки API.
 *
 * Сырой текст вроде «TimeoutError: Request timed out: GET http://…» ничего не
 * говорит пользователю: он не знает, что делать. Здесь ошибка превращается в
 * заголовок, пояснение и признак «есть смысл повторить».
 */

export type ApiErrorKind = 'offline' | 'timeout' | 'server' | 'auth' | 'forbidden' | 'notFound' | 'conflict' | 'unknown'

/**
 * О чём ошибка. Один и тот же 404 на публичной истории и в каталоге резидентов
 * означает разное, поэтому подсказку выбираем по предмету, а не только по коду.
 */
export type ApiErrorSubject = 'story' | 'person' | 'import'

export interface ApiErrorInfo {
  kind: ApiErrorKind
  title: string
  hint: string
  /** Стоит ли предлагать «Повторить»: сеть и 5xx — да, 4xx — нет. */
  retryable: boolean
  status?: number
}

interface ErrLike {
  name?: string
  message?: string
  response?: { status?: number }
  cause?: unknown
}

export function describeApiError(
  e: unknown,
  subject: ApiErrorSubject = 'story',
  lang: Lang = 'ru',
): ApiErrorInfo {
  const err = (e ?? {}) as ErrLike
  const status = err.response?.status
  const name = err.name ?? ''
  const message = err.message ?? ''

  if (status === 404) {
    if (subject === 'person') {
      return {
        kind: 'notFound',
        title: translate(lang, 'err.profileTitle'),
        hint: translate(lang, 'err.profileHint'),
        retryable: false,
        status,
      }
    }
    if (subject === 'import') {
      return {
        kind: 'notFound',
        title: translate(lang, 'err.importFilesTitle'),
        hint: translate(lang, 'err.importFilesHint'),
        retryable: false,
        status,
      }
    }
    return {
      kind: 'notFound',
      title: translate(lang, 'err.pageTitle'),
      hint: translate(lang, 'err.pageHint'),
      retryable: false,
      status,
    }
  }
  if (status === 401) {
    return {
      kind: 'auth',
      title: translate(lang, 'err.authTitle'),
      hint: translate(lang, 'err.authHint'),
      retryable: false,
      status,
    }
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      title: translate(lang, 'err.forbiddenTitle'),
      hint: translate(lang, 'err.forbiddenHint'),
      retryable: false,
      status,
    }
  }
  if (status === 409) {
    return {
      kind: 'conflict',
      title: translate(lang, 'err.conflictTitle'),
      hint: translate(lang, 'err.conflictHint'),
      retryable: true,
      status,
    }
  }
  // Импорт: сервер на 400 объясняет причину своими словами («больше 2000 файлов»),
  // поэтому его текст показываем как есть, а повторять тот же файл бессмысленно.
  if (subject === 'import' && status === 400) {
    return {
      kind: 'unknown',
      title: translate(lang, 'err.importTitle'),
      hint: message || translate(lang, 'err.importHint'),
      retryable: false,
      status,
    }
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      kind: 'server',
      title: translate(lang, 'err.serverTitle'),
      hint: translate(lang, 'err.serverHint'),
      retryable: true,
      status,
    }
  }
  if (name === 'TimeoutError' || /timed? ?out/i.test(message)) {
    return {
      kind: 'timeout',
      title: translate(lang, 'err.timeoutTitle'),
      hint: translate(lang, 'err.timeoutHint'),
      retryable: true,
    }
  }
  if (name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(message)) {
    return {
      kind: 'offline',
      title: translate(lang, 'err.offlineTitle'),
      hint: translate(lang, 'err.offlineHint'),
      retryable: true,
    }
  }
  const fallbackTitle =
    subject === 'import' ? translate(lang, 'err.importTitle') : translate(lang, 'err.fallbackTitle')
  return {
    kind: 'unknown',
    title: fallbackTitle,
    hint: message || translate(lang, 'err.unknownHint'),
    retryable: true,
    status,
  }
}
