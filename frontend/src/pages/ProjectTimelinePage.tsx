import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Scene } from '../components/timeline/Scene'
import { useScrub } from '../components/timeline/ScrubController'
import { EventCard } from '../components/timeline/EventCard'
import { TimelineScroll } from '../components/timeline/TimelineScroll'
import { useCollab, yAddEvent, type YMap } from '../collab/yprovider'
import { listAssets, uploadAsset, assetUrl, type Asset } from '../api/assets'
import type { Project } from '../api/projects'
import { getProject } from '../api/projects'

export function ProjectTimelinePage() {
  const params = useParams()
  const projectId = params.id ?? ''
  const [project, setProject] = useState<Project | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [selected, setSelected] = useState<YMap | null>(null)
  const [selectedIdx, setSelectedIdx] = useState<number>(0)

  const collab = useCollab(projectId)
  const events = collab?.events

  useEffect(() => {
    getProject(projectId).then(setProject).catch(() => setProject(null))
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    listAssets(projectId).then(setAssets).catch(() => setAssets([]))
  }, [projectId])

  // Точки для 3D-сцены: только если есть реальные события.
  // Когда событий нет — пустой массив (Scene ничего не рендерит, мы показываем
  // большой empty-state CTA вместо дефолтных "фейковых" сфер).
  const points = useMemo(() => {
    if (!events || events.length === 0) return []
    const n = events.length
    return Array.from({ length: n }).map((_, i) => ({
      x: ((i - (n - 1) / 2) * 6) / Math.max(1, n),
      y: Math.sin(i * 0.7) * 0.4,
      z: 0,
    }))
  }, [events])

  const totalSteps = Math.max(0, points.length - 1)
  const idx = useScrub(totalSteps)

  // Маппинг event.id → URL первого ассета для использования в иллюстрации
  const assetUrlByEventId = useMemo(() => {
    const map: Record<string, string> = {}
    if (!events) return map
    events.forEach((m) => {
      const eventId = (m.get('id') as string) ?? ''
      const attached = ((m.get('assets') as string[] | undefined) ?? [])
      if (attached.length > 0) {
        map[eventId] = assetUrl(attached[0])
      }
    })
    return map
  }, [events, assets])

  function onAddEvent() {
    if (!events) return
    const m = yAddEvent(events)
    setSelected(m)
    setSelectedIdx(events.length - 1)
    setTimeout(() => {
      // scroll к новой секции
      const idx = events.length - 1
      const target = document.querySelector<HTMLElement>(`[data-event-section][data-idx="${idx}"]`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
  }

  async function onUploadAsset(file: File) {
    if (!selected) return
    try {
      const a = await uploadAsset(projectId, file)
      setAssets((cur) => [a, ...cur])
      const list = ((selected.get('assets') as string[] | undefined) ?? [])
      selected.set('assets', [...list, a.id])
    } catch (e) {
      console.error('upload failed', e)
    }
  }

  function handleSelectEvent(idx: number) {
    if (!events) return
    const arr = events.toArray()
    setSelected(arr[idx] ?? null)
    setSelectedIdx(idx)
    // прокрутить к редактору выбранного события (если есть)
    setTimeout(() => {
      const editor = document.querySelector<HTMLElement>(`[data-editor-section][data-idx="${idx}"]`)
      editor?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  const eventTitle = (m: YMap): string => ((m.get('title') as string | undefined) ?? '').trim()

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 12px' }}>
      {/* Hero header */}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8, padding: '12px 0' }}>
        <h2 style={{
          margin: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '100%',
          flex: '1 1 200px',
        }}>
          {project?.title ?? 'Timeline'}
        </h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Link to={`/projects/${projectId}/settings`}>
            <button className="secondary">Участники</button>
          </Link>
          <Link to="/projects">
            <button className="secondary">К проектам</button>
          </Link>
          <button onClick={onAddEvent} disabled={!events}>
            + Событие
          </button>
        </div>
      </div>

      {/* 3D-сцена показывается только если есть хотя бы 1 событие.
          Иначе — empty-state CTA вместо фейковых сфер. */}
      {events && events.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Scene
            scrollIndex={idx}
            points={points}
            selected={selectedIdx}
            label={selected ? eventTitle(selected) || '(без названия)' : 'прокрутите для пролёта между событиями'}
          />
        </div>
      ) : (
        <EmptyState onAdd={onAddEvent} />
      )}

      {/* Scrollytelling timeline — primary view */}
      {!events && <p className="muted">Подключение к realtime-серверу…</p>}
      {events && (
        <TimelineScroll
          events={events}
          selectedIndex={selectedIdx}
          onSelect={handleSelectEvent}
          assetUrlByEventId={assetUrlByEventId}
        />
      )}

      {/* Editor panels — по одному для каждого события, sticky после timeline */}
      {events && events.length > 0 && (
        <section style={{ padding: '40px 12px', borderTop: '1px solid #30363d', marginTop: 40 }}>
          <h3 style={{ margin: '0 0 24px 0', color: '#7d8590', textTransform: 'uppercase', letterSpacing: 2, fontSize: 13 }}>
            Редакторы
          </h3>
          {events.toArray().map((m, i: number) => {
            const title = eventTitle(m) || `Событие ${i + 1}`
            const body = (m.get('body') as string | undefined) ?? ''
            return (
              <article
                key={(m.get('id') as string | undefined) ?? i}
                data-editor-section
                data-idx={i}
                style={{
                  marginBottom: 24,
                  padding: 16,
                  background: '#161b22',
                  border: selectedIdx === i ? '1px solid #58a6ff' : '1px solid #30363d',
                  borderRadius: 8,
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <strong style={{ color: '#7d8590', fontSize: 13 }}>#{i + 1} {title}</strong>
                  <button
                    className="secondary"
                    onClick={() => {
                      setSelected(selectedIdx === i ? null : m)
                      if (selectedIdx !== i) setSelectedIdx(i)
                    }}
                  >
                    {selectedIdx === i ? 'закрыть' : 'редактировать'}
                  </button>
                </div>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0, color: '#c9d1d9' }}>{body || <em className="muted">пусто</em>}</p>
                {selected === m && (
                  <div style={{ marginTop: 12 }}>
                    <EventCard
                      ymap={m}
                      onTitleChange={(v) => m.set('title', v)}
                      onBodyChange={(v) => m.set('body', v)}
                    />
                    <h4 style={{ marginTop: 16, fontSize: 14 }}>Ассеты (скетчи, картинки, PDF)</h4>
                    <input
                      type="file"
                      accept="image/*,.pdf,.svg"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void onUploadAsset(f)
                      }}
                    />
                    <AssetList assets={assets} selected={m} />
                  </div>
                )}
              </article>
            )
          })}
        </section>
      )}
    </div>
  )
}

function AssetList({ assets, selected }: { assets: Asset[]; selected: YMap }) {
  const attached = ((selected.get('assets') as string[] | undefined) ?? [])
  return (
    <div className="list" style={{ marginTop: 12 }}>
      {assets.filter((a) => attached.includes(a.id)).map((a) => (
        <div key={a.id} className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {a.mime.startsWith('image/') && (
            <img
              src={assetUrl(a.id)}
              alt={a.filename}
              loading="lazy"
              style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 4 }}
            />
          )}
          <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
            {a.filename}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Empty-state CTA — крупная карточка с понятным призывом добавить первое событие.
 * Не показывает 3D-сцену с фейковыми сферами.
 */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div style={{
      marginBottom: 16,
      padding: '48px 24px',
      border: '2px dashed #30363d',
      borderRadius: 12,
      background: 'rgba(13, 17, 23, 0.4)',
      textAlign: 'center',
    }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 64, height: 64,
        borderRadius: '50%',
        background: '#161b22',
        border: '1px solid #30363d',
        margin: '0 auto 16px',
        fontSize: 32,
        color: '#58a6ff',
      }}>
        +
      </div>
      <h3 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 600 }}>
        Timeline пока пуст
      </h3>
      <p className="muted" style={{ margin: '0 0 20px', maxWidth: 460, marginLeft: 'auto', marginRight: 'auto' }}>
        Добавьте первое событие сюжета — заголовок и описание. По мере добавления событий появится 3D-сцена с маркерами и прокручиваемая timeline с фоновыми иллюстрациями.
      </p>
      <button onClick={onAdd} style={{ fontSize: 15, padding: '10px 22px' }}>
        + Добавить первое событие
      </button>
      <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
        Ассеты (скетчи, картинки, PDF) можно будет прикрепить к каждому событию после создания
      </p>
    </div>
  )
}
