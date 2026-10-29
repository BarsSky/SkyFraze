import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  listProjects,
  createProject,
  deleteProject,
  listTrash,
  restoreProject,
  purgeProject,
  type Project,
  type TrashedProject,
} from '../api/projects'
import { setPublication } from '../api/feed'
import { exportProject, importProject } from '../api/transfer'
import {
  createProjectFromTemplate,
  parseTemplate,
  type ProjectTemplate,
} from '../api/projectTemplate'
import { exportStoryBook, exportStoryMarkdown } from '../api/storyFiles'
import { ErrorBanner } from '../components/ErrorBanner'
import { ImportFolderModal } from '../components/ImportFolderModal'
import { TrashPanel } from '../components/projects/TrashPanel'
import { DocxTemplateSwitch } from '../components/projects/DocxTemplateSwitch'
import { projectWeight } from '../lib/projectWeight'
import { useT } from '../i18n'
import { useLang } from '../store/lang'
import { copyText } from '../lib/clipboard'
import { useAuthStore } from '../store/auth'
import { projectsWithUnseen } from '../api/comments'

export function ProjectsPage() {
  const t = useT()
  const [lang] = useLang()
  const [list, setList] = useState<Project[]>([])
  const [error, setError] = useState<unknown>(null)
  const [openNew, setOpenNew] = useState(false)
  const [openImportFolder, setOpenImportFolder] = useState(false)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  /**
   * Шаблон для нового проекта (0.85.0): «начни по образцу другого проекта».
   *
   * Файл, а не выбор из списка: шаблон приходит и из другой инсталляции (его скачали там), и
   * выбор «из проекта» уже сделан в настройках проекта-образца. Здесь только «с нуля» или «по
   * файлу».
   */
  const [template, setTemplate] = useState<ProjectTemplate | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  /**
   * Открытое меню «Книга» у проекта: переключатель оформления DOCX грузится только для него.
   * Состояние живёт здесь, а не в компоненте: меню — это <details> в списке, и без общего
   * состояния переключатель монтировался бы у всех проектов сразу.
   */
  const [bookMenu, setBookMenu] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  /** Проект → сколько новых замечаний ждёт ответа (см. docs/comments.md). */
  const [unseen, setUnseen] = useState<Record<string, number>>({})
  /**
   * Корзина: удалённые проекты и срок, за который их ещё можно вернуть.
   *
   * Список корзины грузим сразу, а не по нажатию: кнопка должна сразу говорить, есть ли
   * там что-то («Корзина · 2»), иначе человек, удаливший проект случайно, не догадается,
   * что его можно вернуть, и уйдёт искать копию в другом месте.
   */
  const [trash, setTrash] = useState<{ projects: TrashedProject[]; retention_days: number } | null>(null)
  const [openTrash, setOpenTrash] = useState(false)
  const [trashBusyId, setTrashBusyId] = useState<string | null>(null)
  const userId = useAuthStore((s) => s.user?.id)
  const navigate = useNavigate()

  const load = useCallback(() => {
    listProjects()
      .then((data) => {
        setList(data)
        setError(null)
      })
      .catch(setError)
  }, [])

  const refreshTrash = useCallback(() => {
    listTrash()
      .then(setTrash)
      // Ошибку корзины не показываем баннером: это не данные проекта, и падать из-за
      // подсказки «есть что вернуть» страница не должна.
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    load()
    refreshTrash()
  }, [load, refreshTrash])

  // Новые замечания: список проектов должен отвечать на вопрос «куда заглянуть», не
  // открывая каждый проект. Ошибку не показываем — это подсказка, а не данные проекта.
  useEffect(() => {
    let alive = true
    projectsWithUnseen()
      .then((rows) => {
        if (!alive) return
        const next: Record<string, number> = {}
        for (const row of rows) next[row.projectId] = row.unread
        setUnseen(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [list])

  // Открытое меню выгрузки закрывается кликом мимо: `<details>` сам этого не делает,
  // а оставленная висеть панель перекрывает кнопки соседних проектов.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.dl-menu')) return
      document
        .querySelectorAll<HTMLDetailsElement>('details.dl-menu[open]')
        .forEach((menu) => menu.removeAttribute('open'))
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    try {
      // «По образцу» (0.85.0): если человек выбрал файл шаблона, проект создаётся сразу с типами
      // карточек, карточками и настройками помощника — одной ручкой, а не «создай и потом примени».
      if (template !== null) {
        const created = await createProjectFromTemplate({
          title,
          description: desc,
          template,
        })
        setTitle('')
        setDesc('')
        setTemplate(null)
        setTemplateName('')
        setOpenNew(false)
        setNote(t('projects.noteTemplateCreated', { title: created.project.title, report: created.report.message }))
        await load()
        return
      }
      const p = await createProject({ title, description: desc })
      setList((cur) => [p, ...cur])
      setTitle('')
      setDesc('')
      setOpenNew(false)
    } catch (e) {
      setError(e)
    }
  }

  /**
   * Удаление — это корзина, а не конец. Поэтому и текст подтверждения другой: человек
   * должен знать, что ошибка поправима, и что срок ограничен. Пока проект в корзине, он
   * не виден ни команде, ни в публичной ленте — это видно и сказано.
   */
  async function onDelete(p: Project) {
    if (!confirm(t('projects.confirmDelete', { title: p.title }))) return
    try {
      await deleteProject(p.id)
      setList((cur) => cur.filter((item) => item.id !== p.id))
      refreshTrash()
      setNote(t('projects.noteTrashed', { title: p.title }))
    } catch (e) {
      setError(e)
    }
  }

  /** Вернуть проект из корзины: полный возврат — текст, файлы, история, участие. */
  async function onRestore(p: TrashedProject) {
    setTrashBusyId(p.id)
    setError(null)
    try {
      await restoreProject(p.id)
      load()
      refreshTrash()
      setNote(t('projects.noteRestored', { title: p.title }))
    } catch (e) {
      setError(e)
    } finally {
      setTrashBusyId(null)
    }
  }

  /**
   * Удалить навсегда. Подтверждение отдельное и явное: это единственное действие в
   * списке проектов, которое нельзя отменить ничем, кроме ночной копии.
   */
  async function onPurge(p: TrashedProject) {
    if (!confirm(t('projects.confirmPurge', { title: p.title }))) return
    setTrashBusyId(p.id)
    setError(null)
    try {
      await purgeProject(p.id)
      refreshTrash()
      setNote(t('projects.notePurged', { title: p.title }))
    } catch (e) {
      setError(e)
    } finally {
      setTrashBusyId(null)
    }
  }

  /**
   * Сохранить архив проекта из корзины, не возвращая его в список: «удалить можно, а
   * посмотреть — нельзя» — не порядок. Архив содержит текст, вложения и CRDT-снапшот
   * (фон кадров, привязки), то есть весит столько же, сколько у активного проекта.
   */
  async function onExportTrashed(p: TrashedProject) {
    setTrashBusyId(p.id)
    setError(null)
    try {
      const name = await exportProject(p.id, p.title)
      setNote(t('projects.noteTrashExported', { name }))
    } catch (e) {
      setError(e)
    } finally {
      setTrashBusyId(null)
    }
  }

  /** Экспорт: скачиваем архив проекта, чтобы перенести его на другой стенд. */
  async function onExport(p: Project) {
    setBusyId(p.id)
    setError(null)
    try {
      const name = await exportProject(p.id, p.title)
      setNote(t('projects.noteExported', { name }))
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Выгрузка в Markdown: одной лентой или zip-архивом с главами по файлам и
   * картинками. Второй вариант читается и человеком, и внешними инструментами, и
   * им же можно перенести проект («Импорт папки» принимает такой zip).
   */
  async function onDownloadMarkdown(p: Project, assets: boolean) {
    setBusyId(p.id)
    setError(null)
    try {
      const name = await exportStoryMarkdown(p.id, { assets, projectTitle: p.title })
      setNote(
        assets
          ? t('projects.noteMdFolder', { name })
          : t('projects.noteMdFeed', { name }),
      )
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Книга файлом: EPUB для читалки, DOCX для правки. Отдельно от Markdown — это не
   * «текст проекта», а собранная книга: главы, оглавление, иллюстрации.
   */
  async function onDownloadBook(p: Project, format: 'epub' | 'docx') {
    setBusyId(p.id)
    setError(null)
    try {
      const name = await exportStoryBook(p.id, format, p.title)
      setNote(
        format === 'epub'
          ? t('projects.noteEpub', { name })
          : t('projects.noteDocx', { name }),
      )
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  /** Закрывает меню выгрузки, из которого пришло нажатие. */
  function closeMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.currentTarget.closest('details')?.removeAttribute('open')
  }

  /** Импорт: создаём проект у себя из архива, снятого с другого стенда. */
  async function onImport(file: File) {
    setImporting(true)
    setError(null)
    try {
      const res = await importProject(file)
      setList((cur) => [res.project, ...cur])
      setNote(
        t('projects.noteImported', { title: res.project.title, events: res.events, assets: res.assets }) +
          (res.state ? t('projects.noteImportedState') : ''),
      )
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      if (status === 409) {
        // Самая частая ситуация: архив уже загружали в эту базу.
        const body = await (e as { response?: Response }).response
          ?.clone()
          .json()
          .catch(() => null)
        setError(new Error((body as { error?: string } | null)?.error ?? t('projects.errAlreadyImported')))
      } else if (status === 400 || status === 413) {
        setError(new Error(t('projects.errBadArchive')))
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
          ? t('projects.notePublished', { title: updated.title, slug: updated.public_slug ?? '' })
          : t('projects.noteUnpublished', { title: updated.title }),
      )
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      setError(status === 403 ? new Error(t('projects.errPublishOwner')) : e)
    } finally {
      setBusyId(null)
    }
  }

  function publicLink(p: Project): string {
    return `${window.location.origin}/s/${p.public_slug}`
  }

  // Свои проекты и участие — в основном списке; открытые соавторами — отдельно,
  // потому что там другой набор действий (только чтение).
  const own = list.filter((p) => p.access !== 'coauthor')
  const shared = list.filter((p) => p.access === 'coauthor')
  const trashCount = trash?.projects.length ?? 0

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h2>{t('projects.title')}</h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {/* Импорт папки: md-файлы (или zip той же формы) → новый проект с предпросмотром */}
          <button
            type="button"
            className="secondary"
            title={t('projects.importFolderTitle')}
            onClick={() => setOpenImportFolder(true)}
          >
            {t('projects.importFolder')}
          </button>
          {/* Перенос проекта: скачать архив здесь — загрузить на другом стенде */}
          <label className="secondary pub-import" title={t('projects.importTitle')}>
            {importing ? t('projects.importing') : t('projects.import')}
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
          <button onClick={() => setOpenNew((v) => !v)}>{openNew ? t('projects.cancel') : t('projects.newToggle')}</button>
          {/* Корзина: пока в ней что-то есть, кнопка говорит числом — иначе удалённый
              проект «исчезает» бесследно, и человек не находит способ его вернуть. */}
          <button
            type="button"
            className="secondary"
            aria-expanded={openTrash}
            data-trash-toggle
            title={t('projects.trashTitle')}
            onClick={() => setOpenTrash((v) => !v)}
          >
            {openTrash ? t('projects.trashHide') : trashCount > 0 ? t('projects.trashCount', { count: trashCount }) : t('projects.trash')}
          </button>
        </div>
      </div>

      {openNew && (
        <form className="card" onSubmit={onCreate}>
          <input placeholder={t('projects.name')} value={title} onChange={(e) => setTitle(e.target.value)} required />
          <div style={{ height: 8 }} />
          <textarea
            placeholder={t('projects.desc')}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={3}
          />
          <div style={{ height: 8 }} />
          {/* «По образцу» (0.85.0): необязательный файл шаблона. Без файла — обычный новый
              проект; с файлом — сразу с типами карточек, карточками и настройками помощника. */}
          <label className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted">{t('projects.byTemplate')}</span>
            <input
              type="file"
              accept="application/json,.json"
              aria-label={t('projects.templateFileAria')}
              /* Глобальные стили делают input шириной 100% — для выбора файла это лишнее. */
              style={{ width: 'auto', flex: '0 0 auto' }}
              data-new-template-file
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                file
                  .text()
                  .then((text) => {
                    setTemplate(parseTemplate(text))
                    setTemplateName(file.name)
                    setError(null)
                  })
                  .catch((err: unknown) => {
                    setTemplate(null)
                    setTemplateName('')
                    setError(err)
                  })
              }}
            />
            {template !== null && (
              <button type="button" className="secondary" onClick={() => { setTemplate(null); setTemplateName('') }}>
                {t('projects.templateRemove')}
              </button>
            )}
          </label>
          {template !== null && (
            <p className="muted" data-new-template-note style={{ margin: '4px 0 0' }}>
              {t('projects.templateNote', { name: templateName || t('projects.templateName'), types: template.entity_types.length })}
              {template.cards && template.cards.length > 0 ? t('projects.templateCards', { cards: template.cards.length }) : ''}
              {template.ai ? t('projects.templateAi') : ''}
            </p>
          )}
          <div style={{ height: 8 }} />
          <button type="submit">{template !== null ? t('projects.createByTemplate') : t('projects.create')}</button>
        </form>
      )}

      {error != null && (
        <ErrorBanner
          error={error}
          what={t('projects.errorWhat')}
          onRetry={load}
          actions={<Link className="banner__link" to="/feed">{t('projects.feedLink')}</Link>}
        />
      )}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" style={{ marginLeft: 12 }} onClick={() => setNote(null)}>
            {t('projects.noteOk')}
          </button>
        </div>
      )}

      <div className="list">
        {own.length === 0 && <p className="muted">{t('projects.empty')}</p>}
        {own.map((p) => {
          const isOwner = p.owner_id === userId
          return (
            <div key={p.id} className="card row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                {/* Заголовок переносится, а не рвётся за край (0.98.3). Было whiteSpace: 'nowrap' и
                    textOverflow: 'ellipsis': длинное название — особенно одно слово без пробелов —
                    не переносилось, ссылка вырастала до 472 px при карточке 336, и текст уезжал за
                    экран. Горизонтальной прокрутки у страницы нет, поэтому добраться до него было
                    нечем. Теперь две строки с многоточием и перенос внутри слова. */}
                <h3 style={{
                  margin: 0,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflowWrap: 'anywhere',
                }}>
                  <Link to={`/projects/${p.id}`}>{p.title}</Link>
                  {p.is_public && <span className="pub-badge" title={t('projects.inFeedTitle')}>{t('projects.inFeed')}</span>}
                  {(unseen[p.id] ?? 0) > 0 && (
                    <span
                      className="pub-badge pub-badge--new"
                      data-project-unseen={unseen[p.id]}
                      title={t('projects.newCommentsTitle', { count: unseen[p.id] })}
                    >
                      {t('projects.newComments', { count: unseen[p.id] })}
                    </span>
                  )}
                </h3>
                <p className="muted" style={{
                  margin: 0,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  // Длинная ссылка или слово без пробелов переносится, а не обрезается посреди
                  // токена: две строки остаются, но текст в них читается (0.98.3).
                  overflowWrap: 'anywhere',
                }}>
                  {p.description || <em>{t('projects.noDescription')}</em>}
                </p>
                {/* Вес файлов проекта: место видно до открытия, а не когда загрузка
                    уже упёрлась в предел. */}
                {(() => {
                  const weight = projectWeight(p, lang)
                  if (!weight) return null
                  return (
                    <p className={weight.tight ? 'muted proj-weight proj-weight--tight' : 'muted proj-weight'}>
                      {weight.text}
                      {weight.tight && t('projects.nearlyFull')}
                    </p>
                  )
                })()}
                {p.is_public && p.public_slug && (
                  <p className="muted pub-link">
                    <Link to={`/s/${p.public_slug}`}>/s/{p.public_slug}</Link>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        void copyText(publicLink(p)).then((done) =>
                          setNote(
                            done
                              ? t('projects.copied')
                              : t('projects.copyManual', { link: publicLink(p) }),
                          ),
                        )
                      }}
                    >
                      {t('projects.copy')}
                    </button>
                    <span className="muted">{t('projects.views', { count: p.views_count })}</span>
                  </p>
                )}
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button
                  className="secondary"
                  disabled={busyId === p.id}
                  title={t('projects.exportTitle')}
                  onClick={() => void onExport(p)}
                >
                  {busyId === p.id ? '…' : t('projects.export')}
                </button>
                {/* Две выгрузки в Markdown живут в одном меню: рядом с «Экспорт»
                    три кнопки подряд превращали карточку на телефоне в столбик
                    кнопок и вытесняли название проекта. */}
                <details className="dl-menu">
                  <summary
                    className="dl-menu__toggle"
                    title={t('projects.mdTitle')}
                  >
                    Markdown
                  </summary>
                  <div className="dl-menu__panel">
                    <button
                      type="button"
                      className="dl-menu__item"
                      disabled={busyId === p.id}
                      onClick={(e) => {
                        closeMenu(e)
                        void onDownloadMarkdown(p, false)
                      }}
                    >
                      <b>{t('projects.mdDownload')}</b>
                      <span className="muted">{t('projects.mdDownloadHint')}</span>
                    </button>
                    <button
                      type="button"
                      className="dl-menu__item"
                      disabled={busyId === p.id}
                      onClick={(e) => {
                        closeMenu(e)
                        void onDownloadMarkdown(p, true)
                      }}
                    >
                      <b>{t('projects.mdAssets')}</b>
                      <span className="muted">{t('projects.mdAssetsHint')}</span>
                    </button>
                  </div>
                </details>
                {/* Книга файлом: EPUB читают, DOCX правят. Отдельное меню, а не пункты
                    в Markdown: это разные задачи — «перенести текст» и «получить книгу». */}
                <details
                  className="dl-menu"
                  // Переключатель оформления грузится только когда меню открыли (0.93.1):
                  // иначе список проектов делал бы запрос шаблонов на каждый проект ради меню,
                  // которое чаще всего не открывают.
                  onToggle={(event) => {
                    // `currentTarget` живёт только во время обработчика: внутри updater'а он уже
                    // null. Поэтому «открыто?» снимаем сразу, а не в функции обновления.
                    const open = event.currentTarget.open
                    setBookMenu((current) => {
                      if (open) return p.id
                      return current === p.id ? null : current
                    })
                  }}
                >
                  <summary className="dl-menu__toggle" title={t('projects.bookTitle')}>
                    {t('projects.book')}
                  </summary>
                  <div className="dl-menu__panel">
                    <button
                      type="button"
                      className="dl-menu__item"
                      disabled={busyId === p.id}
                      onClick={(e) => {
                        closeMenu(e)
                        void onDownloadBook(p, 'epub')
                      }}
                    >
                      <b>{t('projects.epub')}</b>
                      <span className="muted">{t('projects.epubHint')}</span>
                    </button>
                    {/* Каким оформлением соберётся .docx — видно ЗДЕСЬ, до нажатия: за выбором
                        оформления раньше нужно было уходить в настройки проекта. */}
                    {bookMenu === p.id && (
                      <DocxTemplateSwitch
                        projectId={p.id}
                        // Роль в списке проектов приходит не всегда (`role` есть у участий,
                        // у своего проекта она может быть пустой) — владелец определяется по
                        // `owner_id`, иначе переключатель был бы выключен у автора.
                        canEdit={p.role === 'owner' || p.role === 'editor' || p.owner_id === userId}
                      />
                    )}
                    <button
                      type="button"
                      className="dl-menu__item"
                      disabled={busyId === p.id}
                      onClick={(e) => {
                        closeMenu(e)
                        void onDownloadBook(p, 'docx')
                      }}
                    >
                      <b>{t('projects.docx')}</b>
                      <span className="muted">{t('projects.docxHint')}</span>
                    </button>
                  </div>
                </details>
                {isOwner && (
                  <button
                    className={p.is_public ? 'secondary' : undefined}
                    disabled={busyId === p.id}
                    title={p.is_public ? t('projects.unpublishTitle') : t('projects.publishTitle')}
                    onClick={() => void onPublish(p)}
                  >
                    {busyId === p.id ? '…' : p.is_public ? t('projects.unpublish') : t('projects.publish')}
                  </button>
                )}
                <Link to={`/projects/${p.id}/settings`}><button className="secondary">{t('projects.members')}</button></Link>
                <button className="secondary" onClick={() => void onDelete(p)}>{t('projects.delete')}</button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Корзина: отдельным блоком под списком. Удалённое не должно стоять рядом с
          рабочим — но и не должно исчезать без следа: «вернуть можно 30 дней» это
          обещание, а обещание без кнопки не существует. */}
      {openTrash && (
        <div style={{ marginTop: 16 }}>
          <TrashPanel
            items={trash?.projects ?? []}
            retentionDays={trash?.retention_days ?? 30}
            busyId={trashBusyId}
            onRestore={(p) => void onRestore(p)}
            onExport={(p) => void onExportTrashed(p)}
            onPurge={(p) => void onPurge(p)}
          />
        </div>
      )}

      {/* Проекты соавторов: открыты владельцем на чтение. Правок здесь нет —
          ни публикации, ни участников, ни удаления; только «открыть». */}
      {shared.length > 0 && (
        <div className="projects__shared" data-shared-projects>
          <h3 style={{ marginBottom: 4 }}>{t('projects.sharedTitle')}</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('projects.sharedHint')}
          </p>
          <div className="list">
            {shared.map((p) => (
              <div key={p.id} className="card row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                  {/* Те же две строки с переносом, что и у своих проектов (0.98.3). */}
                  <h3 style={{ margin: 0, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>
                    <Link to={`/projects/${p.id}`}>{p.title}</Link>
                    <span className="pub-badge" title={t('projects.readOnlyTitle')}>{t('projects.readOnly')}</span>
                  </h3>
                  <p className="muted" style={{ margin: 0 }}>{p.description || <em>{t('projects.noDescription')}</em>}</p>
                </div>
                <Link to={`/projects/${p.id}`}><button className="secondary">{t('projects.open')}</button></Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Импорт папки с md: отдельное окно с предпросмотром дерева. */}
      {openImportFolder && (
        <ImportFolderModal
          onClose={() => setOpenImportFolder(false)}
          onCreated={(projectId) => {
            setOpenImportFolder(false)
            navigate(`/projects/${projectId}`)
          }}
        />
      )}
    </div>
  )
}
