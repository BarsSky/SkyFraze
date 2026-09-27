import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listProjects, createProject, deleteProject, type Project } from '../api/projects'
import { setPublication } from '../api/feed'
import { exportProject, importProject } from '../api/transfer'
import { ErrorBanner } from '../components/ErrorBanner'
import { useAuthStore } from '../store/auth'

export function ProjectsPage() {
  const [list, setList] = useState<Project[]>([])
  const [error, setError] = useState<unknown>(null)
  const [openNew, setOpenNew] = useState(false)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const userId = useAuthStore((s) => s.user?.id)

  const load = useCallback(() => {
    listProjects()
      .then((data) => {
        setList(data)
        setError(null)
      })
      .catch(setError)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    try {
      const p = await createProject({ title, description: desc })
      setList((cur) => [p, ...cur])
      setTitle('')
      setDesc('')
      setOpenNew(false)
    } catch (e) {
      setError(e)
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Удалить проект?')) return
    try {
      await deleteProject(id)
      setList((cur) => cur.filter((p) => p.id !== id))
    } catch (e) {
      setError(e)
    }
  }

  /** Экспорт: скачиваем архив проекта, чтобы перенести его на другой стенд. */
  async function onExport(p: Project) {
    setBusyId(p.id)
    setError(null)
    try {
      const name = await exportProject(p.id, p.title)
      setNote(`Архив «${name}» скачан — загрузите его на другом стенде кнопкой «Импорт проекта»`)
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  /** Импорт: создаём проект у себя из архива, снятого с другого стенда. */
  async function onImport(file: File) {
    setImporting(true)
    setError(null)
    try {
      const res = await importProject(file)
      setList((cur) => [res.project, ...cur])
      setNote(
        `Проект «${res.project.title}» перенесён: событий ${res.events}, вложений ${res.assets}` +
          (res.state ? ', фон кадров и тексты сохранены' : ''),
      )
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      if (status === 409) {
        // Самая частая ситуация: архив уже загружали в эту базу.
        const body = await (e as { response?: Response }).response
          ?.clone()
          .json()
          .catch(() => null)
        setError(new Error((body as { error?: string } | null)?.error ?? 'Этот архив уже импортирован'))
      } else if (status === 400 || status === 413) {
        setError(new Error('Файл не похож на архив SkyFraze или слишком большой'))
      } else {
        setError(e)
      }
    } finally {
      setImporting(false)
    }
  }

  /** Публикация — единственное действие, открывающее историю для всех. */
  async function onPublish(p: Project) {
    setBusyId(p.id)
    setError(null)
    try {
      const updated = await setPublication(p.id, !p.is_public)
      setList((cur) => cur.map((item) => (item.id === p.id ? updated : item)))
      setNote(
        updated.is_public
          ? `«${updated.title}» опубликована — ссылка /s/${updated.public_slug}`
          : `«${updated.title}» снята с публикации`,
      )
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      setError(status === 403 ? new Error('Публиковать может только владелец проекта') : e)
    } finally {
      setBusyId(null)
    }
  }

  function publicLink(p: Project): string {
    return `${window.location.origin}/s/${p.public_slug}`
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h2>Проекты</h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {/* Перенос проекта: скачать архив здесь — загрузить на другом стенде */}
          <label className="secondary pub-import" title="Загрузить архив .skyfraze.zip, чтобы перенести проект с другого стенда">
            {importing ? 'Импорт…' : 'Импорт проекта'}
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={importing}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void onImport(file)
              }}
            />
          </label>
          <button onClick={() => setOpenNew((v) => !v)}>{openNew ? 'Отмена' : '+ Новый проект'}</button>
        </div>
      </div>

      {openNew && (
        <form className="card" onSubmit={onCreate}>
          <input placeholder="Название" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <div style={{ height: 8 }} />
          <textarea
            placeholder="Описание (опционально)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={3}
          />
          <div style={{ height: 8 }} />
          <button type="submit">Создать</button>
        </form>
      )}

      {error != null && (
        <ErrorBanner
          error={error}
          what="Проекты"
          onRetry={load}
          actions={<Link className="banner__link" to="/feed">Публичная лента</Link>}
        />
      )}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" style={{ marginLeft: 12 }} onClick={() => setNote(null)}>
            ок
          </button>
        </div>
      )}

      <div className="list">
        {list.length === 0 && <p className="muted">Нет проектов. Создайте первый.</p>}
        {list.map((p) => {
          const isOwner = p.owner_id === userId
          return (
            <div key={p.id} className="card row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                <h3 style={{
                  margin: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  <Link to={`/projects/${p.id}`}>{p.title}</Link>
                  {p.is_public && <span className="pub-badge" title="Видна всем в публичной ленте">в ленте</span>}
                </h3>
                <p className="muted" style={{
                  margin: 0,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}>
                  {p.description || <em>без описания</em>}
                </p>
                {p.is_public && p.public_slug && (
                  <p className="muted pub-link">
                    <Link to={`/s/${p.public_slug}`}>/s/{p.public_slug}</Link>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void navigator.clipboard?.writeText(publicLink(p))}
                    >
                      скопировать
                    </button>
                    <span className="muted">просмотров: {p.views_count}</span>
                  </p>
                )}
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button
                  className="secondary"
                  disabled={busyId === p.id}
                  title="Скачать архив проекта, чтобы перенести его на другой стенд SkyFraze"
                  onClick={() => void onExport(p)}
                >
                  {busyId === p.id ? '…' : 'Экспорт'}
                </button>
                {isOwner && (
                  <button
                    className={p.is_public ? 'secondary' : undefined}
                    disabled={busyId === p.id}
                    title={p.is_public ? 'Скрыть историю из ленты' : 'Показать историю всем в ленте'}
                    onClick={() => void onPublish(p)}
                  >
                    {busyId === p.id ? '…' : p.is_public ? 'Снять с публикации' : 'Опубликовать'}
                  </button>
                )}
                <Link to={`/projects/${p.id}/settings`}><button className="secondary">Участники</button></Link>
                <button className="secondary" onClick={() => onDelete(p.id)}>Удалить</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
