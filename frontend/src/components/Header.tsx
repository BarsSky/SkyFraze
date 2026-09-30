import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useTheme } from '../store/theme'
import { BrandMark } from './BrandMark'

/**
 * Шапка приложения.
 *
 * Навигация — пилюли, как чипы и переключатели на страницах: активный раздел
 * подсвечен, у остальных только наведение. Так шапка читается частью интерфейса в
 * обеих темах, а не набором голубых ссылок. Кто вошёл — ссылка на свой профиль
 * (имя и ник без служебного email: он мешал навигации на средних экранах и
 * остаётся в подсказке).
 */
export function Header() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const nav = useNavigate()
  const { pathname } = useLocation()
  const [theme, setTheme] = useTheme()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  /** Раздел активен и на своих подстраницах: /projects и /projects/<id>. */
  const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`)

  const links: Array<{ to: string; label: string; className?: string }> = [
    // Лента доступна всем: это витрина опубликованных историй, вход не нужен
    { to: '/feed', label: 'Лента' },
    { to: '/projects', label: 'Мои проекты', className: 'header-nav__projects' },
    { to: '/coauthors', label: 'Соавторы' },
    // Каталог зарегистрированных: кто здесь есть и чем занимается
    { to: '/people', label: 'Резиденты' },
  ]

  return (
    <header>
      <div className="row" style={{ gap: 14, minWidth: 0 }}>
        <Link to={user ? '/projects' : '/feed'} className="brand">
          <BrandMark size={24} />
          <span className="brand__name">SkyFraze</span>
        </Link>
        <nav className="auth-links" aria-label="Основная навигация">
          {links
            .filter((link) => link.to === '/feed' || user)
            .map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={link.className}
                aria-current={isActive(link.to) ? 'page' : undefined}
              >
                {link.label}
              </Link>
            ))}
          {user?.is_admin && (
            <Link to="/admin" aria-current={isActive('/admin') ? 'page' : undefined}>Админка</Link>
          )}
        </nav>
      </div>
      <div className="row" style={{ gap: 8 }}>
        {user && (
          <Link
            to="/coauthors"
            className="header-user"
            title={`${user.email} — профиль и круг соавторов`}
          >
            {user.display_name}
            {user.username ? ` · @${user.username}` : ''}
          </Link>
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
            Выйти
          </button>
        ) : (
          <Link to="/login"><button className="secondary">Войти</button></Link>
        )}
      </div>
    </header>
  )
}
