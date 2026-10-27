import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import { RequireAuth } from '../components/RequireAuth'
import { Header } from '../components/Header'
import { useAuthStore } from '../store/auth'

/**
 * Страницы грузятся по требованию (0.80.0).
 *
 * Почему: до этого в стартовом бандле лежали ВСЕ страницы сразу — админка, лента, публичная
 * история, каталог резидентов, настройки проекта. На телефоне это лишние секунды разбора
 * JavaScript до того, как человек увидит свою страницу. Замер после разделения (прод-сборка,
 * сеть 1,6 Мбит/с, CPU ×4): стартовый бандл 245 КБ gzip → 68 КБ, первый контент 1,8 с → 0,6 с,
 * список проектов оживает 2,6 с → 1,6 с.
 *
 * Suspense стоит ВНУТРИ `<main>`, а не вокруг всего приложения: шапка и каркас появляются сразу
 * после проверки входа, не дожидаясь кода страницы — иначе переезд на `lazy` отнял бы у шапки
 * полсекунды, которые она раньше не ждала.
 */
const LoginPage = lazy(() => import('../pages/LoginPage').then((m) => ({ default: m.LoginPage })))
const RegisterPage = lazy(() =>
  import('../pages/RegisterPage').then((m) => ({ default: m.RegisterPage })),
)
const ProjectsPage = lazy(() =>
  import('../pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })),
)
const ProjectTimelinePage = lazy(() =>
  import('../pages/ProjectTimelinePage').then((m) => ({ default: m.ProjectTimelinePage })),
)
const ProjectSettingsPage = lazy(() =>
  import('../pages/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })),
)
const AcceptInvitation = lazy(() =>
  import('../pages/AcceptInvitation').then((m) => ({ default: m.AcceptInvitation })),
)
const FeedPage = lazy(() => import('../pages/FeedPage').then((m) => ({ default: m.FeedPage })))
const PublicStoryPage = lazy(() =>
  import('../pages/PublicStoryPage').then((m) => ({ default: m.PublicStoryPage })),
)
const AdminPage = lazy(() => import('../pages/AdminPage').then((m) => ({ default: m.AdminPage })))
const CoauthorsPage = lazy(() =>
  import('../pages/CoauthorsPage').then((m) => ({ default: m.CoauthorsPage })),
)
const PeoplePage = lazy(() => import('../pages/PeoplePage').then((m) => ({ default: m.PeoplePage })))

/**
 * Место страницы внутри каркаса: тонкая полоска загрузки вместо пустоты.
 *
 * Не полноэкранная заставка, а именно полоска: шапка уже на экране, человек видит, что попал
 * куда собирался, и что раздел догружается. Полноэкранная заставка на этом шаге выглядела бы
 * как перезагрузка всего приложения.
 */
function PageFallback() {
  return (
    <div className="page-fallback" data-page-loading role="status" aria-live="polite">
      <span className="page-fallback__bar" aria-hidden="true" />
      <p className="muted page-fallback__note">Открываю раздел…</p>
    </div>
  )
}

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>
}

/** Каркас для вошедших: шапка и место страницы. */
function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="layout">
      <Header />
      <main>{children}</main>
    </div>
  )
}

/** Публичные страницы живут в общем каркасе, но без RequireAuth. */
function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="layout">
      <Header />
      <main>{children}</main>
    </div>
  )
}

/** Корень ведёт вошедшего в его проекты, анонима — в публичную ленту. */
function RootRedirect() {
  const user = useAuthStore((s) => s.user)
  const refresh = useAuthStore((s) => s.refreshToken)
  return <Navigate to={user || refresh ? '/projects' : '/feed'} replace />
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Page><LoginPage /></Page>} />
        <Route path="/register" element={<Page><RegisterPage /></Page>} />

        {/* Публичная лента и публичная история: доступны без входа и не содержат
            ни одного элемента редактирования. */}
        <Route
          path="/feed"
          element={<PublicLayout><Page><FeedPage /></Page></PublicLayout>}
        />
        <Route
          path="/s/:slug"
          element={<PublicLayout><Page><PublicStoryPage /></Page></PublicLayout>}
        />

        <Route
          path="/projects"
          element={<RequireAuth><AuthLayout><Page><ProjectsPage /></Page></AuthLayout></RequireAuth>}
        />
        <Route
          path="/projects/:id"
          element={
            <RequireAuth>
              <AuthLayout>
                <Page><ProjectTimelinePage /></Page>
              </AuthLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:id/settings"
          element={
            <RequireAuth>
              <AuthLayout>
                <Page><ProjectSettingsPage /></Page>
              </AuthLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/coauthors"
          element={<RequireAuth><AuthLayout><Page><CoauthorsPage /></Page></AuthLayout></RequireAuth>}
        />
        {/* Каталог резидентов: только вошедшим — это люди инсталляции, а не витрина */}
        <Route
          path="/people"
          element={<RequireAuth><AuthLayout><Page><PeoplePage /></Page></AuthLayout></RequireAuth>}
        />
        <Route
          path="/invitations/:token"
          element={
            <RequireAuth>
              <AuthLayout>
                <Page><AcceptInvitation /></Page>
              </AuthLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={<RequireAuth><AuthLayout><Page><AdminPage /></Page></AuthLayout></RequireAuth>}
        />
        <Route path="/" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
  )
}
