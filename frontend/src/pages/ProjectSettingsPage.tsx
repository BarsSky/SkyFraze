import { FormEvent, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { invite, listMembers, type Invitation, type TeamMember } from '../api/teams'
import { getProject, type Project } from '../api/projects'

export function ProjectSettingsPage() {
  const params = useParams()
  const projectId = params.id ?? ''
  const [project, setProject] = useState<Project | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [lastInvite, setLastInvite] = useState<Invitation | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [err, setErr] = useState('')

  useEffect(() => {
    getProject(projectId).then(setProject).catch(() => setProject(null))
    listMembers(projectId).then(setMembers).catch(() => setMembers([]))
  }, [projectId])

  async function onInvite(e: FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      const inv = await invite(projectId, email, role)
      setLastInvite(inv)
      setEmail('')
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>{project?.title ?? 'Settings'}</h2>
        <Link to={`/projects/${projectId}`}><button className="secondary">К таймлайну</button></Link>
      </div>

      <div className="card">
        <h3>Участники</h3>
        {members.length === 0 && <p className="muted">Нет участников</p>}
        <div className="list">
          {members.map((m) => (
            <div key={m.user_id} className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{m.display_name ?? m.user_id}</strong> <span className="muted">{m.email}</span>
              </div>
              <span className="muted">{m.role}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Пригласить</h3>
        <form onSubmit={onInvite} className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label className="muted">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="muted">Роль</label>
            <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')} style={{ background: '#0d1117', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 6, padding: 8 }}>
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <button type="submit">Отправить</button>
        </form>
        {err && <div className="error">{err}</div>}
        {lastInvite && (
          <div className="card" style={{ marginTop: 12 }}>
            <p>Скопируйте и поделитесь этой ссылкой (одноразовая, {lastInvite.expires_at.slice(0, 10)}):</p>
            <code style={{ wordBreak: 'break-all', display: 'block', padding: 8, background: '#0d1117' }}>
              {window.location.origin}/invitations/{lastInvite.token}
            </code>
          </div>
        )}
      </div>
    </div>
  )
}
