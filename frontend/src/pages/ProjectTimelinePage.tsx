import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Scene } from '../components/timeline/Scene'
import { useScrub } from '../components/timeline/ScrubController'
import { EventCard } from '../components/timeline/EventCard'
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

  // Дефолтные точки, чтобы сцена не была пустой до подключения Yjs
  const defaultPoints = useMemo(
    () => [-3, -1, 1, 3].map((x) => ({ x, y: 0, z: 0 })),
    []
  )
  const points = useMemo(() => {
    if (!events || events.length === 0) return defaultPoints
    const n = Math.max(1, events.length)
    return Array.from({ length: n }).map((_, i) => ({
      x: ((i - (n - 1) / 2) * 6) / Math.max(1, n),
      y: Math.sin(i * 0.7) * 0.4,
      z: 0,
    }))
  }, [events, defaultPoints])

  const totalSteps = Math.max(1, points.length - 1)
  const idx = useScrub(totalSteps)

  function onAddEvent() {
    if (!events) return
    const m = yAddEvent(events)
    setSelected(m)
    setSelectedIdx(events.length - 1)
    setTimeout(() => window.scrollTo({ top: (events.length - 1) * window.innerHeight, behavior: 'smooth' }), 50)
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

  const eventTitle = (m: YMap): string => ((m.get('title') as string | undefined) ?? '').trim()

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 12px' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {project?.title ?? 'Timeline'}
        </h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Link to={`/projects/${projectId}/settings`}><button className="secondary">Участники</button></Link>
          <Link to="/projects"><button className="secondary">К проектам</button></Link>
          <button onClick={onAddEvent} disabled={!events}>+ Событие</button>
        </div>
      </div>

      <Scene
        scrollIndex={idx}
        points={points}
        selected={selectedIdx}
        label={selected ? eventTitle(selected) || '(без названия)' : (events && events.length ? 'прокрутите для пролёта' : 'нет событий — нажмите + Событие')}
      />

      <div style={{ marginTop: 24 }}>
        {!events && <p className="muted">Подключение к realtime-серверу…</p>}
        {events && events.length === 0 && (
          <p className="muted">Нет событий. Нажмите «+ Событие», чтобы начать.</p>
        )}
        {events && events.toArray().map((m, i) => {
          const title = eventTitle(m) || '(без названия)'
          const body = (m.get('body') as string | undefined) ?? ''
          return (
            <section key={(m.get('id') as string | undefined) ?? i} style={{ minHeight: '50vh', padding: '12px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <h3 style={{ margin: 0 }}>{i + 1}. {title}</h3>
                <button
                  className="secondary"
                  onClick={() => { setSelected(selected === m ? null : m); setSelectedIdx(i) }}
                >
                  {selected === m ? 'закрыть' : 'редактировать'}
                </button>
              </div>
              <div className="card">
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{body || <em className="muted">пусто</em>}</p>
              </div>
              {selected === m && (
                <div className="card">
                  <EventCard
                    ymap={m}
                    onTitleChange={(v) => m.set('title', v)}
                    onBodyChange={(v) => m.set('body', v)}
                  />
                  <h4 style={{ marginTop: 16 }}>Ассеты (скетчи, картинки, PDF)</h4>
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
            </section>
          )
        })}
      </div>
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
