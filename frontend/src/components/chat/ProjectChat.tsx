import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { editChat, listChat, markChatSeen, postChat, type ChatBotInfo, type ChatMessage } from '../../api/chat'
import { listEventRows } from '../../api/events'
import { serverErrorMessage } from '../../api/client'
import { onChatChanged } from '../../lib/chatEvents'
import { useAuthStore } from '../../store/auth'

/**
 * «Чат проекта» — общий разговор участников (0.95.0).
 *
 * Почему отдельный чат, а не замечания к кадру. Замечание живёт в блоке кадра и говорит о
 * фрагменте текста; «обсудить идею, спросить коллегу, позвать Нестора на разбор» — это разговор
 * один на проект. Поэтому чат стоит рядом с окном помощника (две вкладки в одном плавающем окне),
 * и в нём есть то, чего нет у замечаний: можно приложить ссылку на кадр (и точную фразу из него) и
 * позвать Нестора, не уходя с обсуждения.
 *
 * Реальное время — опросом: сообщения спрашиваются «после последнего известного» раз в несколько
 * секунд. Отдельный WebSocket ради чата не нужен и добавил бы второй канал состояния к уже
 * существующему collaborативному; задержка в пару секунд для обсуждения незаметна.
 */
interface Props {
  projectId: string
  /** Открыта ли вкладка чата: пока закрыта — только опрос ради маркера «есть новое». */
  visible: boolean
  /** Открыть кадр в редакторах (ссылка из сообщения). */
  onOpenFrame?: (frameId: string) => void
  /** Сколько пришло, пока вкладка была закрыта. */
  onUnread?: (count: number) => void
}

/** Ключ «последнее прочитанное» — в localStorage: он личный и переживает перезагрузку. */
function seenKey(projectId: string): string {
  return `sf-chat-seen:${projectId}`
}

function readSeen(projectId: string): string {
  try {
    return localStorage.getItem(seenKey(projectId)) ?? ''
  } catch {
    return ''
  }
}

function writeSeen(projectId: string, id: string): void {
  try {
    localStorage.setItem(seenKey(projectId), id)
  } catch {
    // Приватный режим/переполнение: «прочитано» — удобство, не критично.
  }
}

function timeOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

export function ProjectChat({ projectId, visible, onOpenFrame, onUnread }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [bot, setBot] = useState<ChatBotInfo>({ name: 'Нестор', available: false })
  const [text, setText] = useState('')
  const [askBot, setAskBot] = useState(false)
  const [linkId, setLinkId] = useState('')
  const [quote, setQuote] = useState('')
  const [frames, setFrames] = useState<Array<{ id: string; title: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Ответ на сообщение (0.96.0): кому и на что. */
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  /** Сообщение, которое прямо сейчас правят, и черновик его текста. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const listRef = useRef<HTMLUListElement | null>(null)
  const lastIdRef = useRef('')
  /** Кто я: «изменить» показываем только у своих сообщений. */
  const currentUserId = useAuthStore((state) => state.user?.id ?? null)

  const titles = useMemo(() => {
    const map = new Map<string, string>()
    for (const frame of frames ?? []) map.set(frame.id, frame.title)
    return map
  }, [frames])

  /** Догрузить новое (или всё, если ещё ничего не знаем). */
  const load = useCallback(async () => {
    try {
      const page = await listChat(projectId, lastIdRef.current || undefined)
      setBot(page.bot)
      if (page.messages.length > 0) {
        setMessages((current) => {
          const seen = new Set(current.map((item) => item.id))
          const fresh = page.messages.filter((item) => !seen.has(item.id))
          if (fresh.length === 0) return current
          return [...current, ...fresh]
        })
        lastIdRef.current = page.messages[page.messages.length - 1].id
      }
      setError(null)
    } catch {
      setError('Чат не загрузился — проверьте доступ к проекту.')
    }
  }, [projectId])

  // Первая загрузка и «страховочный» опрос. Мгновенную доставку даёт сокет проекта (0.96.0):
  // он присылает сигнал, и мы сразу спрашиваем новое. Опрос остаётся редким — на случай, когда
  // сокет недоступен или вкладка была в фоне.
  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), visible ? 20_000 : 30_000)
    return () => window.clearInterval(interval)
  }, [load, visible])

  // Сигнал из сокета: сообщение появилось — забираем сразу, не ожидая опроса.
  useEffect(() => onChatChanged(projectId, () => void load()), [load, projectId])

  // Кадры для привязки — один раз при открытии вкладки: список меняется редко, а выбор нужен
  // только в момент написания.
  useEffect(() => {
    if (!visible || frames !== null) return
    let alive = true
    listEventRows(projectId)
      .then((rows) => {
        if (alive) setFrames(rows.map((row) => ({ id: row.id, title: row.title || 'без названия' })))
      })
      .catch(() => {
        if (alive) setFrames([])
      })
    return () => {
      alive = false
    }
  }, [frames, projectId, visible])

  // Прочитано: вкладка открыта — отмечаем последнее сообщение и гасим маркер.
  //
  // Отметка живёт в двух местах: локально (мгновенный маркер на кнопке) и на сервере (0.97.0) —
  // колокольчик в шапке считает «где меня ждут» по всем проектам, и про другой браузер он иначе
  // не знал бы. Ошибку сервера не показываем: «прочитано» — удобство, а не данные проекта.
  useEffect(() => {
    if (!visible) return
    const last = messages[messages.length - 1]
    if (last) writeSeen(projectId, last.id)
    onUnread?.(0)
    void markChatSeen(projectId).catch(() => undefined)
  }, [messages, onUnread, projectId, visible])

  // Маркер непрочитанного: считаем сообщения после личного «последнего прочитанного».
  useEffect(() => {
    if (visible) return
    const marker = messages.filter((item) => item.kind === 'user').map((item) => item.id)
    if (marker.length === 0) return
    const seen = readSeen(projectId)
    if (!seen) return
    const index = messages.findIndex((item) => item.id === seen)
    const unread = index >= 0 ? messages.length - index - 1 : messages.length
    onUnread?.(Math.max(0, unread))
  }, [messages, onUnread, projectId, visible])

  // Прокрутка к свежему сообщению — только если человек уже был внизу (иначе выдёргиваем из чтения).
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [messages.length, visible])

  /** Сохранить правку своего сообщения: обновляем строку на месте, без перечитывания ленты. */
  const saveEdit = useCallback(
    async (id: string) => {
      if (!editing || editing.text.trim() === '') return
      setEditBusy(true)
      setError(null)
      try {
        const updated = await editChat(projectId, id, editing.text)
        setMessages((current) => current.map((item) => (item.id === updated.id ? updated : item)))
        setEditing(null)
      } catch (e) {
        setError(await explain(e))
      } finally {
        setEditBusy(false)
      }
    },
    [editing, projectId],
  )

  const send = useCallback(async () => {
    const body = text.trim()
    if (body === '' || busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await postChat(projectId, {
        body,
        eventId: linkId || undefined,
        quote: quote.trim() || undefined,
        askBot,
        replyTo: replyTo?.id,
      })
      const added = result.reply ? [result.message, result.reply] : [result.message]
      setMessages((current) => [...current, ...added])
      lastIdRef.current = added[added.length - 1].id
      setText('')
      setReplyTo(null)
      if (result.note) setNote(result.note)
    } catch (e) {
      setError(await explain(e))
    } finally {
      setBusy(false)
    }
  }, [askBot, busy, linkId, projectId, quote, replyTo, text])

  return (
    <div className="chat" data-project-chat>
      <div className="chat__head">
        <strong>Чат проекта</strong>
        <span className="muted chat__hint">видят все участники</span>
      </div>

      <ul className="chat__list" ref={listRef} data-chat-list>
        {messages.length === 0 && (
          <li className="chat__empty muted">
            Пока тихо. Напишите первым или позовите {bot.name} на разбор.
          </li>
        )}
        {messages.map((message) => {
          const quoted = message.reply_to
            ? messages.find((item) => item.id === message.reply_to)
            : undefined
          const mine = currentUserId !== null && message.author_id === currentUserId
          const isEditing = editing?.id === message.id
          return (
          <li
            key={message.id}
            className={message.kind === 'bot' ? 'chat__item chat__item--bot' : 'chat__item'}
            data-chat-message={message.id}
            data-chat-kind={message.kind}
          >
            <div className="chat__meta">
              <span className="chat__author">{message.author_name}</span>
              <span className="muted chat__time">{timeOf(message.created_at)}</span>
              {message.edited_at !== undefined && (
                <span
                  className="muted chat__edited"
                  title={`Изменено в ${timeOf(message.edited_at)}`}
                  data-chat-edited
                >
                  изменено
                </span>
              )}
            </div>
            {message.reply_to !== undefined && (
              <p className="chat__quote-line" data-chat-reply={message.reply_to}>
                {quoted
                  ? `→ ${quoted.author_name}: ${quoted.body.slice(0, 80)}${quoted.body.length > 80 ? '…' : ''}`
                  : '→ сообщение, на которое отвечали, удалено'}
              </p>
            )}
            {isEditing ? (
              <div className="chat__edit">
                <textarea
                  value={editing.text}
                  rows={2}
                  aria-label={`Изменить сообщение ${message.author_name}`}
                  onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                />
                <div className="chat__actions">
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>
                    отмена
                  </button>
                  <button
                    type="button"
                    disabled={editBusy || editing.text.trim() === ''}
                    onClick={() => void saveEdit(message.id)}
                    data-chat-edit-save
                  >
                    сохранить
                  </button>
                </div>
              </div>
            ) : (
              <p className="chat__body">{message.body}</p>
            )}
            {message.event_id !== undefined && (
              <button
                type="button"
                className="chat__link"
                onClick={() => onOpenFrame?.(message.event_id as string)}
                title={message.quote ? `Открыть кадр: «${message.quote}»` : 'Открыть кадр'}
                data-chat-link={message.event_id}
              >
                к кадру{message.quote ? `: «${message.quote}»` : ` «${titles.get(message.event_id) ?? 'кадр удалён'}»`}
              </button>
            )}
            {!isEditing && (
              <div className="chat__item-actions">
                <button
                  type="button"
                  className="chat__mini"
                  aria-label="ответить"
                  title={`Ответить ${message.author_name}`}
                  onClick={() => setReplyTo(message)}
                  data-chat-reply-button={message.id}
                >
                  <span aria-hidden="true">↩</span> ответить
                </button>
                {mine && message.kind === 'user' && (
                  <button
                    type="button"
                    className="chat__mini"
                    // Не «удалить», а «изменить» (0.97.1): правка своего — то, что нужно в
                    // обсуждении, а удаление ломало бы цитаты ответов и смысл разговора.
                    aria-label="изменить"
                    title="Исправить текст своего сообщения — с отметкой «изменено»"
                    onClick={() => setEditing({ id: message.id, text: message.body })}
                    data-chat-edit={message.id}
                  >
                    <span aria-hidden="true">✎</span> изменить
                  </button>
                )}
              </div>
            )}
          </li>
          )
        })}
      </ul>

      {note !== null && <p className="muted chat__note" data-chat-note>{note}</p>}
      {error !== null && <p className="ed-danger chat__note">{error}</p>}

      <div className="chat__composer">
        {replyTo !== null && (
          <div className="chat__reply-chip" data-chat-reply-chip>
            <span>
              ответ {replyTo.author_name}: {replyTo.body.slice(0, 60)}
              {replyTo.body.length > 60 ? '…' : ''}
            </span>
            <button type="button" className="secondary" onClick={() => setReplyTo(null)}>
              отменить
            </button>
          </div>
        )}
        <textarea
          className="chat__input"
          value={text}
          rows={2}
          placeholder={`Сообщение участникам… ${bot.available ? '@' + bot.name + ' в тексте — позвать бота.' : ''}`}
          aria-label="Сообщение в чат проекта"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void send()
            }
          }}
        />

        <div className="chat__attach">
          <label>
            <span className="muted">кадр</span>
            <select
              value={linkId}
              aria-label="Приложить кадр"
              onChange={(event) => setLinkId(event.target.value)}
              data-chat-frame
            >
              <option value="">без ссылки</option>
              {(frames ?? []).map((frame) => (
                <option key={frame.id} value={frame.id}>{frame.title}</option>
              ))}
            </select>
          </label>
          {linkId !== '' && (
            <label className="chat__quote">
              <span className="muted">фраза</span>
              <input
                value={quote}
                placeholder="точная фраза из кадра (необязательно)"
                aria-label="Фраза из кадра"
                onChange={(event) => setQuote(event.target.value)}
              />
            </label>
          )}
        </div>

        <div className="chat__actions">
          {bot.available && (
            <button
              type="button"
              className={askBot ? undefined : 'secondary'}
              aria-pressed={askBot}
              title={`${bot.name} ответит в чате — разбор, а не правка: проект он не меняет`}
              onClick={() => setAskBot((value) => !value)}
              data-chat-ask-bot
            >
              {askBot ? `${bot.name} ответит` : 'спросить бота'}
            </button>
          )}
          <button type="button" onClick={() => void send()} disabled={busy || text.trim() === ''} data-chat-send>
            {busy ? 'Отправляю…' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  )
}

async function explain(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error)
  // Сервер объясняет отказы своими словами («такой фразы в тексте кадра нет»), и это полезнее
  // кода состояния; ky кладёт тело в response, поэтому читаем его через общий помощник.
  return (await serverErrorMessage(error)) ?? message ?? 'Не удалось отправить сообщение.'
}
