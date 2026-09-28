import { http } from './client'

/**
 * Соавторы — творческий круг человека.
 *
 * Соавторство появляется по заявке и согласию. Оно несёт специализации (кто за
 * что берётся в общем деле) и два независимых разрешения «видит мои закрытые
 * проекты»: их ставит владелец проектов, а не тот, кто просит доступ.
 */

/** Как вы связаны с человеком из поиска. */
export type Relation = '' | 'coauthor' | 'request-incoming' | 'request-outgoing'

export interface UserSearchResult {
  id: string
  username: string
  display_name: string
  relation: Relation
  /** Специализации — только у принятого соавторства. */
  crafts: string[] | null
}

export interface CoauthorLink {
  id: string
  requester_id: string
  addressee_id: string
  status: 'pending' | 'accepted' | 'declined'
  message: string
  crafts: string[] | null
  requester_shares_closed: boolean
  addressee_shares_closed: boolean
  created_at: string
  decided_at?: string | null
  /** Вторая сторона связи. */
  other_id: string
  other_username: string
  other_display_name: string
}

export interface CoauthorList {
  coauthors: CoauthorLink[]
  incoming: CoauthorLink[]
  outgoing: CoauthorLink[]
}

export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  return await http.get('users/search', { searchParams: { q: query } }).json<UserSearchResult[]>()
}

export async function listCoauthors(): Promise<CoauthorList> {
  return await http.get('coauthors').json<CoauthorList>()
}

export async function inviteCoauthor(
  userId: string,
  message: string,
  crafts: string[],
): Promise<CoauthorLink> {
  return await http
    .post('coauthors', { json: { user_id: userId, message, crafts } })
    .json<CoauthorLink>()
}

export async function decideCoauthor(linkId: string, accept: boolean): Promise<CoauthorLink> {
  const action = accept ? 'accept' : 'decline'
  return await http.post(`coauthors/${linkId}/${action}`).json<CoauthorLink>()
}

export async function updateCoauthor(
  linkId: string,
  patch: { crafts?: string[]; shares_closed?: boolean },
): Promise<CoauthorLink> {
  return await http.patch(`coauthors/${linkId}`, { json: patch }).json<CoauthorLink>()
}

export async function removeCoauthor(linkId: string): Promise<void> {
  await http.delete(`coauthors/${linkId}`)
}

/** Кириллица и заглавные буквы недопустимы: ник — латиница, цифры, . - _ */
export function normalizeUsername(raw: string): string {
  return raw
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 32)
}

/**
 * Ник проверяем ДО обрезки: normalizeUsername молча укорачивает длинный ввод, и
 * без этой проверки 33 символа выглядели бы допустимыми. Правила те же, что на
 * сервере (store.ValidUsername): 3–32 символа, латиница, цифры, точка, дефис,
 * подчёркивание; @ в начале и пробелы по краям отбрасываются.
 */
export function validUsername(raw: string): boolean {
  const trimmed = raw.trim().replace(/^@/, '')
  if (trimmed.length < 3 || trimmed.length > 32) return false
  return normalizeUsername(trimmed) === trimmed.toLowerCase()
}
