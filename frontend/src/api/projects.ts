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
