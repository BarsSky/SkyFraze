import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TimelineStage, type AssetLookup } from '../components/timeline/TimelineStage'
import { EditorsPanel } from '../components/editors/EditorsPanel'
import { ErrorBanner } from '../components/ErrorBanner'
import { useCollab, yAddEvent } from '../collab/yprovider'
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
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)

  const collab = useCollab(projectId)
  const events = collab?.events
  const realtime = collab?.connected ?? false

  // Realtime может быть недоступен (прокси, мобильная сеть, закрытый WebSocket):
  // работать можно, но люди должны понимать, почему правки не летят другим сразу.
  useEffect(() => {
    if (!collab || realtime) return
    const timer = setTimeout(() => {
      setSyncNote((note) => note ?? 'realtime недоступен: правки сохраняются, но другие вкладки увидят их после перезагрузки')
    }, 4000)
    return () => clearTimeout(timer)
  }, [collab, realtime])

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

  /** Проекция дерева на сервер (серверная модель иерархии + валидация). */
  const pushTree = useCallback(async () => {
    if (!collab) return
    const res = await collab.syncTree()
    if (res.ok) {
      setSyncNote(res.repaired ? `структура исправлена на сервере (${res.repaired})` : 'серверная копия обновлена')
    } else if (res.reason === 'forbidden') {
      setSyncNote('только чтение: ваша роль не позволяет менять таймлайн')
    } else if (res.reason === 'rejected') {
      setSyncNote('сервер отклонил структуру дерева (цикл/глубина)')
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

      {events && eventsCount > 0 && showEditors && (
        <EditorsPanel
          events={events}
          assets={assets}
          assetUrls={assetUrls}
          syncNote={syncNote}
          onChanged={() => {
            void pushTree()
          }}
          onUpload={uploadFile}
        />
      )}
    </div>
  )
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
