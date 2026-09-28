import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useTheme } from '../store/theme'
import { BrandMark } from './BrandMark'

export function Header() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const nav = useNavigate()
  const [theme, setTheme] = useTheme()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  return (
    <header>
      <div className="row" style={{ gap: 16 }}>
        <Link to={user ? '/projects' : '/feed'} className="brand">
          <BrandMark size={24} />
          <span className="brand__name">SkyFraze</span>
        </Link>
        {/* Лента доступна всем: это витрина опубликованных историй, вход не нужен */}
        <nav className="auth-links">
          <Link to="/feed">Лента</Link>
          {user && <Link className="header-nav__projects" to="/projects">Мои проекты</Link>}
          {user && <Link to="/coauthors">Соавторы</Link>}
          {user?.is_admin && <Link to="/admin">Админка</Link>}
        </nav>
      </div>
      <div className="row">
        {user && (
          <span className="muted">
            {user.display_name}
            {user.username ? ` · @${user.username}` : ''} ({user.email})
          </span>
        )}
        <button
          className="secondary header-theme"
          onClick={() => setTheme(nextTheme)}
          title={nextTheme === 'light' ? 'Светлая тема (кремово-мятная)' : 'Тёмная тема'}
          aria-label="Переключить тему"
        >
          {theme === 'dark' ? '☾' : '☀'}
          <span className="header-theme__label">{theme === 'dark' ? ' тёмная' : ' светлая'}</span>
        </button>
        {user ? (
          <button className="secondary" onClick={() => { logout(); nav('/login') }}>
            Logout
          </button>
        ) : (
          <Link to="/login"><button className="secondary">Войти</button></Link>
        )}
      </div>
    </header>
  )
}
