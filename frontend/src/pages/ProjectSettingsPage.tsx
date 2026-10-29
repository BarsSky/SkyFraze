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
import {
  activateDocxTemplate,
  deleteDocxTemplate,
  downloadDocxSample,
  listDocxTemplates,
  mappingRows,
  uploadDocxTemplate,
  type DocxTemplate,
} from '../api/docxTemplates'
import { useAuthStore } from '../store/auth'
import { ErrorBanner } from '../components/ErrorBanner'
import { formatBytes } from '../lib/format'
import { useT, translate } from '../i18n'
import { useLang, type Lang } from '../store/lang'
import { DocxHelp } from '../components/docx/DocxHelp'
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
  const t = useT()
  const [lang] = useLang()
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
      setNote(t('set.memberAdded', { name }))
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
      setNote(t('set.memberRemoved', { name }))
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
        <h2>{project?.title ?? t('set.title')}</h2>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/coauthors"><button className="secondary">{t('set.coauthors')}</button></Link>
          <Link to={`/projects/${projectId}`}>
            <button className="secondary">{t('set.toTimeline')}</button>
          </Link>
        </div>
      </div>

      {err != null && <ErrorBanner error={err} what={t('set.title')} onRetry={() => void load()} />}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" type="button" onClick={() => setNote(null)}>
            {t('set.ok')}
          </button>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('set.members')}</h3>
        {members.length === 0 && <p className="muted">{t('set.membersEmpty')}</p>}
        <div className="list">
          {members.map((m) => (
            <div key={m.user_id} className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong>{m.display_name ?? m.user_id}</strong>
                {m.username && <span className="coauthors__nick"> @{m.username}</span>}
                <span className="muted"> {m.email}</span>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="muted">{roleLabel(m.role, lang)}</span>
                {isOwner && m.role !== 'owner' && (
                  <button
                    type="button"
                    className="secondary ed-danger"
                    disabled={busy === m.user_id}
                    onClick={() => void onRemove(m.user_id, m.display_name ?? m.user_id)}
                  >
                    {t('set.remove')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {isOwner && (
        <div className="card" data-coauthor-picker>
          <h3 style={{ marginTop: 0 }}>{t('set.addCoauthor')}</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('set.addCoauthorHint')}
          </p>
          {coauthors.length === 0 && (
            <p className="muted">
              {t('set.coauthorsEmpty')}{' '}
              <Link to="/coauthors">{t('set.findPeopleLink')}</Link>
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
                      {crafts.length === 0 && <span className="muted">{t('set.craftsEmpty')}</span>}
                      {crafts.map((craft) => (
                        <span key={craft} className="craft-chip">{craft}</span>
                      ))}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    {member ? (
                      <>
                        <span className="muted">
                          {t('set.inProjectRole', { role: roleLabel(member.role, lang) })}
                        </span>
                        {member.role !== 'owner' && (
                          <button
                            type="button"
                            className="secondary ed-danger"
                            disabled={busy === link.other_id}
                            onClick={() => void onRemove(link.other_id, link.other_display_name)}
                          >
                            {t('set.remove')}
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <select
                          value={roles[link.other_id] ?? 'editor'}
                          aria-label={t('set.roleAria', { name: link.other_display_name })}
                          onChange={(e) =>
                            setRoles((prev) => ({ ...prev, [link.other_id]: e.target.value as 'editor' | 'viewer' }))
                          }
                          style={{
                            background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
                            borderRadius: 6, padding: '8px 10px', minWidth: 130,
                          }}
                        >
                          <option value="editor">{t('set.roleEditor')}</option>
                          <option value="viewer">{t('set.roleViewer')}</option>
                        </select>
                        <button
                          type="button"
                          disabled={busy === link.other_id}
                          onClick={() => void onAdd(link.other_id, link.other_display_name)}
                        >
                          {busy === link.other_id ? '…' : t('set.addToProject')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: 18 }}>
            <h4 style={{ marginBottom: 6 }}>{t('set.findByNick')}</h4>
            <div className="coauthors__search">
              <input
                value={query}
                placeholder={t('set.nickPlaceholder')}
                aria-label={t('set.nickAria')}
                onChange={(e) => {
                  setQuery(e.target.value)
                  void runSearch(e.target.value)
                }}
              />
            </div>
            {found !== null && (
              <div className="coauthors__results" data-picker-results>
                {found.length === 0 && <p className="muted">{t('set.nobodyFound')}</p>}
                {found.map((person) => (
                  <div key={person.id} className="coauthors__row">
                    <div className="coauthors__who">
                      <strong>{person.display_name}</strong>
                      <span className="coauthors__nick">@{person.username}</span>
                    </div>
                    {memberIds.has(person.id) ? (
                      <span className="muted">{t('set.alreadyIn')}</span>
                    ) : person.id === me?.id ? (
                      <span className="muted">{t('set.thatIsYou')}</span>
                    ) : (
                      <button type="button" disabled={busy === person.id} onClick={() => void onAdd(person.id, person.display_name)}>
                        {t('set.addToProject')}
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
          <h3 style={{ marginTop: 0 }}>{t('set.inviteEmail')}</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('set.inviteHint')}
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
              <label className="muted" style={{ display: 'block', marginBottom: 4 }}>
                {t('set.role')}
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}
                style={{
                  background: 'var(--bg)', color: 'var(--fg)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px',
                  minWidth: 130,
                }}
              >
                <option value="editor">{t('set.roleEditor')}</option>
                <option value="viewer">{t('set.roleViewer')}</option>
              </select>
            </div>
            <button type="submit">{t('set.send')}</button>
          </form>
          {lastInvite && (
            <div className="card" style={{ marginTop: 12 }}>
              <p>{t('set.inviteReady', { date: lastInvite.expires_at.slice(0, 10) })}</p>
              <code style={{ wordBreak: 'break-all', display: 'block', padding: 8, background: 'var(--bg)' }}>
                {window.location.origin}/invitations/{lastInvite.token}
              </code>
            </div>
          )}
        </div>
      )}
      {isOwner && <ProjectTemplateCard projectId={projectId} projectTitle={project?.title ?? ''} onErr={setErr} />}
      {isOwner && <DocxTemplateCard projectId={projectId} onErr={setErr} />}
    </div>
  )
}

/**
 * Оформление DOCX по шаблону автора (0.91.0, docs/docx-template.md).
 *
 * Человек загружает свой .docx — с титулом, колонтитулами, полями и стилями заголовков — и
 * скачивание проекта собирается В ЭТОМ ПАКЕТЕ: текст встаёт на место абзаца `{{content}}`.
 * Шаблонов может быть несколько («рукопись», «самиздат»), активный используется при скачивании.
 *
 * Отчёт загрузки показываем целиком: без него непонятно, почему заголовок не того вида. Молча
 * подставлять другой стиль нельзя.
 */
function DocxTemplateCard({ projectId, onErr }: { projectId: string; onErr: (err: unknown) => void }) {
  const t = useT()
  const [lang] = useLang()
  const [templates, setTemplates] = useState<DocxTemplate[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [openReport, setOpenReport] = useState<string | null>(null)
  /** Открыта справка «Как сделать шаблон» (0.94.0). */
  const [helpOpen, setHelpOpen] = useState(false)
  /** Идёт скачивание примера шаблона. */
  const [sampleBusy, setSampleBusy] = useState(false)

  /** Скачать пример шаблона: человек сразу видит, о чём речь, а не читает инструкцию. */
  async function downloadSample() {
    setSampleBusy(true)
    setNote(null)
    try {
      const name = await downloadDocxSample(projectId)
      setNote(t('set.docxSampleReady', { name }))
    } catch (e) {
      onErr(e)
    } finally {
      setSampleBusy(false)
    }
  }

  const load = useCallback(async () => {
    try {
      setTemplates(await listDocxTemplates(projectId))
    } catch (e) {
      onErr(e)
    }
  }, [onErr, projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function upload() {
    if (file === null) return
    setBusy(true)
    setNote(null)
    try {
      const entry = await uploadDocxTemplate(projectId, file, name)
      setNote(
        entry.report.warnings?.length
          ? t('set.docxUploadedWarn', { name: entry.name, count: entry.report.warnings.length })
          : t('set.docxUploaded', { name: entry.name }),
      )
      setFile(null)
      setName('')
      await load()
    } catch (e) {
      onErr(e)
    } finally {
      setBusy(false)
    }
  }

  async function activate(id: string) {
    setBusy(true)
    setNote(null)
    try {
      const list = await activateDocxTemplate(projectId, id)
      setTemplates(list)
      setNote(t('set.docxActivated'))
    } catch (e) {
      onErr(e)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string, label: string) {
    setBusy(true)
    setNote(null)
    try {
      const list = await deleteDocxTemplate(projectId, id)
      setTemplates(list)
      setNote(t('set.docxDeleted', { name: label }))
    } catch (e) {
      onErr(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" data-docx-templates>
      <h3 style={{ marginTop: 0 }}>{t('set.docxTitle')}</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('set.docxHint1')} <b>.docx</b> {t('set.docxHint2')}{' '}
        <code>{'{{content}}'}</code>
        {t('set.docxHint3')}
      </p>
      {/* Справка и пример (0.94.0): до этого «как сделать шаблон» нигде не было видно — человек
          видел только поле загрузки и не знал ни про плейсхолдер, ни про имена стилей. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          className="secondary"
          onClick={() => setHelpOpen(true)}
          data-docx-help-open
        >
          {t('set.docxHowTo')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void downloadSample()}
          data-docx-sample
        >
          {sampleBusy ? t('set.docxPreparing') : t('set.docxDownloadSample')}
        </button>
      </div>
      {helpOpen && <DocxHelp projectId={projectId} onClose={() => setHelpOpen(false)} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 200px', minWidth: 160 }}>
          <label className="muted" style={{ display: 'block', marginBottom: 4 }}>
            {t('set.docxName')}
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('set.docxNamePlaceholder')}
            aria-label={t('set.docxNameAria')}
            data-docx-template-name
            maxLength={40}
          />
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            aria-label={t('set.docxFileAria')}
            style={{ width: 'auto', flex: '0 0 auto' }}
            data-docx-template-file
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null
              setFile(picked)
              if (picked && name.trim() === '') {
                setName(picked.name.replace(/\.docx$/i, '').slice(0, 40))
              }
            }}
          />
        </label>
        <button type="button" onClick={() => void upload()} disabled={busy || file === null} data-docx-template-upload>
          {busy ? t('set.docxUploading') : t('set.docxUpload')}
        </button>
      </div>
      {note && (
        <p className="muted" role="status" data-docx-template-note>
          {note}
        </p>
      )}

      {templates.length === 0 ? (
        <p className="muted" data-docx-template-empty>
          {t('set.docxNone')}
        </p>
      ) : (
        <ul className="docx-tpl" data-docx-template-list>
          {templates.map((item) => (
            <li key={item.id} className="docx-tpl__item" data-docx-template={item.id}>
              <div className="docx-tpl__row">
                <strong className="docx-tpl__name">{item.name}</strong>
                {item.is_active && <span className="docx-tpl__active" data-docx-template-active>{t('set.docxActive')}</span>}
                <span className="muted docx-tpl__meta">
                  {item.filename} · {formatBytes(item.size, lang)}{' '}
                  {t('set.docxStyles', { count: (item.report?.styles ?? item.styles).length })}
                </span>
              </div>
              <div className="docx-tpl__actions">
                {!item.is_active && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void activate(item.id)}
                    disabled={busy}
                    data-docx-template-activate
                  >
                    {t('set.docxActivate')}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setOpenReport((current) => (current === item.id ? null : item.id))}
                  aria-expanded={openReport === item.id}
                  data-docx-template-report-toggle
                >
                  {openReport === item.id ? t('set.docxHideReport') : t('set.docxReport')}
                </button>
                <button
                  type="button"
                  className="secondary ed-danger"
                  onClick={() => void remove(item.id, item.name)}
                  disabled={busy}
                  data-docx-template-delete
                >
                  {t('set.docxDelete')}
                </button>
              </div>
              {openReport === item.id && (
                <div className="docx-tpl__report" data-docx-template-report>
                  <p className="muted" style={{ margin: 0 }}>
                    {item.report.has_placeholder
                      ? t('set.docxPlaceholderOk')
                      : t('set.docxPlaceholderMissing')}
                    {item.page.orientation
                      ? t('set.docxPage', { orientation: item.page.orientation })
                      : ''}
                  </p>
                  {mappingRows(item.report, lang).length > 0 && (
                    <table className="docx-tpl__mapping">
                      <thead>
                        <tr>
                          <th scope="col">{t('set.docxWhatInProject')}</th>
                          <th scope="col">{t('set.docxTemplateStyle')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mappingRows(item.report, lang).map((row) => (
                          <tr key={row.key}>
                            <td>{row.label}</td>
                            <td>
                              <code>{row.style}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {(item.report.warnings ?? []).length > 0 && (
                    <ul className="muted docx-tpl__warnings" data-docx-template-warnings>
                      {(item.report.warnings ?? []).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
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
  const t = useT()
  const [lang] = useLang()
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
        t('set.tplSaved', { types: template.entity_types.length }) +
          (withCards
            ? t('set.tplSavedCards', { cards: template.cards?.length ?? 0 })
            : t('set.tplSavedNoCards')),
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
      setNote(e instanceof Error ? e.message : t('set.tplReadFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" data-project-template>
      <h3 style={{ marginTop: 0 }}>{t('set.tplTitle')}</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('set.tplHint1')} <b>{t('set.tplMerge')}</b>
        {t('set.tplHint2')}
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
        <span>{t('set.tplWithCards')}</span>
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <button type="button" className="secondary" onClick={() => void download()} disabled={busy} data-template-download>
          {busy ? t('set.docxPreparing') : t('set.tplDownload')}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {t('set.tplArchived')}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <label className="muted" style={{ display: 'block', marginBottom: 4 }}>
            {t('set.tplApplyFromProject')}
          </label>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            aria-label={t('set.tplSourceAria')}
            data-template-source
          >
            <option value="">{t('set.tplChoose')}</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={() => void applyFromProject()} disabled={busy || sourceId === ''} data-template-apply-project>
          {t('set.tplApply')}
        </button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="muted" style={{ whiteSpace: 'nowrap' }}>
            {t('set.tplOrFile')}
          </span>
          <input
            type="file"
            accept="application/json,.json"
            aria-label={t('set.tplFileAria')}
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
              {t('set.tplRepeat')}
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

/**
 * Роли называем словами: owner/editor/viewer в интерфейсе ничего не говорят.
 *
 * Язык — параметром (0.124.0), по умолчанию русский: подпись собирается здесь, а не в JSX,
 * поэтому английский интерфейс передаёт свой язык явно.
 */
function roleLabel(role: TeamMember['role'], lang: Lang = 'ru'): string {
  switch (role) {
    case 'owner':
      return translate(lang, 'set.roleOwner')
    case 'editor':
      return translate(lang, 'set.roleEditor')
    default:
      return translate(lang, 'set.roleViewerReadonly')
  }
}
