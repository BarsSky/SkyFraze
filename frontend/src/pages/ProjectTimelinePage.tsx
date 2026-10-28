import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TimelineStage, type AssetLookup } from '../components/timeline/TimelineStage'
import { ProjectLoading } from '../components/timeline/ProjectLoading'
import { EditorsPanel } from '../components/editors/EditorsPanel'
import { RelationsPanel } from '../components/entities/RelationsPanel'
import { AssistantDock } from '../components/assistant/AssistantDock'
import { VersionsModal } from '../components/versions/VersionsModal'
import { PresenceBar } from '../components/collab/PresenceBar'
import { ErrorBanner } from '../components/ErrorBanner'
import { useCollab, yAddEvent, type YMap } from '../collab/yprovider'
import type { Mention } from '../collab/mentions'
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
 * Режим работы над проектом (0.83.0).
 *
 * «Проект» — показ с прокруткой: сцены и кадры так, как их увидит читатель. Остальные три —
 * рабочие вкладки: правка текста, связи карточек и история версий. Переключение мгновенное,
 * вкладки друг друга не перекрывают (в отличие от прежней прокрутки между разделами).
 */
type ProjectView = 'project' | 'editors' | 'relations' | 'versions'

/** Подписи вкладок в порядке показа: сначала «как выглядит», потом «что править». */
const PROJECT_TABS: Array<{ id: ProjectView; title: string }> = [
  { id: 'project', title: 'Проект' },
  { id: 'editors', title: 'Редакторы' },
  { id: 'relations', title: 'Связи' },
  { id: 'versions', title: 'Версии' },
]

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
  /**
   * Открыто ли плавающее окно помощника.
   *
   * С 0.83.0 кнопки «ИИ-помощник» в шапке стадии нет: помощник — плавающий чат, доступный в
   * любой вкладке, и отдельный пункт в строке режимов ему не нужен (просьба из отчёта).
   */
  const [assistantOpen, setAssistantOpen] = useState(false)
  /**
   * Режим работы над проектом (0.83.0): «Проект» — показ с прокруткой, остальные три — рабочие
   * вкладки владельца и соавторов. Раньше это были кнопки, которые прокручивали страницу к
   * разделам, лежащим друг под другом; из-за этого «Связи» наезжали на показ проекта, а редактор
   * и карточки жили в одной длинной колонке.
   *
   * У читателя вкладок нет: публичный показ остаётся прежним (прокрутка по сценам).
   */
  const [view, setView] = useState<ProjectView>('project')
  /**
   * Просьба открыть кадр в редакторе (0.87.0).
   *
   * Раньше «Связи» отправляли событие `skyfraze:open-frame`, и его ловила панель редакторов.
   * С 0.83.0 эта панель монтируется только на своей вкладке: событие, отправленное из «Связей»,
   * не слышал никто — переходы по матрице и хронологии перестали работать. Теперь страница
   * сама переключает вкладку и передаёт просьбу панели пропсом (детерминированно: панель
   * получает её уже смонтированной).
   */
  const [openFrameRequest, setOpenFrameRequest] = useState<
    { frameId: string; mention?: Mention; nonce: number } | null
  >(null)
  /** Кадр, к которому надо прокрутить показ проекта (кнопка «К проекту»). */
  const [focusFrame, setFocusFrame] = useState<{ id: string; nonce: number } | null>(null)

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

  /**
   * Переход к рабочим вкладкам (0.83.0) — переключение, а не прокрутка.
   *
   * Раньше обе функции прокручивали `main` к разделам, лежащим друг под другом: «Редакторы» к
   * панели, «Связи» к карточкам. Это и давало наезд раздела на показ проекта. Теперь режим
   * меняется мгновенно; прокрутка осталась только внутри вкладки «Проект» — там, где она и
   * нужна: она и есть показ сцен.
   */
  const openEditors = useCallback(() => {
    setView('editors')
  }, [])

  /** Тот же мгновенный переход к «Связям» — его вызывает и тулбар панели редакторов. */
  const openRelations = useCallback(() => {
    setView('relations')
  }, [])

  /**
   * Помощник изменил проект: сливаем серверное состояние в документ — ВСЕГДА.
   *
   * Почему не «только если сокет закрыт», как было. Правку делает сервер, и до вкладки
   * она доезжает двумя путями: апдейтом по сокету (если комната жива) или не доезжает
   * вовсе (комнаты нет: сокет не поднялся, оборвался, комната выгрузилась). Признак
   * `connected` про первый путь, а не про второй, и расхождение между ними — не теория:
   * в e2e оно выглядело как «помощник ответил „Создал главу“, а таймлайн пуст».
   *
   * Слияние идемпотентно (CRDT): если апдейт уже приехал, `mergeRemoteState` ничего не
   * меняет, а если не приехал — дерево получает созданные кадры без перезагрузки
   * страницы. Стоит это одного GET на осознанное действие агента.
   *
   * `quiet: true` обязателен: обычное перечитывание переводит страницу в фазу загрузки
   * и размонтирует панели — окно помощника закрылось бы прямо во время ответа.
   */
  const assistantChanged = useCallback(() => {
    void collab?.reloadFromServer({ quiet: true }).catch(() => undefined)
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
   * Вкладки режимов (0.83.0): только владельцу и соавторам и только когда есть содержимое.
   * Читатель видит прежний показ проекта без вкладок — публичная версия не меняется.
   */
  const tabsShown = editorsShown && !loading

  /**
   * Переход к конкретному кадру из «Связей» (0.87.0): «к редактированию» или «к проекту».
   *
   * Почему страница, а не событие: панель редакторов монтируется только на своей вкладке, и
   * событие `skyfraze:open-frame`, отправленное из «Связей», слышать было некому — переходы по
   * матрице и хронологии молчали (отчёт: «перестали работать по нажатию»). Здесь вкладка
   * переключается, а просьба передаётся пропсом уже смонтированной панели.
   *
   * Читателю редактор недоступен (вкладок и панели нет) — для него обе кнопки ведут к показу
   * проекта: это единственное место, где он видит кадр.
   */
  const openFrameAt = useCallback(
    (frameId: string, mention: Mention, place: 'editors' | 'project') => {
      if (!frameId) return
      const nonce = Date.now()
      const editorsAvailable = tabsShown && canEdit === true && eventsCount > 0
      if (place === 'editors' && editorsAvailable) {
        setOpenFrameRequest({ frameId, mention, nonce })
        setView('editors')
        return
      }
      if (tabsShown) setView('project')
      setFocusFrame({ id: frameId, nonce })
    },
    [canEdit, eventsCount, tabsShown],
  )
  /**
   * Высота строки вкладок — в CSS-переменную `--sf-tabs-h` (0.83.0).
   *
   * Стадия, её верхняя панель, чипы и лист кадра стоят от верха экрана на `--sf-header-h`;
   * строка вкладок — такая же fixed-полоса под шапкой, поэтому её высоту надо прибавить, иначе
   * панель сцены окажется под вкладками. Меряем, а не задаём числом: на телефоне строка
   * переносится и становится выше.
   */
  const tabsRowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = document.documentElement
    if (!tabsShown) {
      root.style.setProperty('--sf-tabs-h', '0px')
      return undefined
    }
    const apply = () => {
      const el = tabsRowRef.current
      if (!el) return
      root.style.setProperty('--sf-tabs-h', `${Math.round(el.getBoundingClientRect().height)}px`)
    }
    apply()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && tabsRowRef.current) {
      observer = new ResizeObserver(apply)
      observer.observe(tabsRowRef.current)
    }
    return () => {
      observer?.disconnect()
      root.style.setProperty('--sf-tabs-h', '0px')
    }
  }, [tabsShown])

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

      {/* Вкладки режима — только владельцу и соавторам и только когда есть что править.
          Читатель видит прежний показ: прокрутка по сценам, без панелей и вкладок (просьба:
          «на публичную версию всё остаётся как есть»).
          Строка стоит САМА ПО СЕБЕ, не внутри стадии: стадия — fixed-слой, и вкладки в нём
          исчезали бы вместе с ней при переходе в другой режим. */}
      {/* Строка вкладок. Всегда отдельной fixed-строкой под шапкой — и на «Проекте» тоже:
          так она не попадает под fixed-слой сцены и под плавающее окно помощника, а её высота
          уходит в `--sf-tabs-h`, сдвигая панель сцены, чипы и лист кадра ниже (0.83.0). */}
      {tabsShown && (
        <div className="sf-tabs-row" ref={tabsRowRef}>
          <TabBar view={view} projectId={projectId} onChange={setView} />
        </div>
      )}

      {/* Панель режима. Одна вкладка за раз — содержимое не наезжает друг на друга. */}
      <div id="project-tab-panel" role="tabpanel" aria-labelledby={`project-tab-${view}`}>
        {(!tabsShown || view === 'project') && events && eventsCount > 0 && (
          <TimelineStage
            events={events}
            assetsById={assetsById}
            projectTitle={project?.title ?? 'Таймлайн'}
            /* Кнопок режимов в шапке стадии больше нет: вкладки живут своей строкой сверху,
               а помощник — плавающий чат, доступный в любом режиме. */
            actions={undefined}
            /* «К проекту» из «Связей» (0.87.0): прокрутка встаёт на выбранный кадр. */
            focusFrame={focusFrame}
          />
        )}

        {/* «Редакторы» — правка текста. Бар присутствия стоит здесь же: в этом режиме и
            видно, кто из соавторов что правит. */}
        {tabsShown && view === 'editors' && events && (
          <>
            {presenceBar}
            <EditorsPanel
              events={events}
              assets={assets}
              assetUrls={assetUrls}
              projectId={projectId}
              canEdit={canEdit === true}
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
              onOpenRelations={openRelations}
              /* «К редактированию» из всплывающей карточки упоминания: страница уже
                 переключила вкладку, панель открывает кадр и подсвечивает слово. */
              openRequest={openFrameRequest}
              onOpenRequestHandled={() => setOpenFrameRequest(null)}
            />
          </>
        )}

        {/* «Связи» — карточки мира, граф, хронология и матрица. С 0.80.0 раздел не ждёт
            снапшот документа: его данные — проекция и карточки, они приходят своим запросом
            раньше, и вкладка показывает связи, пока грузится текст. */}
        {tabsShown && view === 'relations' && (
          <RelationsPanel projectId={projectId} canEdit={canEdit === true} onOpenFrame={openFrameAt} />
        )}

        {/* «Версии» — та же история, что была окном, но вкладкой: переключение мгновенное,
            и окно больше не накрывает проект. */}
        {tabsShown && view === 'versions' && (
          <VersionsModal
            projectId={projectId}
            canEdit={showEditors}
            onClose={() => setView('project')}
            onRestored={assistantChanged}
            embedded
          />
        )}
      </div>

      {/* Читателю и в пустом проекте панели редакторов нет, и карточки ему показываются в
          обычном потоке под показом проекта — без вкладок, как и было до 0.83.0. */}
      {!showEditors && !loading && eventsCount > 0 && project != null && (
        <RelationsPanel projectId={projectId} canEdit={false} onOpenFrame={openFrameAt} />
      )}

      {!tabsShown && !loading && presenceBar}

      {/* Плавающий помощник: кнопка в углу и окно поверх проекта. Он есть и в пустом
          проекте — «собери проект по описанию» первый же осмысленный вопрос, — и
          остаётся доступным при любой прокрутке: панель в потоке страницы уезжала под
          фиксированную стадию. */}
      {showEditors && !loading && (
        <AssistantDock
          projectId={projectId}
          open={assistantOpen}
          onOpenChange={setAssistantOpen}
          onProjectChanged={assistantChanged}
          onOpenEditors={openEditors}
          projectIsEmpty={eventsCount === 0}
        />
      )}
    </div>
  )
}

/**
 * Вкладки режима проекта (0.83.0).
 *
 * Живут в шапке стадии на вкладке «Проект» и отдельной строкой на остальных вкладках: стадия —
 * fixed-слой, и вкладки внутри неё исчезали бы вместе с ней при переходе в другой режим.
 */
export function TabBar({
  view,
  projectId,
  onChange,
}: {
  view: ProjectView
  projectId: string
  onChange: (next: ProjectView) => void
}) {
  return (
    <nav className="sf-tabs" role="tablist" aria-label="Режим проекта" data-project-tabs>
      {PROJECT_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`project-tab-${tab.id}`}
          aria-selected={view === tab.id}
          aria-controls="project-tab-panel"
          className={view === tab.id ? 'sf-tabs__tab is-active' : 'sf-tabs__tab'}
          onClick={() => onChange(tab.id)}
          data-project-tab={tab.id}
          data-versions-open={tab.id === 'versions' ? true : undefined}
          data-relations-open={tab.id === 'relations' ? true : undefined}
        >
          {tab.title}
        </button>
      ))}
      {/* «Настройки» — ССЫЛКА, а не вкладка: это отдельная страница (`/projects/{id}/settings`)
          со своими окнами и своими правами. До 0.94.1 попасть туда можно было только кнопкой
          «Участники» в списке проектов, и её никто не находил: отчёт «кнопки Настройки проекта
          тоже нигде не видно». Стоит последней, рядом с «Версиями»: это тоже «про проект», а не
          «про текст». */}
      <Link
        to={`/projects/${projectId}/settings`}
        role="tab"
        aria-selected={false}
        className="sf-tabs__tab sf-tabs__tab--link"
        data-project-tab="settings"
        title="Участники, оформление DOCX, шаблон проекта и прочие настройки проекта"
      >
        Настройки
      </Link>
    </nav>
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
