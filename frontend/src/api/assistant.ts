import { http } from './client'

/**
 * ИИ-помощник: подключение моделей, свои ключи, согласие и беседы.
 *
 * Устроено в три слоя, и это важно для интерфейса:
 *
 *   1. **Настройка** (`/api/ai/*`) — провайдеры, модели, ключи, согласие. Она общая
 *      для всего стенда и не привязана к проекту: человек подключает свой ключ один
 *      раз и пользуется им во всех своих проектах.
 *   2. **Беседа** (`/api/projects/{id}/ai/*`) — всегда про конкретный проект: и
 *      контекст, и изменения привязаны к нему.
 *   3. **Ответ на сообщение** приходит от сервера размеченным: `answer` — что
 *      сказать, `changes` — что изменилось в проекте. Интерфейс не разбирает текст
 *      модели, чтобы показать «создана глава „Пролог“»: это было бы угадыванием.
 *
 * Ответы сервера читаем через parse-функции, а не приводим тип: сервер — внешний
 * источник, и «поля не пришло» должно давать пустой список, а не падение разметки.
 */

export interface AIProviderInfo {
  id: string
  title: string
  note: string
  /** Локальная модель: работает без ключа, текст проекта никуда не уходит. */
  local: boolean
  /** Бесплатна по умолчанию (локальная или бесплатный тариф провайдера). */
  freeByDefault: boolean
  /** Есть чем работать: локальная, свой ключ или ключ стенда. */
  hasKey: boolean
  /** Ключ задан администратором стенда: модели доступны без своего ключа. */
  standKey: boolean
  /** Ключ не нужен вовсе: свой сервер моделей (llama.cpp, vLLM) в своей сети. */
  keyless: boolean
  /** Без ключа провайдер не заработает — интерфейс предложит его добавить. */
  keyRequired: boolean
}

export interface AIConfig {
  enabled: boolean
  /** Настроено ли хранение ключей (AI_SECRET_KEY): без него своих ключей нет. */
  keysReady: boolean
  defaultModel: string
  maxToolCalls: number
  providers: AIProviderInfo[]
  /** Провайдеры, на отправку текста которым человек уже согласился. */
  consents: string[]
}

export interface AIModel {
  id: string
  /** `provider:model` — то, что уходит на сервер при отправке сообщения. */
  ref: string
  provider: string
  title: string
  free: boolean
  local: boolean
  /** Умеет ли модель вызывать инструменты. Без этого она глав не создаст. */
  tools: boolean
  /**
   * Модель считается на удалённом сервере, хотя провайдер «локальный»: облачные
   * модели Ollama (`…:cloud`) считаются на ollama.com. Для текста проекта это ровно
   * то же, что чужой сервис: нужно согласие.
   */
  cloud?: boolean
  contextKb?: number
}

export interface AICall {
  name: string
  ok: boolean
  detail?: string
  error?: string
}

export interface AIChange {
  action: string
  id: string
  title: string
  parentId?: string | null
}

export interface AIMessage {
  id: string
  role: string
  content: string
  createdAt: string
}

export interface AIConversation {
  id: string
  title: string
  model: string
  updatedAt: string
}

export interface AITurn {
  conversationId: string
  answer: string
  model: string
  calls: AICall[]
  changes: AIChange[]
  message: AIMessage
}

/** Одна роль агента, из которой выбирает владелец. */
export interface AIRole {
  id: string
  title: string
  hint: string
}

/**
 * Агент в проекте: имя (зашито в коде, не настраивается), роль и указания владельца.
 *
 * Агент правит текст проекта, поэтому он участник на правах соавтора: имя стоит под
 * его правками, а роль и поведение задаёт владелец проекта — в одной истории нужен
 * строгий летописец, в другой соавтор-фантаст.
 */
export interface AISettings {
  agentName: string
  agentId: string
  role: string
  roleTitle: string
  roleHint: string
  instructions: string
  /** Владелец может попросить агента не трогать эту историю. */
  enabled: boolean
  /** Менять роль и поведение может только владелец. */
  canEdit: boolean
  /** Участвует ли агент в проекте как соавтор. */
  member: boolean
  roles: AIRole[]
}

/** Роль и поведение агента в проекте. */
export async function getAISettings(projectId: string): Promise<AISettings> {
  const raw = await http
    .get(`projects/${encodeURIComponent(projectId)}/ai/settings`)
    .json<unknown>()
  return parseAISettings(raw)
}

/** Сохранить роль и поведение агента (владелец проекта). */
export async function saveAISettings(
  projectId: string,
  patch: { role: string; instructions: string; enabled: boolean },
): Promise<AISettings> {
  const raw = await http
    .put(`projects/${encodeURIComponent(projectId)}/ai/settings`, { json: patch })
    .json<unknown>()
  return parseAISettings(raw)
}

/** Разбор настроек агента: сервер — внешний источник, поля проверяем. */
export function parseAISettings(raw: unknown): AISettings {
  const record = asRecord(raw)
  return {
    agentName: asText(record?.agent_name) || 'Агент',
    agentId: asText(record?.agent_id),
    role: asText(record?.role),
    roleTitle: asText(record?.role_title),
    roleHint: asText(record?.role_hint),
    instructions: asText(record?.instructions),
    enabled: record?.enabled !== false,
    canEdit: record?.can_edit === true,
    member: record?.member === true,
    roles: Array.isArray(record?.roles)
      ? record.roles
          .map((item) => {
            const role = asRecord(item)
            const id = asText(role?.id)
            if (!id) return null
            return { id, title: asText(role?.title) || id, hint: asText(role?.hint) }
          })
          .filter((item): item is AIRole => item !== null)
      : [],
  }
}

/** Настройка помощника: провайдеры, их готовность и выданные согласия. */
export async function getAIConfig(): Promise<AIConfig> {
  const raw = await http.get('ai/config').json<unknown>()
  return parseAIConfig(raw)
}

/** Модели провайдера: список спрашивается у него самого, поэтому может быть пустым. */
export async function listAIModels(provider: string): Promise<AIModel[]> {
  const raw = await http
    .get('ai/models', { searchParams: { provider }, timeout: 30000 })
    .json<unknown>()
  return parseAIModels(raw)
}

/** Сохраняет свой ключ провайдера. Сервер сначала проверит его у провайдера. */
export async function saveAIKey(provider: string, key: string): Promise<void> {
  await http.post('ai/keys', { json: { provider, key }, timeout: 30000 })
}

export async function deleteAIKey(provider: string): Promise<void> {
  await http.delete(`ai/keys/${encodeURIComponent(provider)}`)
}

/**
 * Согласие на отправку текста проекта провайдеру.
 *
 * Отдельным действием, а не «галочкой при отправке»: это осознанное решение о том,
 * что текст проекта уходит на чужую машину, и оно не должно случаться само.
 */
export async function setAIConsent(provider: string): Promise<void> {
  await http.post('ai/consent', { json: { provider } })
}

export async function deleteAIConsent(provider: string): Promise<void> {
  await http.delete(`ai/consent/${encodeURIComponent(provider)}`)
}

export async function listAIConversations(projectId: string): Promise<AIConversation[]> {
  const raw = await http
    .get(`projects/${encodeURIComponent(projectId)}/ai/conversations`)
    .json<unknown>()
  return parseAIConversations(raw)
}

export async function getAIConversation(
  projectId: string,
  conversationId: string,
): Promise<{ conversation: AIConversation | null; messages: AIMessage[] }> {
  const raw = await http
    .get(
      `projects/${encodeURIComponent(projectId)}/ai/conversations/${encodeURIComponent(conversationId)}`,
    )
    .json<unknown>()
  const record = asRecord(raw)
  return {
    conversation: parseAIConversation(record?.conversation),
    messages: parseAIMessages(record?.messages),
  }
}

/**
 * Отправляет вопрос помощнику.
 *
 * `conversationId` может быть `new` — тогда беседа заводится этим же запросом:
 * интерфейс новый разговор ничего не создаёт заранее, иначе пустые беседы копились
 * бы от каждого открытия панели.
 */
export async function sendAIMessage(
  projectId: string,
  conversationId: string,
  text: string,
  model: string,
): Promise<AITurn> {
  const raw = await http
    .post(
      `projects/${encodeURIComponent(projectId)}/ai/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        json: { text, model },
        // Модель думает и вызывает инструменты: это самый долгий запрос в приложении.
        timeout: 300000,
      },
    )
    .json<unknown>()
  return parseAITurn(raw)
}

/**
 * Облачная ли модель по её ссылке `provider:model`.
 *
 * Признак нужен ДО запроса к провайдеру: сервер отвечает `409 consent_required`, когда
 * текст уйдёт наружу, но интерфейс должен показать это заранее — до того, как человек
 * наберёт вопрос. Ollama помечает облачные модели суффиксом `:cloud`.
 */
export function isCloudModelRef(ref: string): boolean {
  return /:cloud$/i.test(ref.trim())
}

/**
 * Требуется ли согласие для выбранной модели.
 *
 * Локальная модель согласия не требует: текст проекта не покидает машину. Но
 * «локальный» — свойство МОДЕЛИ, а не провайдера: у Ollama рядом с локальными живут
 * облачные (`…:cloud`), которые считаются на ollama.com, и для них согласие нужно так
 * же, как для чужого сервиса. Требовать «разрешите поговорить с собственной машиной» —
 * значит приучать нажимать «согласен» не читая, а пропускать облачную модель молча —
 * отправлять текст проекта без согласия.
 */
export function needsConsent(config: AIConfig | null, providerId: string, modelRef = ''): boolean {
  if (!config || !providerId) return false
  const provider = config.providers.find((item) => item.id === providerId)
  if (!provider) return false
  if (provider.local && !isCloudModelRef(modelRef)) return false
  return !config.consents.includes(providerId)
}

/**
 * Разбор ошибки помощника: текст для человека и признак «нужно согласие».
 *
 * `consent_required` приходит кодом 409 и означает не сбой, а вопрос: интерфейс по
 * нему показывает согласие, а не красную плашку «ошибка сервера».
 */
export async function readAIError(
  error: unknown,
): Promise<{ message: string | null; consentRequired: boolean }> {
  const response = (error as { response?: Response } | null)?.response
  if (!response || typeof response.clone !== 'function') {
    return { message: null, consentRequired: false }
  }
  try {
    const body = (await response.clone().json()) as {
      error?: unknown
      consent_required?: unknown
    }
    return {
      message: typeof body?.error === 'string' && body.error ? body.error : null,
      consentRequired: body?.consent_required === true,
    }
  } catch {
    return { message: null, consentRequired: false }
  }
}

/** Разбор `GET /api/ai/config`. */
export function parseAIConfig(raw: unknown): AIConfig {
  const record = asRecord(raw)
  return {
    enabled: record?.enabled === true,
    keysReady: record?.keys_ready === true,
    defaultModel: asText(record?.default_model),
    maxToolCalls: asWhole(record?.max_tool_calls),
    providers: Array.isArray(record?.providers)
      ? record.providers
          .map(parseProvider)
          .filter((item): item is AIProviderInfo => item !== null)
      : [],
    consents: asStrings(record?.consents),
  }
}

function parseProvider(raw: unknown): AIProviderInfo | null {
  const record = asRecord(raw)
  const id = asText(record?.id)
  if (!id) return null
  return {
    id,
    title: asText(record?.title) || id,
    note: asText(record?.note),
    local: record?.local === true,
    freeByDefault: record?.free_by_default === true,
    hasKey: record?.has_key === true,
    standKey: record?.stand_key === true,
    keyless: record?.keyless === true,
    keyRequired: record?.key_required === true,
  }
}

/** Разбор `GET /api/ai/models`: список моделей одного провайдера. */
export function parseAIModels(raw: unknown): AIModel[] {
  const record = asRecord(raw)
  if (!Array.isArray(record?.models)) return []
  const out: AIModel[] = []
  for (const item of record.models) {
    const model = asRecord(item)
    const id = asText(model?.id)
    if (!id) continue
    out.push({
      id,
      ref: asText(model?.ref),
      provider: asText(model?.provider),
      title: asText(model?.title) || id,
      free: model?.free === true,
      local: model?.local === true,
      cloud: model?.cloud === true || isCloudModelRef(asText(model?.ref) || id),
      // Поле необязательное: старый сервер его не присылает, и «не знаем» честнее
      // показать как «умеет» — отказ модели виден в чате.
      tools: model?.tools !== false,
      contextKb: typeof model?.context_kb === 'number' ? model.context_kb : undefined,
    })
  }
  return out
}

/** Разбор ответа на сообщение. */
export function parseAITurn(raw: unknown): AITurn {
  const record = asRecord(raw)
  return {
    conversationId: asText(record?.conversation_id),
    answer: asText(record?.answer),
    model: asText(record?.model),
    calls: Array.isArray(record?.calls)
      ? record.calls.map(parseCall).filter((item): item is AICall => item !== null)
      : [],
    changes: Array.isArray(record?.changes)
      ? record.changes.map(parseChange).filter((item): item is AIChange => item !== null)
      : [],
    message: parseMessage(record?.message) ?? {
      id: '',
      role: 'assistant',
      content: asText(record?.answer),
      createdAt: '',
    },
  }
}

function parseCall(raw: unknown): AICall | null {
  const record = asRecord(raw)
  const name = asText(record?.name)
  if (!name) return null
  return {
    name,
    ok: record?.ok === true,
    detail: asText(record?.detail) || undefined,
    error: asText(record?.error) || undefined,
  }
}

function parseChange(raw: unknown): AIChange | null {
  const record = asRecord(raw)
  const id = asText(record?.id)
  if (!id) return null
  return {
    action: asText(record?.action),
    id,
    title: asText(record?.title),
    parentId: asText(record?.parent_id) || null,
  }
}

export function parseAIConversations(raw: unknown): AIConversation[] {
  const record = asRecord(raw)
  if (!Array.isArray(record?.conversations)) return []
  return record.conversations
    .map(parseAIConversation)
    .filter((item): item is AIConversation => item !== null)
}

function parseAIConversation(raw: unknown): AIConversation | null {
  const record = asRecord(raw)
  const id = asText(record?.id)
  if (!id) return null
  return {
    id,
    title: asText(record?.title),
    model: asText(record?.model),
    updatedAt: asText(record?.updated_at),
  }
}

export function parseAIMessages(raw: unknown): AIMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.map(parseMessage).filter((item): item is AIMessage => item !== null)
}

function parseMessage(raw: unknown): AIMessage | null {
  const record = asRecord(raw)
  if (!record) return null
  const role = asText(record.role)
  if (role === '') return null
  return {
    id: asText(record.id),
    role,
    content: asText(record.content),
    createdAt: asText(record.created_at),
  }
}

/**
 * Человеческое описание изменения: «создана глава „Пролог“».
 *
 * Текст собирается из данных сервера, а не из ответа модели: модель может назвать
 * действие как угодно, а `action` приходит из кода, который это действие выполнил.
 */
export function changeLabel(change: AIChange): string {
  switch (change.action) {
    case 'created_chapter':
      return `создана глава «${change.title}»`
    case 'created_sub_event':
      return `создано под-событие «${change.title}»`
    default:
      return change.title ? `изменение: «${change.title}»` : 'изменение проекта'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asWhole(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}
