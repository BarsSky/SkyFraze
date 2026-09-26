import { YMap } from '../../collab/yprovider'

export function EventCard({
  ymap,
  onTitleChange,
  onBodyChange,
}: {
  ymap: YMap | null
  onTitleChange?: (v: string) => void
  onBodyChange?: (v: string) => void
}) {
  if (!ymap) return null
  const title = (ymap.get('title') as string | undefined) ?? ''
  const body = (ymap.get('body') as string | undefined) ?? ''
  return (
    <div className="card">
      <input
        value={title}
        onChange={(e) => onTitleChange?.(e.target.value)}
        placeholder="Заголовок события"
        style={{ fontSize: 18, fontWeight: 600 }}
      />
      <div style={{ height: 8 }} />
      <textarea
        value={body}
        onChange={(e) => onBodyChange?.(e.target.value)}
        rows={6}
        placeholder="Описание события"
      />
    </div>
  )
}
