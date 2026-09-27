import { http } from './client'

export type RegistrationMode = 'request' | 'open'

export interface AdminSettings {
  registration_mode: RegistrationMode
  admins: number
  users: number
  pending_requests: number
}

export interface RegistrationRequest {
  id: string
  email: string
  display_name: string
  message: string
  status: 'pending' | 'approved' | 'rejected'
  note: string
  created_at: string
  decided_at?: string
}

export interface AdminUser {
  id: string
  email: string
  display_name: string
  is_admin: boolean
  created_at: string
}

// ── механизм обновления (см. deploy/skyfraze-update.sh) ─────────────────────

export interface UpdateRelease {
  tag: string
  name: string
  url: string
  notes?: string
  published_at: string
  prerelease: boolean
}

export interface UpdateCheck {
  current: string
  commit: string
  repo: string
  configured: boolean
  latest?: UpdateRelease
  update_available: boolean
  checked_at: string
  error?: string
}

export interface UpdateStatus {
  status: 'idle' | 'requested' | 'running' | 'done' | 'failed'
  target?: string
  message?: string
  started_at?: string
  ended_at?: string
  commit?: string
}

export interface UpdateInfo {
  check: UpdateCheck
  status: UpdateStatus | null
  log: string
}

/** Состояние обновления; force=true — «Проверить сейчас» (минуя кэш GitHub). */
export async function getUpdateInfo(force = false): Promise<UpdateInfo> {
  return await http
    .get('admin/update', { searchParams: force ? { force: '1' } : {} })
    .json<UpdateInfo>()
}

/** Оставить заявку на обновление: применит хост (systemd + deploy-скрипт). */
export async function requestUpdate(target?: string): Promise<{ target: string }> {
  return await http.post('admin/update', { json: { target: target ?? '' } }).json<{ target: string }>()
}

export async function getAdminSettings(): Promise<AdminSettings> {
  return await http.get('admin/settings').json<AdminSettings>()
}

/** Переключение режима регистрации: 'request' (по заявке) | 'open' (свободная). */
export async function setRegistrationMode(mode: RegistrationMode): Promise<AdminSettings> {
  return await http.patch('admin/settings', { json: { registration_mode: mode } }).json<AdminSettings>()
}

export async function listRegistrations(status = ''): Promise<RegistrationRequest[]> {
  const res = await http
    .get('admin/registrations', { searchParams: status ? { status } : {} })
    .json<{ requests: RegistrationRequest[] }>()
  return res.requests
}

export async function approveRegistration(id: string): Promise<void> {
  await http.post(`admin/registrations/${id}/approve`)
}

export async function rejectRegistration(id: string, note = ''): Promise<void> {
  await http.post(`admin/registrations/${id}/reject`, { json: { note } })
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const res = await http.get('admin/users').json<{ users: AdminUser[] }>()
  return res.users
}
