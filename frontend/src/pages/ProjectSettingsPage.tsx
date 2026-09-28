import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  addMember,
  invite,
  listMembers,
  removeMember,
  type Invitation,
  type TeamMember,
} from '../api/teams'
import { listCoauthors, searchUsers, type CoauthorLink, type UserSearchResult } from '../api/coauthors'
import { getProject, type Project } from '../api/projects'
import { useAuthStore } from '../store/auth'
import { ErrorBanner } from '../components/ErrorBanner'
import { craftsOf } from '../lib/crafts'

/**
 * Настройки проекта: участники и приглашения.
 *
 * Главный путь добавления — соавторы: список людей из своего круга с их
 * специализациями выпадает сразу, роль назначается одной кнопкой. Ссылка-приглашение
 * по email осталась для тех, кого в круге ещё нет, а поиск по нику позволяет
 * добавить человека, не выходя со страницы проекта.
 */
export function ProjectSettingsPage() {
  const params = useParams()
  const projectId = params.id ?? ''
  const me = useAuthStore((s) => s.user)
  const [project, setProject] = useState<Project | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [coauthors, setCoauthors] = useState<CoauthorLink[]>([])
  const [lastInvite, setLastInvite] = useState<Invitation | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  /** Роль для каждого соавтора в списке: по умолчанию редактор. */
  const [roles, setRoles] = useState<Record<string, 'editor' | 'viewer'>>({})
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<UserSearchResult[] | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [p, m, c] = await Promise.all([
        getProject(projectId),
        listMembers(projectId),
        listCoauthors().catch(() => ({ coauthors: [], incoming: [], outgoing: [] })),
      ])
      setProject(p)
      setMembers(m)
      setCoauthors(c.coauthors)
      setErr(null)
    } catch (e) {
      setErr(e)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  // Владелец — единственный, кто добавляет участников: остальным показываем
  // только состав.
  const isOwner = project?.role === 'owner'
  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members])
  const memberById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members])

  async function onInvite(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const inv = await invite(projectId, email, role)
      setLastInvite(inv)
      setEmail('')
    } catch (e) {
      setErr(e)
    }
  }

  async function onAdd(userId: string, name: string) {
    setBusy(userId)
    try {
      await addMember(projectId, userId, roles[userId] ?? 'editor')
      setNote(`${name} добавлен в проект`)
      await load()
    } catch (e) {
      setErr(e)
    } finally {
      setBusy(null)
    }
  }

  async function onRemove(userId: string, name: string) {
    setBusy(userId)
    try {
      await removeMember(projectId, userId)
      setNote(`${name} больше не участник проекта`)
      await load()
    } catch (e) {
      setErr(e)
    } finally {
      setBusy(null)
    }
  }

  async function runSearch(value: string) {
    const q = value.trim()
    if (q.length < 2) {
      setFound(null)
      return
    }
    try {
      setFound(await searchUsers(q))
    } catch (e) {
      setErr(e)
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h2>{project?.title ?? 'Настройки проекта'}</h2>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/coauthors"><button className="secondary">Соавторы</button></Link>
          <Link to={`/projects/${projectId}`}><button className="secondary">К таймлайну</button></Link>
        </div>
      </div>

      {err != null && <ErrorBanner error={err} what="Настройки проекта" onRetry={() => void load()} />}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" type="button" onClick={() => setNote(null)}>ок</button>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Участники</h3>
        {members.length === 0 && <p className="muted">Нет участников</p>}
        <div className="list">
          {members.map((m) => (
            <div key={m.user_id} className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong>{m.display_name ?? m.user_id}</strong>
                {m.username && <span className="coauthors__nick"> @{m.username}</span>}
                <span className="muted"> {m.email}</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="muted">{roleLabel(m.role)}</span>
                {isOwner && m.role !== 'owner' && (
                  <button
                    type="button"
                    className="secondary ed-danger"
                    disabled={busy === m.user_id}
                    onClick={() => void onRemove(m.user_id, m.display_name ?? m.user_id)}
                  >
                    убрать
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {isOwner && (
        <div className="card" data-coauthor-picker>
          <h3 style={{ marginTop: 0 }}>Добавить соавтора</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Люди из вашего круга — специализации подсказывают, кому что поручить.
            Кого нет в списке, найдите по нику ниже или позовите в соавторы на странице «Соавторы».
          </p>
          {coauthors.length === 0 && (
            <p className="muted">
              Соавторов пока нет.{' '}
              <Link to="/coauthors">Найти людей по нику →</Link>
            </p>
          )}
          <div className="list">
            {coauthors.map((link) => {
              const member = memberById.get(link.other_id)
              const crafts = craftsOf(link.crafts)
              return (
                <div key={link.id} className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                    <strong>{link.other_display_name}</strong>
                    <span className="coauthors__nick"> @{link.other_username}</span>
                    <div className="coauthors__crafts">
                      {crafts.length === 0 && <span className="muted">специализации не указаны</span>}
                      {crafts.map((craft) => (
                        <span key={craft} className="craft-chip">{craft}</span>
                      ))}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    {member ? (
                      <>
                        <span className="muted">в проекте: {roleLabel(member.role)}</span>
                        {member.role !== 'owner' && (
                          <button
                            type="button"
                            className="secondary ed-danger"
                            disabled={busy === link.other_id}
                            onClick={() => void onRemove(link.other_id, link.other_display_name)}
                          >
                            убрать
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <select
                          value={roles[link.other_id] ?? 'editor'}
                          aria-label={`Роль для ${link.other_display_name}`}
                          onChange={(e) =>
                            setRoles((prev) => ({ ...prev, [link.other_id]: e.target.value as 'editor' | 'viewer' }))
                          }
                          style={{
                            background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
                            borderRadius: 6, padding: '8px 10px', minWidth: 130,
                          }}
                        >
                          <option value="editor">редактор</option>
                          <option value="viewer">наблюдатель</option>
                        </select>
                        <button
                          type="button"
                          disabled={busy === link.other_id}
                          onClick={() => void onAdd(link.other_id, link.other_display_name)}
                        >
                          {busy === link.other_id ? '…' : 'Добавить в проект'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: 18 }}>
            <h4 style={{ marginBottom: 6 }}>Найти по нику</h4>
            <div className="coauthors__search">
              <input
                value={query}
                placeholder="@nick или имя"
                aria-label="Поиск людей по нику"
                onChange={(e) => {
                  setQuery(e.target.value)
                  void runSearch(e.target.value)
                }}
              />
            </div>
            {found !== null && (
              <div className="coauthors__results" data-picker-results>
                {found.length === 0 && <p className="muted">Никого не найдено.</p>}
                {found.map((person) => (
                  <div key={person.id} className="coauthors__row">
                    <div className="coauthors__who">
                      <strong>{person.display_name}</strong>
                      <span className="coauthors__nick">@{person.username}</span>
                    </div>
                    {memberIds.has(person.id) ? (
                      <span className="muted">уже в проекте</span>
                    ) : person.id === me?.id ? (
                      <span className="muted">это вы</span>
                    ) : (
                      <button type="button" disabled={busy === person.id} onClick={() => void onAdd(person.id, person.display_name)}>
                        Добавить в проект
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {isOwner && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Пригласить по email</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Для тех, кого нет в круге соавторов: приглашение придёт ссылкой, и человек
            войдёт по ней сам.
          </p>
          <form onSubmit={onInvite} className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ flex: '1 1 220px', minWidth: 200 }}>
              <label className="muted" style={{ display: 'block', marginBottom: 4 }}>Email</label>
              <input
                placeholder="email@example.com"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="muted" style={{ display: 'block', marginBottom: 4 }}>Роль</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}
                style={{
                  background: 'var(--bg)', color: 'var(--fg)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px',
                  minWidth: 130,
                }}
              >
                <option value="editor">редактор</option>
                <option value="viewer">наблюдатель</option>
              </select>
            </div>
            <button type="submit">Отправить</button>
          </form>
          {lastInvite && (
            <div className="card" style={{ marginTop: 12 }}>
              <p>Скопируйте и поделитесь этой ссылкой (одноразовая, {lastInvite.expires_at.slice(0, 10)}):</p>
              <code style={{ wordBreak: 'break-all', display: 'block', padding: 8, background: 'var(--bg)' }}>
                {window.location.origin}/invitations/{lastInvite.token}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Роли называем по-русски: owner/editor/viewer в интерфейсе ничего не говорят. */
function roleLabel(role: TeamMember['role']): string {
  switch (role) {
    case 'owner':
      return 'владелец'
    case 'editor':
      return 'редактор'
    default:
      return 'наблюдатель — только чтение'
  }
}
