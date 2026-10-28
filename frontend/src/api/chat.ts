import { http } from './client'

/**
 * Общий чат проекта (0.95.0, docs/project-chat.md).
 *
 * Разговор участников один на проект — в отличие от замечаний к кадру, которые привязаны к
 * фрагменту текста. В чат можно позвать Нестора (ask_bot) и приложить ссылку на элемент текста:
 * кадр и необязательную точную фразу из него.
 */

/**
 * Вид отметки на сообщении (0.98.0, docs/project-chat.md §2.5).
 *
 * Три рабочих, а не «любой эмодзи»: чат проекта — разговор о тексте, и голосование за сообщения
 * превращало бы его в рейтинг. Набор тот же, что у реакций на замечания в обсуждении кадров:
 * «согласен» (мысль принята), «надо сделать» (из этого следует правка), «вопрос» (надо уточнить).
 */
export type ChatReactionKind = 'agree' | 'todo' | 'question'

/** Отметки сообщения: сколько каждого вида и какие из них мои. */
export interface ChatReactions {
  agree: number
  todo: number
  question: number
  /** Виды, поставленные мной: у одного человека их может быть несколько на одном сообщении. */
  mine: ChatReactionKind[]
}

export interface ChatMessage {
  id: string
  project_id: string
  author_id?: string
  author_name: string
  /** 'user' — участник, 'bot' — Нестор. */
  kind: 'user' | 'bot'
  body: string
  /** Ссылка на кадр (может пропасть: кадр удалили). */
  event_id?: string
  /** Точная фраза из кадра. */
  quote?: string
  /** Ответ на сообщение (0.96.0). */
  reply_to?: string
  /** Когда правили после отправки. */
  edited_at?: string
  /** Отметки (0.98.0). Пустые — если никто ничего не ставил. */
  reactions: ChatReactions
  created_at: string
}

export interface ChatBotInfo {
  name: string
  available: boolean
}

export interface ChatPage {
  messages: ChatMessage[]
  bot: ChatBotInfo
}

export interface ChatPostResult {
  message: ChatMessage
  /** Ответ Нестора, если его просили и он ответил. */
  reply?: ChatMessage
  /** Почему ответа нет (бот выключен, модель недоступна). */
  note?: string
}

export interface ChatPostInput {
  body: string
  eventId?: string
  quote?: string
  askBot?: boolean
  replyTo?: string
}

/** Непрочитанное в чате по проектам — для колокольчика (0.97.0). */
export interface ChatUnseen {
  projectId: string
  title: string
  unread: number
  lastAt: string
}

export async function chatUnseen(): Promise<ChatUnseen[]> {
  const raw = await http.get('chat/unseen').json<{ projects?: unknown }>()
  const list = Array.isArray(raw?.projects) ? raw.projects : []
  const out: ChatUnseen[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const projectId = typeof record.project_id === 'string' ? record.project_id : ''
    if (!projectId) continue
    out.push({
      projectId,
      title: typeof record.title === 'string' ? record.title : '',
      unread: typeof record.unread === 'number' ? record.unread : 0,
      lastAt: typeof record.last_at === 'string' ? record.last_at : '',
    })
  }
  return out
}

/** Отметить чат проекта прочитанным (0.97.0): по этому живёт колокольчик. */
export async function markChatSeen(projectId: string): Promise<void> {
  await http.post(`projects/${projectId}/chat/seen`).json()
}

/**
 * Сообщения чата: последние, только новые после `after`, или только прежние до `before`.
 *
 * `before` — листнуть назад (0.99.2): до этого в старом проекте начало разговора было недостижимо,
 * окно открывалось последними ста сообщениями. `after` и `before` вместе сервер не принимает:
 * это два разных вопроса к одной ленте.
 */
export async function listChat(
  projectId: string,
  options?: { after?: string; before?: string; limit?: number },
): Promise<ChatPage> {
  const searchParams: Record<string, string> = {}
  if (options?.after) searchParams.after = options.after
  if (options?.before) searchParams.before = options.before
  if (options?.limit !== undefined) searchParams.limit = String(options.limit)
  const raw = await http
    .get(`projects/${projectId}/chat/messages`, {
      searchParams: Object.keys(searchParams).length > 0 ? searchParams : undefined,
    })
    .json<{ messages?: unknown; bot?: unknown }>()
  const messages = Array.isArray(raw?.messages)
    ? raw.messages.flatMap((item) => {
        const message = readMessage(item)
        return message === null ? [] : [message]
      })
    : []
  const botRaw = (raw?.bot ?? {}) as Record<string, unknown>
  return {
    messages,
    bot: {
      name: typeof botRaw.name === 'string' && botRaw.name ? botRaw.name : 'Нестор',
      available: botRaw.available === true,
    },
  }
}

export async function postChat(projectId: string, input: ChatPostInput): Promise<ChatPostResult> {
  const raw = await http
    .post(`projects/${projectId}/chat/messages`, {
      json: {
        body: input.body,
        event_id: input.eventId ?? '',
        quote: input.quote ?? '',
        ask_bot: input.askBot === true,
        reply_to: input.replyTo ?? '',
      },
      // Ответ Нестора — это обращение к модели: даём время, как у окна помощника.
      timeout: 180_000,
    })
    .json<{ message?: unknown; reply?: unknown; note?: unknown }>()
  const message = readMessage(raw?.message)
  if (message === null) throw new Error('сервер не вернул сообщение')
  const reply = readMessage(raw?.reply)
  return {
    message,
    reply: reply ?? undefined,
    note: typeof raw?.note === 'string' && raw.note ? raw.note : undefined,
  }
}

/** Изменить текст своего сообщения (0.96.0). */
export async function editChat(projectId: string, messageId: string, body: string): Promise<ChatMessage> {
  const raw = await http
    .patch(`projects/${projectId}/chat/messages/${messageId}`, { json: { body } })
    .json<{ message?: unknown }>()
  const message = readMessage(raw?.message)
  if (message === null) throw new Error('сервер не вернул сообщение')
  return message
}

/**
 * Поставить или снять отметку (0.98.0). Одна ручка на оба действия: состояние решает сервер — он
 * снимает уже стоящую отметку, поэтому кнопка ведёт себя как переключатель.
 *
 * Ответ — отметки сообщения целиком, а не «готово»: интерфейс сразу перерисовывает счётчики и не
 * ждёт следующего чтения ленты.
 */
export async function toggleChatReaction(
  projectId: string,
  messageId: string,
  kind: ChatReactionKind,
): Promise<ChatReactions> {
  const raw = await http
    .post(`projects/${projectId}/chat/messages/${messageId}/reactions`, { json: { kind } })
    .json<{ reactions?: unknown }>()
  return readReactions(raw?.reactions)
}

/** Отметки из ответа сервера. Пустой ответ — нули, а не падение: лента важнее плашек. */
function readReactions(raw: unknown): ChatReactions {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const count = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.trunc(value) : 0)
  const mine: ChatReactionKind[] = []
  if (Array.isArray(record.mine)) {
    for (const item of record.mine) {
      if (item === 'agree' || item === 'todo' || item === 'question') mine.push(item)
    }
  }
  return {
    agree: count(record.agree),
    todo: count(record.todo),
    question: count(record.question),
    mine,
  }
}

function readMessage(raw: unknown): ChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) return null
  const kind = record.kind === 'bot' ? 'bot' : 'user'
  return {
    id,
    project_id: typeof record.project_id === 'string' ? record.project_id : '',
    author_id: typeof record.author_id === 'string' ? record.author_id : undefined,
    author_name: typeof record.author_name === 'string' ? record.author_name : 'участник',
    kind,
    body: typeof record.body === 'string' ? record.body : '',
    event_id: typeof record.event_id === 'string' && record.event_id ? record.event_id : undefined,
    quote: typeof record.quote === 'string' && record.quote ? record.quote : undefined,
    reply_to: typeof record.reply_to === 'string' && record.reply_to ? record.reply_to : undefined,
    edited_at: typeof record.edited_at === 'string' && record.edited_at ? record.edited_at : undefined,
    reactions: readReactions(record.reactions),
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
  }
}
