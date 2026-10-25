import { useCallback, useEffect, useState } from 'react'
import {
  createComment,
  deleteComment,
  listComments,
  markCommentsSeen,
  type FrameComment,
} from '../../api/comments'
import { useAuthStore } from '../../store/auth'

/**
 * Обсуждение кадра.
 *
 * Где живёт и почему так. Блок стоит под редактором выбранного кадра, а не отдельной
 * страницей: замечание возникает в момент чтения текста, и уводить человека на другую
 * вкладку за ним — значит терять замечание. Счётчики у строк дерева (их считает панель
 * редакторов) показывают, где разговор уже идёт.
 *
 * Чего здесь нет намеренно:
 *   - живого обновления по сокету: обсуждение не текст проекта, и «перечитал кадр —
 *     увидел новые замечания» честно описывает происходящее;
 *   - ответов ветками и упоминаний: сначала должен работать плоский разговор, иначе
 *     обсуждение превращается в отдельный продукт;
 *   - правки комментария: сказанное можно удалить (своё), но не переписать.
 */

interface Props {
  projectId: string
  eventId: string
  /** Можно ли писать: читателю проект открыт, но следов он не оставляет. */
  canEdit: boolean
  /** Сообщить панели, что счётчик кадра изменился (бейдж у строки дерева). */
  onCountChange?: (eventId: string, count: number) => void
}

/** Время комментария: коротко и по-русски — «25.10, 14:32». */
function commentStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function FrameComments({ projectId, eventId, canEdit, onCountChange }: Props) {
  const me = useAuthStore((state) => state.user)
  const [comments, setComments] = useState<FrameComment[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(
    async (id: string) => {
      let list: FrameComment[] = []
      try {
        list = await listComments(projectId, id)
      } catch {
        // Кадр могли удалить, пока он был выбран: пустое обсуждение — верный ответ,
        // а панель не должна падать из-за этого.
        list = []
      }
      setComments(list)
      onCountChange?.(id, list.length)
      // Отметка «прочитано» — отдельной попыткой и отдельным catch: её сбой не должен
      // стирать уже показанное обсуждение. Не удалось отметить — счётчик «новых»
      // просто останется, это не потеря данных.
      try {
        await markCommentsSeen(projectId, id)
      } catch {
        /* ничего: см. комментарий выше */
      }
    },
    [projectId, onCountChange],
  )

  useEffect(() => {
    setComments([])
    setNote(null)
    setDraft('')
    if (eventId) void load(eventId)
  }, [eventId, load])

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setNote(null)
    try {
      const created = await createComment(projectId, eventId, body)
      setDraft('')
      if (created) {
        setComments((list) => {
          const next = [...list, created]
          onCountChange?.(eventId, next.length)
          return next
        })
      } else {
        // Сервер ответил без записи — перечитываем, чтобы не показать ложный успех.
        await load(eventId)
      }
    } catch (e) {
      setNote(
        e instanceof Error && e.message
          ? 'Не удалось отправить: ' + e.message
          : 'Не удалось отправить комментарий.',
      )
    } finally {
      setBusy(false)
    }
  }, [busy, draft, projectId, eventId, load, onCountChange])

  const remove = useCallback(
    async (comment: FrameComment) => {
      setBusy(true)
      setNote(null)
      try {
        await deleteComment(projectId, comment.id)
        setComments((list) => {
          const next = list.filter((item) => item.id !== comment.id)
          onCountChange?.(eventId, next.length)
          return next
        })
      } catch {
        setNote('Не удалось удалить комментарий.')
      } finally {
        setBusy(false)
      }
    },
    [projectId, eventId, onCountChange],
  )

  return (
    <section className="fc" data-frame-comments aria-label="Обсуждение кадра">
      <div className="fc__head">
        <strong>Обсуждение</strong>
        <span className="muted fc__count" data-frame-comments-count>
          {comments.length > 0 ? `${comments.length}` : 'пока пусто'}
        </span>
      </div>

      {comments.length > 0 && (
        <ul className="fc__list">
          {comments.map((comment) => (
            <li key={comment.id} className="fc__item" data-frame-comment-id={comment.id}>
              <div className="fc__meta">
                <span className="fc__author">{comment.authorName || 'Участник'}</span>
                <span className="muted fc__stamp">{commentStamp(comment.createdAt)}</span>
                {me?.id === comment.userId && (
                  <button
                    type="button"
                    className="fc__remove"
                    disabled={busy}
                    onClick={() => void remove(comment)}
                    aria-label={`Удалить комментарий ${commentStamp(comment.createdAt)}`}
                    title="Удалить свой комментарий"
                  >
                    ×
                  </button>
                )}
              </div>
              <p className="fc__body">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="fc__form">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Замечание к кадру…"
            aria-label="Новый комментарий"
            rows={2}
            maxLength={4000}
          />
          <button type="button" onClick={() => void send()} disabled={busy || draft.trim() === ''}>
            {busy ? 'Отправляю…' : 'Написать'}
          </button>
        </div>
      ) : (
        <p className="muted fc__readonly">Читать обсуждение можно, писать — нет: у вас доступ на просмотр.</p>
      )}

      {note !== null && (
        <p className="fc__note" role="status" data-frame-comments-note>
          {note}
        </p>
      )}
    </section>
  )
}
