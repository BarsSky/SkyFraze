import ky from 'ky'
import { useAuthStore } from '../store/auth'

export const http = ky.create({
  prefixUrl: '/api',
  hooks: {
    beforeRequest: [
      (req) => {
        const tok = useAuthStore.getState().accessToken
        if (tok) {
          req.headers.set('Authorization', `Bearer ${tok}`)
        }
      },
    ],
    afterResponse: [
      async (req, _opts, res) => {
        if (res.status === 401) {
          // пытаемся refresh
          const refreshed = await tryRefresh()
          if (refreshed) {
            const tok = useAuthStore.getState().accessToken
            if (tok) req.headers.set('Authorization', `Bearer ${tok}`)
            return ky(req)
          }
          useAuthStore.getState().logout()
        }
      },
    ],
  },
})

async function tryRefresh(): Promise<boolean> {
  const refresh = useAuthStore.getState().refreshToken
  if (!refresh) return false
  try {
    const resp = await ky.post('/api/auth/refresh', {
      prefixUrl: '',
      json: { refresh },
    }).json<{ access: string; refresh: string }>()
    useAuthStore.getState().setTokens(resp.access, resp.refresh)
    return true
  } catch {
    return false
  }
}

/**
 * Текст ошибки от сервера, если он есть.
 *
 * Сервер объясняет отказы своими словами — «в проекте занято 9.4 МБ из 10 МБ —
 * файл на 1.2 МБ не помещается», «файл прикреплён к 2 кадрам». Для человека это
 * полезнее кода состояния, но ky кладёт тело в response, а не в message, поэтому
 * читаем его здесь. Тело не JSON или его нет — вернём null, и вызывающий покажет
 * своё сообщение.
 */
export async function serverErrorMessage(e: unknown): Promise<string | null> {
  const response = (e as { response?: Response } | null)?.response
  if (!response || typeof response.clone !== 'function') return null
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    return typeof body?.error === 'string' && body.error ? body.error : null
  } catch {
    return null
  }
}
