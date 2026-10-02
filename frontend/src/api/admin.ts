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

// ── хранилище (см. docs/storage-compression.md) ─────────────────────────────

export interface TableSize {
  name: string
  bytes: number
}

/**
 * Проект и его вес по частям: вложения и снапшот.
 *
 * Админ видит вес и заголовок, но не содержимое: он отвечает за инсталляцию, а не за
 * то, что в историях написано (см. docs/architecture.md).
 */
export interface ProjectUsage {
  id: string
  title: string
  asset_bytes: number
  snapshot_bytes: number
}

/** Файл или строка, попавшие в отчёт как проблемные. */
export interface StorageFileEntry {
  key: string
  size?: number
  modified?: string
  project?: string
}

export interface StorageReport {
  scanned_at: string
  scan_ms: number
  database_bytes: number
  tables: TableSize[]
  projects: number
  snapshot_count: number
  snapshot_bytes: number
  /** Вес проектов, от тяжёлых к лёгким (верхушка списка). */
  projects_usage?: ProjectUsage[]
  event_rows: number
  event_text_bytes: number
  asset_rows: number
  asset_bytes: number
  file_count: number
  file_bytes: number
  orphan_files: number
  orphan_bytes: number
  pending_files: number
  missing_files: number
  orphan_examples?: StorageFileEntry[]
  missing_examples?: StorageFileEntry[]
  removed_files: number
  removed_bytes: number
  failed_files: number
}

/** Отчёт о размерах: ничего не меняет (обход каталога и запросы к базе). */
export async function getStorageReport(): Promise<StorageReport> {
  return await http.get('admin/storage').json<StorageReport>()
}

/** Уборка: удаляет файлы без строк в `assets` старше суток. */
export async function sweepStorage(): Promise<StorageReport> {
  return await http.post('admin/storage/sweep').json<StorageReport>()
}

export interface RecompressReport {
  files: number
  images: number
  changed: number
  skipped: number
  damaged: number
  failed: number
  damaged_examples?: string[]
  bytes_from: number
  bytes_to: number
  applied: boolean
}

/**
 * Пережатие уже загруженных картинок в WebP.
 *
 * Без `apply` это сухой прогон: считает выигрыш и ничего не пишет — по нему и
 * решают, запускать ли. Применение необратимо (оригиналы не хранятся), поэтому в
 * интерфейсе это две отдельные кнопки.
 */
export async function recompressStorage(apply = false): Promise<RecompressReport> {
  return await http
    .post('admin/storage/recompress', { searchParams: apply ? { apply: '1' } : {} })
    .json<RecompressReport>()
}
