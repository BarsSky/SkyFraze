import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TimelineStage, type AssetLookup } from '../components/timeline/TimelineStage'
import { EditorsPanel } from '../components/editors/EditorsPanel'
import { PresenceBar } from '../components/collab/PresenceBar'
import { ErrorBanner } from '../components/ErrorBanner'
import { useCollab, yAddEvent, type YMap } from '../collab/yprovider'
import { titleString } from '../collab/text'
import { connectionNotice } from '../collab/connection'
import { listAssets, uploadAsset, type Asset } from '../api/assets'
import { useAssetObjectUrls } from '../api/assetObject'
import type { Project } from '../api/projects'
import { getProject } from '../api/projects'

/**
 * Страница проекта — только композиция и данные:
 *   TimelineStage (показ и навигация) + EditorsPanel (единственное место правок).
 * Связь односторонняя: редактор сообщает об изменении (`onChanged`), страница
 * проецирует дерево на сервер и, при необходимости, просит стадию перейти к кадру.
 */
export function ProjectTimelinePage() {
  const params = useParams()
  const projectId = params.id ?? ''
  const [project, setProject] = useState<Project | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [eventsCount, setEventsCount] = useState<number>(-1) // -1 = loading
  /** Названия событий для бара присутствия: подпись «Аня правит …». */
  const [eventTitles, setEventTitles] = useState<Array<{ id: string; title: string }>>([])
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [connectionNote, setConnectionNote] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)

  const collab = useCollab(projectId)
  const events = collab?.events
  const realtime = collab?.connected ?? false
  const connectionStatus = collab?.status ?? 'connecting'
  const reconnectAttempt = collab?.reconnectAttempt ?? 0

  // Realtime может быть недоступен (прокси, мобильная сеть, закрытый WebSocket):
  // работать можно, но люди должны понимать, почему правки не летят другим сразу.
  // Разные состояния — разные сообщения: «переподключаюсь…» (связь была и
  // возвращается) и «realtime недоступен» (повторы не помогают) — это не одно и
  // то же, и раньше наружу торчал только флаг «не подключено».
  //
  // Сообщение о связи живёт отдельно от сообщения о проекции дерева: раньше оба
  // писались в одну строку, и «серверная копия обновлена» от проекции выглядело
  // как ответ на разрыв соединения.
  const connectionMessage = connectionNotice(connectionStatus, reconnectAttempt)
  useEffect(() => {
    if (!collab || !connectionMessage) {
      setConnectionNote(null)
      return undefined
    }
    if (realtime) return undefined
    // Первые секунды разрыва ничего не показываем: короткое переподключение
    // человеку видеть не нужно, и мигание текста раздражает.
    const timer = setTimeout(() => setConnectionNote(connectionMessage), 4000)
    return () => clearTimeout(timer)
  }, [collab, connectionMessage, realtime])

  useEffect(() => {
    getProject(projectId)
      .then((p) => {
        setProject(p)
        setError(null)
      })
      .catch((e) => setError(e))
  }, [projectId, attempt])

  useEffect(() => {
    if (!projectId) return
    listAssets(projectId).then(setAssets).catch(() => setAssets([]))
  }, [projectId, attempt])

  // Длина Y.Array: переключение empty-state ↔ стадия и зависимость для мемо.
  useEffect(() => {
    if (!events) {
      setEventsCount(-1)
      return
    }
    const update = () => setEventsCount(events.length)
    update()
    events.observe(update)
    return () => events.unobserve(update)
  }, [events])

  // Названия событий — подпись «кто что правит» в баре присутствия. Наблюдаем
  // глубоко: заголовок меняется в редакторе, и подпись должна ехать за ним.
  useEffect(() => {
    if (!events) {
      setEventTitles((prev) => (prev.length === 0 ? prev : []))
      return undefined
    }
    const read = () =>
      (events.toArray() as YMap[])
        .map((m) => ({
          id: (m.get('id') as string | undefined) ?? '',
          title: titleString(m),
        }))
        .filter((event) => event.id.length > 0)
    const update = () => {
      const next = read()
      // Сравнение по значению: observeDeep срабатывает и на текст события, а без
      // проверки каждое нажатие в поле перерисовывало бы всю страницу.
      setEventTitles((prev) => (sameEventTitles(prev, next) ? prev : next))
    }
    update()
    events.observeDeep(update)
    return () => events.unobserveDeep(update)
  }, [events])

  // Ассеты требуют авторизации: получаем blob-URL (иначе <img> отдаёт 401).
  const assetIds = useMemo(() => assets.map((asset) => asset.id), [assets])
  const assetUrls = useAssetObjectUrls(assetIds)

  const assetsById = useMemo<Record<string, AssetLookup>>(() => {
    const map: Record<string, AssetLookup> = {}
    for (const asset of assets) {
      const url = assetUrls[asset.id]
      if (url) map[asset.id] = { url, mime: asset.mime }
    }
    return map
  }, [assets, assetUrls])

  /**
   * Проекция дерева на сервер — только когда realtime не поднялся.
   *
   * Фаза 4: строки таблицы событий сервер строит сам из своего документа (он же
   * пишет и снапшот), поэтому у подключённого клиента проекция — лишняя работа и
   * лишний повод для 409. REST-путь остаётся для клиента без сокета (прокси без
   * Upgrade, мобильная сеть): там сервер о правках ничего не знает.
   */
  const pushTree = useCallback(async () => {
    if (!collab || collab.connected) return
    const res = await collab.syncTree()
    if (res.ok) {
      setSyncNote(res.repaired ? `структура исправлена на сервере (${res.repaired})` : 'серверная копия обновлена')
    } else if (res.reason === 'forbidden') {
      setSyncNote('только чтение: ваша роль не позволяет менять таймлайн')
    } else if (res.reason === 'rejected') {
      setSyncNote('сервер отклонил структуру дерева (цикл/глубина)')
    } else if (res.reason === 'conflict') {
      setSyncNote('сервер обгоняет по ревизии: проекция дерева не применилась, повторю позже')
    } else {
      setSyncNote('не удалось синхронизировать дерево с сервером')
    }
  }, [collab])

  const uploadFile = useCallback(
    async (file: File): Promise<Asset | null> => {
      try {
        const asset = await uploadAsset(projectId, file)
        setAssets((current) => [asset, ...current])
        return asset
      } catch (e) {
        console.error('upload failed', e)
        return null
      }
    },
    [projectId],
  )

  const createFirstChapter = useCallback(async () => {
    if (!events) return
    yAddEvent(events, 'Новая глава', '')
    await pushTree()
  }, [events, pushTree])

  const openEditors = useCallback(() => {
    document.querySelector<HTMLElement>('[data-editor-panel]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // Правки доступны владельцу и редактору. Наблюдателю и соавтору, которому
  // владелец открыл закрытый проект, доступно только чтение: редакторы не
  // показываем вовсе — молча неработающие поля хуже, чем их отсутствие.
  // `canEdit === null` — роль ещё не приехала; до этого запись не отправляем,
  // иначе читатель получал 403 в консоль (и лишний трафик).
  const canEdit = project == null ? null : project.role === 'owner' || project.role === 'editor'
  const showEditors = canEdit !== false

  useEffect(() => {
    collab?.setWritable(canEdit)
  }, [collab, canEdit])

  /**
   * Кто сейчас в проекте. Один элемент на страницу: он либо над панелью
   * редакторов (см. разметку), либо над стадией у читателя. Соседей нет — бар
   * не рендерит ничего, поэтому «в проекте только вы» нигде не маячит.
   */
  const presenceBar = <PresenceBar peers={collab?.presence ?? []} events={eventTitles} />
  /** Панель редакторов: только тем, кто может править, и только с событиями. */
  const editorsShown = Boolean(events && eventsCount > 0 && showEditors)

  return (
    <div className="sf-page">
      {error != null && (
        <div style={{ padding: '16px 24px 0' }}>
          <ErrorBanner
            error={error}
            what="Проект"
            onRetry={() => setAttempt((n) => n + 1)}
            actions={
              <>
                <Link className="banner__link" to="/projects">← К проектам</Link>
                <Link className="banner__link" to="/feed">Лента</Link>
              </>
            }
          />
        </div>
      )}
      {canEdit === false && (
        <div className="sf-readonly" data-readonly-banner>
          {project?.coauthor_access
            ? 'Проект открыт вам как соавтору: только чтение, правок здесь нет.'
            : 'Вы наблюдатель в этом проекте: только чтение, правок здесь нет.'}
        </div>
      )}
      {eventsCount === -1 && !error && <p className="muted">Подключение к realtime-серверу…</p>}
      {eventsCount === 0 && showEditors && <EmptyState onCreate={createFirstChapter} />}
      {eventsCount === 0 && !showEditors && (
        <div className="sf-empty">
          <h3 className="sf-empty__title">Таймлайн пока пуст</h3>
          <p className="muted sf-empty__text">Автор ещё не добавил ни одной главы.</p>
        </div>
      )}

      {events && eventsCount > 0 && (
        <TimelineStage
          events={events}
          assetsById={assetsById}
          projectTitle={project?.title ?? 'Таймлайн'}
          actions={
            showEditors ? (
              <button className="secondary" onClick={openEditors}>
                Редакторы
              </button>
            ) : undefined
          }
        />
      )}

      {/* Читателю и в пустом проекте панели редакторов нет, и бар остаётся
          единственным местом про присутствие — в обычном потоке над стадией. У
          редактора бар стоит рядом со строкой синхронизации, над панелью:
          fixed-слои стадии (sf-stage, z-index 10, непрозрачный фон) закрывают
          всё, что в потоке выше трека, поэтому «над стадией» у редактора было бы
          не видно вовсе. */}
      {!editorsShown && presenceBar}

      {editorsShown && events && (
        <>
          {presenceBar}
          <EditorsPanel
            events={events}
            assets={assets}
            assetUrls={assetUrls}
            syncNote={connectionNote ?? syncNote}
            onChanged={() => {
              void pushTree()
            }}
            onUpload={uploadFile}
            presence={collab?.presence}
            onEditing={collab?.setEditing}
          />
        </>
      )}
    </div>
  )
}

/**
 * Совпадают ли списки названий событий по значению.
 *
 * Нужна, чтобы `observeDeep` на каждое нажатие в тексте события не перерисовывал
 * страницу: ссылка на массив меняется всегда, а содержимое — только когда тронули
 * заголовок или состав дерева.
 */
function sameEventTitles(
  a: Array<{ id: string; title: string }>,
  b: Array<{ id: string; title: string }>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].title !== b[i].title) return false
  }
  return true
}

/** Empty-state: единственное действие — создать первую главу. */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="sf-empty">
      <div className="sf-empty__mark">+</div>
      <h3 className="sf-empty__title">Таймлайн пока пуст</h3>
      <p className="muted sf-empty__text">
        Создайте первую главу: дальше появится сценический таймлайн — прокрутка ведёт по кадрам,
        а внутри главы по одному раскрываются её под-события.
      </p>
      <button onClick={onCreate}>+ Добавить первую главу</button>
      <p className="muted sf-empty__hint">
        Тексты, вложения и фон кадров настраиваются в блоке «Редакторы» под таймлайном
      </p>
    </div>
  )
}
