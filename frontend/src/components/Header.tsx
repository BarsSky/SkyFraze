import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'

export function Header() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const nav = useNavigate()
  return (
    <header>
      <Link to="/projects" style={{ fontWeight: 600 }}>SkyFraze</Link>
      <div className="row">
        {user && <span className="muted">{user.display_name} ({user.email})</span>}
        <button className="secondary" onClick={() => { logout(); nav('/login') }}>
          Logout
        </button>
      </div>
    </header>
  )
}
