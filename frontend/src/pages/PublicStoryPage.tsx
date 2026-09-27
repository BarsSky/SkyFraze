import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { TimelineStage, type AssetLookup } from '../components/timeline/TimelineStage'
import { buildPublicDoc } from '../components/timeline/publicDoc'
import { RatingStars } from '../components/RatingStars'
import { ErrorBanner } from '../components/ErrorBanner'
import {
  getPublicStory,
  publicAssetUrl,
  rateStory,
  unrateStory,
  type PublicStory,
} from '../api/feed'
import { formatViews } from '../lib/format'
import { useAuthStore } from '../store/auth'

/**
 * Публичная страница истории: тот же сценический таймлайн, но только на чтение.
 *
 * Данные приходят одним ответом API и разворачиваются в локальный Y.Doc
 * (buildPublicDoc): realtime-сервер не подключается, ни одной ручки записи
 * страница не вызывает. Оценка — единственное действие, и только для вошедших.
 */
export function PublicStoryPage() {
  const { slug = '' } = useParams()
  const nav = useNavigate()
  const user = useAuthStore((s) => s.user)

  const [story, setStory] = useState<PublicStory | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [rating, setRating] = useState<{ mine: number | null; avg: number; count: number }>({
    mine: null,
    avg: 0,
    count: 0,
  })
  const [ratingNote, setRatingNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setStory(null)
    setMissing(false)
    setError(null)
    getPublicStory(slug)
      .then((data) => {
        if (!alive) return
        setStory(data)
        setRating({
          mine: data.my_rating ?? null,
          avg: data.story.rating_avg,
          count: data.story.rating_count,
        })
        document.title = `${data.story.title} — SkyFraze`
      })
      .catch((e) => {
        if (!alive) return
        // 404 — это не сбой, а «истории нет»: отдельное состояние без баннера.
        const status = (e as { response?: Response })?.response?.status
        if (status === 404) setMissing(true)
        else setError(e)
      })
    return () => {
      alive = false
      document.title = 'SkyFraze'
    }
  }, [slug, attempt])

  // Локальный документ только для чтения: пересобирается при загрузке истории.
  const publicDoc = useMemo(() => (story ? buildPublicDoc(story) : null), [story])

  const assetsById = useMemo<Record<string, AssetLookup>>(() => {
    const map: Record<string, AssetLookup> = {}
    for (const asset of story?.assets ?? []) {
      map[asset.id] = { url: publicAssetUrl(asset.id), mime: asset.mime }
    }
    return map
  }, [story])

  const onRate = useCallback(
    (stars: number) => {
      if (!user) {
        nav('/login')
        return
      }
      const remove = rating.mine === stars
      setBusy(true)
      setRatingNote(null)
      const request = remove ? unrateStory(slug) : rateStory(slug, stars)
      request
        .then((res) => {
          setRating({ mine: res.my_rating, avg: res.rating_avg, count: res.rating_count })
          setRatingNote(remove ? 'оценка снята' : 'спасибо, оценка учтена')
        })
        .catch((e) => {
          const status = (e as { response?: Response })?.response?.status
          if (status === 403) setRatingNote('автор не оценивает свою историю')
          else if (status === 401) setRatingNote('нужно войти, чтобы оценить')
          else setRatingNote('не удалось сохранить оценку')
        })
        .finally(() => setBusy(false))
    },
    [nav, rating.mine, slug, user],
  )

  if (missing) {
    return (
      <div className="feed">
        <div className="card feed__empty">
          <h3 style={{ marginTop: 0 }}>История не найдена</h3>
          <p className="muted">
            Она снята с публикации или ссылка неверна. Публичными видны только истории,
            которые автор явно открыл.
          </p>
          <div className="banner__actions">
            <Link to="/feed">
              <button type="button">← В ленту</button>
            </Link>
            {user && (
              <Link to="/projects">
                <button type="button" className="secondary">Мои проекты</button>
              </Link>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="feed">
        <ErrorBanner
          error={error}
          what="История"
          onRetry={() => setAttempt((n) => n + 1)}
          actions={
            <>
              <Link className="banner__link" to="/feed">← В ленту</Link>
              {user && <Link className="banner__link" to="/projects">Мои проекты</Link>}
            </>
          }
        />
        <p className="muted">
          Пока страница не открылась, можно посмотреть <Link to="/feed">другие публичные истории</Link>.
        </p>
      </div>
    )
  }

  if (!story || !publicDoc) return <p className="muted">Загрузка истории…</p>

  const item = story.story

  return (
    <div className="sf-page">
      <TimelineStage
        events={publicDoc.events}
        assetsById={assetsById}
        projectTitle={item.title}
        actions={
          <Link className="sf-btn sf-btn--ghost pub-back" to="/feed">
            ← Лента
          </Link>
        }
        copyFooter={
          <div className="pub-meta">
            <div className="pub-meta__line">
              <span className="pub-meta__author" title="Автор">
                {item.author}
              </span>
              <span className="pub-meta__views" title="Просмотры">
                {formatViews(item.views)}
              </span>
            </div>
            <RatingStars
              mine={rating.mine}
              avg={rating.avg}
              count={rating.count}
              onRate={onRate}
              note={ratingNote ?? (user ? null : 'войдите, чтобы оценить')}
              busy={busy}
            />
          </div>
        }
      />
    </div>
  )
}
