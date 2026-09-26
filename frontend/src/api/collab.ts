import { http } from './client'

export async function getYjsState(projectId: string): Promise<Uint8Array> {
  const resp = await http.get(`projects/${projectId}/events/state`, {
    headers: { Accept: 'application/octet-stream' },
  })
  const buf = await resp.arrayBuffer()
  return new Uint8Array(buf)
}

export async function putYjsState(projectId: string, state: Uint8Array): Promise<void> {
  // приводим Uint8Array<ArrayBufferLike> к Uint8Array<ArrayBuffer> через копию
  const safe = new Uint8Array(new ArrayBuffer(state.byteLength))
  safe.set(state)
  await http.put(`projects/${projectId}/events/state`, {
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob([safe]),
  })
}
