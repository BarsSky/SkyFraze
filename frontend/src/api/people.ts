import { http } from './client'
import type { Relation } from './coauthors'

/**
 * Каталог резидентов — зарегистрированные участники инсталляции.
 *
 * Резидент — это не роль и не право, а видимость: человек виден в каталоге по
 * умолчанию, а снятая галочка «Показывать меня в списке резидентов» (`discoverable`
 * в профиле) прячет его отсюда. Резюме и специализации человек заполняет сам.
 * Каталог отвечает на вопрос «кто здесь есть и чем занимается», а заявку в
 * соавторы можно отправить прямо из строки — тем же приглашением, что и в разделе
 * «Соавторы», поэтому связь (`relation`) приходит вместе с человеком.
 *
 * Доступ — только вошедшим: это внутренний список людей, а не публичная витрина.
 */

/** Человек в каталоге: всё, что видно до раскрытия строки. */
export interface Person {
  id: string
  username: string
  display_name: string
  /** Короткое резюме о себе. В списке обрезается по строкам, раскрытая строка показывает целиком. */
  bio: string
  /** Специализации: всегда массив (пустой — если человек их не указал). */
  crafts: string[]
  /** Как вы уже связаны с этим человеком. */
  relation: Relation
  /**
   * Сколько историй человек открыл публично.
   *
   * Поля `discoverable` здесь нет: каталог и так содержит только видимых, а
   * сам флаг приезжает исключительно из /api/auth/me.
   */
  public_stories: number
}

/** Публичная история резидента: ссылка ведёт на /s/{slug}. */
export interface PersonStory {
  id: string
  title: string
  slug: string
}

/** Раскрытая строка: человек плюс его публичные истории. */
export interface PersonProfile extends Person {
  stories: PersonStory[]
}

/** Страница каталога: items — срез, total — сколько всего подходит под фильтр. */
export interface PeoplePage {
  items: Person[]
  total: number
  limit: number
  offset: number
}

export interface PeopleQuery {
  /** Поиск по нику и имени. Короче двух символов — ещё не запрос. */
  q?: string
  /** Точное значение из каталога специализаций (см. lib/crafts.ts). */
  craft?: string | null
  limit?: number
  offset?: number
}

/** Сколько людей забираем за раз: каталог листается кнопкой «Показать ещё». */
export const PEOPLE_PAGE_SIZE = 24

/**
 * Разбор конверта ответа.
 *
 * Поля страницы нужны интерфейсу для счётчика и листания, поэтому типобезопасный
 * JSON от ky здесь приводится к числам и массиву: без этого отсутствующий `total`
 * дал бы «Найдено: NaN», а кривой `items` уронил бы рендер.
 */
function readPage(raw: unknown, limit: number, offset: number): PeoplePage {
  const data = (raw ?? {}) as Partial<PeoplePage>
  const items = Array.isArray(data.items) ? data.items : []
  return {
    items,
    total: typeof data.total === 'number' ? data.total : items.length,
    limit: typeof data.limit === 'number' ? data.limit : limit,
    offset: typeof data.offset === 'number' ? data.offset : offset,
  }
}

/**
 * Каталог резидентов.
 *
 * Слишком короткий запрос не уходит в сеть: сервер на `q` из одного символа всё
 * равно отвечает пустым списком, а поиск срабатывает на каждое нажатие клавиши.
 * Пустой `q` — это не поиск, а весь каталог.
 */
export async function listPeople(query: PeopleQuery = {}): Promise<PeoplePage> {
  const q = (query.q ?? '').trim()
  const craft = (query.craft ?? '').trim()
  const limit = query.limit ?? PEOPLE_PAGE_SIZE
  const offset = query.offset ?? 0

  if (q.length > 0 && q.length < 2) {
    return { items: [], total: 0, limit, offset }
  }

  const searchParams: Record<string, string> = {
    limit: String(limit),
    offset: String(offset),
  }
  if (q.length >= 2) searchParams.q = q
  if (craft) searchParams.craft = craft

  const raw = await http.get('users', { searchParams }).json<PeoplePage>()
  return readPage(raw, limit, offset)
}

/** Раскрытая строка: 404 — человек скрылся из каталога или его больше нет. */
export async function getPerson(id: string): Promise<PersonProfile> {
  const raw = await http.get(`users/${encodeURIComponent(id)}`).json<PersonProfile>()
  return { ...raw, stories: Array.isArray(raw?.stories) ? raw.stories : [] }
}
