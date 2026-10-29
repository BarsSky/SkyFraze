import { http } from './client'

/** Что отдаёт `GET /api/health`: сервер, версия и коммит сборки. */
export interface BuildInfo {
  version: string
  commit: string
}

/**
 * Версия и коммит сборки (0.114.0).
 *
 * Зачем: страница «О проекте» должна говорить, ЧТО именно развёрнуто на этом стенде — люди
 * открывают свои установки и пишут «у меня не работает» без номера версии. Сервер уже отдаёт
 * `version` и `commit` (их вписывает ldflags при сборке), брать их из сборки фронтенда было бы
 * неправдой: фронтенд и бэкенд обновляются одним образом, но версия у клиента своя.
 *
 * Ошибка сети — не повод ломать страницу: «О проекте» остаётся полезной и без номера версии,
 * поэтому возвращаем `null`, а не бросаем.
 */
export async function getBuildInfo(): Promise<BuildInfo | null> {
  try {
    const body = await http
      .get('health', { timeout: 5000, retry: 0 })
      .json<{ version?: unknown; commit?: unknown }>()
    const version = typeof body.version === 'string' ? body.version.trim() : ''
    const commit = typeof body.commit === 'string' ? body.commit.trim() : ''
    if (version === '' && commit === '') return null
    return { version, commit }
  } catch {
    return null
  }
}
