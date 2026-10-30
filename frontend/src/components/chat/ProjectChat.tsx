import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tStatic, useT, type Key } from '../../i18n'
import { useLang } from '../../store/lang'
import {
  editChat,
  listChat,
  markChatSeen,
  postChat,
  toggleChatReaction,
  type ChatBotInfo,
  type ChatMessage,
  type ChatReactionKind,
  type ChatReactions,
} from '../../api/chat'
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
/** Цитата из показа проекта: её просят вставить в поле ввода (0.132.0). */
export interface DockPrefill {
  /** Вкладка, на которую надо переключиться. */
  tab: 'assistant' | 'chat'
  /** Меняется на каждое выделение: по нему панель понимает, что цитата новая. */
  nonce: number
  frameId: string
  frameTitle: string
  quote: string
}

interface Props {
  projectId: string
  /** Открыта ли вкладка чата: пока закрыта — только опрос ради маркера «есть новое». */
  visible: boolean
  /**
   * Открыть кадр по ссылке из сообщения (0.95.0; фраза — 0.133.0).
   *
   * Второй аргумент — цитата: получатель должен увидеть то самое место в показе проекта, а не
   * искать его глазами в кадре.
   */
  onOpenFrame?: (frameId: string, quote?: string) => void
  /** Сколько пришло, пока вкладка была закрыта. */
  onUnread?: (count: number) => void
  /**
   * Выделенный в проекте фрагмент: поле ввода заполняется цитатой и ссылкой на кадр (0.132.0).
   *
   * Ссылка — не «голая» строка в тексте: сообщение несёт `event_id` и точную фразу, поэтому
   * участник нажимает на неё и попадает в тот же кадр. Цитата при этом остаётся в тексте —
   * разговор читается и без перехода.
   */
  prefill?: DockPrefill | null
}

/** Ключ «последнее прочитанное» — в localStorage: он личный и переживает перезагрузку. */
function seenKey(projectId: string): string {
  return `sf-chat-seen:${projectId}`
}

/**
 * Отметки на сообщении (0.98.0): три вида, как у реакций на замечания.
 *
 * Короткая подпись на плашке («сделать») и полная в подсказке и для скринридера («надо сделать»):
 * в строке сообщения три длинных подписи не помещаются, но человек должен понимать, что нажимает.
 */
const REACTIONS: Array<{ kind: ChatReactionKind; labelKey: Key; fullKey: Key }> = [
  { kind: 'agree', labelKey: 'chat.reactionAgree', fullKey: 'chat.reactionAgree' },
  { kind: 'todo', labelKey: 'chat.reactionTodo', fullKey: 'chat.reactionTodoFull' },
  { kind: 'question', labelKey: 'chat.reactionQuestion', fullKey: 'chat.reactionQuestion' },
]

/**
 * Размер страницы истории (0.99.2).
 *
 * Совпадает с серверным `defaultLimit` (100): окно открывается одной страницей, а кнопка «показать
 * прежние» листает назад такими же страницами. Если сервер отдал меньше — история кончилась, и
 * кнопка пропадает: иначе она «крутилась» бы на пустых страницах.
 */
const PAGE_SIZE = 100

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

export function ProjectChat({ projectId, visible, onOpenFrame, onUnread, prefill }: Props) {
  const t = useT()
  const [lang] = useLang()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [bot, setBot] = useState<ChatBotInfo>({ name: t('chat.botName'), available: false })
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
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
  /** Какая плашка отметки сейчас в запросе (`сообщение:вид`) — защита от двойного нажатия. */
  const [reactionBusy, setReactionBusy] = useState<string | null>(null)

  // Цитата из показа проекта: заполняем поле и ссылку на кадр, но НЕ отправляем — человек
  // дописывает мысль сам. Автоотправка была бы решением за него.
  useEffect(() => {
    if (!prefill || prefill.tab !== 'chat') return
    setText(t('sel.chatPrefill', { quote: prefill.quote, frame: prefill.frameTitle }))
    setLinkId(prefill.frameId)
    setQuote(prefill.quote)
    requestAnimationFrame(() => inputRef.current?.focus())
    // Зависимость — только nonce: перерисовка по другим причинам не должна перезаписывать
    // то, что человек уже начал печатать.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce])
  /**
   * Есть ли в истории сообщения ДО показанных (0.99.2).
   *
   * `null` — ещё не знаем: первая загрузка не отвечает на этот вопрос, если пришло меньше лимита
   * (значит, показано всё). Дальше `true` — кнопка «показать прежние» видна, `false` — история
   * кончилась.
   */
  const [hasOlder, setHasOlder] = useState<boolean | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  /** Не прокручивать вниз после подгрузки прежних сообщений (см. эффект прокрутки). */
  const skipAutoScroll = useRef(false)
  const listRef = useRef<HTMLUListElement | null>(null)
  const lastIdRef = useRef('')
  /** Номер последней запущенной перезагрузки ленты (0.140.0). */
  const pageSeq = useRef(0)
  /** Номер последней ПРИМЕНЁННОЙ перезагрузки: ответ применяем, только если он свежее. */
  const appliedSeq = useRef(0)
  /** Кто я: «изменить» показываем только у своих сообщений. */
  const currentUserId = useAuthStore((state) => state.user?.id ?? null)

  const titles = useMemo(() => {
    const map = new Map<string, string>()
    for (const frame of frames ?? []) map.set(frame.id, frame.title)
    return map
  }, [frames])

  /** Догрузить новое (или всё, если ещё ничего не знаем).
   *
   * `reload` (0.98.0) — перечитать страницу целиком. Нужен из-за отметок: они меняют УЖЕ
   * показанные сообщения, а не добавляют строки, поэтому догрузка «после последнего» их не увидит.
   * Сигнал из сокета приходит на любое изменение ленты (новое сообщение, правка, отметка), и по
   * нему дешевле перечитать страницу, чем поддерживать отдельный канал «что именно изменилось».
   */
  const load = useCallback(async (mode: 'append' | 'reload' = 'append') => {
    // Номер перезагрузки: применяется ответ, который СВЕЖЕЕ применённого (0.140.0).
    //
    // До этого ответы применялись в порядке прихода, и быстрая пачка сообщений (e2e присылает
    // 101 подряд, каждое — сигнал из сокета) давала гонку: страница, прочитанная, когда сообщений
    // было меньше сотни, приезжала ПОСЛЕ полной и снимала «показать прежние». Сценарий `chat`
    // падал именно на этом.
    //
    // Сравнение с ПРИМЕНЁННЫМ, а не с последним запущенным, — намеренно: если самый свежий запрос
    // не дошёл (прокси оборвал, вкладка в фоне), его ответа не будет вовсе, и хороший предыдущий
    // применять всё равно нужно. Иначе одна упавшая перезагрузка оставляла ленту без «есть ещё».
    const seq = mode === 'reload' ? ++pageSeq.current : pageSeq.current
    try {
      const initial = lastIdRef.current === ''
      const page = await listChat(projectId, mode === 'reload' ? {} : { after: lastIdRef.current || undefined })
      setBot(page.bot)
      if (mode === 'reload') {
        // Замену ленты делает только ответ свежее применённого: устаревший молчит целиком.
        if (seq <= appliedSeq.current) return
        appliedSeq.current = seq
        setMessages(page.messages)
        lastIdRef.current =
          page.messages.length > 0 ? page.messages[page.messages.length - 1].id : ''
        // Признак «есть прежние» этот ответ может поставить, но не снять (0.140.2).
        //
        // Снять его вправе только `loadOlder` — то есть ответ, который ТОЧНО видел конец
        // истории. Иначе кнопка пропадала насовсем: пока приложение присылает сообщения пачкой,
        // любая перезагрузка, прочитавшая неполную страницу (сообщений ещё меньше сотни),
        // выключала «показать прежние», и вернуть её было некому. Именно так `chat.spec` и
        // падал — 101 сообщение в ленте, а кнопки нет.
        setHasOlder((current) => page.messages.length >= PAGE_SIZE || current === true)
      } else if (page.messages.length > 0) {
        setMessages((current) => {
          const seen = new Set(current.map((item) => item.id))
          const fresh = page.messages.filter((item) => !seen.has(item.id))
          if (fresh.length === 0) return current
          return [...current, ...fresh]
        })
        // Догрузка новых — дополнение, а не замена: свой ответ не отменяет чужой. Признак «есть
        // прежние» она может только ПОСТАВИТЬ (страница полная), но не снять: снять его вправе
        // лишь тот ответ, который видел конец истории, — иначе мимолётная неполная страница
        // (сообщений ещё меньше сотни) прятала кнопку навсегда.
        if (seq >= appliedSeq.current) {
          lastIdRef.current = page.messages[page.messages.length - 1].id
          if (initial) {
            setHasOlder((current) => page.messages.length >= PAGE_SIZE || current === true)
          }
        }
      }
      setError(null)
    } catch {
      setError(tStatic('chat.errLoad'))
    }
  }, [projectId])

  /**
   * Листнуть назад (0.99.2): «показать прежние».
   *
   * Отдельная функция, а не режим `load`: у неё другое направление — страница ДОБАВЛЯЕТСЯ СВЕРХУ,
   * и прокрутку после этого двигать нельзя (иначе человека выбрасывает в конец, откуда он только
   * что ушёл). `skipAutoScroll` гасит единственный эффект, который прокручивает ленту вниз.
   */
  const loadOlder = useCallback(async () => {
    if (loadingOlder) return
    const first = messages[0]
    if (!first) return
    setLoadingOlder(true)
    try {
      const page = await listChat(projectId, { before: first.id })
      if (page.messages.length === 0) {
        setHasOlder(false)
        return
      }
      skipAutoScroll.current = true
      setMessages((current) => {
        const seen = new Set(current.map((item) => item.id))
        const older = page.messages.filter((item) => !seen.has(item.id))
        return [...older, ...current]
      })
      setHasOlder(page.messages.length >= PAGE_SIZE)
      setError(null)
    } catch {
      setError(tStatic('chat.errOlder'))
    } finally {
      setLoadingOlder(false)
    }
  }, [loadingOlder, messages, projectId])

  // Первая загрузка и «страховочный» опрос. Мгновенную доставку даёт сокет проекта (0.96.0):
  // он присылает сигнал, и мы сразу спрашиваем новое. Опрос остаётся редким — на случай, когда
  // сокет недоступен или вкладка была в фоне.
  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), visible ? 20_000 : 30_000)
    return () => window.clearInterval(interval)
  }, [load, visible])

  // Сигнал из сокета: лента изменилась (новое сообщение, правка, отметка) — перечитываем страницу
  // целиком, не ожидая опроса. Именно перечитываем, а не догружаем: отметка меняет уже показанные
  // сообщения, и «после последнего» её не увидело бы.
  useEffect(() => onChatChanged(projectId, () => void load('reload')), [load, projectId])

  // Кадры для привязки — один раз при открытии вкладки: список меняется редко, а выбор нужен
  // только в момент написания.
  useEffect(() => {
    if (!visible || frames !== null) return
    let alive = true
    listEventRows(projectId)
      .then((rows) => {
        if (alive)
      setFrames(rows.map((row) => ({ id: row.id, title: row.title || tStatic('chat.untitledFrame') })))
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
  //
  // `skipAutoScroll` (0.99.2): после «показать прежние» сообщений стало больше, но прокручивать
  // вниз нельзя — человек как раз читает старое сверху, и прыжок в конец выбросил бы его оттуда.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    if (skipAutoScroll.current) {
      skipAutoScroll.current = false
      return
    }
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

  /**
   * Поставить или снять отметку (0.98.0).
   *
   * Ответ сервера — отметки сообщения целиком, поэтому строку обновляем по нему, а не перечитываем
   * всю ленту: нажатие должно отвечать сразу. Пока запрос идёт, повторное нажатие по той же плашке
   * игнорируется — иначе два быстрых клика дали бы «поставить и снять» в непредсказуемом порядке.
   */
  const toggleReaction = useCallback(
    async (messageId: string, kind: ChatReactionKind) => {
      const key = `${messageId}:${kind}`
      if (reactionBusy === key) return
      setReactionBusy(key)
      try {
        const reactions: ChatReactions = await toggleChatReaction(projectId, messageId, kind)
        setMessages((current) =>
          current.map((item) => (item.id === messageId ? { ...item, reactions } : item)),
        )
        setError(null)
      } catch (e) {
        setError(await explain(e))
      } finally {
        setReactionBusy(null)
      }
    },
    [projectId, reactionBusy],
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
        <strong>{t('chat.title')}</strong>
        <span className="muted chat__hint">{t('chat.hint')}</span>
      </div>

      <ul className="chat__list" ref={listRef} data-chat-list>
        {/* «Показать прежние» (0.99.2): сверху ленты, а не снизу — история листается назад.
            Кнопка одна и исчезает, когда сервер отдал неполную страницу: «ещё» больше нет. */}
        {hasOlder === true && (
          <li className="chat__older">
            <button
              type="button"
              className="chat__mini"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              data-chat-older
            >
              {loadingOlder ? t('chat.loadingOlder') : t('chat.showOlder')}
            </button>
          </li>
        )}
        {messages.length === 0 && (
          <li className="chat__empty muted">
            {t('chat.silent', { bot: bot.name })}
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
                  title={t('chat.editedTitle', { time: timeOf(message.edited_at) })}
                  data-chat-edited
                >
                  {t('chat.edited')}
                </span>
              )}
            </div>
            {message.reply_to !== undefined && (
              <p className="chat__quote-line" data-chat-reply={message.reply_to}>
                {quoted
                  ? `→ ${quoted.author_name}: ${quoted.body.slice(0, 80)}${quoted.body.length > 80 ? '…' : ''}`
                  : t('chat.replyDeleted')}
              </p>
            )}
            {isEditing ? (
              <div className="chat__edit">
                <textarea
                  value={editing.text}
                  rows={2}
                  aria-label={t('chat.editAria', { author: message.author_name })}
                  onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                />
                <div className="chat__actions">
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>
                    {t('chat.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={editBusy || editing.text.trim() === ''}
                    onClick={() => void saveEdit(message.id)}
                    data-chat-edit-save
                  >
                    {t('chat.save')}
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
                onClick={() => onOpenFrame?.(message.event_id as string, message.quote)}
                title={
                  message.quote ? t('chat.toFrameTitle', { quote: message.quote }) : t('chat.toFrame')
                }
                data-chat-link={message.event_id}
              >
                {message.quote
                  ? t('chat.toFrameQuote', { quote: message.quote })
                  : t('chat.toFrameNamed', {
                      title: titles.get(message.event_id) ?? t('chat.frameDeleted'),
                    })}
              </button>
            )}
            {/* Отметки (0.98.0): три рабочие, как у реакций на замечания. Показываем все три всегда —
                счётчик у нуля может не быть, а «а что тут можно нажать» человек должен видеть. */}
            {!isEditing && (
              <div className="chat__reactions" data-chat-reactions={message.id}>
                {REACTIONS.map((reaction) => {
                  const count = message.reactions?.[reaction.kind] ?? 0
                  const active = message.reactions?.mine?.includes(reaction.kind) === true
                  const busyThis = reactionBusy === `${message.id}:${reaction.kind}`
                  return (
                    <button
                      key={reaction.kind}
                      type="button"
                      className={active ? 'chat__reaction is-on' : 'chat__reaction'}
                      aria-pressed={active}
                      aria-label={
                        count > 0 ? `${t(reaction.fullKey)}: ${count}` : t(reaction.fullKey)
                      }
                      title={
                        active
                          ? t('chat.markOff', { label: t(reaction.fullKey) })
                           : t('chat.markOn', { label: t(reaction.fullKey) })
                      }
                      disabled={busyThis}
                      onClick={() => void toggleReaction(message.id, reaction.kind)}
                      data-chat-reaction={`${message.id}:${reaction.kind}`}
                    >
                      {t(reaction.labelKey)}
                      {count > 0 && <span className="chat__reaction-count">{count}</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {!isEditing && (
              <div className="chat__item-actions">
                <button
                  type="button"
                  className="chat__mini"
                  aria-label={t('chat.replyAria')}
                  title={t('chat.replyTitle', { author: message.author_name })}
                  onClick={() => setReplyTo(message)}
                  data-chat-reply-button={message.id}
                >
                  <span aria-hidden="true">↩</span> {t('chat.reply')}
                </button>
                {mine && message.kind === 'user' && (
                  <button
                    type="button"
                    className="chat__mini"
                    // Не «удалить», а «изменить» (0.97.1): правка своего — то, что нужно в
                    // обсуждении, а удаление ломало бы цитаты ответов и смысл разговора.
                    aria-label={t('chat.editAriaShort')}
                    title={t('chat.editTitle')}
                    onClick={() => setEditing({ id: message.id, text: message.body })}
                    data-chat-edit={message.id}
                  >
                    <span aria-hidden="true">✎</span> {t('chat.edit')}
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
              {t('chat.replyTo', { author: replyTo.author_name, body: replyTo.body.slice(0, 60) })}
              {replyTo.body.length > 60 ? '…' : ''}
            </span>
            <button type="button" className="secondary" onClick={() => setReplyTo(null)}>
              {t('chat.replyCancel')}
            </button>
          </div>
        )}
        <textarea
          className="chat__input"
          value={text}
          rows={2}
          placeholder={t('chat.placeholder', {
            bot: bot.available ? t('chat.placeholderBot', { name: bot.name }) : '',
            })}
          aria-label={t('chat.aria')}
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
            <span className="muted">{t('chat.frame')}</span>
            <select
              value={linkId}
              aria-label={t('chat.attachFrameAria')}
              onChange={(event) => setLinkId(event.target.value)}
              data-chat-frame
            >
              <option value="">{t('chat.noLink')}</option>
              {(frames ?? []).map((frame) => (
                <option key={frame.id} value={frame.id}>{frame.title}</option>
              ))}
            </select>
          </label>
          {linkId !== '' && (
            <label className="chat__quote">
              <span className="muted">{t('chat.phrase')}</span>
              <input
                value={quote}
                placeholder={t('chat.phrasePlaceholder')}
                aria-label={t('chat.phraseAria')}
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
              title={t('chat.askBotTitle', { name: bot.name })}
              onClick={() => setAskBot((value) => !value)}
              data-chat-ask-bot
            >
              {askBot ? t('chat.botWillAnswer', { name: bot.name }) : t('chat.askBot')}
            </button>
          )}
          <button type="button" onClick={() => void send()} disabled={busy || text.trim() === ''} data-chat-send>
            {busy ? t('chat.sending') : t('chat.send')}
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
  return (await serverErrorMessage(error)) ?? message ?? tStatic('chat.errSend')
}




