import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from '../pages/LoginPage'
import { RegisterPage } from '../pages/RegisterPage'
import { ProjectsPage } from '../pages/ProjectsPage'
import { ProjectTimelinePage } from '../pages/ProjectTimelinePage'
import { ProjectSettingsPage } from '../pages/ProjectSettingsPage'
import { AcceptInvitation } from '../pages/AcceptInvitation'
import { FeedPage } from '../pages/FeedPage'
import { PublicStoryPage } from '../pages/PublicStoryPage'
import { AdminPage } from '../pages/AdminPage'
import { RequireAuth } from '../components/RequireAuth'
import { Header } from '../components/Header'
import { useAuthStore } from '../store/auth'

/** Публичные страницы живут в общем каркасе, но без RequireAuth. */
function PublicLayout({ children }: { children: React.ReactNode }) {
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
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Публичная лента и публичная история: доступны без входа и не содержат
            ни одного элемента редактирования. */}
        <Route path="/feed" element={<PublicLayout><FeedPage /></PublicLayout>} />
        <Route path="/s/:slug" element={<PublicLayout><PublicStoryPage /></PublicLayout>} />

        <Route
          path="/projects"
          element={
            <RequireAuth>
              <div className="layout">
                <Header />
                <main><ProjectsPage /></main>
              </div>
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:id"
          element={
            <RequireAuth>
              <div className="layout">
                <Header />
                <main><ProjectTimelinePage /></main>
              </div>
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:id/settings"
          element={
            <RequireAuth>
              <div className="layout">
                <Header />
                <main><ProjectSettingsPage /></main>
              </div>
            </RequireAuth>
          }
        />
        <Route
          path="/invitations/:token"
          element={
            <RequireAuth>
              <div className="layout">
                <Header />
                <main><AcceptInvitation /></main>
              </div>
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <div className="layout">
                <Header />
                <main><AdminPage /></main>
              </div>
            </RequireAuth>
          }
        />
        <Route path="/" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
  )
}
