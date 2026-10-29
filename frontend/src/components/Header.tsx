import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useTheme } from '../store/theme'
import { useMediaQuery } from '../lib/useMediaQuery'
import { BrandMark } from './BrandMark'
import { NotificationBell } from './NotificationBell'

/**
 * Шапка приложения.
 *
 * Навигация — пилюли, как чипы и переключатели на страницах: активный раздел
 * подсвечен, у остальных только наведение. Так шапка читается частью интерфейса в
 * обеих темах, а не набором голубых ссылок. Кто вошёл — ссылка на свой профиль
 * (имя и ник без служебного email: он мешал навигации на средних экранах и
 * остаётся в подсказке).
 *
 * На телефоне шапка раньше прокручивалась ВБОК: «Резиденты» и «Админка» уезжали за правый
 * край, полосы прокрутки не видно, и узнать о них было нельзя (замер: правый край ссылок —
 * 469 и 562 px при экране 390). Теперь на узком экране в строке остаются два главных пункта, а
 * остальные лежат в меню «Ещё»: ничего не спрятано за краем, и всё доступно с клавиатуры.
 */
interface NavLink {
  to: string
  label: string
  className?: string
}

/** Действие в меню «Ещё» (0.88.0): не раздел, а команда — тема, выход. */
interface MenuAction {
  label: string
  icon?: string
  onSelect: () => void
}

/** С какого момента пункты уходят в меню: уже тесно, но ещё не «совсем узкий телефон». */
const COMPACT_QUERY = '(max-width: 760px)'
/**
 * Совсем узкий экран (320 px): в строке не остаётся ни одного пункта, кроме «Ещё».
 *
 * Почему: на 320 px навигации достаётся ~80 px, а «Мои проекты» + «Ещё» требуют ~174. Прежде
 * кнопка «Ещё» просто вылезала за свою полосу и перекрывала переключатель темы — клик по теме
 * попадал в неё (нашёл аудит интерфейса после первой версии меню). В меню «Мои проекты» стоит
 * первым, а логотип ведёт туда же.
 */
const NARROW_QUERY = '(max-width: 420px)'

export function Header() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const nav = useNavigate()
  const { pathname } = useLocation()
  const [theme, setTheme] = useTheme()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const compact = useMediaQuery(COMPACT_QUERY)
  const narrow = useMediaQuery(NARROW_QUERY)
  const headerRef = useRef<HTMLElement | null>(null)

  /**
   * Фактическая высота шапки — в `--sf-header-h` (0.86.0).
   *
   * Почему мерим ЗДЕСЬ, а не в стадии проекта, как было до 0.86.0: с 0.83.0 стадия живёт только
   * на вкладке «Проект», и на «Редакторах», «Связях» и «Версиях» её компонент размонтировался —
   * вместе с ним исчезала переменная, и фиксированная полоса вкладок вставала на запасные 46 px
   * при реальной шапке 62 px. Полоса уезжала ПОД шапку, и её верхняя часть была не видна: отчёт
   * «меню накрывает кнопки переключения». Шапка смонтирована всегда — она и есть хозяин своей
   * высоты.
   *
   * На телефоне шапка переносится и становится выше (две строки) — ResizeObserver сообщает об
   * этом сам, без опроса размеров на каждом кадре.
   */
  useLayoutEffect(() => {
    const header = headerRef.current
    const apply = () => {
      const h = header ? Math.round(header.getBoundingClientRect().height) : 0
      if (h > 0) document.documentElement.style.setProperty('--sf-header-h', `${h}px`)
    }
    apply()
    const ro = header && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    if (ro && header) ro.observe(header)
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      document.documentElement.style.removeProperty('--sf-header-h')
    }
  }, [])

  /** Раздел активен и на своих подстраницах: /projects и /projects/<id>. */
  const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`)

  const links: NavLink[] = [
    // Лента доступна всем: это витрина опубликованных историй, вход не нужен
    { to: '/feed', label: 'Лента' },
    { to: '/projects', label: 'Мои проекты', className: 'header-nav__projects' },
    { to: '/coauthors', label: 'Соавторы' },
    // Каталог зарегистрированных: кто здесь есть и чем занимается
    { to: '/people', label: 'Резиденты' },
    // Своя учётная запись — отдельной вкладкой (0.99.0): до этого имя, ник, резюме, ключи доступа
    // и журнал входов жили на странице «Соавторы», и «профиля» в навигации не было вовсе.
    { to: '/profile', label: 'Профиль' },
  ]
  if (user?.is_admin) links.push({ to: '/admin', label: 'Админка' })
  // «О проекте» (0.114.0) — последним: лицензия, исходники, документация, приватность. На узком
  // экране уходит в меню «Ещё» вместе с остальными разделами, поэтому в строке шапка не теснее.
  links.push({ to: '/about', label: 'О проекте' })

  // Анонимному видны только витрины: публичная лента и «О проекте» — остальное требует входа.
  const visible = links.filter((link) => link.to === '/feed' || link.to === '/about' || user)
  /**
   * Что остаётся в строке на узком экране (0.88.0).
   *
   * До 0.88.0 на ≤420 px в строке не оставалось НИ ОДНОГО раздела — только кнопка «Ещё», и
   * шапка выглядела пустой («из меню видно только кнопку Ещё и больше ничего»). Пространство
   * освобождаем не магией: переключатель темы и «Выйти» уезжают в само меню «Ещё», а в строке
   * остаётся главный раздел — «Мои проекты» (у анонимного — «Лента»).
   */
  const primary = visible.find((link) => link.to === '/projects' || (!user && link.to === '/feed'))
  const inline = compact ? (primary ? [primary] : []) : visible
  const inMenu = compact ? visible.filter((link) => !inline.includes(link)) : []
  // Главный раздел — первым в меню (0.78.0): на 320 px он единственный вход в проекты из строки.
  // Переставляем ЯВНО, а не сортировкой: компаратор, равный нулю для остальных пар, не поднимает
  // нужный элемент наверх (нашёл тест 0.88.0 — «Лента» оказывалась первой).
  const projectsAt = inMenu.findIndex((link) => link.to === '/projects')
  if (projectsAt > 0) inMenu.unshift(...inMenu.splice(projectsAt, 1))
  /**
   * Действия, которым на узком экране не хватило места в строке: тема и выход. В меню они
   * последними — пункты навигации важнее.
   */
  const menuActions: MenuAction[] = narrow
    ? [
        {
          label: nextTheme === 'light' ? 'Светлая тема' : 'Тёмная тема',
          onSelect: () => setTheme(nextTheme),
          icon: theme === 'dark' ? '☾' : '☀',
        },
        user
          ? { label: 'Выйти', onSelect: () => { logout(); nav('/login') } }
          : { label: 'Войти', onSelect: () => nav('/login') },
      ]
    : []

  return (
    <header ref={headerRef}>
      <div className="row" style={{ gap: 14, minWidth: 0 }}>
        <Link to={user ? '/projects' : '/feed'} className="brand">
          <BrandMark size={24} />
          <span className="brand__name">SkyFraze</span>
        </Link>
        <nav className="auth-links" aria-label="Основная навигация">
          {inline.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={link.className}
              aria-current={isActive(link.to) ? 'page' : undefined}
            >
              {link.label}
            </Link>
          ))}
          {inMenu.length > 0 && (
            <HeaderMenu links={inMenu} actions={menuActions} isActive={isActive} />
          )}
        </nav>
      </div>
      <div className="row" style={{ gap: 8 }}>
        {user && (
          <Link
            to="/profile"
            className="header-user"
            title={`${user.email} — профиль: имя, ник, ключи доступа и журнал входов`}
          >
            {user.display_name}
            {user.username ? ` · @${user.username}` : ''}
          </Link>
        )}
        {/* Колокольчик: где ждут новые замечания. Только для вошедших — у анонимного
            человека нет ни проектов, ни обсуждений, а лишний значок в шапке ленты
            выглядел бы поломкой. */}
        {user && <NotificationBell />}
        {/* На совсем узком экране тема и выход живут в меню «Ещё»: в строке иначе остаётся
            только кнопка меню, и шапка выглядит пустой (0.88.0). */}
        {!narrow && (
          <button
            className="secondary header-theme"
            onClick={() => setTheme(nextTheme)}
            title={nextTheme === 'light' ? 'Светлая тема (кремово-мятная)' : 'Тёмная тема'}
            aria-label="Переключить тему"
          >
            {theme === 'dark' ? '☾' : '☀'}
            <span className="header-theme__label">{theme === 'dark' ? ' тёмная' : ' светлая'}</span>
          </button>
        )}
        {!narrow && (user ? (
          <button className="secondary" onClick={() => { logout(); nav('/login') }}>
            Выйти
          </button>
        ) : (
          <Link to="/login"><button className="secondary">Войти</button></Link>
        ))}
      </div>
    </header>
  )
}

/**
 * «Ещё» — пункты, которым не хватило места в строке.
 *
 * Почему кнопка с меню, а не прокрутка строки: прокрутка прячет пункты за краем без всякого
 * признака, что они есть (нашлось на телефоне: «Резиденты» и «Админка» были за экраном, и
 * полосы прокрутки не видно). Кнопка говорит «здесь ещё есть» и открывается пальцем.
 *
 * Доступность: `aria-expanded` и `aria-haspopup`, Escape закрывает и возвращает фокус на
 * кнопку, клик мимо закрывает, переход закрывает сам себя.
 */
function HeaderMenu({
  links,
  actions = [],
  isActive,
}: {
  links: NavLink[]
  /** Действия вне навигации (тема, выход) — последними, 0.88.0. */
  actions?: MenuAction[]
  isActive: (to: string) => boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const { pathname } = useLocation()

  const close = useCallback((returnFocus = false) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }, [])

  // Переход закрывает меню: иначе оно оставалось бы висеть над новой страницей.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true)
    }
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [open, close])

  return (
    <div className="header-more" ref={wrapRef}>
      <button
        type="button"
        className="secondary header-more__button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Ещё разделы"
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        data-header-more
      >
        Ещё
        {/* Уголок рисует CSS, а не символ ▾: на телефоне шрифт подставлял вместо него точку
            (в отчёте 0.98.2 кнопка выглядела как «Ещё ·»), и было не видно, что это раскрывающееся
            меню. Направление задаёт aria-expanded — тот же признак, что читает скринридер. */}
        <span aria-hidden="true" className="header-more__caret" />
      </button>
      {open && (
        <div className="header-more__menu" role="menu" data-header-menu>
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              role="menuitem"
              aria-current={isActive(link.to) ? 'page' : undefined}
              onClick={() => close()}
            >
              {link.label}
            </Link>
          ))}
          {/* Действия после навигации и отделены линией: тема и выход — не разделы. */}
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className="header-more__action"
              onClick={() => {
                close()
                action.onSelect()
              }}
              data-header-action={action.label}
            >
              {action.icon && <span aria-hidden="true">{action.icon} </span>}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
