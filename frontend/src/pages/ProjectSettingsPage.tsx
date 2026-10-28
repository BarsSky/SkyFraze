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
import { getProject, listProjects, type Project } from '../api/projects'
import {
  applyProjectTemplate,
  getProjectTemplate,
  parseTemplate,
  templateFileName,
  type TemplateReport,
} from '../api/projectTemplate'
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
      {isOwner && <ProjectTemplateCard projectId={projectId} projectTitle={project?.title ?? ''} onErr={setErr} />}
    </div>
  )
}

/**
 * Шаблон проекта (0.85.0, docs/entity-types.md §3).
 *
 * Здесь два действия: забрать устройство проекта файлом и применить чужое. Перенос — СЛИЯНИЕ:
 * типы с теми же ключами обновляются, новые добавляются, карточки с занятыми именами
 * пропускаются и называются в отчёте. Ничего не удаляется — это обещание, а не настройка.
 *
 * Отдельная карточка в настройках, а не в панели связей: шаблон меняет и настройки помощника, а
 * они живут не в редакторе. И только владельцу: шаблон меняет устройство проекта целиком.
 */
function ProjectTemplateCard({
  projectId,
  projectTitle,
  onErr,
}: {
  projectId: string
  projectTitle: string
  onErr: (err: unknown) => void
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [sourceId, setSourceId] = useState('')
  const [withCards, setWithCards] = useState(true)
  const [report, setReport] = useState<TemplateReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    listProjects()
      .then((list) => setProjects(list.filter((item) => item.id !== projectId)))
      .catch(() => setProjects([]))
  }, [projectId])

  // Скачать шаблон файлом: тот же JSON, что уедет в архив. Скачиваем через Blob, а не ссылкой:
  // нужен токен авторизации, а <a download> его не отправит.
  async function download() {
    setBusy(true)
    setNote(null)
    try {
      const template = await getProjectTemplate(projectId, withCards)
      const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = templateFileName(projectTitle)
      link.click()
      URL.revokeObjectURL(url)
      setNote(
        `Шаблон сохранён: типов ${template.entity_types.length}` +
          (withCards ? `, карточек ${template.cards?.length ?? 0}` : ', без карточек'),
      )
    } catch (e) {
      onErr(e)
    } finally {
      setBusy(false)
    }
  }

  async function applyFromProject() {
    if (sourceId === '') return
    setBusy(true)
    setNote(null)
    try {
      const template = await getProjectTemplate(sourceId, withCards)
      setReport(await applyProjectTemplate(projectId, template))
    } catch (e) {
      onErr(e)
    } finally {
      setBusy(false)
    }
  }

  async function applyFromFile(file: File) {
    setBusy(true)
    setNote(null)
    try {
      const text = await file.text()
      const template = parseTemplate(text)
      setReport(await applyProjectTemplate(projectId, template))
    } catch (e) {
      setReport(null)
      setNote(e instanceof Error ? e.message : 'Не удалось прочитать шаблон.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" data-project-template>
      <h3 style={{ marginTop: 0 }}>Шаблон проекта</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Устройство проекта: типы карточек с заготовками, карточки и настройки помощника — роль,
        указания, режим генерации, стиль. Кадры и текст не переносятся: для них есть архив.
        Применение — <b>слияние</b>: типы с теми же ключами обновляются, новые добавляются,
        карточки с занятыми именами пропускаются. Ничего не удаляется.
      </p>
      {/* Строки идут столбиком, а не полосой `.row`: у `.row` `justify-content: space-between`,
          и подпись галочки уезжала к правому краю, а «или файлом» ломалось на два слова. */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={withCards}
          onChange={(e) => setWithCards(e.target.checked)}
          /* Глобальные стили делают input шириной 100% — для галочки это лишнее: она
             растягивалась, а подпись уезжала к правому краю. */
          style={{ width: 'auto', flex: '0 0 auto', margin: 0 }}
          data-template-with-cards
        />
        <span>вместе с карточками (персонажи, места, темы)</span>
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <button type="button" className="secondary" onClick={() => void download()} disabled={busy} data-template-download>
          {busy ? 'Готовлю…' : 'Скачать шаблон'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          тот же файл лежит в архиве проекта как template.json
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <label className="muted" style={{ display: 'block', marginBottom: 4 }}>
            Применить шаблон из моего проекта
          </label>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            aria-label="Проект-образец"
            data-template-source
          >
            <option value="">— выберите проект —</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={() => void applyFromProject()} disabled={busy || sourceId === ''} data-template-apply-project>
          Применить
        </button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="muted" style={{ whiteSpace: 'nowrap' }}>или файлом</span>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Файл шаблона"
            style={{ width: 'auto', flex: '0 0 auto' }}
            data-template-file
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void applyFromFile(file)
              e.target.value = ''
            }}
          />
        </label>
      </div>
      {note && (
        <p className="muted" role="status" data-template-note>
          {note}
        </p>
      )}
      {report !== null && (
        <div className="card" style={{ marginTop: 12 }} data-template-report>
          <p style={{ marginTop: 0 }}>{report.message}</p>
          {report.changed === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              Повторное применение того же шаблона ничего не меняет — это ожидаемо.
            </p>
          )}
          {[...(report.types_skipped ?? []), ...(report.cards_skipped ?? [])].length > 0 && (
            <ul className="muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {[...(report.types_skipped ?? []), ...(report.cards_skipped ?? [])].map((skip) => (
                <li key={`${skip.name}-${skip.reason}`}>
                  «{skip.name}»: {skip.reason}
                </li>
              ))}
            </ul>
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
