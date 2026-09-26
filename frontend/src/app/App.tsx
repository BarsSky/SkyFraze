import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from '../pages/LoginPage'
import { RegisterPage } from '../pages/RegisterPage'
import { ProjectsPage } from '../pages/ProjectsPage'
import { ProjectTimelinePage } from '../pages/ProjectTimelinePage'
import { ProjectSettingsPage } from '../pages/ProjectSettingsPage'
import { AcceptInvitation } from '../pages/AcceptInvitation'
import { RequireAuth } from '../components/RequireAuth'
import { Header } from '../components/Header'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
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
        <Route path="/" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
