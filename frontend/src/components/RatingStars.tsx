import { formatRating } from '../lib/format'

interface Props {
  /** Моя оценка (null — я ещё не голосовал) */
  mine: number | null
  /** Средняя оценка и число оценок по истории */
  avg: number
  count: number
  /** null — пользователь не может оценивать (аноним): клик ведёт на вход */
  onRate: ((stars: number) => void) | null
  /** Подпись-объяснение под звёздами (например, «автор не оценивает свою историю») */
  note?: string | null
  busy?: boolean
}

/**
 * Оценка истории звёздами 1..5.
 *
 * Одна оценка на пользователя: повторный клик по той же звезде снимает оценку,
 * по другой — заменяет. Анониму звёзды не прячем (иначе непонятно, что оценивать
 * можно), но клик ведёт на вход.
 */
export function RatingStars({ mine, avg, count, onRate, note, busy }: Props) {
  const shown = mine ?? Math.round(avg)
  const stars = [1, 2, 3, 4, 5]

  return (
    <div className="pub-rating" data-my-rating={mine ?? ''}>
      <span className="pub-rating__stars" role="group" aria-label="Оценка истории">
        {stars.map((star) => {
          const filled = star <= shown
          const isMine = mine !== null && star <= mine
          return (
            <button
              key={star}
              type="button"
              className={
                'pub-rating__star' +
                (filled ? ' is-filled' : '') +
                (isMine ? ' is-mine' : '')
              }
              disabled={busy}
              aria-label={mine === star ? `Снять оценку ${star}` : `Оценить на ${star}`}
              title={
                onRate
                  ? mine === star
                    ? 'Нажмите, чтобы снять свою оценку'
                    : `Оценить на ${star}`
                  : 'Войдите, чтобы оценить историю'
              }
              onClick={() => onRate?.(star)}
            >
              ★
            </button>
          )
        })}
      </span>
      <span className="pub-rating__value">{formatRating(avg, count)}</span>
      {note && <span className="pub-rating__note">{note}</span>}
    </div>
  )
}
