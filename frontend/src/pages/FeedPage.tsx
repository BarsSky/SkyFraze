import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listFeed, publicAssetUrl, type FeedItem, type FeedSort } from '../api/feed'
import { ErrorBanner } from '../components/ErrorBanner'
import { useAuthStore } from '../store/auth'
import { formatDate, formatRating, formatViews } from '../lib/format'

const SORTS: Array<{ id: FeedSort; label: string; hint: string }> = [
  { id: 'new', label: 'Новые', hint: 'Сначала недавно опубликованные' },
  { id: 'rating', label: 'По оценке', hint: 'Сначала с высокой средней оценкой' },
  { id: 'views', label: 'По просмотрам', hint: 'Сначала самые читаемые' },
]

/**
 * Публичная лента: только то, что авторы сами пометили как публичное.
 *
 * Страница доступна без входа — это витрина, а не рабочий кабинет: здесь нет
 * ни редакторов, ни кнопок изменения. Единственное действие — открыть историю
 * и (для вошедших) поставить оценку на её странице.
 */
export function FeedPage() {
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
          <h2 className="feed__title">Публичные истории</h2>
          <p className="muted feed__sub">
            Таймлайны, которые авторы открыли для всех. Просмотр — без регистрации и без правок.
          </p>
        </div>
        <div className="feed__sorts" role="tablist" aria-label="Порядок ленты">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={sort === s.id}
              title={s.hint}
              className={sort === s.id ? 'feed__sort is-active' : 'feed__sort'}
              onClick={() => setSort(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {error != null && (
        <ErrorBanner
          error={error}
          what="Лента"
          onRetry={() => void load(sort)}
          actions={
            <>
              <Link className="banner__link" to="/feed">Обновить ленту</Link>
              {user && <Link className="banner__link" to="/projects">Мои проекты</Link>}
            </>
          }
        />
      )}
      {loading && <p className="muted">Загрузка…</p>}

      {!loading && error == null && items.length === 0 && (
        <div className="card feed__empty">
          <h3 style={{ marginTop: 0 }}>Пока ничего не опубликовано</h3>
          <p className="muted">
            История попадает сюда только после того, как автор нажмёт «Опубликовать» в списке проектов.
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
              <p className="feed-card__desc muted">{item.description || 'без описания'}</p>
              <div className="feed-card__meta">
                <span className="feed-card__author" title="Автор">
                  {item.author}
                </span>
                <span title="Просмотры">{formatViews(item.views)}</span>
                <span title="Оценки">★ {formatRating(item.rating_avg, item.rating_count)}</span>
                {item.published_at && <span title="Дата публикации">{formatDate(item.published_at)}</span>}
              </div>
              <Link className="feed-card__open" to={`/s/${item.slug}`}>
                Читать →
              </Link>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
