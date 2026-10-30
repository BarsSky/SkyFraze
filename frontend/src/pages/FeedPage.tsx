import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listFeed, publicAssetUrl, type FeedItem, type FeedSort } from '../api/feed'
import { ErrorBanner } from '../components/ErrorBanner'
import { useAuthStore } from '../store/auth'
import { formatDate, formatRating, formatViews } from '../lib/format'
import { useT, type Key } from '../i18n'
import { useLang } from '../store/lang'

const SORTS: Array<{ id: FeedSort; labelKey: Key; hintKey: Key }> = [
  { id: 'new', labelKey: 'feed.sortNew', hintKey: 'feed.sortNewHint' },
  { id: 'rating', labelKey: 'feed.sortRating', hintKey: 'feed.sortRatingHint' },
  { id: 'views', labelKey: 'feed.sortViews', hintKey: 'feed.sortViewsHint' },
]

/**
 * Публичная лента: только то, что авторы сами пометили как публичное.
 *
 * Страница доступна без входа — это витрина, а не рабочий кабинет: здесь нет
 * ни редакторов, ни кнопок изменения. Единственное действие — открыть историю
 * и (для вошедших) поставить оценку на её странице.
 */
export function FeedPage() {
  const t = useT()
  const [lang] = useLang()
  const [items, setItems] = useState<FeedItem[]>([])
  const [sort, setSort] = useState<FeedSort>('new')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const user = useAuthStore((s) => s.user)

  const load = useCallback(async (next: FeedSort) => {
    setLoading(true)
    setError(null)
    try {
      const res = await listFeed(next)
      setItems(res.items)
    } catch (e) {
      setError(e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(sort)
  }, [load, sort])

  return (
    <div className="feed">
      <div className="feed__head">
        <div>
          <h2 className="feed__title">{t('feed.title')}</h2>
          <p className="muted feed__sub">
            {t('feed.sub')}
          </p>
        </div>
        <div className="feed__sorts" role="tablist" aria-label={t('feed.sortsAria')}>
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={sort === s.id}
              title={t(s.hintKey)}
              className={sort === s.id ? 'feed__sort is-active' : 'feed__sort'}
              onClick={() => setSort(s.id)}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {error != null && (
        <ErrorBanner
          error={error}
          what={t('feed.what')}
          onRetry={() => void load(sort)}
          actions={
            <>
              <Link className="banner__link" to="/feed">{t('feed.refresh')}</Link>
              {user && <Link className="banner__link" to="/projects">{t('feed.myProjects')}</Link>}
            </>
          }
        />
      )}
      {loading && <p className="muted">{t('feed.loading')}</p>}

      {!loading && error == null && items.length === 0 && (
        <div className="card feed__empty">
          <h3 style={{ marginTop: 0 }}>{t('feed.emptyTitle')}</h3>
          <p className="muted">
            {t('feed.emptyHint')}
          </p>
        </div>
      )}

      <div className="feed__grid">
        {items.map((item) => (
          <article className="feed-card" key={item.id}>
            <Link className="feed-card__cover" to={`/s/${item.slug}`} aria-label={item.title}>
              {item.cover_asset_id ? (
                <img src={publicAssetUrl(item.cover_asset_id)} alt="" loading="lazy" />
              ) : (
                <span className="feed-card__placeholder" aria-hidden>
                  {item.title.slice(0, 1).toUpperCase()}
                </span>
              )}
            </Link>
            <div className="feed-card__body">
              <h3 className="feed-card__title">
                <Link to={`/s/${item.slug}`}>{item.title}</Link>
              </h3>
              <p className="feed-card__desc muted">{item.description || t('feed.noDesc')}</p>
              <div className="feed-card__meta">
                <span className="feed-card__author" title={t('feed.author')}>
                  {item.author}
                </span>
                <span title={t('feed.views')}>{formatViews(item.views, lang)}</span>
                <span title={t('feed.ratings')}>
                  ★ {formatRating(item.rating_avg, item.rating_count, lang)}
                </span>
                {item.published_at && (
                  <span title={t('feed.published')}>{formatDate(item.published_at)}</span>
                )}
              </div>
              <Link className="feed-card__open" to={`/s/${item.slug}`}>
                {t('feed.read')}
              </Link>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
