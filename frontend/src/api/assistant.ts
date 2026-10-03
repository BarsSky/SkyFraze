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
  /**
   * Сколько токенов израсходовано за последние сутки — по всем беседам человека.
   *
   * Показываем всегда, даже когда предел не задан: «сколько это стоит» — вопрос,
   * который человек задаёт раньше, чем упирается в ограничение.
   */
  tokensToday: number
  /** Предел расхода за сутки (0 — без предела): задаёт администратор стенда. */
  tokenLimit: number
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
  /**
   * Модель умеет смотреть картинки. Признак нужен ДО отправки: приложить картинку
   * модели, которая её не видит, значит получить ответ, где картинка молча
   * проигнорирована, — а человек будет думать, что модель её посмотрела.
   */
  vision?: boolean
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
  /**
   * Ответ оборван человеком (кнопка «стоп»). Отдельным признаком, а не припиской в
   * тексте: тот же текст уходит модели как история, и «остановлено» выглядело бы для
   * неё частью ответа.
   */
  stopped?: boolean
  /** Расход этого сообщения: по нему интерфейс обновляет счётчик без лишнего запроса. */
  tokensIn?: number
  tokensOut?: number
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

/** Один режим генерации, который владелец может выбрать. */
export interface AIGenerationOption {
  id: string
  title: string
  hint: string
  /** Можно ли выбрать его сейчас: генератор доступен И инструмент реализован. */
  available: boolean
}

/**
 * Что агент умеет СЕЙЧАС в этом проекте.
 *
 * Складывается из трёх независимых вещей: что умеет стенд, что разрешил владелец и что
 * реализовано в этой версии. Интерфейс обязан показывать итог этих трёх, а не обещать
 * картинку, которой не будет.
 */
export interface AICapabilities {
  text: boolean
  images: boolean
  generation: string
  imageNote: string
  imageStyle: string
}

/**
 * Агент в проекте: имя (зашито в коде, не настраивается), роль, указания владельца и
 * режим генерации.
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
  /** Режим генерации в проекте: auto | text | images | both. */
  generation: string
  /** Стиль иллюстраций словами (дописывается в каждый промпт генератора). */
  imageStyle: string
  capabilities: AICapabilities
  /** Какие режимы можно выбрать и почему нельзя остальные. */
  generations: AIGenerationOption[]
  /** Доступен ли генератор изображений на стенде и что об этом сказать. */
  imageAvailable: boolean
  imageNote: string
}

/** Роль и поведение агента в проекте. */
export async function getAISettings(projectId: string): Promise<AISettings> {
  const raw = await http
    .get(`projects/${encodeURIComponent(projectId)}/ai/settings`)
    .json<unknown>()
  return parseAISettings(raw)
}

/** Сохранить роль, указания и режим генерации (владелец проекта). */
export async function saveAISettings(
  projectId: string,
  patch: { role: string; instructions: string; enabled: boolean; generation: string; imageStyle: string },
): Promise<AISettings> {
  const raw = await http
    .put(`projects/${encodeURIComponent(projectId)}/ai/settings`, {
      json: {
        role: patch.role,
        instructions: patch.instructions,
        enabled: patch.enabled,
        generation: patch.generation,
        image_style: patch.imageStyle,
      },
    })
    .json<unknown>()
  return parseAISettings(raw)
}

/** Разбор настроек агента: сервер — внешний источник, поля проверяем. */
export function parseAISettings(raw: unknown): AISettings {
  const record = asRecord(raw)
  const capabilities = asRecord(record?.capabilities)
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
    generation: asText(record?.generation) || 'auto',
    imageStyle: asText(record?.image_style),
    capabilities: {
      text: capabilities?.text !== false,
      images: capabilities?.images === true,
      generation: asText(capabilities?.generation) || asText(record?.generation) || 'auto',
      imageNote: asText(capabilities?.image_note),
      imageStyle: asText(capabilities?.image_style) || asText(record?.image_style),
    },
    generations: Array.isArray(record?.generations)
      ? record.generations
          .map((item) => {
            const option = asRecord(item)
            const id = asText(option?.id)
            if (!id) return null
            return {
              id,
              title: asText(option?.title) || id,
              hint: asText(option?.hint),
              available: option?.available === true,
            }
          })
          .filter((item): item is AIGenerationOption => item !== null)
      : [],
    imageAvailable: record?.image_available === true,
    imageNote: asText(record?.image_note),
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
 * Одно событие потока ответа.
 *
 * Поля необязательные: у `start` — идентификатор беседы, у `delta` — кусок текста,
 * у `call`/`change` — что помощник сделал, у `done` — итог целиком, у `error` — текст
 * сбоя, случившегося уже после начала потока.
 */
export interface AIStreamEvent {
  type: string
  conversationId?: string
  text?: string
  call?: AICall
  change?: AIChange
  turn?: AITurn
  error?: string
}

/** Что интерфейс делает с событиями по мере их прихода. */
export interface AIStreamHandlers {
  onStart?: (conversationId: string) => void
  onDelta?: (text: string) => void
  onCall?: (call: AICall) => void
  onChange?: (change: AIChange) => void
}

/** Необязательная часть вопроса: картинки, обработчики событий и «стоп». */
export interface AIAskOptions {
  /**
   * Картинки в виде data URL. Единый вид с сервером: он сам переводит их в то, что
   * ждёт конкретный провайдер (Ollama — чистый base64, OpenAI — data URL в части
   * контента).
   */
  images?: string[]
  handlers?: AIStreamHandlers
  signal?: AbortSignal
}

/**
 * Разбор буфера SSE: готовые события и «хвост», который ещё не дописан.
 *
 * Отдельной чистой функцией, а не внутри чтения потока: сеть режет данные как угодно,
 * кусок события приходит в середине кадра, и это единственное место в потоковой части,
 * где ошибка была бы незаметной (потерялся кусок текста — и всё).
 */
export function parseSSEBuffer(buffer: string): { events: AIStreamEvent[]; rest: string } {
  const events: AIStreamEvent[] = []
  let rest = buffer
  for (;;) {
    // Разделитель кадров — пустая строка, причём перевод строки может быть и CRLF:
    // так пишет часть прокси, и по формату это допустимо. Регулярным выражением, а не
    // `split('\n\n')`: разделитель бывает разрезан между двумя чтениями из сети, и
    // тогда «хвост» нужно считать от фактически найденного места.
    const boundary = /\r?\n\r?\n/.exec(rest)
    if (!boundary) break
    const frame = rest.slice(0, boundary.index)
    rest = rest.slice(boundary.index + boundary[0].length)
    // В кадре несколько строк data склеиваются переводом строки (так велит формат),
    // а служебные строки (`event:`, `id:`, комментарии) нам не нужны.
    const payload = frame
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''))
      .join('\n')
    if (payload.trim() === '') continue
    events.push(parseStreamEvent(payload))
  }
  return { events, rest }
}

function parseStreamEvent(payload: string): AIStreamEvent {
  const record = asRecord(JSON.parse(payload))
  return {
    type: asText(record?.type),
    conversationId: asText(record?.conversation_id) || undefined,
    text: asText(record?.text) || undefined,
    call: parseCall(record?.call) ?? undefined,
    change: parseChange(record?.change) ?? undefined,
    turn: record?.turn != null ? parseAITurn(record.turn) : undefined,
    error: asText(record?.error) || undefined,
  }
}

/**
 * Отправляет вопрос и читает ответ потоком.
 *
 * Возвращает итог — тот же, что у обычного запроса: по нему интерфейс заменяет текст,
 * показанный «на лету», сообщением из истории (и только тогда он становится правдой —
 * сервер мог и не сохранить то, что успел показать).
 *
 * `signal` — кнопка «стоп»: запрос прерывается, и сервер сохраняет то, что модель
 * успела сказать. Это не ошибка, а обычное действие человека.
 */
export async function streamAIMessage(
  projectId: string,
  conversationId: string,
  text: string,
  model: string,
  options: AIAskOptions = {},
): Promise<AITurn> {
  const { images = [], handlers = {}, signal } = options
  const response = await http.post(
    `projects/${encodeURIComponent(projectId)}/ai/conversations/${encodeURIComponent(conversationId)}/stream`,
    { json: { text, model, images }, signal },
  )
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('сервер не отдал поток ответа')
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let turn: AITurn | null = null

  const apply = (event: AIStreamEvent): AITurn | null => {
    switch (event.type) {
      case 'start':
        if (event.conversationId) handlers.onStart?.(event.conversationId)
        return null
      case 'delta':
        handlers.onDelta?.(event.text ?? '')
        return null
      case 'call':
        if (event.call) handlers.onCall?.(event.call)
        return null
      case 'change':
        if (event.change) handlers.onChange?.(event.change)
        return null
      case 'done':
        return event.turn ?? null
      case 'error':
        throw new Error(event.error || 'помощник не смог ответить')
      default:
        // Незнакомое событие — не повод рвать ответ: сервер может научиться присылать
        // новое, а старый интерфейс просто его не покажет.
        return null
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parsed = parseSSEBuffer(buffer)
    buffer = parsed.rest
    for (const event of parsed.events) {
      turn = apply(event) ?? turn
    }
  }
  // Поток мог закончиться без пустой строки после последнего события: дочитываем хвост.
  buffer += decoder.decode()
  if (buffer.trim() !== '') {
    for (const event of parseSSEBuffer(`${buffer}\n\n`).events) {
      turn = apply(event) ?? turn
    }
  }
  if (!turn) {
    throw new Error('помощник не прислал итог — попробуйте ещё раз')
  }
  return turn
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
 * Разбор ошибки помощника: текст для человека и признаки, по которым интерфейс
 * показывает не «ошибку сервера», а объяснение.
 *
 * `consent_required` приходит кодом 409 и означает не сбой, а вопрос: интерфейс по
 * нему показывает согласие. `token_budget` — код 429: исчерпан предел расхода за
 * сутки, и человеку нужно сказать это словами (и показать счётчик), а не «что-то
 * пошло не так».
 */
export async function readAIError(
  error: unknown,
): Promise<{ message: string | null; consentRequired: boolean; tokenBudget: boolean }> {
  const response = (error as { response?: Response } | null)?.response
  if (!response || typeof response.clone !== 'function') {
    return { message: null, consentRequired: false, tokenBudget: false }
  }
  try {
    const body = (await response.clone().json()) as {
      error?: unknown
      consent_required?: unknown
      token_budget?: unknown
    }
    return {
      message: typeof body?.error === 'string' && body.error ? body.error : null,
      consentRequired: body?.consent_required === true,
      tokenBudget: body?.token_budget === true,
    }
  } catch {
    return { message: null, consentRequired: false, tokenBudget: false }
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
    tokensToday: asWhole(record?.tokens_today),
    tokenLimit: asWhole(record?.token_limit),
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
      // А вот зрение наоборот: «не знаем» показываем как «не умеет». Обещать зрение и
      // молча потерять картинку хуже, чем не показать кнопку.
      vision: model?.vision === true,
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
    stopped: record.stopped === true,
    tokensIn: asWhole(record.tokens_in),
    tokensOut: asWhole(record.tokens_out),
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
