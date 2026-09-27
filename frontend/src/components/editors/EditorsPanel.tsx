import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildEventTree, flattenTree, type EventLike } from '../../collab/eventTree'
import { yAddEvent, yDeleteEvent, yEventParentId, type YArray, type YMap } from '../../collab/yprovider'
import type { Asset } from '../../api/assets'
import { EventEditor } from './EventEditor'
import type { BackgroundValue } from './BackgroundPicker'

interface Props {
  events: YArray
  assets: Asset[]
  /** id ассета → blob-URL для превью (ассеты отдаются только с авторизацией). */
  assetUrls: Record<string, string>
  syncNote?: string | null
  /** Любая правка CRDT: страница проецирует дерево на сервер. */
  onChanged: () => void
  /** Загрузка файла: страница сохраняет ассет и возвращает его. */
  onUpload: (file: File) => Promise<Asset | null>
}

interface NavRow {
  id: string
  depth: number
  title: string
  childCount: number
  isChapter: boolean
}

const SYNC_DEBOUNCE_MS = 900

/** Совпадает с лимитом nginx (client_max_body_size) и бэкенда (assets.maxAssetSize). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Модуль редактирования: навигатор по дереву, тулбар создания/удаления и
 * редактор выбранного события (текст, дата, вложения, фон кадра).
 *
 * Единственное место, где проект меняется: стадия (components/timeline)
 * намеренно только показывает и не переключает редактор.
 */
export function EditorsPanel({ events, assets, assetUrls, syncNote, onChanged, onUpload }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [version, setVersion] = useState(0) // перерисовка после правок CRDT
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Подписка на CRDT: заголовки/дерево в навигаторе и полях должны обновляться.
  useEffect(() => {
    if (!events) return
    const update = () => setVersion((v) => v + 1)
    events.observeDeep(update)
    return () => events.unobserveDeep(update)
  }, [events])

  /** Отложенная проекция на сервер: не отправляем PUT на каждое нажатие. */
  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null
      onChanged()
    }, SYNC_DEBOUNCE_MS)
  }, [onChanged])

  useEffect(() => () => {
    if (syncTimer.current) clearTimeout(syncTimer.current)
  }, [])

  const rows = useMemo<NavRow[]>(() => {
    void version
    if (!events) return []
    const flat: Array<EventLike & { title: string }> = (events.toArray() as YMap[]).map((m) => ({
      id: (m.get('id') as string | undefined) ?? '',
      parentId: yEventParentId(m),
      title: ((m.get('title') as string | undefined) ?? '').trim(),
    })).filter((e) => e.id.length > 0)
    return flattenTree(buildEventTree(flat, 4)).map((node) => ({
      id: node.item.id,
      depth: node.depth,
      title: node.item.title || 'Без названия',
      childCount: node.children.length,
      isChapter: node.depth === 0,
    }))
  }, [events, version])

  // Первое событие выбирается автоматически; дальше выбор только ручной —
  // создание события не уводит ни редактор, ни стадию.
  useEffect(() => {
    if (!selectedId && rows.length > 0) setSelectedId(rows[0].id)
  }, [rows, selectedId])

  const selectedMap = useMemo<YMap | null>(() => {
    void version
    if (!events || !selectedId) return null
    return (events.toArray() as YMap[]).find((m) => (m.get('id') as string) === selectedId) ?? null
  }, [events, selectedId, version])

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.title.toLowerCase().includes(q))
  }, [rows, filter])

  const selectedRow = rows.find((r) => r.id === selectedId)
  const attachedIds = ((selectedMap?.get('assets') as string[] | undefined) ?? []).filter(Boolean)
  const images = assets.filter((a) => attachedIds.includes(a.id) && a.mime.startsWith('image/'))

  const background = useMemo<BackgroundValue>(() => {
    const kind = selectedMap?.get('bg_kind')
    const tone = selectedMap?.get('bg_tone')
    const assetId = selectedMap?.get('bg_asset')
    return {
      kind: kind === 'tone' || kind === 'asset' ? kind : 'inherit',
      tone: typeof tone === 'string' ? tone : undefined,
      assetId: typeof assetId === 'string' ? assetId : undefined,
    }
  }, [selectedMap, version])

  function createChapter() {
    if (!events) return
    const map = yAddEvent(events, 'Новая глава', '')
    setSelectedId(map.get('id') as string)
    setFilter('')
    onChanged()
  }

  function createChild() {
    if (!events || !selectedId) return
    // Под-событие создаётся у выбранного события (главы или другого под-события).
    const map = yAddEvent(events, 'Новое подсобытие', '', { parentId: selectedId })
    setSelectedId(map.get('id') as string)
    onChanged()
  }

  function removeSelected() {
    if (!events || !selectedMap || !selectedId) return
    const arr = events.toArray() as YMap[]
    const descendants = countDescendants(arr, selectedId)
    const title = ((selectedMap.get('title') as string | undefined) ?? '').trim() || '(без названия)'
    const warn = descendants > 0
      ? `Удалить «${title}» вместе с ${descendants} вложенным(и) событием(ями)?`
      : `Удалить «${title}»?`
    if (!window.confirm(warn)) return
    yDeleteEvent(events, selectedId)
    const nextRow = rows.find((r) => r.id !== selectedId)
    setSelectedId(nextRow?.id ?? null)
    onChanged()
  }

  function uploadAndAttach(file: File) {
    setUploadNote(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadNote(`Файл больше ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ — сервер его не примет.`)
      return
    }
    const targetId = selectedId
    void (async () => {
      const asset = await onUpload(file)
      if (!asset) {
        setUploadNote('Не удалось загрузить файл (сервер отклонил запрос).')
        return
      }
      // Прикрепляем к тому событию, для которого выбирали файл: за время
      // загрузки пользователь мог переключиться в навигаторе.
      const target = (events?.toArray() as YMap[] | undefined)?.find(
        (m) => (m.get('id') as string) === targetId,
      )
      const map = target ?? selectedMap
      if (!map) return
      const list = ((map.get('assets') as string[] | undefined) ?? []).filter(Boolean)
      map.set('assets', [...list, asset.id])
      // Первая картинка сразу становится фоном кадра — обычно это и нужно.
      if (asset.mime.startsWith('image/') && map.get('bg_kind') !== 'asset') {
        map.set('bg_kind', 'asset')
        map.set('bg_asset', asset.id)
      }
      setUploadNote(`Загружено: ${asset.filename}`)
      setVersion((v) => v + 1)
    })()
  }

  function attach(assetId: string) {
    if (!selectedMap) return
    const list = ((selectedMap.get('assets') as string[] | undefined) ?? []).filter(Boolean)
    if (list.includes(assetId)) return
    selectedMap.set('assets', [...list, assetId])
    setVersion((v) => v + 1)
  }

  function detach(assetId: string) {
    if (!selectedMap) return
    const list = ((selectedMap.get('assets') as string[] | undefined) ?? []).filter((id) => id !== assetId)
    selectedMap.set('assets', list)
    if (selectedMap.get('bg_asset') === assetId) selectedMap.delete('bg_asset')
    setVersion((v) => v + 1)
  }

  function changeBackground(value: BackgroundValue) {
    if (!selectedMap) return
    selectedMap.set('bg_kind', value.kind)
    if (value.tone) selectedMap.set('bg_tone', value.tone)
    else selectedMap.delete('bg_tone')
    if (value.assetId) selectedMap.set('bg_asset', value.assetId)
    else selectedMap.delete('bg_asset')
    setVersion((v) => v + 1)
  }

  return (
    <section className="ed-panel" data-editor-panel>
      <div className="ed-panel__head">
        <h3 className="ed-panel__title">Редакторы</h3>
        <div className="ed-toolbar">
          <button type="button" onClick={createChapter}>+ глава</button>
          <button type="button" className="secondary" onClick={createChild} disabled={!selectedId}>+ подсобытие</button>
          <button type="button" className="secondary ed-danger" onClick={removeSelected} disabled={!selectedId}>удалить</button>
        </div>
        <div className="ed-panel__meta">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Фильтр по названию…"
            aria-label="Фильтр событий"
            className="ed-filter"
          />
          <span className="muted ed-panel__count">
            {filter ? `${visibleRows.length} из ${rows.length}` : `событий: ${rows.length}`}
          </span>
        </div>
      </div>

      {syncNote && <p className="muted ed-panel__note">{syncNote}</p>}
      {uploadNote && <p className="ed-panel__note ed-panel__note--upload">{uploadNote}</p>}

      <div className="ed-panel__grid">
        <nav className="ed-nav" aria-label="Список событий">
          {visibleRows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={[
                'ed-row',
                row.isChapter ? 'ed-row--chapter' : 'ed-row--sub',
                row.id === selectedId ? 'ed-row--active' : '',
              ].filter(Boolean).join(' ')}
              style={{ marginLeft: Math.min(row.depth, 4) * 14 }}
              onClick={() => setSelectedId(row.id)}
              title={row.title}
            >
              <span className="ed-row__mark">{row.isChapter ? '#' : '└'}</span>
              <span className="ed-row__name">{row.title}</span>
              {row.childCount > 0 && <span className="ed-row__badge">{row.childCount}</span>}
            </button>
          ))}
          {visibleRows.length === 0 && <p className="muted">Ничего не найдено.</p>}
        </nav>

        <div className="ed-editor">
          {selectedMap ? (
            <>
              <div className="ed-editor__head">
                <strong className="ed-editor__path">
                  {selectedRow?.isChapter ? 'Глава' : 'Подсобытие'} · {selectedRow?.title ?? ''}
                </strong>
              </div>
              <EventEditor
                ymap={selectedMap}
                assets={assets}
                images={images}
                assetUrls={assetUrls}
                background={background}
                onUpload={uploadAndAttach}
                onAttach={attach}
                onDetach={detach}
                onBackgroundChange={changeBackground}
                onChange={() => scheduleSync()}
              />
              <p className="muted ed-editor__hint">
                Изменения сохраняются автоматически; дерево синхронизируется с сервером.
              </p>
            </>
          ) : (
            <p className="muted">Выберите событие слева или создайте новую главу.</p>
          )}
        </div>
      </div>
    </section>
  )
}

function countDescendants(all: YMap[], id: string): number {
  const childrenOf = new Map<string, string[]>()
  for (const m of all) {
    const parent = yEventParentId(m)
    const child = m.get('id') as string | undefined
    if (parent && child) {
      const list = childrenOf.get(parent) ?? []
      list.push(child)
      childrenOf.set(parent, list)
    }
  }
  const seen = new Set<string>()
  const walk = (parent: string) => {
    for (const child of childrenOf.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      walk(child)
    }
  }
  walk(id)
  return seen.size
}
