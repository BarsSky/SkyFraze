import { http } from './client'

export interface Project {
  id: string
  owner_id: string
  title: string
  description: string
  created_at: string
  updated_at: string
  /** Публичная лента: видно всем только при is_public */
  is_public: boolean
  public_slug?: string | null
  published_at?: string | null
  views_count: number
  /** Как получен доступ: свой проект, участие в команде или соавторское чтение. */
  access?: 'owner' | 'member' | 'coauthor'
  /** Роль в проекте: по ней страница решает, показывать ли редакторы. */
  role?: 'owner' | 'editor' | 'viewer'
  /** Доступ выдан соавторством (только чтение), а не участием в команде. */
  coauthor_access?: boolean
  /**
   * Вес вложений проекта после пережатия и предел (`0` — без предела).
   *
   * Список показывает «файлы: 8.4 МБ из 10»: место в проекте видно до открытия, а не
   * когда загрузка уже упёрлась в отказ.
   */
  asset_bytes?: number
  quota_bytes?: number
}

export async function listProjects(): Promise<Project[]> {
  return await http.get('projects').json<Project[]>()
}

export async function getProject(id: string): Promise<Project> {
  return await http.get(`projects/${id}`).json<Project>()
}

export async function createProject(input: { title: string; description: string }): Promise<Project> {
  return await http.post('projects', { json: input }).json<Project>()
}

export async function deleteProject(id: string): Promise<void> {
  await http.delete(`projects/${id}`)
}

/**
 * Проект в корзине: удалён, но ещё восстановим.
 *
 * `days_left` считает сервер от `retention_days`: срок хранения — обещание продукта, и
 * держать его копию в браузере значило бы однажды разойтись с сервером и соврать человеку
 * про то, что проект ещё можно вернуть.
 */
export interface TrashedProject {
  id: string
  title: string
  description: string
  deleted_at: string
  days_left: number
  /**
   * Сколько занимают вложения проекта. Нужен до окончательного удаления: человек решает
   * «вернуть или стереть» в том числе по цене вопроса, а файлы в корзине не удаляются —
   * значит и вес там настоящий, а не «0, потому что удалено».
   */
  asset_bytes?: number
}

export interface TrashResponse {
  projects: TrashedProject[]
  retention_days: number
}

export async function listTrash(): Promise<TrashResponse> {
  return await http.get('projects/trash').json<TrashResponse>()
}

export async function restoreProject(id: string): Promise<void> {
  await http.post(`projects/${id}/restore`)
}

/**
 * Удалить навсегда. Необратимо: файлы и история версий уходят вместе с проектом —
 * поэтому это отдельный вызов, а не «удалить дважды» то же кнопкой.
 */
export async function purgeProject(id: string): Promise<void> {
  await http.delete(`projects/${id}/purge`)
}
