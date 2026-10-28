import { http } from './client'

/**
 * Общий чат проекта (0.95.0, docs/project-chat.md).
 *
 * Разговор участников один на проект — в отличие от замечаний к кадру, которые привязаны к
 * фрагменту текста. В чат можно позвать Нестора (ask_bot) и приложить ссылку на элемент текста:
 * кадр и необязательную точную фразу из него.
 */

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
}

/** Последние сообщения (или только новые после `after`). */
export async function listChat(projectId: string, after?: string): Promise<ChatPage> {
  const raw = await http
    .get(`projects/${projectId}/chat/messages`, {
      searchParams: after ? { after } : undefined,
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
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
  }
}
