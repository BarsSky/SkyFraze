import { http } from './client'

export interface Asset {
  id: string
  project_id: string
  owner_id: string
  filename: string
  mime: string
  size: number
  s3_key: string
  kind: string
  created_at: string
}

export async function listAssets(projectId: string): Promise<Asset[]> {
  return await http.get(`projects/${projectId}/assets`).json<Asset[]>()
}

export async function uploadAsset(projectId: string, file: File): Promise<Asset> {
  const fd = new FormData()
  fd.append('file', file)
  return await http.post(`projects/${projectId}/assets`, { body: fd }).json<Asset>()
}

/**
 * Удаление файла проекта.
 *
 * Сервер откажет (409), если файл ещё прикреплён к кадрам: ссылки живут в
 * CRDT-документе, и удалённый файл оставил бы кадр с пустым местом. Порядок такой:
 * открепить в редакторе, потом удалить.
 */
export async function deleteAsset(projectId: string, assetId: string): Promise<void> {
  await http.delete(`projects/${projectId}/assets/${assetId}`)
}

/** Занятое место и предел квоты проекта: `limit: 0` — предела нет. */
export interface AssetUsage {
  used: number
  limit: number
  used_text: string
  limit_text: string
}

export async function assetUsage(projectId: string): Promise<AssetUsage> {
  return await http.get(`projects/${projectId}/assets/usage`).json<AssetUsage>()
}

export function assetUrl(id: string): string {
  return `/api/assets/${id}`
}
