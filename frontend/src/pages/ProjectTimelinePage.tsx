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

  const collab = useCollab(projectId)
  const events = collab?.events

  useEffect(() => {
    getProject(projectId).then(setProject).catch(() => setProject(null))
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    listAssets(projectId).then(setAssets).catch(() => setAssets([]))
  }, [projectId])

  const points = useMemo(() => {
    if (!events) return []
    const n = Math.max(1, events.length)
    return Array.from({ length: n }).map((_, i) => ({
      x: (i - n / 2) * 2,
      y: 0,
      z: 0,
    }))
  }, [events])

  const idx = useScrub(Math.max(1, points.length))

  function onAddEvent() {
    if (!events) return
    const m = yAddEvent(events)
    setSelected(m)
    // прокрутим страницу к новому событию
    setTimeout(() => window.scrollTo({ top: (events.length - 1) * window.innerHeight, behavior: 'smooth' }), 50)
  }

  async function onUploadAsset(file: File) {
    if (!selected) return
    const a = await uploadAsset(projectId, file)
    setAssets((cur) => [a, ...cur])
    const list = (selected.get('assets') as string[] | undefined) ?? []
    selected.set('assets', [...list, a.id])
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2>{project?.title ?? 'Timeline'}</h2>
        <div className="row">
          <Link to={`/projects/${projectId}/settings`}><button className="secondary">Участники</button></Link>
          <Link to="/projects"><button className="secondary">К проектам</button></Link>
          <button onClick={onAddEvent}>+ Событие</button>
        </div>
      </div>

      <Scene
        scrollIndex={idx}
        points={points.length ? points : [{ x: 0, y: 0, z: 0 }]}
        label={selected ? ((selected.get('title') as string | undefined) ?? 'без названия') : 'прокрутите, чтобы пролететь между событиями'}
      />

      <div style={{ marginTop: 24 }}>
        {!events && <p className="muted">Подключение к realtime-серверу…</p>}
        {events && events.length === 0 && (
          <p className="muted">Нет событий. Нажмите "+ Событие", чтобы начать.</p>
        )}
        {events && events.toArray().map((m, i) => {
          const title = (m.get('title') as string | undefined) ?? 'без названия'
          return (
            <section key={(m.get('id') as string | undefined) ?? i} style={{ minHeight: '60vh' }}>
              <h3>{i + 1}. {title}</h3>
              <button className="secondary" onClick={() => setSelected(m)}>
                {selected === m ? 'редактируется' : 'редактировать'}
              </button>
              <div className="card">
                <p style={{ whiteSpace: 'pre-wrap' }}>{(m.get('body') as string | undefined) ?? ''}</p>
              </div>
              {selected === m && (
                <div className="card">
                  <EventCard
                    ymap={m}
                    onTitleChange={(v) => m.set('title', v)}
                    onBodyChange={(v) => m.set('body', v)}
                  />
                  <h4>Ассеты</h4>
                  <input type="file" onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void onUploadAsset(f)
                  }} />
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
  const attached = (selected.get('assets') as string[] | undefined) ?? []
  return (
    <div className="list" style={{ marginTop: 12 }}>
      {assets.filter((a) => attached.includes(a.id)).map((a) => (
        <div key={a.id} className="row">
          {a.mime.startsWith('image/') && (
            <img src={assetUrl(a.id)} alt={a.filename} style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 4 }} />
          )}
          <span className="muted">{a.filename}</span>
        </div>
      ))}
    </div>
  )
}
