import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { updateProfile, type ProfilePatch } from '../api/auth'
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
        ? `${link.other_display_name} теперь соавтор — можно добавить его в проект`
        : `Заявка от ${link.other_display_name} отклонена`)
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
      setNote(`${link.other_display_name} больше не соавтор`)
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
      setNote(`Заявка отправлена: ${target.display_name} (@${target.username})`)
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
          <h2 className="feed__title">Соавторы</h2>
          <p className="muted feed__sub">
            Круг людей, с которыми делается общее дело. Соавтор попадает в список при добавлении
            в проект, а его специализации подсказывают, кому что поручить.
          </p>
        </div>
        <Link to="/projects">
          <button className="secondary" type="button">← К проектам</button>
        </Link>
      </div>

      {error != null && (
        <ErrorBanner
          error={error}
          what="Соавторы"
          onRetry={() => void load()}
          actions={<Link className="banner__link" to="/projects">← К проектам</Link>}
        />
      )}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" type="button" onClick={() => setNote(null)}>ок</button>
        </div>
      )}

      <ProfileCard />

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Найти человека</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Поиск по нику (@nick) или по имени. Ник виден в шапке и меняется в блоке «Как вас найти».
        </p>
        <div className="coauthors__search">
          <input
            value={query}
            placeholder="@nick или имя"
            aria-label="Поиск людей по нику или имени"
            onChange={(e) => {
              setQuery(e.target.value)
              void runSearch(e.target.value)
            }}
          />
          <button type="button" disabled={searching || query.trim().length < 2} onClick={() => void runSearch(query)}>
            {searching ? 'Ищу…' : 'Найти'}
          </button>
        </div>

        {found !== null && (
          <div className="coauthors__results" data-search-results>
            {found.length === 0 && (
              <p className="muted">
                Никого не нашлось. Проверьте ник: он пишется латиницей, например <code>@anna.design</code>.
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
                      Позвать в соавторы
                    </button>
                  )}
                  {person.relation === 'request-outgoing' && <span className="muted">заявка отправлена</span>}
                  {person.relation === 'request-incoming' && (
                    <span className="muted">этот человек позвал вас — заявка ниже</span>
                  )}
                  {person.relation === 'coauthor' && <span className="muted">уже соавтор</span>}
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
            Заявки{pendingCount > 0 && <span className="coauthors__badge">{pendingCount}</span>}
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
                  Принять
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy === link.id}
                  onClick={() => void onDecide(link, false)}
                >
                  Отклонить
                </button>
              </div>
            </div>
          ))}
          {list.outgoing.map((link) => (
            <div key={link.id} className="coauthors__row">
              <div className="coauthors__who">
                <strong>{link.other_display_name}</strong>
                <span className="coauthors__nick">@{link.other_username}</span>
                <span className="muted">ждёт ответа</span>
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
                  Отменить заявку
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="card" data-coauthors>
        <h3 style={{ marginTop: 0 }}>Мои соавторы: {list.coauthors.length}</h3>
        {list.coauthors.length === 0 && (
          <p className="muted">
            Пока никого. Найдите человека по нику выше и позовите — после согласия он появится
            в списке при добавлении участника в проект.
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
                  {crafts.length === 0 && <span className="muted">специализации не указаны</span>}
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
                  <span>видит мои закрытые проекты (только чтение)</span>
                </label>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setCraftsFor(craftsFor === link.id ? null : link.id)}
                  >
                    Специализации
                  </button>
                  <button type="button" className="secondary ed-danger" disabled={busy === link.id} onClick={() => void onRemove(link)}>
                    Убрать
                  </button>
                </div>
                <Link to="/projects" className="muted">добавить в проект →</Link>
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

/** Предел резюме: столько же принимает сервер, счётчик предупреждает заранее. */
const BIO_LIMIT = 600

/**
 * «Как вас найти»: имя, ник, резюме, специализации и видимость в каталоге.
 *
 * Один блок отвечает на два вопроса сразу: как человека находят по нику и что о
 * нём узнают в каталоге резидентов. Ник уникален — занятый вернёт понятную
 * ошибку, а не сырое «409».
 */
function ProfileCard() {
  const user = useAuthStore((s) => s.user)
  const [name, setName] = useState(user?.display_name ?? '')
  const [nick, setNick] = useState(user?.username ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [crafts, setCrafts] = useState<string[]>(craftsOf(user?.crafts))
  /** Отсутствие поля — не «скрыт»: на сервере видимость включена по умолчанию. */
  const savedDiscoverable = user?.discoverable !== false
  const [discoverable, setDiscoverable] = useState(savedDiscoverable)
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setName(user?.display_name ?? '')
    setNick(user?.username ?? '')
    setBio(user?.bio ?? '')
    setCrafts(craftsOf(user?.crafts))
    setDiscoverable(user?.discoverable !== false)
  }, [user?.display_name, user?.username, user?.bio, user?.crafts, user?.discoverable])

  const nickOk = validUsername(nick)
  const savedCrafts = craftsOf(user?.crafts)
  const sameCrafts =
    crafts.length === savedCrafts.length && crafts.every((craft) => savedCrafts.includes(craft))

  // Отправляем только изменённое: незатронутое поле сервер и так не трогает, а
  // пустое значение в теле — это осознанная очистка (снять резюме, убрать все
  // специализации, скрыться из каталога).
  const patch: ProfilePatch = {}
  if (name.trim() !== (user?.display_name ?? '')) patch.display_name = name.trim()
  if (normalizeUsername(nick) !== (user?.username ?? '')) patch.username = normalizeUsername(nick)
  if (bio.trim() !== (user?.bio ?? '')) patch.bio = bio.trim()
  if (!sameCrafts) patch.crafts = crafts
  if (discoverable !== savedDiscoverable) patch.discoverable = discoverable
  const changed = Object.keys(patch).length > 0

  async function save() {
    if (!changed) return
    setState('busy')
    setMessage(null)
    try {
      await updateProfile(patch)
      setState('saved')
      setMessage('Сохранено')
    } catch (e) {
      setState('idle')
      setMessage(/409/.test(String(e)) ? 'Этот ник уже занят — попробуйте другой' : 'Не удалось сохранить')
    }
  }

  return (
    <section className="card" data-profile>
      <h3 style={{ marginTop: 0 }}>Как вас найти</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Ник — это то, что человек вводит в поиске: <code>@{user?.username}</code>. Резюме
        и специализации здесь же попадают в каталог резидентов.
      </p>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 220px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: 4 }}>Имя</span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Ваше имя" />
        </label>
        <label style={{ flex: '1 1 200px' }}>
          <span className="muted" style={{ display: 'block', marginBottom: 4 }}>Ник</span>
          <input
            value={nick}
            onChange={(e) => setNick(normalizeUsername(e.target.value))}
            aria-label="Ваш ник"
            placeholder="anna.design"
          />
        </label>
      </div>
      {!nickOk && nick.length > 0 && (
        <p className="ed-panel__note">Ник: от 3 до 32 символов, латиница, цифры, точка, дефис, подчёркивание.</p>
      )}

      <label className="coauthors__bio">
        <span className="muted" style={{ display: 'block', marginBottom: 4 }}>О себе</span>
        <textarea
          rows={3}
          maxLength={BIO_LIMIT}
          value={bio}
          aria-label="О себе"
          placeholder="Чем занимаетесь, что пишете и чем можете помочь в общем деле"
          onChange={(e) => setBio(e.target.value)}
        />
        <span className="muted coauthors__counter">{bio.length} / {BIO_LIMIT}</span>
      </label>

      <div className="coauthors__profile-crafts">
        <span className="muted" style={{ display: 'block', marginBottom: 6 }}>
          Специализации — что вы берёте на себя в общем деле
        </span>
        <CraftPicker initial={crafts} value={crafts} onChange={setCrafts} />
      </div>

      <label className="coauthors__toggle">
        <input
          type="checkbox"
          checked={discoverable}
          onChange={(e) => setDiscoverable(e.target.checked)}
        />
        <span>
          Показывать меня в списке резидентов
          <span className="muted" style={{ display: 'block' }}>
            Включено по умолчанию: снимите галочку, чтобы скрыть себя из каталога и из
            поиска людей.
          </span>
        </span>
      </label>

      <div className="row" style={{ gap: 12, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" disabled={state === 'busy' || !nickOk || !changed} onClick={() => void save()}>
          {state === 'busy' ? 'Сохраняю…' : 'Сохранить профиль'}
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </section>
  )
}
