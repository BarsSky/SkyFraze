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

export function assetUrl(id: string): string {
  return `/api/assets/${id}`
}
