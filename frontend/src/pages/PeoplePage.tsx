import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { inviteCoauthor } from '../api/coauthors'
import {
  getPerson,
  listPeople,
  PEOPLE_PAGE_SIZE,
  type Person,
  type PersonProfile,
} from '../api/people'
import { ErrorBanner } from '../components/ErrorBanner'
import { InviteForm } from '../components/coauthors/InviteForm'
import { describeApiError } from '../lib/apiError'
import { CRAFT_CATALOG, craftShort, craftsOf } from '../lib/crafts'
import { plural } from '../lib/format'
import { useAuthStore } from '../store/auth'

/** Пауза после последнего нажатия: без неё поиск дёргал бы сервер на каждый символ. */
const SEARCH_DEBOUNCE_MS = 250

/** Поиск идёт от двух символов — короче сервер всё равно отвечает пустым списком. */
const MIN_QUERY = 2

/**
 * Резиденты — каталог зарегистрированных участников.
 *
 * Страница отвечает на вопрос «кто здесь есть»: ник, имя, специализации и
 * короткое резюме, а строка раскрывается до полного резюме и списка публичных
 * историй. Заявку в соавторы можно отправить прямо отсюда: это та же форма, что
 * и в разделе «Соавторы», поэтому связь (`relation`) видна сразу и кнопка не
 * предлагает повторно то, что уже есть.
 *
 * В каталоге видно всех зарегистрированных (`discoverable` включён по умолчанию):
 * человек скрывается отсюда сам, сняв галочку в профиле.
 */
export function PeoplePage() {
  const user = useAuthStore((s) => s.user)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  /** Выбранная специализация: null — фильтра нет («все»). */
  const [craft, setCraft] = useState<string | null>(null)
  const [items, setItems] = useState<Person[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Раскрытая строка: полное резюме, истории и заявка. */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, PersonProfile>>({})
  const [detailFor, setDetailFor] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<{ id: string; error: unknown } | null>(null)
  const [inviteFor, setInviteFor] = useState<Person | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * Номер последнего запроса каталога. Ответ, пришедший после более свежего
   * (человек продолжает печатать), отбрасывается: иначе список мигал бы чужими
   * результатами.
   */
  const ticket = useRef(0)

  const trimmed = query.trim()
  // Поиск работает по «отложенному» значению, а подсказка про два символа — по
  // тому, что человек видит в поле прямо сейчас.
  const settled = debounced.trim()
  const activeQuery = settled.length >= MIN_QUERY ? settled : ''

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [query])

  const load = useCallback(async (q: string, nextCraft: string | null, offset: number) => {
    const mine = ++ticket.current
    if (offset === 0) setLoading(true)
    else setLoadingMore(true)
    try {
      const page = await listPeople({ q, craft: nextCraft, limit: PEOPLE_PAGE_SIZE, offset })
      if (mine !== ticket.current) return
      setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]))
      setTotal(page.total)
      setError(null)
    } catch (e) {
      if (mine !== ticket.current) return
      setError(e)
      if (offset === 0) {
        setItems([])
        setTotal(0)
      }
    } finally {
      if (mine === ticket.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [])

  // Смена запроса или фильтра начинается с начала списка: иначе «Показать ещё»
  // дописало бы старые строки к новому результату.
  useEffect(() => {
    setExpanded(null)
    setInviteFor(null)
    void load(activeQuery, craft, 0)
  }, [load, activeQuery, craft])

  const loadDetail = useCallback(async (person: Person) => {
    setDetailError(null)
    setDetailFor(person.id)
    try {
      const profile = await getPerson(person.id)
      setDetails((prev) => ({ ...prev, [person.id]: profile }))
    } catch (e) {
      setDetailError({ id: person.id, error: e })
    } finally {
      setDetailFor((prev) => (prev === person.id ? null : prev))
    }
  }, [])

  function toggle(person: Person) {
    if (expanded === person.id) {
      setExpanded(null)
      setInviteFor(null)
      return
    }
    setExpanded(person.id)
    setInviteFor(null)
    if (!details[person.id]) void loadDetail(person)
  }

  async function onInvite(target: Person, message: string, targetCrafts: string[]) {
    setBusy(target.id)
    try {
      await inviteCoauthor(target.id, message, targetCrafts)
      setInviteFor(null)
      setNote(`Заявка отправлена: ${target.display_name} (@${target.username})`)
      // Связь изменилась прямо сейчас — помечаем строку, чтобы кнопка не
      // предлагала отправить ту же заявку второй раз.
      setItems((prev) =>
        prev.map((p) => (p.id === target.id ? { ...p, relation: 'request-outgoing' } : p)),
      )
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  function resetFilters() {
    setQuery('')
    setDebounced('')
    setCraft(null)
  }

  /**
   * Явный поиск: Enter в поле и кнопка «Найти» применяют запрос сразу, не ожидая
   * паузы после набора. Если дебаунс уже применил ровно этот запрос (эффект ниже
   * ничего не перезапустит), повторяем его сами — иначе нажатие выглядело бы как
   * «ничего не произошло».
   */
  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (query.trim() === debounced.trim()) {
      void load(activeQuery, craft, 0)
      return
    }
    setDebounced(query)
  }

  /**
   * Что делать со строкой: пригласить или объяснить, почему нельзя. Повторную
   * заявку кнопка не предлагает — связь приходит вместе с человеком.
   */
  function relationControl(person: Person) {
    if (user?.id === person.id) return <span className="muted">это вы</span>
    if (person.relation === 'coauthor') return <span className="muted">уже соавтор</span>
    if (person.relation === 'request-outgoing') {
      return <span className="muted">заявка отправлена, ждём ответа</span>
    }
    if (person.relation === 'request-incoming') {
      return (
        <span className="muted people__relation">
          этот человек позвал вас —{' '}
          <Link className="people__link" to="/coauthors">ответить</Link>
        </span>
      )
    }
    return (
      <button
        type="button"
        disabled={busy === person.id}
        onClick={() => {
          setExpanded(person.id)
          setInviteFor(person)
        }}
      >
        Позвать в соавторы
      </button>
    )
  }

  const filtering = activeQuery.length >= MIN_QUERY || craft !== null
  const empty = !loading && error == null && items.length === 0

  return (
    <div className="coauthors people" data-people>
      <div className="feed__head">
        <div>
          <h2 className="feed__title">Резиденты</h2>
          <p className="muted feed__sub">
            Зарегистрированные участники: чем занимаются и что уже опубликовали.
            Заявку в соавторы можно отправить прямо из строки.
          </p>
        </div>
        <Link to="/coauthors">
          <button className="secondary" type="button">← К соавторам</button>
        </Link>
      </div>

      {user && user.discoverable === false && (
        <p className="muted people__self-note">
          Вас не видно в каталоге: галочка «Показывать меня в списке резидентов» снята в профиле на
          странице <Link className="people__link" to="/coauthors">«Соавторы»</Link>.
        </p>
      )}

      {error != null && (
        <ErrorBanner
          error={error}
          what="Резиденты"
          onRetry={() => void load(activeQuery, craft, 0)}
          actions={<Link className="banner__link" to="/coauthors">← К соавторам</Link>}
        />
      )}
      {note && (
        <div className="card pub-note">
          {note}
          <button className="secondary" type="button" onClick={() => setNote(null)}>ок</button>
        </div>
      )}

      <section className="card">
        <form className="coauthors__search" role="search" onSubmit={submitSearch}>
          <input
            value={query}
            placeholder="Поиск по нику (@nick) или имени"
            aria-label="Поиск резидентов по нику или имени"
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* Кнопка нужна не только ради Enter: явное нажатие применяет запрос
              сразу, а не после паузы набора. */}
          <button type="submit" className="secondary">Найти</button>
        </form>
        {trimmed.length === 1 && (
          <p className="muted people__hint">
            Поиск идёт от двух символов — пока показан весь каталог.
          </p>
        )}

        <div className="people__filters" role="group" aria-label="Фильтр по специализациям">
          <button
            type="button"
            className={craft === null ? 'craft-chip is-picked' : 'craft-chip'}
            aria-pressed={craft === null}
            onClick={() => setCraft(null)}
          >
            все
          </button>
          {CRAFT_CATALOG.map((item) => (
            <button
              key={item}
              type="button"
              title={item}
              className={craft === item ? 'craft-chip is-picked' : 'craft-chip'}
              aria-pressed={craft === item}
              onClick={() => setCraft(craft === item ? null : item)}
            >
              {craftShort(item)}
            </button>
          ))}
        </div>

        {loading && <p className="muted">Загрузка…</p>}
        {!loading && error == null && (
          <p className="muted people__count" data-people-count>
            Найдено: {total} {plural(total, 'резидент', 'резидента', 'резидентов')}
          </p>
        )}
      </section>

      <section className="card" data-people-list>
        {empty && (
          <div className="people__empty" data-people-empty>
            <h3 className="people__empty-title">
              {filtering ? 'Никого не нашлось' : 'Каталог резидентов пуст'}
            </h3>
            {filtering ? (
              <>
                <p className="muted people__empty-text">
                  Попробуйте другое имя или ник: ник пишется латиницей, например{' '}
                  <code>@anna.design</code>.
                </p>
                <button type="button" className="secondary" onClick={resetFilters}>
                  Сбросить поиск и фильтр
                </button>
              </>
            ) : (
              <>
                <p className="muted people__empty-text">
                  Пока никто не зарегистрировался. Каталог заполняется сам: как только на
                  инсталляции появляются участники, они видны здесь — со своим резюме и
                  специализациями.
                </p>
                <Link className="people__link" to="/coauthors">
                  Профиль и круг соавторов →
                </Link>
              </>
            )}
          </div>
        )}

        {items.map((person) => {
          const crafts = craftsOf(person.crafts)
          const profile = details[person.id]
          const isOpen = expanded === person.id
          const bio = person.bio ?? ''
          // 404 у профиля — это «человек не найден», а не «историю сняли с публикации»:
          // подсказку берём по предмету ошибки (subject), иначе текст врал бы.
          const detailIssue =
            detailError && detailError.id === person.id
              ? describeApiError(detailError.error, 'person')
              : null
          return (
            <article
              key={person.id}
              className="coauthors__row people__row"
              data-person-id={person.id}
              data-relation={person.relation}
            >
              <div className="coauthors__who people__who">
                <div className="people__headline">
                  <strong className="people__name">{person.display_name}</strong>
                  <span className="coauthors__nick people__nick">@{person.username}</span>
                  {person.public_stories > 0 && (
                    <span className="people__public">
                      {person.public_stories}{' '}
                      {plural(
                        person.public_stories,
                        'публичная история',
                        'публичные истории',
                        'публичных историй',
                      )}
                    </span>
                  )}
                </div>

                {crafts.length > 0 && (
                  <span className="coauthors__crafts">
                    {crafts.map((item) => (
                      <span key={item} className="craft-chip" title={item}>{craftShort(item)}</span>
                    ))}
                  </span>
                )}

                {bio ? (
                  <p className={isOpen ? 'people__bio muted is-open' : 'people__bio muted'}>{bio}</p>
                ) : (
                  <p className="people__bio muted">о себе пока не рассказал</p>
                )}

                {isOpen && (
                  <div className="people__details">
                    {detailFor === person.id && <p className="muted">Загружаю публичные истории…</p>}
                    {detailIssue && (
                      <p className="muted people__detail-error" role="alert">
                        <span>
                          <b>{detailIssue.title}.</b> {detailIssue.hint}
                        </span>
                        {detailIssue.retryable && (
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => void loadDetail(person)}
                          >
                            Повторить
                          </button>
                        )}
                      </p>
                    )}
                    {profile && (
                      <div className="people__stories">
                        <span className="muted">Публичные истории: {profile.stories.length}</span>
                        {profile.stories.length === 0 ? (
                          <p className="muted people__stories-empty">
                            Ничего не опубликовано: проекты человека пока закрыты.
                          </p>
                        ) : (
                          <ul className="people__story-list">
                            {profile.stories.map((story) => (
                              <li key={story.id}>
                                <Link className="people__story-link" to={`/s/${story.slug}`}>
                                  {story.title || story.slug}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="people__actions">
                <button type="button" className="secondary" onClick={() => toggle(person)}>
                  {isOpen ? 'Свернуть' : 'Подробнее'}
                </button>
                {relationControl(person)}
              </div>

              {isOpen && inviteFor?.id === person.id && (
                <div className="people__invite">
                  <InviteForm
                    person={person}
                    busy={busy === person.id}
                    onCancel={() => setInviteFor(null)}
                    onSubmit={(message, inviteCrafts) => void onInvite(person, message, inviteCrafts)}
                  />
                </div>
              )}
            </article>
          )
        })}

        {items.length > 0 && items.length < total && (
          <div className="people__more">
            <button
              type="button"
              className="secondary"
              disabled={loadingMore}
              onClick={() => void load(activeQuery, craft, items.length)}
            >
              {loadingMore ? 'Загружаю…' : `Показать ещё (${total - items.length})`}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
