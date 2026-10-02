import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TimelineStage, type AssetLookup } from '../components/timeline/TimelineStage'
import { ProjectLoading } from '../components/timeline/ProjectLoading'
import { EditorsPanel } from '../components/editors/EditorsPanel'
import { AssistantPanel } from '../components/assistant/AssistantPanel'
import { PresenceBar } from '../components/collab/PresenceBar'
import { ErrorBanner } from '../components/ErrorBanner'
import { useCollab, yAddEvent, type YMap } from '../collab/yprovider'
import { titleString } from '../collab/text'
import { connectionNotice } from '../collab/connection'
import { projectPhase } from '../lib/projectPhase'
import { assetUsage, deleteAsset, listAssets, uploadAsset, type Asset, type AssetUsage } from '../api/assets'
import { serverErrorMessage } from '../api/client'
import {
  importMarkdownInto,
  type MarkdownImportResult,
  type MarkdownImportSource,
  type MarkdownInsertPlace,
} from '../api/storyFiles'
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
  const [assetUsageInfo, setAssetUsage] = useState<AssetUsage | null>(null)
  const [assetNote, setAssetNote] = useState<string | null>(null)
  const [assetBusyId, setAssetBusyId] = useState<string | null>(null)
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

  // Фазу считаем ниже, после событий: она смотрит и на число событий, и на признак
  // «контент загружен» из collab-провайдера, и на то, знаем ли мы роль пользователя.

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

  /**
   * Перечитать список файлов проекта.
   *
   * Нужно после импорта «в место» с вложениями: файлы создаёт сервер, и без
   * перечитывания вложение не показывается ни в кадре, ни в редакторе — его просто
   * нет в списке, по которому интерфейс ищет картинку по id (человек видел бы
   * «вложение прикреплено, но пусто»). Ошибку молча оставляем: содержимое события
   * уже приехало, а файлы подтянутся при следующем открытии проекта.
   */
  const refreshAssets = useCallback(async () => {
    if (!projectId) return
    try {
      setAssets(await listAssets(projectId))
    } catch {
      /* ignore: покажем то, что уже есть */
    }
  }, [projectId])

  /**
   * Расход места в проекте: «занято 8.4 МБ из 10 МБ».
   *
   * Отдельным запросом, потому что список файлов — массив, и служебное поле в нём
   * ломало бы всех, кто его читает. Ошибку молча оставляем: без расхода список
   * файлов просто покажет суммарный вес, а работать в проекте это не мешает.
   */
  useEffect(() => {
    if (!projectId) return
    assetUsage(projectId).then(setAssetUsage).catch(() => setAssetUsage(null))
  }, [projectId, attempt])

  /**
   * Удаление файла проекта.
   *
   * Сервер откажет, если файл ещё прикреплён к кадрам (409), и объяснит это
   * словами — показываем их как есть. После успеха перечитываем и список, и
   * расход: квота освободилась, и это должно быть видно.
   */
  const deleteFile = useCallback(
    async (asset: Asset) => {
      setAssetBusyId(asset.id)
      setAssetNote(null)
      try {
        await deleteAsset(projectId, asset.id)
        await refreshAssets()
        assetUsage(projectId).then(setAssetUsage).catch(() => undefined)
      } catch (e) {
        setAssetNote((await serverErrorMessage(e)) ?? 'Не удалось удалить файл.')
      } finally {
        setAssetBusyId(null)
      }
    },
    [projectId, refreshAssets],
  )

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

  /**
   * Импорт куска md «в место» (файлы уже разобраны в панели редакторов).
   *
   * Вставку делает СЕРВЕР, а не клиент: чтобы разобрать md по правилам проекта,
   * нужен парсер на Go, а он есть только там. Поэтому после ответа документ мог
   * уйти вперёд нас, и дальше всё зависит от транспорта:
   *
   *   - сокет открыт — сервер уже разослал апдейт вставки всем в комнате,
   *     включая эту вкладку: дерево обновится само, перечитывать нечего;
   *   - сокета нет (прокси без Upgrade, мобильная сеть) — апдейт до нас не
   *     доедет, и без перечитывания кусок появился бы только после перезагрузки.
   *     `reloadFromServer` сливает серверное состояние в документ (CRDT не теряет
   *     ни чужие правки, ни наши).
   */
  const importIntoProject = useCallback(
    async (source: MarkdownImportSource, place: MarkdownInsertPlace): Promise<MarkdownImportResult> => {
      const result = await importMarkdownInto(projectId, source, place)
      // Сервер мог создать вложения (картинки из куска) — перечитываем файлы
      // проекта, иначе они не появятся ни в кадре, ни в редакторе.
      if (result.events > 0) await refreshAssets()
      if (collab && !collab.connected) await collab.reloadFromServer()
      return result
    },
    [projectId, collab, refreshAssets],
  )

  const createFirstChapter = useCallback(async () => {
    if (!events) return
    yAddEvent(events, 'Новая глава', '')
    await pushTree()
  }, [events, pushTree])

  const openEditors = useCallback(() => {
    document.querySelector<HTMLElement>('[data-editor-panel]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const openAssistant = useCallback(() => {
    document.querySelector<HTMLElement>('[data-assistant-panel]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  /**
   * Помощник изменил проект: с открытым сокетом апдейт уже приехал (вставку делает
   * сервер и рассылает всем в комнате), а вкладке без realtime нужно перечитать
   * состояние — иначе созданные кадры появятся только после перезагрузки.
   */
  const assistantChanged = useCallback(() => {
    if (collab && !collab.connected) void collab.reloadFromServer()
  }, [collab])

  // Правки доступны владельцу и редактору. Наблюдателю и соавтору, которому
  // владелец открыл закрытый проект, доступно только чтение: редакторы не
  // показываем вовсе — молча неработающие поля хуже, чем их отсутствие.
  // `canEdit === null` — роль ещё не приехала; до этого запись не отправляем,
  // иначе читатель получал 403 в консоль (и лишний трафик).
  const canEdit = project == null ? null : project.role === 'owner' || project.role === 'editor'
  // Пока проект (и роль в нём) не приехал, «можно править» неизвестно: панели не
  // показываем, иначе читатель на мгновение видел бы редакторы. Та же логика, что и
  // у фазы загрузки, поэтому оба признака смотрят на одно и то же.
  const showEditors = project != null && canEdit !== false

  /**
   * Фаза страницы: загрузка, отказ чтения или содержимое.
   *
   * Пустой `Y.Array` до приезда снапшота и по-настоящему пустой проект выглядели
   * одинаково, поэтому на каждом открытии показывалась заглушка «Таймлайн пока пуст»
   * с кнопкой «Добавить первую главу» — вместо загрузки и с риском создать лишнюю
   * главу на медленной связи. Состояние загрузки знает провайдер (`collab.content`),
   * решение о фазе — в `projectPhase` (там же его тесты).
   */
  const phase = projectPhase({
    projectKnown: project != null,
    content: collab?.content ?? 'loading',
    eventsCount,
    failed: error != null,
  })
  const loading = phase === 'loading'

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

  /**
   * Пока содержимое не приехало, страница не гадает: ни заглушки «таймлайн пуст», ни
   * пустого места — анимация загрузки. Отказ чтения (снапшот не пришёл и дерева в базе
   * нет) показываем отдельно: это не пустой проект, и «Добавить первую главу» здесь
   * предлагать нельзя, иначе человек создаст главу в проекте, содержимого которого не видел.
   */
  const retryContent = useCallback(() => {
    void collab?.reloadFromServer().catch(() => undefined)
  }, [collab])

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
      {phase === 'failed' && (
        <div style={{ padding: '16px 24px 0' }}>
          <ErrorBanner
            error={
              new Error(
                'Не удалось загрузить содержимое проекта: сервер не ответил или соединение прервалось.',
              )
            }
            what="Проект"
            onRetry={retryContent}
          />
        </div>
      )}
      {loading && <ProjectLoading />}
      {canEdit === false && !loading && (
        <div className="sf-readonly" data-readonly-banner>
          {project?.coauthor_access
            ? 'Проект открыт вам как соавтору: только чтение, правок здесь нет.'
            : 'Вы наблюдатель в этом проекте: только чтение, правок здесь нет.'}
        </div>
      )}
      {!loading && eventsCount === 0 && showEditors && <EmptyState onCreate={createFirstChapter} />}
      {!loading && eventsCount === 0 && !showEditors && (
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
              <>
                <button className="secondary" onClick={openAssistant} data-assistant-open>
                  ИИ-помощник
                </button>
                <button className="secondary" onClick={openEditors}>
                  Редакторы
                </button>
              </>
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
      {!editorsShown && !loading && presenceBar}

      {editorsShown && !loading && events && (
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
            onImportInto={canEdit ? importIntoProject : undefined}
            presence={collab?.presence}
            onEditing={collab?.setEditing}
            assetUsage={assetUsageInfo}
            onDeleteAsset={canEdit ? deleteFile : undefined}
            assetNote={assetNote}
            assetBusyId={assetBusyId}
          />
        </>
      )}

      {/* Панель помощника показываем и в пустом проекте: «сделай мне проект по
          описанию» — первый же осмысленный вопрос, и он должен быть доступен до
          того, как в таймлайне появится хоть один кадр. */}
      {showEditors && !loading && (
        <AssistantPanel
          projectId={projectId}
          onProjectChanged={assistantChanged}
          onOpenEditors={openEditors}
        />
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
