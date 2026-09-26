import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listProjects, createProject, deleteProject, type Project } from '../api/projects'

export function ProjectsPage() {
  const [list, setList] = useState<Project[]>([])
  const [err, setErr] = useState('')
  const [openNew, setOpenNew] = useState(false)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')

  useEffect(() => {
    listProjects().then(setList).catch((e) => setErr(String(e)))
  }, [])

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    try {
      const p = await createProject({ title, description: desc })
      setList((cur) => [p, ...cur])
      setTitle('')
      setDesc('')
      setOpenNew(false)
    } catch (e) {
      setErr(String(e))
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Удалить проект?')) return
    await deleteProject(id)
    setList((cur) => cur.filter((p) => p.id !== id))
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>Проекты</h2>
        <button onClick={() => setOpenNew((v) => !v)}>{openNew ? 'Отмена' : '+ Новый проект'}</button>
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
          <button type="submit">Создать</button>
        </form>
      )}

      {err && <div className="error">{err}</div>}

      <div className="list">
        {list.length === 0 && <p className="muted">Нет проектов. Создайте первый.</p>}
        {list.map((p) => (
          <div key={p.id} className="card row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h3 style={{ margin: 0 }}><Link to={`/projects/${p.id}`}>{p.title}</Link></h3>
              <p className="muted" style={{ margin: 0 }}>{p.description || <em>без описания</em>}</p>
            </div>
            <div className="row">
              <Link to={`/projects/${p.id}/settings`}><button className="secondary">Участники</button></Link>
              <button className="secondary" onClick={() => onDelete(p.id)}>Удалить</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
