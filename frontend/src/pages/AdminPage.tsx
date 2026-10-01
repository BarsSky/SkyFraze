import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  approveRegistration,
  getAdminSettings,
  getUpdateInfo,
  listAdminUsers,
  listRegistrations,
  rejectRegistration,
  requestUpdate,
  setRegistrationMode,
  type AdminSettings,
  type AdminUser,
  type RegistrationMode,
  type RegistrationRequest,
  type UpdateInfo,
} from '../api/admin'
import { useAuthStore } from '../store/auth'
import { ErrorBanner } from '../components/ErrorBanner'
import { StoragePanel } from '../components/admin/StoragePanel'
import { formatDate } from '../lib/format'

type Tab = 'pending' | 'approved' | 'rejected'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'pending', label: 'На рассмотрении' },
  { id: 'approved', label: 'Одобренные' },
  { id: 'rejected', label: 'Отклонённые' },
]

/**
 * Админка развёртывания: чем управляет администратор.
 *
 * Только две вещи: режим регистрации (свободная или по заявке) и рассмотрение
 * заявок. Доступа к чужим проектам и историям здесь нет и не должно появиться:
 * администратор отвечает за вход на инсталляцию, а не за содержимое.
 */
export function AdminPage() {
  const user = useAuthStore((s) => s.user)
  const nav = useNavigate()
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [requests, setRequests] = useState<RegistrationRequest[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [tab, setTab] = useState<Tab>('pending')
  const [error, setError] = useState<unknown>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, r, u] = await Promise.all([getAdminSettings(), listRegistrations(), listAdminUsers()])
      setSettings(s)
      setRequests(r)
      setUsers(u)
      setError(null)
    } catch (e) {
      setError(e)
    }
  }, [])

  const loadUpdate = useCallback(async (force = false) => {
    try {
      setUpdate(await getUpdateInfo(force))
    } catch (e) {
      setError(e)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadUpdate()
  }, [load, loadUpdate])

  async function onCheckUpdates() {
    setChecking(true)
    try {
      await loadUpdate(true)
      setNote('Проверил релизы на GitHub')
    } finally {
      setChecking(false)
    }
  }

  /** Заявка на обновление: применяет хост, админка только просит. */
  async function onRequestUpdate(target: string) {
    setUpdating(true)
    try {
      await requestUpdate(target)
      setNote(`Заявка на обновление до ${target} создана — хост применит её в течение минуты`)
      await loadUpdate(true)
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      setError(status === 409 ? new Error('Обновление уже идёт') : e)
    } finally {
      setUpdating(false)
    }
  }

  async function onMode(mode: RegistrationMode) {
    setBusy('mode')
    try {
      const s = await setRegistrationMode(mode)
      setSettings(s)
      setNote(mode === 'open' ? 'Регистрация открыта для всех' : 'Регистрация только по заявке')
    } catch {
      setNote(null)
      setError(new Error('Не удалось изменить режим регистрации — повторите попытку'))
    } finally {
      setBusy(null)
    }
  }

  async function onApprove(id: string, email: string) {
    setBusy(id)
    try {
      await approveRegistration(id)
      setNote(`Доступ для ${email} открыт — можно входить указанным паролем`)
      await load()
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      setError(status === 409 ? new Error(`Email ${email} уже занят`) : e)
    } finally {
      setBusy(null)
    }
  }

  async function onReject(id: string, email: string) {
    setBusy(id)
    try {
      await rejectRegistration(id, '')
      setNote(`Заявка ${email} отклонена`)
      await load()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  if (!user) return null
  if (!user.is_admin) {
    return (
      <div className="feed">
        <div className="card feed__empty">
          <h3 style={{ marginTop: 0 }}>Нужны права администратора</h3>
          <p className="muted">
            Администратор назначается при развёртывании: переменная окружения <code>ADMIN_EMAILS</code>.
            Если админов ещё нет, им становится первый зарегистрированный пользователь.
          </p>
          <button type="button" onClick={() => nav('/projects')}>
            ← К проектам
          </button>
        </div>
      </div>
    )
  }

  const visible = requests.filter((r) => r.status === tab)

  return (
    <div className="admin">
      <div className="feed__head">
        <div>
          <h2 className="feed__title">Администрирование</h2>
          <p className="muted feed__sub">
            Кто может завести аккаунт на этой инсталляции. Содержимое проектов админу недоступно.
          </p>
        </div>
        <Link to="/projects">
          <button className="secondary" type="button">← К проектам</button>
        </Link>
      </div>

      {error != null && (
        <ErrorBanner
          error={error}
          what="Админка"
          onRetry={() => void load()}
          actions={
            <>
              <Link className="banner__link" to="/projects">← К проектам</Link>
              <Link className="banner__link" to="/feed">Лента</Link>
            </>
          }
        />
      )}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" type="button" onClick={() => setNote(null)}>ок</button>
        </div>
      )}

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Регистрация</h3>
        <div className="admin__modes" role="radiogroup" aria-label="Режим регистрации">
          <button
            type="button"
            role="radio"
            aria-checked={settings?.registration_mode === 'request'}
            className={settings?.registration_mode === 'request' ? 'admin__mode is-active' : 'admin__mode'}
            disabled={busy === 'mode'}
            onClick={() => void onMode('request')}
          >
            <b>По заявке</b>
            <span>Аккаунт создаёт администратор после рассмотрения заявки (по умолчанию)</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={settings?.registration_mode === 'open'}
            className={settings?.registration_mode === 'open' ? 'admin__mode is-active' : 'admin__mode'}
            disabled={busy === 'mode'}
            onClick={() => void onMode('open')}
          >
            <b>Свободная</b>
            <span>Любой может зарегистрироваться сам</span>
          </button>
        </div>
        {settings && (
          <p className="muted admin__stats">
            пользователей: {settings.users} · администраторов: {settings.admins} · заявок на рассмотрении: {settings.pending_requests}
          </p>
        )}
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Заявки на доступ</h3>
        <div className="feed__sorts" role="tablist" aria-label="Статус заявок">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'feed__sort is-active' : 'feed__sort'}
              onClick={() => setTab(t.id)}
            >
              {t.label} ({requests.filter((r) => r.status === t.id).length})
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            {tab === 'pending' ? 'Новых заявок нет.' : 'Пусто.'}
          </p>
        ) : (
          <ul className="admin__requests">
            {visible.map((r) => (
              <li key={r.id} className="admin__request">
                <div className="admin__request-main">
                  <b>{r.display_name}</b> <span className="muted">{r.email}</span>
                  <div className="muted admin__request-date">{formatDate(r.created_at)}</div>
                  {r.message && <p className="admin__request-message">{r.message}</p>}
                </div>
                {r.status === 'pending' && (
                  <div className="row">
                    <button type="button" disabled={busy === r.id} onClick={() => void onApprove(r.id, r.email)}>
                      Одобрить
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === r.id}
                      onClick={() => void onReject(r.id, r.email)}
                    >
                      Отклонить
                    </button>
                  </div>
                )}
                {r.status !== 'pending' && <span className="muted">{r.status === 'approved' ? 'одобрена' : 'отклонена'}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Обновление</h3>
        {!update && <p className="muted">Проверяю версию…</p>}
        {update && (
          <>
            <div className="admin__update">
              <div>
                <div className="admin__update-version">
                  Текущая версия: <b>{update.check.current || 'dev'}</b>
                  {update.check.commit ? ` (${update.check.commit})` : ''}
                </div>
                {update.check.configured ? (
                  update.check.error ? (
                    <div className="muted">Не удалось проверить: {update.check.error}</div>
                  ) : update.check.latest ? (
                    <div className="muted">
                      Последний релиз:{' '}
                      <a href={update.check.latest.url} target="_blank" rel="noreferrer">
                        {update.check.latest.tag}
                      </a>{' '}
                      {update.check.update_available ? '— доступно обновление' : '— у вас актуальная версия'}
                    </div>
                  ) : (
                    <div className="muted">Релизов пока нет</div>
                  )
                ) : (
                  <div className="muted">
                    Источник не настроен: укажите <code>UPDATE_REPO=владелец/репозиторий</code> в <code>.env</code> и
                    перезапустите backend.
                  </div>
                )}
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="secondary" disabled={checking} onClick={() => void onCheckUpdates()}>
                  {checking ? 'Проверяю…' : 'Проверить обновления'}
                </button>
                {update.check.update_available && update.check.latest && (
                  <button
                    type="button"
                    disabled={updating || ['requested', 'running'].includes(update.status?.status ?? '')}
                    title="Заявку применит хост: git pull + docker compose up -d --build"
                    onClick={() => void onRequestUpdate(update.check.latest!.tag)}
                  >
                    Обновить до {update.check.latest.tag}
                  </button>
                )}
              </div>
            </div>

            {update.status && update.status.status !== 'idle' && (
              <p className="admin__update-state">
                Состояние: <b>{update.status.status}</b>
                {update.status.message ? ` — ${update.status.message}` : ''}
                {update.status.ended_at ? ` (${formatDate(update.status.ended_at)})` : ''}
              </p>
            )}

            {update.status?.status === 'requested' && (
              <p className="muted">
                Заявка создана. Применяет хост: systemd-юнит <code>skyfraze-update.path</code> и скрипт{' '}
                <code>deploy/skyfraze-update.sh</code>. Если через минуту ничего не началось — проверьте, установлены ли
                юниты (<code>sudo bash deploy/install-update-units.sh</code>).
              </p>
            )}

            {update.log && (
              <details className="admin__update-log">
                <summary>Лог последнего обновления</summary>
                <pre>{update.log}</pre>
              </details>
            )}
          </>
        )}
      </section>

      <StoragePanel />

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Пользователи ({users.length})</h3>
        <ul className="admin__users">
          {users.map((u) => (
            <li key={u.id}>
              <span>{u.display_name}</span>
              <span className="muted">{u.email}</span>
              {u.is_admin && <span className="pub-badge">админ</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
