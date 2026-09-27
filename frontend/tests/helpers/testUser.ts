/**
 * Общий помощник для e2e-скриптов: завести тестового пользователя на инсталляции,
 * где регистрация может быть закрыта (режим «по заявке»).
 *
 * Скрипты, которые просто дёргают POST /api/auth/register, работают только при
 * REGISTRATION_MODE=open. Здесь же повторяется путь живого человека: попытка
 * регистрации → заявка → одобрение администратором.
 *
 * Требует админский аккаунт (ADMIN_EMAILS); по умолчанию — тестовый логин стенда.
 */

export interface TestUserResult {
  ok: boolean
  note: string
  /** Токен доступа созданного пользователя (если удалось войти). */
  access?: string
}

const DEFAULT_PASSWORD = 'hunter22!'

export async function ensureTestUser(
  base: string,
  email: string,
  displayName: string,
  admin: { email: string; password: string },
  password = DEFAULT_PASSWORD,
): Promise<TestUserResult> {
  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: displayName }),
  })
  if (register.ok) {
    const body = (await register.json()) as { tokens?: { access: string } }
    return { ok: true, note: 'регистрация открыта', access: body.tokens?.access }
  }
  if (register.status !== 403) {
    return { ok: false, note: `register → ${register.status}` }
  }

  const requested = await fetch(`${base}/api/auth/registration-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: displayName, message: 'тестовый пользователь e2e' }),
  })
  if (requested.status !== 202) {
    return { ok: false, note: `request → ${requested.status}` }
  }

  const adminLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  })
  if (!adminLogin.ok) {
    return { ok: false, note: `admin login → ${adminLogin.status}` }
  }
  const adminToken = ((await adminLogin.json()) as { tokens: { access: string } }).tokens.access

  const list = (await (
    await fetch(`${base}/api/admin/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
  ).json()) as { requests: Array<{ id: string; email: string }> }
  const found = list.requests.find((r) => r.email === email)
  if (!found) return { ok: false, note: 'заявка не найдена у администратора' }

  const approved = await fetch(`${base}/api/admin/registrations/${found.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  if (!approved.ok) return { ok: false, note: `approve → ${approved.status}` }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!login.ok) return { ok: false, note: `login → ${login.status}` }
  const body = (await login.json()) as { tokens?: { access: string } }
  return { ok: true, note: 'заявка одобрена администратором', access: body.tokens?.access }
}
