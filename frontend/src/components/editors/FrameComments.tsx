import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createComment,
  deleteComment,
  listComments,
  markCommentsSeen,
  type FrameComment,
} from '../../api/comments'
import { listMembers } from '../../api/teams'
import { useAuthStore } from '../../store/auth'
import {
  applyMention,
  matchMentionCandidates,
  mentionQueryAt,
  splitMentions,
} from '../../lib/mentions'

/**
 * Обсуждение кадра.
 *
 * Где живёт и почему так. Блок стоит под редактором выбранного кадра, а не отдельной
 * страницей: замечание возникает в момент чтения текста, и уводить человека на другую
 * вкладку за ним — значит терять замечание. Счётчики у строк дерева (их считает панель
 * редакторов) показывают, где разговор уже идёт.
 *
 * Ответы ветками (0.57.0) — ровно один уровень: «замечание — ответы на него». Ответ на
 * ответ в узкой панели под кадром превращается в лесенку отступов, где на телефоне остаётся
 * по 12 знаков на строку. Один уровень покрывает разговор двух-трёх человек; глубже
 * начинается форум, а не обсуждение кадра. Сервер это тоже проверяет — интерфейс лишь не
 * предлагает того, что сервер отвергнет.
 *
 * Удалённое замечание остаётся строкой «Комментарий удалён», а его ответы — живыми: мягкое
 * удаление сделано именно ради этого, иначе вместе со своим текстом автор уносил бы чужие
 * слова.
 *
 * Чего здесь нет намеренно:
 *   - живого обновления по сокету: обсуждение не текст проекта, и «перечитал кадр —
 *     увидел новые замечания» честно описывает происходящее;
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

/** Сколько комментариев видно: удалённые не считаются — счётчик зовёт к живому разговору. */
function liveCount(list: FrameComment[]): number {
  return list.filter((comment) => !comment.deleted).length
}

/** Кого можно упомянуть: участники проекта с ником (для подсказки после `@`). */
interface MentionCandidate {
  username: string
  displayName: string
}

/**
 * Текст с подсвеченными никами.
 *
 * Не `dangerouslySetInnerHTML`: комментарий — чужой текст, и единственный безопасный способ
 * его показать — текстовые узлы, а подсветка остаётся разметкой вокруг них.
 */
function CommentBody({ text }: { text: string }) {
  return (
    <p className="fc__body">
      {splitMentions(text).map((part, index) =>
        part.mention ? (
          <span className="fc__mention" key={index} data-frame-mention={part.text.slice(1)}>
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  )
}

/**
 * Поле ввода с подсказкой участников по `@`.
 *
 * Подсказка нужна не для красоты: ник — латиница, придуманная сервером из email (человека
 * зовут «Сергей», а ник `sergey-2`), и набирать его по памяти никто не станет. Без подсказки
 * упоминание осталось бы функцией для тех, кто помнит ники наизусть.
 */
function MentionInput({
  label,
  placeholder,
  rows,
  value,
  onChange,
  candidates,
  disabled,
  autoFocus,
}: {
  label: string
  placeholder: string
  rows: number
  value: string
  onChange: (next: string) => void
  candidates: MentionCandidate[]
  disabled?: boolean
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null)
  const suggestions = query ? matchMentionCandidates(candidates, query.query) : []
  const show = query !== null && suggestions.length > 0

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value
    onChange(next)
    setQuery(mentionQueryAt(next, event.target.selectionStart ?? next.length))
  }

  const pick = (username: string) => {
    if (!query) return
    const caret = ref.current?.selectionStart ?? value.length
    const applied = applyMention(value, query.start, caret, username)
    onChange(applied.text)
    setQuery(null)
    // Каретку ставим после вставленного ника: иначе следующий символ уедет в начало.
    requestAnimationFrame(() => {
      const field = ref.current
      if (!field) return
      field.focus()
      field.setSelectionRange(applied.caret, applied.caret)
    })
  }

  return (
    <div className="fc__field">
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && show) {
            event.stopPropagation()
            setQuery(null)
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        rows={rows}
        maxLength={4000}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {show && (
        <ul className="fc__mention-menu" data-frame-mention-menu aria-label="Участники проекта">
          {suggestions.map((candidate) => (
            <li key={candidate.username}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(candidate.username)}>
                @{candidate.username}
                {candidate.displayName && candidate.displayName !== candidate.username && (
                  <span className="muted"> — {candidate.displayName}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Ветка: корневое замечание и его ответы (только живые родители могут получать ответы). */
interface Thread {
  root: FrameComment
  replies: FrameComment[]
}

/**
 * Раскладка плоского списка в ветки.
 *
 * Порядок сохраняется как пришёл: корни по времени написания, ответы — тоже. Отдельный
 * запрос за деревом не нужен: список уже весь, и группировка — это несколько строк кода
 * против лишнего round-trip.
 *
 * Ответ, чей родитель не пришёл (кадр длинный, список обрезан лимитом), не теряется: он
 * показывается отдельной строкой с пометкой, а не пропадает молча.
 */
function buildThreads(list: FrameComment[]): { threads: Thread[]; orphans: FrameComment[] } {
  const roots: FrameComment[] = []
  const byParent = new Map<string, FrameComment[]>()
  for (const comment of list) {
    if (!comment.parentId) {
      roots.push(comment)
      continue
    }
    const bucket = byParent.get(comment.parentId)
    if (bucket) bucket.push(comment)
    else byParent.set(comment.parentId, [comment])
  }
  const threads: Thread[] = []
  const orphans: FrameComment[] = []
  const known = new Set(roots.map((root) => root.id))
  for (const root of roots) {
    threads.push({ root, replies: byParent.get(root.id) ?? [] })
  }
  for (const [parentId, replies] of byParent) {
    if (!known.has(parentId)) orphans.push(...replies)
  }
  return { threads, orphans }
}

export function FrameComments({ projectId, eventId, canEdit, onCountChange }: Props) {
  const me = useAuthStore((state) => state.user)
  const [comments, setComments] = useState<FrameComment[]>([])
  const [draft, setDraft] = useState('')
  /** Корень, на который сейчас отвечают: под ним открывается поле ответа. */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** Участники проекта для подсказки по `@` (ник живёт отдельно от имени). */
  const [candidates, setCandidates] = useState<MentionCandidate[]>([])

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
      onCountChange?.(id, liveCount(list))
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
    setReplyTo(null)
    setReplyDraft('')
    if (eventId) void load(eventId)
  }, [eventId, load])

  // Участники для подсказки по `@`: один запрос на проект, а не на кадр. Ошибку не
  // показываем — без подсказки обсуждение работает, ник можно набрать руками.
  useEffect(() => {
    let alive = true
    listMembers(projectId)
      .then((members) => {
        if (!alive) return
        setCandidates(
          members
            .filter((member) => Boolean(member.username))
            .map((member) => ({
              username: member.username as string,
              displayName: member.display_name ?? member.username ?? '',
            })),
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [projectId])

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
          onCountChange?.(eventId, liveCount(next))
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

  const sendReply = useCallback(
    async (root: FrameComment) => {
      const body = replyDraft.trim()
      if (!body || busy) return
      setBusy(true)
      setNote(null)
      try {
        const created = await createComment(projectId, eventId, body, root.id)
        setReplyDraft('')
        setReplyTo(null)
        if (created) {
          setComments((list) => {
            const next = [...list, created]
            onCountChange?.(eventId, liveCount(next))
            return next
          })
        } else {
          await load(eventId)
        }
      } catch (e) {
        setNote(
          e instanceof Error && e.message
            ? 'Не удалось ответить: ' + e.message
            : 'Не удалось отправить ответ.',
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, replyDraft, projectId, eventId, load, onCountChange],
  )

  const remove = useCallback(
    async (comment: FrameComment) => {
      setBusy(true)
      setNote(null)
      try {
        await deleteComment(projectId, comment.id)
        // Не убираем строку: сервер оставляет её «удалённой», и ответы на неё должны
        // остаться на месте. Перечитываем, чтобы порядок и счётчики пришли с сервера.
        await load(eventId)
      } catch {
        setNote('Не удалось удалить комментарий.')
      } finally {
        setBusy(false)
      }
    },
    [projectId, eventId, load],
  )

  const { threads, orphans } = useMemo(() => buildThreads(comments), [comments])
  const total = liveCount(comments)

  /** Одна строка обсуждения: корень и ответы рисуются одинаково, разница — место. */
  const row = (comment: FrameComment, isReply: boolean) => (
    <li
      key={comment.id}
      className={isReply ? 'fc__item fc__item--reply' : 'fc__item'}
      data-frame-comment-id={comment.id}
      data-frame-comment-reply={isReply ? '1' : undefined}
    >
      <div className="fc__meta">
        <span className="fc__author">
          {comment.deleted ? <em>Комментарий удалён</em> : comment.authorName || 'Участник'}
        </span>
        <span className="muted fc__stamp">{commentStamp(comment.createdAt)}</span>
        {!comment.deleted && me?.id === comment.userId && (
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
      {!comment.deleted && <CommentBody text={comment.body} />}
    </li>
  )

  return (
    <section className="fc" data-frame-comments aria-label="Обсуждение кадра">
      <div className="fc__head">
        <strong>Обсуждение</strong>
        <span className="muted fc__count" data-frame-comments-count>
          {total > 0 ? `${total}` : 'пока пусто'}
        </span>
      </div>

      {comments.length > 0 && (
        <ul className="fc__list">
          {threads.map(({ root, replies }) => (
            <li key={root.id} className="fc__thread" data-frame-thread={root.id}>
              <ul className="fc__branch">{row(root, false)}</ul>
              {replies.length > 0 && (
                <ul className="fc__replies">
                  {replies.map((reply) => row(reply, true))}
                </ul>
              )}
              {canEdit && !root.deleted && (
                <>
                  {replyTo === root.id ? (
                    <div className="fc__reply-form" data-frame-reply-form={root.id}>
                      <MentionInput
                        label="Ответ на замечание"
                        placeholder="Ответ на замечание… (ник — через @)"
                        rows={2}
                        value={replyDraft}
                        onChange={setReplyDraft}
                        candidates={candidates}
                        disabled={busy}
                        autoFocus
                      />
                      <div className="row" style={{ gap: 8 }}>
                        <button
                          type="button"
                          disabled={busy || replyDraft.trim() === ''}
                          onClick={() => void sendReply(root)}
                        >
                          {busy ? 'Отправляю…' : 'Ответить'}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setReplyTo(null)
                            setReplyDraft('')
                          }}
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="fc__reply-open"
                      disabled={busy}
                      onClick={() => {
                        setReplyTo(root.id)
                        setReplyDraft('')
                      }}
                      data-frame-reply-open={root.id}
                    >
                      Ответить
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
          {/* Ответы, чей родитель не пришёл (обрезанный список): показываем, а не теряем. */}
          {orphans.map((comment) => row(comment, true))}
        </ul>
      )}

      {canEdit ? (
        <div className="fc__form">
          <MentionInput
            label="Новый комментарий"
            placeholder="Замечание к кадру… (ник — через @)"
            rows={2}
            value={draft}
            onChange={setDraft}
            candidates={candidates}
            disabled={busy}
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
