/**
 * seed-project.ts — данные для визуального аудита (0.103.0).
 *
 * Зачем отдельный скрипт, а не «взять проект со стенда»: аудит раньше запускался только руками по
 * dev-стенду, где есть живой проект с кадрами, карточками и чатом. В CI такого проекта нет, поэтому
 * экраны проекта были бы пустыми, а проверки — зелёными ни о чём. Скрипт создаёт ровно столько
 * данных, сколько нужно экранам аудита: проект, глава, два кадра с текстом и упоминаниями, две
 * карточки мира со связью, сообщение в чате. Публикацию аудит включает сам (`ensurePublicStory`).
 *
 * Всё делается HTTP-ручками, без браузера: сценарии интерфейса для этого не нужны, а идти через
 * них — значит зависеть от тех же селекторов, которые аудит и проверяет.
 *
 * Запуск (vite :5173 и backend :8181 подняты):
 *   cd frontend && npx tsx tests/audit/seed-project.ts
 *
 * Печатает последней строкой `AUDIT_PROJECT_ID=<uuid>` — это и есть значение `AUDIT_PROJECT`
 * для `visual-audit.ts`; остальное (учётка, пароль) — `AUDIT_EMAIL` / `AUDIT_PASS`.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
/** Ручки можно звать напрямую в backend: прокси vite на старте может быть ещё не готов. */
const API = process.env.API_URL ?? BASE
const EMAIL = process.env.AUDIT_EMAIL ?? 'audit@example.com'
const PASSWORD = process.env.AUDIT_PASS ?? 'hunter22!'
const AUTHOR = 'Аудит интерфейса'

/** Ошибка ручки с телом ответа: без тела разбор упавшего запуска в CI превращается в гадание. */
class ApiError extends Error {}

function headers(token?: string): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) out.Authorization = `Bearer ${token}`
  return out
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: headers(token) })
  if (!res.ok) {
    throw new ApiError(`${init.method ?? 'GET'} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Вход конкретной учёткой. `null` — учётки ещё нет (пустая база CI). */
async function loginAs(email: string): Promise<string | null> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { tokens?: { access?: string } }
  return body.tokens?.access ?? null
}

/** Вход существующей учёткой аудита. `null` — учётки аудита ещё нет. */
async function login(): Promise<string | null> {
  return loginAs(EMAIL)
}

/**
 * Учётка аудита. Сначала вход: на непустой базе (dev-стенд) человек уже заведён, а регистрация
 * может быть закрыта режимом «по заявке» — тогда новой учётке никто не нужен. Если входа нет,
 * регистрируем: в CI база пустая, и первый человек становится администратором, поэтому аудиту
 * доступна и `/admin`. `403`/`409` у регистрации — это «закрыто» или «уже есть», а не поломка.
 */
async function authToken(): Promise<string> {
  const existing = await login()
  if (existing !== null) return existing

  const register = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, display_name: AUTHOR }),
  })
  if (!register.ok && register.status !== 403 && register.status !== 409) {
    throw new ApiError(`регистрация аудита → ${register.status}: ${(await register.text()).slice(0, 300)}`)
  }
  const token = await login()
  if (token === null) {
    throw new ApiError(
      `учётка аудита «${EMAIL}» не создалась: регистрация ${register.status}, вход 401. ` +
        'На стенде с закрытой регистрацией нужна существующая учётка (AUDIT_EMAIL/AUDIT_PASS).',
    )
  }
  return token
}

/**
 * Ник нужен проверке профиля: аудит считает пустой ник дефектом («человека не найти поиском»).
 * Регистрация ник не выдаёт, поэтому ставим сами — префикс фиксированный, чтобы поиск в каталоге
 * всегда находил эту учётку.
 */
async function setNick(token: string): Promise<string> {
  const nick = 'audit-seed'
  try {
    await call('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: AUTHOR, username: nick, bio: 'проект для визуального аудита' }),
    }, token)
  } catch (e) {
    // Ник уже занят другой учёткой (повторный прогон на непустой базе) — это не повод падать.
    console.warn(`ник «${nick}» не поставлен: ${(e as Error).message}`)
  }
  return nick
}

/**
 * Второй житель для каталога резидентов.
 *
 * Каталог исключает самого зрителя (`CatalogUsers`: «себя в списке искать незачем»), поэтому на
 * свежей базе CI, где есть только наша учётка, список резидентов пуст — и аудит честно считает это
 * дефектом. Второй человек решает это по существу, а не отключением проверки. На стенде с
 * закрытой регистрацией создать его нельзя — там люди уже есть, и предупреждения достаточно.
 */
async function seedPeer(): Promise<string | null> {
  const email = 'audit-peer@example.com'
  const register = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password: PASSWORD, display_name: 'Соавтор аудита' }),
  })
  if (!register.ok) {
    console.warn(`второй житель не создан (регистрация ${register.status}) — каталог может быть пуст`)
    return null
  }
  const peer = await loginAs(email)
  if (peer === null) return null
  try {
    await call('/api/auth/me', {
      method: 'PATCH',
      // discoverable по умолчанию включён, но пишем явно: каталог показывает только тех, кто
      // «показывать меня» не снял.
      body: JSON.stringify({ display_name: 'Соавтор аудита', username: 'audit-peer', discoverable: true }),
    }, peer)
  } catch (e) {
    console.warn(`профиль второго жителя: ${(e as Error).message}`)
  }
  return email
}

type CreatedEvent = { id: string }

async function main() {
  const token = await authToken()
  const nick = await setNick(token)
  // Второй житель нужен каталогу резидентов (себя каталог не показывает). В CI это единственный
  // способ проверить страницу по существу; на закрытом стенде он может не создаться — не беда.
  const peer = await seedPeer()

  const created = await call<{ project?: { id: string }; id?: string }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ title: 'Аудит интерфейса', description: 'проект для визуального аудита' }),
  }, token)
  const projectId = created.project?.id ?? created.id
  if (!projectId) throw new ApiError('создание проекта: в ответе нет id')

  // Глава и два кадра. Не через `POST /events`: эта ручка пишет только таблицу событий, а стадия
  // и дерево читают документ CRDT — проект с «табличными» событиями выглядит пустым («Таймлайн
  // пока пуст»), и аудит честно ругался «стадия не открылась». Импорт Markdown идёт тем же путём,
  // что и помощник (`LiveDoc` + `SetEventTextLive`), поэтому документ и таблица согласованы.
  const markdown = [
    '# Аудит интерфейса',
    'Проект для визуального аудита.',
    '',
    '## 01 Начало',
    '',
    '### 01.1 Утро на Земле',
    '',
    'Аня пришла на **Землю** и нашла письмо.',
    '',
    '| Место | Когда |',
    '| --- | --- |',
    '| Земля | утро |',
    '',
    '> «Так начинается история», — сказала Аня.',
    '',
    '### 01.2 Письмо',
    '',
    'Письмо было от Земли. Аня перечитала его дважды.',
    '',
  ].join('\n')

  const form = new FormData()
  form.append('files', new Blob([markdown], { type: 'text/markdown; charset=utf-8' }), 'audit.md')
  const imported = await fetch(`${API}/api/projects/${projectId}/import/markdown`, {
    method: 'POST',
    // Content-Type не ставим: границу multipart подставляет сам fetch, ручной заголовок её ломает.
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!imported.ok) {
    throw new ApiError(`импорт Markdown → ${imported.status}: ${(await imported.text()).slice(0, 300)}`)
  }

  // Проверка, что данные видит ИНТЕРФЕЙС, а не только таблица: документ непустой и в дереве есть
  // события. Без неё подготовка «проходила», а аудит шёл по пустым экранам — ровно та ложная
  // зелень, из-за которой этот скрипт и появился.
  const treeRes = await fetch(`${API}/api/projects/${projectId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const tree = (await treeRes.json()) as Array<{ children?: unknown[] }>
  if (!Array.isArray(tree) || tree.length === 0) {
    throw new ApiError('после импорта дерево событий пустое — аудиту нечего показывать')
  }
  const stateRes = await fetch(`${API}/api/projects/${projectId}/events/state`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const state = await stateRes.text()
  if (state.trim().length < 16) {
    throw new ApiError(`документ проекта пустой (${state.trim().length} байт) — стадия не отрисуется`)
  }

  // Карточки мира и связь: без них пустуют «Связи проекта», граф и матрица.
  const anna = await call<{ entity?: { id: string } }>(`/api/projects/${projectId}/entities`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Аня', kind: 'character' }),
  }, token)
  const earth = await call<{ entity?: { id: string } }>(`/api/projects/${projectId}/entities`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Земля', kind: 'place' }),
  }, token)
  if (anna.entity?.id && earth.entity?.id) {
    await call(`/api/projects/${projectId}/entities/${anna.entity.id}/links`, {
      method: 'POST',
      body: JSON.stringify({ to: earth.entity.id, label: 'живёт на' }),
    }, token)
  }

  // Чат: лента, отметки и поле ввода проверяются на живом сообщении.
  await call(`/api/projects/${projectId}/chat/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Первое сообщение для проверки ленты.' }),
  }, token)

  // Публикация — чтобы у аудита были публичные экраны (`/s/<slug>`); операция идемпотентна.
  // Поле называется `public_slug` (у проекта) — так его отдаёт `feedH.Publish`.
  let slug: string | null = null
  try {
    const published = await call<{ public_slug?: string; slug?: string; project?: { slug?: string } }>(
      `/api/projects/${projectId}/publication`,
      { method: 'POST', body: JSON.stringify({ is_public: true }) },
      token,
    )
    slug = published.public_slug ?? published.slug ?? published.project?.slug ?? null
  } catch (e) {
    // Публичные экраны — дополнительная проверка, а не повод валить подготовку данных.
    console.warn(`публикация не удалась: ${(e as Error).message}`)
  }

  console.log(
    `проект: ${projectId}, учётка: ${EMAIL} (ник @${nick}), публикация: ${slug ?? 'нет'}, ` +
      `второй житель: ${peer ?? 'нет'}`,
  )
  console.log('AUDIT_EMAIL=' + EMAIL)
  console.log('AUDIT_PASS=' + PASSWORD)
  console.log('AUDIT_PROJECT_ID=' + projectId)
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
