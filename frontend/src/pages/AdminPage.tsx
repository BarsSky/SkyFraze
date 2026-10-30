import { useCallback, useEffect, useState } from 'react'
import { useT, type Key } from '../i18n'
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

const TABS: Array<{ id: Tab; labelKey: Key }> = [
  { id: 'pending', labelKey: 'adm.tabPending' },
  { id: 'approved', labelKey: 'adm.tabApproved' },
  { id: 'rejected', labelKey: 'adm.tabRejected' },
]

/**
 * Админка развёртывания: чем управляет администратор.
 *
 * Только две вещи: режим регистрации (свободная или по заявке) и рассмотрение
 * заявок. Доступа к чужим проектам и историям здесь нет и не должно появиться:
 * администратор отвечает за вход на инсталляцию, а не за содержимое.
 */
export function AdminPage() {
  const t = useT()
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
      setNote(t('adm.releasesChecked'))
    } finally {
      setChecking(false)
    }
  }

  /** Заявка на обновление: применяет хост, админка только просит. */
  async function onRequestUpdate(target: string) {
    setUpdating(true)
    try {
      await requestUpdate(target)
      setNote(t('adm.updateRequested', { target }))
      await loadUpdate(true)
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      setError(status === 409 ? new Error(t('adm.updateInProgress')) : e)
    } finally {
      setUpdating(false)
    }
  }

  async function onMode(mode: RegistrationMode) {
    setBusy('mode')
    try {
      const s = await setRegistrationMode(mode)
      setSettings(s)
      setNote(mode === 'open' ? t('adm.registrationOpen') : t('adm.registrationByRequest'))
    } catch {
      setNote(null)
      setError(new Error(t('adm.registrationFailed')))
    } finally {
      setBusy(null)
    }
  }

  async function onApprove(id: string, email: string) {
    setBusy(id)
    try {
      await approveRegistration(id)
      setNote(t('adm.accessOpened', { email }))
      await load()
    } catch (e) {
      const status = (e as { response?: Response })?.response?.status
      setError(status === 409 ? new Error(t('adm.emailTaken', { email })) : e)
    } finally {
      setBusy(null)
    }
  }

  async function onReject(id: string, email: string) {
    setBusy(id)
    try {
      await rejectRegistration(id, '')
      setNote(t('adm.requestRejected', { email }))
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
          <h3 style={{ marginTop: 0 }}>{t('adm.noAdminTitle')}</h3>
          <p className="muted">
            {t('adm.noAdminHint1')} <code>ADMIN_EMAILS</code>
            {t('adm.noAdminHint2')}
          </p>
          <button type="button" onClick={() => nav('/projects')}>
            {t('adm.backToProjects')}
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
          <h2 className="feed__title">{t('adm.title')}</h2>
          <p className="muted feed__sub">
            {t('adm.sub')}
          </p>
        </div>
        <Link to="/projects">
          <button className="secondary" type="button">
          {t('adm.backToProjects')}
          </button>
        </Link>
      </div>

      {error != null && (
        <ErrorBanner
          error={error}
                    what={t('adm.what')}
          onRetry={() => void load()}
          actions={
            <>
              <Link className="banner__link" to="/projects">{t('adm.backToProjects')}</Link>
              <Link className="banner__link" to="/feed">{t('adm.feed')}</Link>
            </>
          }
        />
      )}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" type="button" onClick={() => setNote(null)}>
          {t('adm.ok')}
          </button>
        </div>
      )}

      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('adm.registration')}</h3>
        <div className="admin__modes" role="radiogroup" aria-label={t('adm.modeAria')}>
          <button
            type="button"
            role="radio"
            aria-checked={settings?.registration_mode === 'request'}
            className={settings?.registration_mode === 'request' ? 'admin__mode is-active' : 'admin__mode'}
            disabled={busy === 'mode'}
            onClick={() => void onMode('request')}
          >
            <b>{t('adm.byRequest')}</b>
            <span>{t('adm.byRequestHint')}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={settings?.registration_mode === 'open'}
            className={settings?.registration_mode === 'open' ? 'admin__mode is-active' : 'admin__mode'}
            disabled={busy === 'mode'}
            onClick={() => void onMode('open')}
          >
            <b>{t('adm.free')}</b>
            <span>{t('adm.freeHint')}</span>
          </button>
        </div>
        {settings && (
          <p className="muted admin__stats">
            {t('adm.counts', {
            users: settings.users,
            admins: settings.admins,
            pending: settings.pending_requests,
            })}
          </p>
        )}
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('adm.requests')}</h3>
        <div className="feed__sorts" role="tablist" aria-label={t('adm.statusAria')}>
          {TABS.map((tabItem) => (
            <button
              key={tabItem.id}
              type="button"
              role="tab"
              aria-selected={tab === tabItem.id}
              className={tab === tabItem.id ? 'feed__sort is-active' : 'feed__sort'}
              onClick={() => setTab(tabItem.id)}
            >
              {t(tabItem.labelKey)} ({requests.filter((r) => r.status === tabItem.id).length})
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            {tab === 'pending' ? t('adm.nonePending') : t('adm.none')}
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
                                      {t('adm.approve')}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === r.id}
                      onClick={() => void onReject(r.id, r.email)}
                    >
                                      {t('adm.reject')}
                    </button>
                  </div>
                )}
                {r.status !== 'pending' && (
                <span className="muted">
                {r.status === 'approved' ? t('adm.approved') : t('adm.rejected')}
                </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('adm.update')}</h3>
        {!update && <p className="muted">{t('adm.checkingVersion')}</p>}
        {update && (
          <>
            <div className="admin__update">
              <div>
                <div className="admin__update-version">
                  {t('adm.current')} <b>{update.check.current || 'dev'}</b>
                  {update.check.commit ? ` (${update.check.commit})` : ''}
                </div>
                {update.check.configured ? (
                  update.check.error ? (
                    <div className="muted">{t('adm.checkFailed', { error: update.check.error })}</div>
                  ) : update.check.latest ? (
                    <div className="muted">
                      {t('adm.lastRelease')}{' '}
                      <a href={update.check.latest.url} target="_blank" rel="noreferrer">
                        {update.check.latest.tag}
                      </a>{' '}
                      {update.check.update_available ? t('adm.updateAvailable') : t('adm.upToDate')}
                    </div>
                  ) : (
                    <div className="muted">{t('adm.noReleases')}</div>
                  )
                ) : (
                  <div className="muted">
                    {t('adm.noSource1')} <code>{t('adm.noSourceExample')}</code>
                    {t('adm.noSource2')} <code>.env</code>
                    {t('adm.noSource3')}
                  </div>
                )}
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="secondary" disabled={checking} onClick={() => void onCheckUpdates()}>
                  {checking ? t('adm.checking') : t('adm.checkUpdates')}
                </button>
                {update.check.update_available && update.check.latest && (
                  <button
                    type="button"
                    disabled={updating || ['requested', 'running'].includes(update.status?.status ?? '')}
                    title={t('adm.applyTitle')}
                    onClick={() => void onRequestUpdate(update.check.latest!.tag)}
                  >
                    {t('adm.updateTo', { tag: update.check.latest.tag })}
                  </button>
                )}
              </div>
            </div>

            {update.status && update.status.status !== 'idle' && (
              <p className="admin__update-state">
                {t('adm.state')} <b>{update.status.status}</b>
                {update.status.message ? ` — ${update.status.message}` : ''}
                {update.status.ended_at ? ` (${formatDate(update.status.ended_at)})` : ''}
              </p>
            )}

            {update.status?.status === 'requested' && (
              <p className="muted">
                {t('adm.requestCreated1')} <code>skyfraze-update.path</code>
                {t('adm.requestCreated2')} <code>deploy/skyfraze-update.sh</code>
                {t('adm.requestCreated3')}
                <code>sudo bash deploy/install-update-units.sh</code>
                {t('adm.requestCreated4')}
              </p>
            )}

            {update.log && (
              <details className="admin__update-log">
                <summary>{t('adm.logSummary')}</summary>
                <pre>{update.log}</pre>
              </details>
            )}
          </>
        )}
      </section>

      <StoragePanel />

      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('adm.users', { count: users.length })}</h3>
        <ul className="admin__users">
          {users.map((u) => (
            <li key={u.id}>
              <span>{u.display_name}</span>
              <span className="muted">{u.email}</span>
              {u.is_admin && <span className="pub-badge">{t('adm.adminBadge')}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
