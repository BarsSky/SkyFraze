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
import { copyText } from '../lib/clipboard'
import { useAuthStore } from '../store/auth'
import { projectsWithUnseen } from '../api/comments'

export function ProjectsPage() {
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
        setNote(`«${created.project.title}» создан по шаблону: ${created.report.message}`)
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
    if (!confirm(`Удалить «${p.title}»?\n\nПроект уедет в корзину: он пропадёт из списка и станет недоступен соавторам, но вернуть его можно будет 30 дней.`)) return
    try {
      await deleteProject(p.id)
      setList((cur) => cur.filter((item) => item.id !== p.id))
      refreshTrash()
      setNote(`«${p.title}» в корзине — вернуть можно 30 дней`)
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
      setNote(`«${p.title}» вернулась в список проектов`)
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
    if (!confirm(`Удалить «${p.title}» навсегда?\n\nТекст, файлы и история версий будут удалены. Вернуть их будет нечем.`)) return
    setTrashBusyId(p.id)
    setError(null)
    try {
      await purgeProject(p.id)
      refreshTrash()
      setNote(`«${p.title}» удалена окончательно`)
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
      setNote(`Архив «${name}» скачан — проект остался в корзине`)
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
      setNote(`Архив «${name}» скачан — загрузите его на другом стенде кнопкой «Импорт проекта»`)
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
          ? `Скачан «${name}»: текст, главы по файлам и картинки — папка для чтения и правок`
          : `Скачан «${name}» — вся история одной лентой`,
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
          ? `Скачан «${name}» — книга для читалки: главы, оглавление и иллюстрации`
          : `Скачан «${name}» — документ для правки в Word или LibreOffice`,
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

  // Свои проекты и участие — в основном списке; открытые соавторами — отдельно,
  // потому что там другой набор действий (только чтение).
  const own = list.filter((p) => p.access !== 'coauthor')
  const shared = list.filter((p) => p.access === 'coauthor')
  const trashCount = trash?.projects.length ?? 0

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h2>Проекты</h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {/* Импорт папки: md-файлы (или zip той же формы) → новый проект с предпросмотром */}
          <button
            type="button"
            className="secondary"
            title="Загрузить папку с md-файлами (или zip из выгрузки «.md + картинки») и создать из неё новый проект"
            onClick={() => setOpenImportFolder(true)}
          >
            Импорт папки
          </button>
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
          {/* Корзина: пока в ней что-то есть, кнопка говорит числом — иначе удалённый
              проект «исчезает» бесследно, и человек не находит способ его вернуть. */}
          <button
            type="button"
            className="secondary"
            aria-expanded={openTrash}
            data-trash-toggle
            title="Удалённые проекты: вернуть или удалить окончательно"
            onClick={() => setOpenTrash((v) => !v)}
          >
            {openTrash ? 'Скрыть корзину' : trashCount > 0 ? `Корзина · ${trashCount}` : 'Корзина'}
          </button>
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
          {/* «По образцу» (0.85.0): необязательный файл шаблона. Без файла — обычный новый
              проект; с файлом — сразу с типами карточек, карточками и настройками помощника. */}
          <label className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted">по образцу</span>
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Файл шаблона проекта"
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
                убрать шаблон
              </button>
            )}
          </label>
          {template !== null && (
            <p className="muted" data-new-template-note style={{ margin: '4px 0 0' }}>
              {templateName || 'шаблон'}: типов {template.entity_types.length}
              {template.cards && template.cards.length > 0 ? `, карточек ${template.cards.length}` : ''}
              {template.ai ? ', настройки помощника' : ''}
            </p>
          )}
          <div style={{ height: 8 }} />
          <button type="submit">{template !== null ? 'Создать по шаблону' : 'Создать'}</button>
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
        {own.length === 0 && <p className="muted">Нет проектов. Создайте первый.</p>}
        {own.map((p) => {
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
                  {(unseen[p.id] ?? 0) > 0 && (
                    <span
                      className="pub-badge pub-badge--new"
                      data-project-unseen={unseen[p.id]}
                      title={`Новых замечаний в обсуждении: ${unseen[p.id]}`}
                    >
                      {unseen[p.id]} новых
                    </span>
                  )}
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
                {/* Вес файлов проекта: место видно до открытия, а не когда загрузка
                    уже упёрлась в предел. */}
                {(() => {
                  const weight = projectWeight(p)
                  if (!weight) return null
                  return (
                    <p className={weight.tight ? 'muted proj-weight proj-weight--tight' : 'muted proj-weight'}>
                      {weight.text}
                      {weight.tight && ' — место заканчивается'}
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
                              ? 'Ссылка скопирована в буфер обмена'
                              : `Скопируйте ссылку вручную: ${publicLink(p)}`,
                          ),
                        )
                      }}
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
                {/* Две выгрузки в Markdown живут в одном меню: рядом с «Экспорт»
                    три кнопки подряд превращали карточку на телефоне в столбик
                    кнопок и вытесняли название проекта. */}
                <details className="dl-menu">
                  <summary
                    className="dl-menu__toggle"
                    title="Выгрузить историю в Markdown: одной лентой или zip с главами и картинками"
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
                      <b>Скачать .md</b>
                      <span className="muted">вся история одной лентой, ссылки на картинки</span>
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
                      <b>.md + картинки</b>
                      <span className="muted">zip: story.md, главы по файлам и assets/</span>
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
                  <summary className="dl-menu__toggle" title="Скачать книгу: EPUB для читалки или DOCX для правки">
                    Книга
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
                      <b>Скачать .epub</b>
                      <span className="muted">книга с оглавлением и иллюстрациями — для читалки</span>
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
                      <b>Скачать .docx</b>
                      <span className="muted">документ Word — для правки и редактора</span>
                    </button>
                  </div>
                </details>
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
                <button className="secondary" onClick={() => void onDelete(p)}>Удалить</button>
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
          <h3 style={{ marginBottom: 4 }}>Проекты соавторов</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Эти проекты открыли вам как соавтору — читать можно целиком, править нельзя.
          </p>
          <div className="list">
            {shared.map((p) => (
              <div key={p.id} className="card row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                  <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Link to={`/projects/${p.id}`}>{p.title}</Link>
                    <span className="pub-badge" title="Доступ только на чтение">только чтение</span>
                  </h3>
                  <p className="muted" style={{ margin: 0 }}>{p.description || <em>без описания</em>}</p>
                </div>
                <Link to={`/projects/${p.id}`}><button className="secondary">Открыть</button></Link>
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
