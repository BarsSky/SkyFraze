import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { Link } from 'react-router-dom'
import {
  decideCoauthor,
  inviteCoauthor,
  listCoauthors,
  normalizeUsername,
  removeCoauthor,
  searchUsers,
  updateCoauthor,
  validUsername,
  type CoauthorLink,
  type CoauthorList,
  type UserSearchResult,
} from '../api/coauthors'
import { useAuthStore } from '../store/auth'
import { ErrorBanner } from '../components/ErrorBanner'
import { InviteForm } from '../components/coauthors/InviteForm'
import { CraftPicker } from '../components/coauthors/CraftPicker'
import { craftsOf } from '../lib/crafts'

/**
 * Соавторы — круг людей, с которыми делается общее дело.
 *
 * Страница отвечает на три вопроса: «как меня найти» (ник), «кого позвать»
 * (поиск по нику и имени) и «что человек делает и что ему открыто»
 * (специализации и доступ к закрытым проектам).
 *
 * Заявка — обязательна: без согласия человека соавторства не возникает.
 * Доступ к закрытым проектам включает владелец проектов, и только на чтение.
 */
export function CoauthorsPage() {
  const t = useT()
  const user = useAuthStore((s) => s.user)
  const [list, setList] = useState<CoauthorList>({ coauthors: [], incoming: [], outgoing: [] })
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<UserSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** Открытая форма приглашения: кого зовём и с какими специализациями. */
  const [inviteFor, setInviteFor] = useState<UserSearchResult | null>(null)
  /** Открытый редактор специализаций у конкретного соавтора. */
  const [craftsFor, setCraftsFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setList(await listCoauthors())
      setError(null)
    } catch (e) {
      setError(e)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runSearch = useCallback(async (value: string) => {
    const q = value.trim()
    if (q.length < 2) {
      setFound(null)
      return
    }
    setSearching(true)
    try {
      setFound(await searchUsers(q))
      setError(null)
    } catch (e) {
      setError(e)
    } finally {
      setSearching(false)
    }
  }, [])

  async function onDecide(link: CoauthorLink, accept: boolean) {
    setBusy(link.id)
    try {
      await decideCoauthor(link.id, accept)
      setNote(accept
        ? t('coa.accepted', { name: link.other_display_name })
        : t('coa.declinedIncoming', { name: link.other_display_name }))
      await load()
      if (query.trim().length >= 2) await runSearch(query)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  async function onRemove(link: CoauthorLink) {
    setBusy(link.id)
    try {
      await removeCoauthor(link.id)
      setNote(t('coa.removed', { name: link.other_display_name }))
      await load()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  async function onToggleClosed(link: CoauthorLink, shares: boolean) {
    setBusy(link.id)
    try {
      await updateCoauthor(link.id, { shares_closed: shares })
      await load()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  async function onSaveCrafts(link: CoauthorLink, crafts: string[]) {
    setBusy(link.id)
    try {
      await updateCoauthor(link.id, { crafts })
      setCraftsFor(null)
      await load()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  async function onInvite(target: UserSearchResult, message: string, crafts: string[]) {
    setBusy(target.id)
    try {
      await inviteCoauthor(target.id, message, crafts)
      setInviteFor(null)
      setNote(t('coa.invited', { name: target.display_name, nick: target.username }))
      await load()
      if (query.trim().length >= 2) await runSearch(query)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const pendingCount = list.incoming.length
  const coauthorIds = useMemo(() => new Set(list.coauthors.map((l) => l.other_id)), [list.coauthors])

  if (!user) return null

  return (
    <div className="coauthors">
      <div className="feed__head">
        <div>
          <h2 className="feed__title">{t('coa.title')}</h2>
          <p className="muted feed__sub">
            {t('coa.sub')}
          </p>
        </div>
        <Link to="/projects">
          <button className="secondary" type="button">
              {t('coa.backToProjects')}
            </button>
        </Link>
      </div>

      {error != null && (
        <ErrorBanner
          error={error}
          what={t('coa.what')}
          onRetry={() => void load()}
          actions={<Link className="banner__link" to="/projects">{t('coa.backToProjects')}</Link>}
        />
      )}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" type="button" onClick={() => setNote(null)}>
              {t('coa.ok')}
            </button>
        </div>
      )}

      {/* Профиль переехал на свою вкладку (0.99.0): «нету вкладки пользователя, всё про вход
          пользователя в Соавторах». Здесь остаётся короткий указатель — человек, который искал
          настройки и раньше находил их тут, не должен уйти ни с чем. */}
      <section className="card" data-profile-link>
        <h3 style={{ marginTop: 0 }}>{t('coa.yourProfile')}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('coa.profileHint')}
        </p>
        {/* Ссылка — inline-flex: у строчной ссылки высота была 21 px, и аудит справедливо
            ругался «мелкая цель нажатия» (0.99.0). Внутри — обычная secondary-кнопка. */}
        <Link to="/profile" style={{ display: 'inline-flex' }}>
          <button className="secondary" type="button">
                {t('coa.openProfile')}
              </button>
        </Link>
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('coa.findPerson')}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('coa.findHint')}
        </p>
        <div className="coauthors__search">
          <input
            value={query}
            placeholder={t('coa.searchPlaceholder')}
            aria-label={t('coa.searchAria')}
            onChange={(e) => {
              setQuery(e.target.value)
              void runSearch(e.target.value)
            }}
          />
          <button type="button" disabled={searching || query.trim().length < 2} onClick={() => void runSearch(query)}>
            {searching ? t('coa.searching') : t('coa.find')}
          </button>
        </div>

        {found !== null && (
          <div className="coauthors__results" data-search-results>
            {found.length === 0 && (
              <p className="muted">
                {t('coa.nobody1')} <code>@anna.design</code>{t('coa.nobody2')}
              </p>
            )}
            {found.map((person) => (
              <div key={person.id} className="coauthors__row" data-user-id={person.id}>
                <div className="coauthors__who">
                  <strong>{person.display_name}</strong>
                  <span className="coauthors__nick">@{person.username}</span>
                  {craftsOf(person.crafts).length > 0 && (
                    <span className="coauthors__crafts">
                      {craftsOf(person.crafts).map((craft) => (
                        <span key={craft} className="craft-chip">{craft}</span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="coauthors__actions">
                  {person.relation === '' && (
                    <button type="button" disabled={busy === person.id} onClick={() => setInviteFor(person)}>
                      {t('coa.invite')}
                    </button>
                  )}
                  {person.relation === 'request-outgoing' && (
                    <span className="muted">{t('coa.outgoing')}</span>
                  )}
                  {person.relation === 'request-incoming' && (
                    <span className="muted">{t('coa.incoming')}</span>
                  )}
                  {person.relation === 'coauthor' && (
                    <span className="muted">{t('coa.alreadyCoauthor')}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {inviteFor && (
          <InviteForm
            person={inviteFor}
            busy={busy === inviteFor.id}
            onCancel={() => setInviteFor(null)}
            onSubmit={(message, crafts) => void onInvite(inviteFor, message, crafts)}
          />
        )}
      </section>

      {(pendingCount > 0 || list.outgoing.length > 0) && (
        <section className="card" data-requests>
          <h3 style={{ marginTop: 0 }}>
            {t('coa.requests')}
            {pendingCount > 0 && <span className="coauthors__badge">{pendingCount}</span>}
          </h3>
          {list.incoming.map((link) => (
            <div key={link.id} className="coauthors__row">
              <div className="coauthors__who">
                <strong>{link.other_display_name}</strong>
                <span className="coauthors__nick">@{link.other_username}</span>
                {link.message && <span className="muted">«{link.message}»</span>}
                {craftsOf(link.crafts).length > 0 && (
                  <span className="coauthors__crafts">
                    {craftsOf(link.crafts).map((craft) => (
                      <span key={craft} className="craft-chip">{craft}</span>
                    ))}
                  </span>
                )}
              </div>
              <div className="coauthors__actions">
                <button type="button" disabled={busy === link.id} onClick={() => void onDecide(link, true)}>
                  {t('coa.accept')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy === link.id}
                  onClick={() => void onDecide(link, false)}
                >
                  {t('coa.decline')}
                </button>
              </div>
            </div>
          ))}
          {list.outgoing.map((link) => (
            <div key={link.id} className="coauthors__row">
              <div className="coauthors__who">
                <strong>{link.other_display_name}</strong>
                <span className="coauthors__nick">@{link.other_username}</span>
                <span className="muted">{t('coa.waiting')}</span>
                {craftsOf(link.crafts).length > 0 && (
                  <span className="coauthors__crafts">
                    {craftsOf(link.crafts).map((craft) => (
                      <span key={craft} className="craft-chip">{craft}</span>
                    ))}
                  </span>
                )}
              </div>
              <div className="coauthors__actions">
                <button type="button" className="secondary" disabled={busy === link.id} onClick={() => void onRemove(link)}>
                  {t('coa.cancelRequest')}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="card" data-coauthors>
        <h3 style={{ marginTop: 0 }}>{t('coa.myCoauthors', { count: list.coauthors.length })}</h3>
        {list.coauthors.length === 0 && (
          <p className="muted">
            {t('coa.emptyHint')}
          </p>
        )}
        {list.coauthors.map((link) => {
          const iShare = link.requester_id === user.id
            ? link.requester_shares_closed
            : link.addressee_shares_closed
          const crafts = craftsOf(link.crafts)
          return (
            <div key={link.id} className="coauthors__row coauthors__row--card">
              <div className="coauthors__who">
                <strong>{link.other_display_name}</strong>
                <span className="coauthors__nick">@{link.other_username}</span>
                <span className="coauthors__crafts">
                  {crafts.length === 0 && <span className="muted">{t('coa.craftsEmpty')}</span>}
                  {crafts.map((craft) => (
                    <span key={craft} className="craft-chip">{craft}</span>
                  ))}
                </span>
              </div>
              <div className="coauthors__actions coauthors__actions--stack">
                <label className="coauthors__toggle">
                  <input
                    type="checkbox"
                    checked={iShare}
                    disabled={busy === link.id}
                    onChange={(e) => void onToggleClosed(link, e.target.checked)}
                  />
                  <span>{t('coa.seesPrivate')}</span>
                </label>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setCraftsFor(craftsFor === link.id ? null : link.id)}
                  >
                    {t('coa.crafts')}
                  </button>
                  <button type="button" className="secondary ed-danger" disabled={busy === link.id} onClick={() => void onRemove(link)}>
                    {t('coa.remove')}
                  </button>
                </div>
                <Link to="/projects" className="muted">
                  {t('coa.addToProject')}
                </Link>
              </div>
              {craftsFor === link.id && (
                <CraftPicker
                  initial={crafts}
                  busy={busy === link.id}
                  onCancel={() => setCraftsFor(null)}
                  onSave={(next) => void onSaveCrafts(link, next)}
                />
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
