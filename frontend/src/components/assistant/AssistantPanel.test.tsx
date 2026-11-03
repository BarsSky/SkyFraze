import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AIConfig, AIEndpoint, AIModel, AIProposal, AISettings, AITurn } from '../../api/assistant'
import { AssistantPanel } from './AssistantPanel'
import { setLang } from '../../store/lang'

/**
 * Содержимое окна помощника: то, что видит и чего не видит человек.
 *
 * Сеть подменена целиком. Проверяем правила, а не разметку:
 *   - пока нет согласия на отправку текста внешнему провайдеру, поле ввода
 *     заблокировано, а согласие можно выдать одной кнопкой;
 *   - у локальной модели согласия не спрашивают вовсе (текст никуда не уходит);
 *   - «что изменилось» показывается из ответа СЕРВЕРА, а не из текста модели;
 *   - настройка (провайдер, модель, ключ, согласие) — второй вид того же окна;
 *   - ответ, пришедший при закрытом окне, отмечается как непрочитанный (`onUnread`).
 *
 * Markdown-рендер подменён: панель проверяется как поведение, а сам рендер разметки
 * покрыт своими тестами (MarkdownBlock).
 */

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  models: vi.fn(),
  stream: vi.fn(),
  consent: vi.fn(),
  revoke: vi.fn(),
  saveKey: vi.fn(),
  deleteKey: vi.fn(),
  error: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
  endpoints: vi.fn(),
  addEndpoint: vi.fn(),
  deleteEndpoint: vi.fn(),
  proposals: vi.fn(),
  applyProposal: vi.fn(),
  revertProposal: vi.fn(),
  /** Беседы проекта (0.147.0): список для «Истории» и восстановление последней. */
  conversations: vi.fn(),
  conversation: vi.fn(),
  /** Удаление беседы и очистка истории (0.148.0). */
  deleteConversation: vi.fn(),
  clearConversations: vi.fn(),
  /** Знания проекта (0.149.0): список для окна выбора. */
  listKnowledge: vi.fn(),
  discardProposal: vi.fn(),
}))

vi.mock('../../api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../api/assistant')>('../../api/assistant')
  return {
    // Разбор и правила оставляем настоящими: панель должна ходить через них.
    parseAIConfig: actual.parseAIConfig,
    parseAITurn: actual.parseAITurn,
    parseAISettings: actual.parseAISettings,
    needsConsent: actual.needsConsent,
    isCloudModelRef: actual.isCloudModelRef,
    changeLabel: actual.changeLabel,
    getAIConfig: mocks.config,
    getAISettings: mocks.settings,
    saveAISettings: mocks.saveSettings,
    listAIModels: mocks.models,
    streamAIMessage: mocks.stream,
    setAIConsent: mocks.consent,
    deleteAIConsent: mocks.revoke,
    saveAIKey: mocks.saveKey,
    deleteAIKey: mocks.deleteKey,
    readAIError: mocks.error,
    listAIConversations: mocks.conversations,
    getAIConversation: mocks.conversation,
    deleteAIConversation: mocks.deleteConversation,
    clearAIConversations: mocks.clearConversations,
    listAIKnowledge: mocks.listKnowledge,
    listAIEndpoints: mocks.endpoints,
    addAIEndpoint: mocks.addEndpoint,
    deleteAIEndpoint: mocks.deleteEndpoint,
    listAIProposals: mocks.proposals,
    applyAIProposal: mocks.applyProposal,
    revertAIProposal: mocks.revertProposal,
    discardAIProposal: mocks.discardProposal,
    parseProposal: actual.parseProposal,
    parseProposals: actual.parseProposals,
  }
})

vi.mock('../MarkdownBlock', () => ({
  MarkdownBlock: ({ source }: { source: string }) => <p data-markdown>{source}</p>,
}))

const LOCAL: AIConfig = {
  enabled: true,
  keysReady: true,
  defaultModel: '',
  maxToolCalls: 10,
  tokensToday: 0,
  tokenLimit: 0,
  providers: [
    {
      id: 'ollama',
      title: 'Локальная модель (Ollama)',
      note: '',
      local: true,
      freeByDefault: true,
      hasKey: true,
      standKey: false,
      keyless: false,
      own: false,
      keyRequired: false,
    },
  ],
  consents: [],
}

const REMOTE: AIConfig = {
  ...LOCAL,
  defaultModel: 'groq:llama-3.1-8b',
  providers: [
    {
      id: 'groq',
      title: 'Groq',
      note: 'бесплатный тариф: нужен ваш ключ',
      local: false,
      freeByDefault: true,
      hasKey: true,
      standKey: false,
      keyless: false,
      own: false,
      keyRequired: false,
    },
  ],
}

const MODELS: AIModel[] = [
  { id: 'llama-3.1-8b', ref: 'groq:llama-3.1-8b', provider: 'groq', title: 'Llama 3.1 8B', free: true, local: false, tools: true },
]

const TURN: AITurn = {
  conversationId: 'c1',
  answer: 'Создал главу «Пролог».',
  model: 'llama-3.1-8b',
  calls: [{ name: 'create_chapter', ok: true, detail: 'создал главу «Пролог»' }],
  changes: [{ action: 'created_chapter', id: 'e1', title: 'Пролог' }],
  message: { id: 'm2', role: 'assistant', content: 'Создал главу «Пролог».', createdAt: '' },
}

/** Агент проекта: имя зашито на сервере, роль и указания задаёт владелец. */
const AGENT: AISettings = {
  agentName: 'Нестор',
  agentId: '00000000-0000-0000-0000-0000000000a1',
  role: '',
  roleTitle: '',
  roleHint: '',
  instructions: '',
  enabled: true,
  canEdit: true,
  member: false,
  roles: [
    { id: 'chronicler', title: 'Летописец', hint: 'выстраивает хронологию' },
    { id: 'editor', title: 'Редактор', hint: 'правит формулировки' },
  ],
  generation: 'auto',
  imageStyle: '',
  imageNegative: '',
  capabilities: {
    text: true,
    images: false,
    generation: 'auto',
    imageNote: 'генератор изображений не настроен (AI_IMAGE_URL)',
    imageStyle: '',
  },
  generations: [
    { id: 'auto', title: 'Как получится', hint: 'оба, если генератор доступен', available: true },
    { id: 'text', title: 'Только текст', hint: 'агент пишет и не рисует', available: true },
    { id: 'images', title: 'Только картинки', hint: 'пока недоступно', available: false },
    { id: 'both', title: 'Текст и картинки', hint: 'пока недоступно', available: false },
  ],
  imageAvailable: false,
  imageNote: 'генератор изображений не настроен (AI_IMAGE_URL)',
  retentionDays: 0,
}

/** Панель всегда живёт внутри окна: по умолчанию считаем его открытым. */
function renderPanel(props: Partial<Parameters<typeof AssistantPanel>[0]> = {}) {
  const all = {
    projectId: 'p1',
    open: true,
    onClose: () => {},
    onUnread: () => {},
    onThinkingChange: () => {},
    onProjectChanged: () => {},
    onOpenEditors: () => {},
    ...props,
  }
  const view = render(<AssistantPanel {...all} />)
  // Пропсы отдаём наружу: тесту нужно «закрыть окно» повторным рендером
  // (в доке окно именно прячется, а не размонтируется).
  return { view, props: all }
}

beforeEach(() => {
  setLang('ru')
  // Окно помнит последнюю беседу проекта в localStorage (0.147.0) — в тестах начинаем с чистого листа.
  localStorage.clear()
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.error.mockResolvedValue({ message: null, consentRequired: false })
  mocks.models.mockResolvedValue(MODELS)
  mocks.consent.mockResolvedValue(undefined)
  mocks.saveKey.mockResolvedValue(undefined)
  mocks.settings.mockResolvedValue(AGENT)
  mocks.saveSettings.mockResolvedValue({ ...AGENT, role: 'chronicler', roleTitle: 'Летописец' })
  mocks.endpoints.mockResolvedValue([])
  mocks.proposals.mockResolvedValue([])
  // По умолчанию истории нет: панель открывается в новом разговоре. Сценарии, которым нужна
  // беседа проекта, подставляют её сами (0.147.0).
  mocks.conversations.mockResolvedValue([])
  mocks.conversation.mockResolvedValue({ conversation: null, messages: [] })
  mocks.deleteConversation.mockResolvedValue(undefined)
  mocks.clearConversations.mockResolvedValue(0)
  mocks.applyProposal.mockResolvedValue({ proposal: null, warning: '' })
  mocks.revertProposal.mockResolvedValue({ proposal: null, warning: '' })
  mocks.discardProposal.mockResolvedValue(undefined)
  mocks.applyProposal.mockResolvedValue({ proposal: null, warning: '' })
  mocks.revertProposal.mockResolvedValue({ proposal: null, warning: '' })
  mocks.discardProposal.mockResolvedValue(undefined)
  mocks.addEndpoint.mockResolvedValue(null)
  mocks.deleteEndpoint.mockResolvedValue(undefined)
  mocks.listKnowledge.mockResolvedValue([])
})

afterEach(() => cleanup())

describe('AssistantPanel', () => {
  it('выключенный помощник честно об этом говорит и не даёт поля ввода', async () => {
    mocks.config.mockResolvedValue({ ...LOCAL, enabled: false })
    renderPanel()
    expect(await screen.findByText(/Помощник выключен на этом стенде/)).toBeTruthy()
    expect(screen.queryByLabelText('Сообщение помощнику')).toBeNull()
  })

  it('без согласия поле ввода заблокировано, кнопка согласия его открывает', async () => {
    mocks.config.mockResolvedValue(REMOTE)
    renderPanel()

    expect(await screen.findByText(/уйдёт провайдеру «Groq»/)).toBeTruthy()
    const input = screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement
    expect(input.disabled).toBe(true)

    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    fireEvent.click(screen.getByRole('button', { name: 'Согласен, продолжить' }))
    await waitFor(() => expect(mocks.consent).toHaveBeenCalledWith('groq'))
    await waitFor(() =>
      expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).disabled).toBe(false),
    )
  })

  it('у локальной модели согласия не спрашивает: текст никуда не уходит', async () => {
    mocks.config.mockResolvedValue(LOCAL)
    mocks.models.mockResolvedValue([
      { id: 'qwen2.5:7b', ref: 'ollama:qwen2.5:7b', provider: 'ollama', title: 'qwen2.5:7b', free: true, local: true, tools: true },
    ])
    renderPanel()

    expect(await screen.findByText(/текст проекта не покидает сервер стенда/)).toBeTruthy()
    expect(screen.queryByText(/уйдёт провайдеру/)).toBeNull()
    expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).disabled).toBe(false)
  })

  /**
   * Модель приходит двумя шагами (0.140.1).
   *
   * Настройка приносит `defaultModel`, а список моделей — сам `ref` модели. Между этими
   * ответами кнопка «Спросить» была активна, а нажатие молча ничего не отправляло: `ask`
   * возвращался с ошибкой «выберите модель», вопрос оставался в поле. Человек видел
   * «спросил — ответа нет», и именно на этом падал e2e `fragment-edit` под нагрузкой.
   */
  it('не отправляет вопрос, пока модель ещё не известна, и отправляет, когда она пришла', async () => {
    mocks.config.mockResolvedValue(LOCAL) // defaultModel пуст: модель даст только список
    let resolveModels: (value: unknown) => void = () => undefined
    mocks.models.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve
        }),
    )
    mocks.stream.mockResolvedValue(TURN)
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Добавь главу «Пролог»' } })

    const ask = screen.getByRole('button', { name: 'Спросить' }) as HTMLButtonElement
    expect(ask.disabled, 'без модели кнопка молчит, а не теряет вопрос').toBe(true)

    // Модель приехала — кнопка становится рабочей и вопрос действительно уходит.
    resolveModels([
      { id: 'qwen2.5:7b', ref: 'ollama:qwen2.5:7b', provider: 'ollama', title: 'qwen2.5:7b', free: true, local: true, tools: true },
    ])
    await waitFor(() => expect(ask.disabled).toBe(false))
    fireEvent.click(ask)
    await waitFor(() => expect(mocks.stream).toHaveBeenCalled())
  })

  it('показывает ответ модели и отдельный блок «что изменилось» из ответа сервера', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockResolvedValue(TURN)
    const changed = vi.fn()
    renderPanel({ onProjectChanged: changed })

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Добавь главу «Пролог»' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    await waitFor(() =>
      expect(mocks.stream.mock.calls[0]?.slice(0, 4)).toEqual([
        'p1',
        'new',
        'Добавь главу «Пролог»',
        'groq:llama-3.1-8b',
      ]),
    )
    expect(await screen.findByText('Создал главу «Пролог».')).toBeTruthy()
    expect(await screen.findByText('Изменения в проекте')).toBeTruthy()
    expect(screen.getByText('создана глава «Пролог»')).toBeTruthy()
    // Страница должна узнать об изменениях: без realtime иначе не перечитать проект.
    expect(changed).toHaveBeenCalled()
  })

  it('изменения и правки — свёрнутые карточки, чтобы не поджимать переписку (0.146.0)', async () => {
    // На телефоне развёрнутые блоки занимали почти весь низ окна, и переписку с Нестором
    // было не прочитать. Теперь это карточки со счётчиком: свёрнуты по умолчанию.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockResolvedValue(TURN)
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Добавь главу «Пролог»' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    const card = (await waitFor(() => {
      const found = document.querySelector('[data-assistant-changes]')
      expect(found).not.toBeNull()
      return found
    })) as HTMLDetailsElement
    expect(card.tagName).toBe('DETAILS')
    expect(card.open).toBe(false)
    expect(card.querySelector('.ai-card__count')?.textContent).toBe('1')

    fireEvent.click(card.querySelector('summary') as Element)
    expect(card.open).toBe(true)
    expect(screen.getByText('создана глава «Пролог»')).toBeTruthy()
  })

  it('предложенные правки раскрыты по умолчанию: это решение для человека (0.146.2)', async () => {
    // Изменения и применённое — информация, их можно свернуть. А предложенная правка ждёт
    // кнопки «Применить»/«Отклонить», поэтому карточка открыта сразу — иначе человек
    // увидит счётчик и не поймёт, что от него хотят.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockResolvedValue({
      ...TURN,
      changes: [],
      proposals: [
        {
          id: 'p1',
          kind: 'update_text',
          status: 'pending',
          eventId: 'e1',
          eventTitle: 'Пролог',
          oldTitle: 'Пролог',
          oldBody: 'Старый текст главы.',
          newTitle: 'Пролог',
          newBody: 'Новый текст главы.',
          oldSpan: '',
          oldDate: '',
          newDate: '',
        } as AIProposal,
      ],
    })
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Перепиши главу' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    const card = (await waitFor(() => {
      const found = document.querySelector('[data-assistant-proposals]')
      expect(found).not.toBeNull()
      return found
    })) as HTMLDetailsElement
    expect(card.tagName).toBe('DETAILS')
    expect(card.open).toBe(true)
    expect(card.getAttribute('open')).not.toBeNull()
  })

  it('пока ответа нет, в переписке видно, что Нестор печатает (0.146.0)', async () => {
    // Раньше ожидание было серой строчкой между блоками, и понять, ответил ли помощник,
    // было нельзя. Теперь это реплика с подписью автора.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockImplementation(() => new Promise<AITurn>(() => {}))
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Добавь главу' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    await waitFor(() => {
      const typing = document.querySelector('[data-assistant-thinking]')
      expect(typing?.textContent).toContain('Нестор')
      expect(typing?.textContent).toContain('печатает')
    })
  })

  it('показывает текст ответа по мере генерации, а не после конца', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    let finish: (turn: AITurn) => void = () => {}
    mocks.stream.mockImplementation(
      (
        _projectId: string,
        _conversationId: string,
        _text: string,
        _model: string,
        options: { handlers?: { onDelta?: (text: string) => void } } = {},
      ) =>
        new Promise<AITurn>((resolve) => {
          // Сервер сначала присылает куски текста, и только потом — итог.
          options.handlers?.onDelta?.('Создал ')
          options.handlers?.onDelta?.('главу «Пролог».')
          finish = resolve
        }),
    )
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Добавь главу' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    // Текст виден ДО того, как ответ пришёл целиком: ради этого поток и делался.
    await waitFor(() =>
      expect(document.querySelector('[data-assistant-live]')?.textContent).toContain(
        'Создал главу «Пролог».',
      ),
    )
    // Пока ответ не закончен, он не подменяет историю: это ещё не факт на сервере.
    expect(screen.queryByText('Изменения в проекте')).toBeNull()

    finish(TURN)
    await waitFor(() => expect(document.querySelector('[data-assistant-live]')).toBeNull())
    expect(await screen.findByText('Создал главу «Пролог».')).toBeTruthy()
  })

  it('показывает черновик нового текста кадра отдельно от реплики', async () => {
    // 0.144.0: «перепиши главу» приходит не JSON-аргументом, а черновиком по мере
    // написания. Черновик — не ответ помощника: пока правка не подтверждена, текст кадра
    // прежний, и путать эти два факта в интерфейсе нельзя.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    let finish: (turn: AITurn) => void = () => {}
    mocks.stream.mockImplementation(
      (
        _projectId: string,
        _conversationId: string,
        _text: string,
        _model: string,
        options: {
          handlers?: { onDraft?: (text: string) => void; onDelta?: (text: string) => void }
        } = {},
      ) =>
        new Promise<AITurn>((resolve) => {
          options.handlers?.onDraft?.('Новый первый абзац. ')
          options.handlers?.onDraft?.('Новый второй абзац.')
          finish = resolve
        }),
    )
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Перепиши главу целиком' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    await waitFor(() =>
      expect(document.querySelector('[data-assistant-draft]')?.textContent).toContain(
        'Новый первый абзац. Новый второй абзац.',
      ),
    )
    // Это не реплика помощника: в потоке ответа черновика нет.
    expect(document.querySelector('[data-assistant-live]')).toBeNull()

    finish(TURN)
    // Удачный ответ: черновик убран, его место занимает сообщение из истории.
    await waitFor(() => expect(document.querySelector('[data-assistant-draft]')).toBeNull())
    expect(await screen.findByText('Создал главу «Пролог».')).toBeTruthy()
  })

  it('через 20 секунд молчания объясняет, что модель загружается', async () => {
    // 0.145.0: локальная модель выгружается из памяти, и первый запрос поднимает её
    // минутами. Без пояснения человек решает, что помощник сломался, и перезагружает
    // страницу — а это и есть настоящий обрыв запроса.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    let finish: (turn: AITurn) => void = () => {}
    mocks.stream.mockImplementation(
      () =>
        new Promise<AITurn>((resolve) => {
          finish = resolve
        }),
    )
    // Порог подсказки — параметром: изображать двадцать секунд ожидания в тесте незачем.
    const { view } = renderPanel({ coldStartHintMs: 40 })

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Помоги с орфографией и стилем главы' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    // До порога — обычное «думает…», после — объяснение про загрузку модели.
    await waitFor(() =>
      expect(document.querySelector('[data-assistant-thinking]')?.textContent).toContain(
        'Модель загружается на сервере',
      ),
    )

    finish(TURN)
    await waitFor(() => expect(screen.queryByText(/Модель загружается на сервере/)).toBeNull())
    view.unmount()
  })

  it('при исчерпанном пределе расхода объясняет это и не даёт отправить', async () => {
    mocks.config.mockResolvedValue({
      ...REMOTE,
      consents: ['groq'],
      tokensToday: 1000,
      tokenLimit: 1000,
    })
    renderPanel()

    expect(await screen.findByText(/Предел расхода на сутки исчерпан/)).toBeTruthy()
    expect(screen.getByText(/Израсходовано 1000 из 1000 токенов за сутки/)).toBeTruthy()
    // Поле заблокировано ДО нажатия: человек видит причину, а не отказ после отправки.
    expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).disabled).toBe(
      true,
    )
  })

  it('после ответа обновляет счётчик расхода без нового запроса', async () => {
    mocks.config.mockResolvedValue({
      ...REMOTE,
      consents: ['groq'],
      tokensToday: 100,
      tokenLimit: 0,
    })
    mocks.stream.mockResolvedValue({
      ...TURN,
      message: { ...TURN.message, tokensIn: 120, tokensOut: 40 },
    })
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Добавь главу' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    // 100 + 120 + 40: расход берётся из ответа, а не отдельным запросом к настройке.
    expect(await screen.findByText(/Израсходовано 260 токенов за сутки/)).toBeTruthy()
    expect(mocks.config).toHaveBeenCalledTimes(1)
  })

  it('в пустом чате показывает подсказки и подставляет выбранную в поле', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    renderPanel({ projectIsEmpty: false })

    // Подсказка не отправляется сама: нажатие только подставляет текст, чтобы человек
    // увидел, что именно уйдёт модели.
    const hint = await screen.findByRole('button', { name: 'Продолжи историю' })
    fireEvent.click(hint)

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    expect(input.value).toMatch(/дальше/i)
    expect(mocks.stream).not.toHaveBeenCalled()
  })

  it('в пустом проекте первая подсказка — «собери проект с нуля»', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    renderPanel({ projectIsEmpty: true })

    expect(await screen.findByRole('button', { name: 'Собери проект с нуля' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Продолжи историю' })).toBeNull()
  })

  it('кнопку прикрепления показывает только у модели, которая видит картинки', async () => {
    // Слепая модель: кнопки нет. Обещать зрение и молча потерять картинку нельзя.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    renderPanel()
    await screen.findByLabelText('Сообщение помощнику')
    expect(screen.queryByRole('button', { name: 'Картинка' })).toBeNull()

    cleanup()
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'], defaultModel: 'groq:зрячая' })
    mocks.models.mockResolvedValue([
      {
        id: 'зрячая',
        ref: 'groq:зрячая',
        provider: 'groq',
        title: 'Зрячая',
        free: false,
        local: false,
        tools: true,
        vision: true,
      },
    ])
    renderPanel()
    expect(await screen.findByRole('button', { name: 'Картинка' })).toBeTruthy()
  })

  it('прикрепляет картинку, показывает превью и отправляет её с вопросом', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'], defaultModel: 'groq:зрячая' })
    mocks.models.mockResolvedValue([
      {
        id: 'зрячая',
        ref: 'groq:зрячая',
        provider: 'groq',
        title: 'Зрячая',
        free: false,
        local: false,
        tools: true,
        vision: true,
      },
    ])
    mocks.stream.mockResolvedValue(TURN)
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    const fileInput = document.querySelector('[data-assistant-file]') as HTMLInputElement
    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput, {
      target: { files: [new File([new Uint8Array([137, 80, 78, 71])], 'маяк.png', { type: 'image/png' })] },
    })

    // Превью появляется после чтения файла — и вместе с ним кнопка «убрать».
    await waitFor(() => expect(document.querySelector('[data-assistant-attach] img')).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Убрать картинку 1' })).toBeTruthy()

    fireEvent.change(input, { target: { value: 'Что на картинке?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    await waitFor(() => {
      const options = mocks.stream.mock.calls[0]?.[4] as { images?: string[] } | undefined
      expect(options?.images?.length).toBe(1)
      expect(options?.images?.[0]?.startsWith('data:image/png;base64,')).toBe(true)
    })
    // После отправки превью исчезает: картинка была для одного вопроса, а не «навсегда».
    await waitFor(() => expect(document.querySelector('[data-assistant-attach]')).toBeNull())
  })

  /**
   * Знания проекта (0.149.0).
   *
   * Проверяем главное: приложенное знание уходит с вопросом ТОЛЬКО идентификатором (тела
   * знает сервер), его состав виден до отправки, а сохранённое помощником знание показано
   * карточкой, а не спрятано в тексте ответа.
   */
  it('прикладывает знание к вопросу и показывает его состав', async () => {
    mocks.config.mockResolvedValue(LOCAL)
    mocks.models.mockResolvedValue([
      { id: 'qwen2.5:7b', ref: 'ollama:qwen2.5:7b', provider: 'ollama', title: 'qwen2.5:7b', free: true, local: true, tools: true },
    ])
    mocks.listKnowledge.mockResolvedValue([
      {
        id: 'k1',
        title: 'Решения по миру',
        summary: 'драконы спят',
        chars: 13,
        authorName: 'Автор',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])
    mocks.stream.mockResolvedValue(TURN)
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: /Знания/ }))
    const checkbox = (await waitFor(() => {
      const found = document.querySelector('[data-knowledge-picker-item="k1"]') as HTMLInputElement | null
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })) as HTMLInputElement
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Приложить' }))

    // Состав виден до отправки: «какие выводы уйдут модели» — не догадка.
    expect(await screen.findByText('Решения по миру')).toBeTruthy()
    fireEvent.change(input, { target: { value: 'Что решили в марте?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    await waitFor(() => {
      const options = mocks.stream.mock.calls[0]?.[4] as { knowledge?: string[] } | undefined
      expect(options?.knowledge).toEqual(['k1'])
    })
    // После отправки вложения очищаются: они относились к этому вопросу.
    await waitFor(() => expect(document.querySelector('[data-assistant-knowledge]')).toBeNull())
  })

  it('показывает сохранённое помощником знание карточкой', async () => {
    mocks.config.mockResolvedValue(LOCAL)
    mocks.models.mockResolvedValue([
      { id: 'qwen2.5:7b', ref: 'ollama:qwen2.5:7b', provider: 'ollama', title: 'qwen2.5:7b', free: true, local: true, tools: true },
    ])
    mocks.stream.mockResolvedValue({
      ...TURN,
      knowledge: [{ id: 'k9', title: 'Выводы беседы', summary: 'главное', chars: 42, createdAt: '' }],
    })
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Сохрани выводы' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    expect(await screen.findByText('Сохранено в знания')).toBeTruthy()
    const card = document.querySelector('[data-assistant-knowledge-saved]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Выводы беседы')
  })

  it('объясняет, почему файл не прикрепился', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'], defaultModel: 'groq:зрячая' })
    mocks.models.mockResolvedValue([
      {
        id: 'зрячая',
        ref: 'groq:зрячая',
        provider: 'groq',
        title: 'Зрячая',
        free: false,
        local: false,
        tools: true,
        vision: true,
      },
    ])
    renderPanel()
    await screen.findByLabelText('Сообщение помощнику')

    const fileInput = document.querySelector('[data-assistant-file]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'схема.svg', { type: 'image/svg+xml' })] },
    })

    expect(await screen.findByText(/схема\.svg/)).toBeTruthy()
    expect(document.querySelector('[data-assistant-attach]')).toBeNull()
  })

  it('показывает предложения сервера и подставляет выбранное в поле ввода', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockResolvedValue({
      ...TURN,
      suggestions: [
        { id: 'set-dates', label: 'Проставь даты', prompt: 'Проставь даты кадрам.', kind: 'text' },
        {
          id: 'illustrate-chapter',
          label: 'Нарисуй иллюстрацию к «Пролог»',
          prompt: 'Нарисуй иллюстрацию к главе «Пролог».',
          kind: 'image',
        },
      ],
    })
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Что дальше?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    // Предложение подставляет текст, а не отправляет его само: человек видит, что уйдёт
    // модели (и сколько это будет стоить), до отправки.
    const chip = await screen.findByRole('button', { name: 'Нарисуй иллюстрацию к «Пролог»' })
    fireEvent.click(chip)
    expect(input.value).toBe('Нарисуй иллюстрацию к главе «Пролог».')
  })

  it('«стоп» обрывает ответ и оставляет сказанное с пометкой', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockImplementation(
      (
        _projectId: string,
        _conversationId: string,
        _text: string,
        _model: string,
        options: {
          handlers?: { onDelta?: (text: string) => void }
          signal?: AbortSignal
        } = {},
      ) =>
        new Promise<AITurn>((_resolve, reject) => {
          options.handlers?.onDelta?.('Первый абзац')
          options.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),    )
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Расскажи' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    // Пока ответ идёт, вместо «Спросить» стоит «Стоп».
    const stop = await screen.findByRole('button', { name: 'Стоп' })
    await waitFor(() =>
      expect(document.querySelector('[data-assistant-live]')?.textContent).toContain('Первый абзац'),
    )
    fireEvent.click(stop)

    // Сказанное остаётся в переписке с пометкой, а не пропадает и не превращается в
    // «помощник не ответил»: остановку выбрал сам человек.
    await waitFor(() => expect(document.querySelector('[data-assistant-stopped]')).not.toBeNull())
    expect(screen.getByText('Первый абзац')).toBeTruthy()
    expect(screen.queryByText(/Помощник не ответил/)).toBeNull()
    expect(await screen.findByRole('button', { name: 'Спросить' })).toBeTruthy()
  })

  it('показывает объяснение сервера, а не общее «Помощник не ответил»', async () => {
    // 0.145.1: текст ошибки приходит событием потока — у такой ошибки нет HTTP-ответа, и
    // раньше любое объяснение сервера превращалось в «Помощник не ответил. Проверьте связь
    // и модель.» Человек не узнавал ни про загрузку модели, ни про размер контекста.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockRejectedValue(
      Object.assign(new Error('модель не начала отвечать'), {
        serverMessage: 'модель не начала отвечать за 4 мин — вероятно, она загружается',
      }),
    )
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Помоги с орфографией' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    expect(await screen.findByText(/вероятно, она загружается/)).toBeTruthy()
    expect(screen.queryByText('Помощник не ответил. Проверьте связь и модель.')).toBeNull()
  })

  it('ответ при закрытом окне отмечается как непрочитанный', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    // Запрос «висит»: человек закрывает окно, ответ приходит уже без него.
    let resolveSend: (turn: AITurn) => void = () => {}
    mocks.stream.mockImplementation(
      () =>
        new Promise<AITurn>((resolve) => {
          resolveSend = resolve
        }),
    )
    const unread = vi.fn()
    const { view, props } = renderPanel({ onUnread: unread })

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Создай главу' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))
    await waitFor(() => expect(mocks.stream).toHaveBeenCalled())

    // Окно закрыто (в доке оно просто прячется), панель продолжает работать.
    view.rerender(<AssistantPanel {...props} open={false} />)
    resolveSend(TURN)

    await waitFor(() => expect(unread).toHaveBeenCalled())
  })

  it('на просьбу о согласии в ответе показывает согласие, а не «ошибку сервера»', async () => {
    // Согласие считалось выданным, а сервер его не видит (отозвали в другой вкладке):
    // панель должна показать просьбу о согласии и не потерять набранный вопрос.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockRejectedValue(new Error('409'))
    mocks.error.mockResolvedValue({ message: 'нужно согласие', consentRequired: true })
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Создай главу' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    expect(await screen.findByText(/Сервер запросил согласие заново/)).toBeTruthy()
    // Вопрос не потерян: человек не должен набирать его заново.
    expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).value).toBe('Создай главу')
  })

  it('облачную модель Ollama показывает предупреждением и спрашивает согласие', async () => {
    mocks.config.mockResolvedValue(LOCAL)
    mocks.models.mockResolvedValue([
      { id: 'qwen2.5:7b', ref: 'ollama:qwen2.5:7b', provider: 'ollama', title: 'qwen2.5:7b', free: true, local: true, tools: true },
      // Облачная модель того же провайдера: считается на ollama.com.
      { id: 'glm-5.2:cloud', ref: 'ollama:glm-5.2:cloud', provider: 'ollama', title: 'glm-5.2:cloud', free: false, local: false, cloud: true, tools: true },
    ])
    renderPanel()

    // По умолчанию выбрана локальная: ни предупреждения, ни согласия.
    expect(await screen.findByText(/текст проекта не покидает сервер стенда/)).toBeTruthy()
    expect(screen.queryByText(/Выбрана ОБЛАЧНАЯ модель/)).toBeNull()

    // Модель выбирается в настройке — втором виде того же окна.
    fireEvent.click(screen.getByRole('button', { name: 'Настройка помощника' }))
    fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'ollama:glm-5.2:cloud' } })

    expect(await screen.findByText(/Выбрана ОБЛАЧНАЯ модель/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к переписке' }))
    expect(await screen.findByText(/уйдёт ОБЛАЧНОЙ модели/)).toBeTruthy()
    expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('настройка — второй вид окна: провайдер, модель, ключ и возврат к переписке', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    renderPanel()

    // В переписке настроек нет: они не отвлекают от разговора.
    expect(await screen.findByLabelText('Сообщение помощнику')).toBeTruthy()
    expect(screen.queryByLabelText('Ключ провайдера')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Настройка помощника' }))
    expect(await screen.findByText('Провайдер')).toBeTruthy()
    expect(screen.getByLabelText('Модель')).toBeTruthy()

    const field = screen.getByLabelText('Ключ провайдера')
    fireEvent.change(field, { target: { value: 'gsk_secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(mocks.saveKey).toHaveBeenCalledWith('groq', 'gsk_secret'))
    expect(await screen.findByText(/Ключ сохранён/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к переписке' }))
    expect(await screen.findByLabelText('Сообщение помощнику')).toBeTruthy()
    expect(screen.queryByLabelText('Ключ провайдера')).toBeNull()
  })

  it('свой сервер моделей добавляется с адресом и сразу становится выбранным', async () => {
    const added: AIEndpoint = {
      id: 'e1',
      title: 'Моя машина',
      url: 'http://192.168.1.10:8080/v1',
      local: true,
      hasKey: false,
      providerId: 'own:e1',
    }
    // Настройка читается дважды: при открытии и после добавления — во второй раз в ней
    // уже есть провайдер нового сервера.
    mocks.config
      .mockResolvedValueOnce({ ...REMOTE, consents: ['groq'] })
      .mockResolvedValue({
        ...REMOTE,
        consents: ['groq'],
        providers: [
          ...REMOTE.providers,
          {
            id: 'own:e1',
            title: 'Моя машина',
            note: 'свой сервер моделей',
            local: true,
            freeByDefault: true,
            hasKey: false,
            standKey: false,
            keyless: true,
            own: true,
            keyRequired: false,
          },
        ],
      })
    mocks.endpoints.mockResolvedValueOnce([]).mockResolvedValue([added])
    mocks.addEndpoint.mockResolvedValue(added)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    expect(await screen.findByText('Свои серверы моделей')).toBeTruthy()
    expect(await screen.findByText('Своих серверов пока нет.')).toBeTruthy()

    // Пустая форма не уходит на сервер: без названия сервер неотличим в списке моделей.
    fireEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }))
    expect(await screen.findByText(/Назовите сервер/)).toBeTruthy()
    expect(mocks.addEndpoint).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Название своего сервера'), {
      target: { value: 'Моя машина' },
    })
    fireEvent.change(screen.getByLabelText('Адрес своего сервера'), {
      target: { value: 'http://192.168.1.10:8080/v1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }))

    await waitFor(() =>
      expect(mocks.addEndpoint).toHaveBeenCalledWith({
        title: 'Моя машина',
        url: 'http://192.168.1.10:8080/v1',
        key: '',
        local: true,
      }),
    )
    // Человек добавил сервер, чтобы им пользоваться: он должен быть выбран, а не просто
    // появиться в списке.
    await waitFor(() =>
      expect((screen.getByLabelText('Провайдер') as HTMLSelectElement).value).toBe('own:e1'),
    )
    expect(await screen.findByText(/Сервер «Моя машина» добавлен/)).toBeTruthy()
  })

  it('свой сервер можно удалить, и выбор возвращается на доступного провайдера', async () => {
    const added: AIEndpoint = {
      id: 'e1',
      title: 'Моя машина',
      url: 'http://192.168.1.10:8080/v1',
      local: true,
      hasKey: false,
      providerId: 'own:e1',
    }
    mocks.config
      .mockResolvedValueOnce({
        ...REMOTE,
        consents: ['groq'],
        providers: [
          {
            id: 'own:e1',
            title: 'Моя машина',
            note: 'свой сервер моделей',
            local: true,
            freeByDefault: true,
            hasKey: false,
            standKey: false,
            keyless: true,
            own: true,
            keyRequired: false,
          },
          ...REMOTE.providers,
        ],
      })
      .mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.endpoints.mockResolvedValueOnce([added]).mockResolvedValue([])
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    await waitFor(() =>
      expect((screen.getByLabelText('Провайдер') as HTMLSelectElement).value).toBe('own:e1'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Удалить сервер Моя машина' }))
    await waitFor(() => expect(mocks.deleteEndpoint).toHaveBeenCalledWith('e1'))
    // Выбор не должен остаться на исчезнувшем сервере: это пустой список моделей без
    // объяснения причины.
    await waitFor(() =>
      expect((screen.getByLabelText('Провайдер') as HTMLSelectElement).value).toBe('groq'),
    )
    expect(await screen.findByText(/Сервер «Моя машина» удалён/)).toBeTruthy()
  })

  it('без AI_SECRET_KEY адрес ввести можно, а ключ — нет', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, keysReady: false, consents: ['groq'] })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    expect(await screen.findByText('Свои серверы моделей')).toBeTruthy()
    // Свой сервер без ключа (llama.cpp) — основной случай, и он должен работать даже
    // там, где хранение ключей не настроено.
    expect((screen.getByLabelText('Адрес своего сервера') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('Ключ своего сервера') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Добавить сервер' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('предложение правки показывается отдельно от изменений и применяется кнопкой', async () => {
    const proposal: AIProposal = {
      id: 'p1',
      kind: 'update_text',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Пролог',
      oldTitle: 'Пролог',
      oldBody: 'Старый текст главы.',
      newTitle: 'Пролог',
      newBody: 'Новый текст главы.',
      oldSpan: '',
      oldDate: '',
      newDate: '',
      oldParentId: '',
      newParentId: '',
      oldParentTitle: '',
      newParentTitle: '',
      newSpan: '',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([proposal])
    mocks.applyProposal.mockResolvedValue({ proposal, warning: '' })
    renderPanel()

    // Блок отдельный: проект ещё не изменён, и это должно быть видно по подписи.
    expect(await screen.findByText('Предложенные правки')).toBeTruthy()
    expect(screen.getByText(/Переписать кадр «Пролог»/)).toBeTruthy()
    // «Было → станет» одной строкой: человек решает по ней.
    expect(screen.getByText(/Старый текст главы/)).toBeTruthy()
    expect(screen.queryByText('Изменения в проекте')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    await waitFor(() => expect(mocks.applyProposal).toHaveBeenCalledWith('p1', 'p1'))
    expect(await screen.findByText('Правки применены')).toBeTruthy()
    expect(screen.queryByText('Предложенные правки')).toBeNull()
  })

  it('правка фрагмента показывается как «было → станет» для куска и возвращается отдельной кнопкой', async () => {
    const spanProposal: AIProposal = {
      id: 'sp1',
      kind: 'update_span',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Пролог',
      oldTitle: '',
      oldBody: '',
      newTitle: '',
      newBody: '',
      commentId: 'c1',
      oldSpan: 'текст главы',
      oldDate: '',
      newDate: '',
      oldParentId: '',
      newParentId: '',
      oldParentTitle: '',
      newParentTitle: '',
      newSpan: 'логика восстановлена',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([spanProposal])
    mocks.applyProposal.mockResolvedValue({ proposal: { ...spanProposal, status: 'applied' }, warning: '' })
    renderPanel()

    // Подпись отличает правку фрагмента от перезаписи кадра: человек подтверждает то,
    // что прочитал, а не «правку вообще».
    expect(await screen.findByText(/Правка фрагмента в кадре «Пролог»/)).toBeTruthy()
    expect(screen.getByText(/текст главы/)).toBeTruthy()
    expect(screen.getByText(/логика восстановлена/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    await waitFor(() => expect(mocks.applyProposal).toHaveBeenCalledWith('p1', 'sp1'))
    expect(await screen.findByText(/Фрагмент в кадре «Пролог» изменён/)).toBeTruthy()
    // Кнопка возврата говорит про фрагмент, а не про весь текст кадра.
    expect(screen.getByRole('button', { name: 'Вернуть прежний фрагмент' })).toBeTruthy()
  })
  it('правка даты показывается как «было → станет» и возвращается прежней датой', async () => {
    const dateProposal: AIProposal = {
      id: 'dp1',
      kind: 'update_date',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Пролог',
      oldTitle: '',
      oldBody: '',
      newTitle: '',
      newBody: '',
      oldSpan: '',
      newSpan: '',
      oldDate: '',
      newDate: '2026-03-05',
      oldParentId: '',
      newParentId: '',
      oldParentTitle: '',
      newParentTitle: '',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([dateProposal])
    mocks.applyProposal.mockResolvedValue({
      proposal: { ...dateProposal, status: 'applied' },
      warning: '',
    })
    renderPanel()

    // Подпись отличает правку даты от перезаписи текста: человек подтверждает то, что прочитал.
    expect(await screen.findByText(/Поменять дату кадра «Пролог»/)).toBeTruthy()
    expect(screen.getByText(/дата: без даты → 2026-03-05/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    await waitFor(() => expect(mocks.applyProposal).toHaveBeenCalledWith('p1', 'dp1'))
    expect(await screen.findByText(/Дата кадра «Пролог» изменена/)).toBeTruthy()
    // Возврат говорит именно про дату: текст кадра эта правка не трогала.
    expect(screen.getByRole('button', { name: 'Вернуть прежнюю дату' })).toBeTruthy()
  })

  it('перенос кадра показывается «куда» и возвращается в прежнюю главу', async () => {
    const moveProposal: AIProposal = {
      id: 'mp1',
      kind: 'move_event',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Под-событие',
      oldTitle: '',
      oldBody: '',
      newTitle: '',
      newBody: '',
      oldSpan: '',
      newSpan: '',
      oldDate: '',
      newDate: '',
      oldParentId: 'ch1',
      newParentId: '',
      oldParentTitle: 'Глава 1',
      newParentTitle: '',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([moveProposal])
    mocks.applyProposal.mockResolvedValue({
      proposal: { ...moveProposal, status: 'applied' },
      warning: '',
    })
    renderPanel()

    // В подписи — КУДА переносим: «переместить» без адреса человек подтверждал бы вслепую.
    expect(await screen.findByText(/Переместить кадр «Под-событие» в верхний уровень/)).toBeTruthy()
    expect(screen.getByText(/место: Глава 1 → верхний уровень/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    await waitFor(() => expect(mocks.applyProposal).toHaveBeenCalledWith('p1', 'mp1'))
    expect(await screen.findByText(/Кадр «Под-событие» перемещён в верхний уровень/)).toBeTruthy()
    // Возврат говорит про главу: текст и дата этой правкой не менялись.
    expect(screen.getByRole('button', { name: 'Вернуть в прежнюю главу' })).toBeTruthy()
  })

  it('применённую перезапись можно вернуть прежним текстом', async () => {
    const update: AIProposal = {
      id: 'p1',
      kind: 'update_text',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Пролог',
      oldTitle: 'Пролог',
      oldBody: 'Старый текст.',
      newTitle: 'Пролог',
      newBody: 'Новый текст.',
      oldSpan: '',
      oldDate: '',
      newDate: '',
      oldParentId: '',
      newParentId: '',
      oldParentTitle: '',
      newParentTitle: '',
      newSpan: '',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([update])
    mocks.applyProposal.mockResolvedValue({ proposal: update, warning: '' })
    mocks.revertProposal.mockResolvedValue({ proposal: update, warning: '' })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Применить' }))
    await waitFor(() => expect(mocks.applyProposal).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Вернуть прежний текст' }))
    await waitFor(() => expect(mocks.revertProposal).toHaveBeenCalledWith('p1', 'p1'))
    // Вернувшееся предложение снова ждёт решения.
    expect(await screen.findByText('Предложенные правки')).toBeTruthy()
  })

  it('удалённый агентом кадр можно вернуть', async () => {
    const removal: AIProposal = {
      id: 'p1',
      kind: 'delete_event',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Лишний кадр',
      oldTitle: 'Лишний кадр',
      oldBody: 'текст',
      newTitle: '',
      newBody: '',
  oldSpan: '',
  oldDate: '',
  newDate: '',
  oldParentId: '',
  newParentId: '',
  oldParentTitle: '',
  newParentTitle: '',
  newSpan: '',
    }
    const applied: AIProposal = { ...removal, status: 'applied' }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([removal])
    mocks.applyProposal.mockResolvedValue({ proposal: applied, warning: '' })
    mocks.revertProposal.mockResolvedValue({ proposal: removal, warning: '' })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Применить' }))
    await waitFor(() => expect(mocks.applyProposal).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Удалён кадр «Лишний кадр»/)).toBeTruthy()
    // У удаления тоже есть отмена: кадр возвращается по снимку, который сохранил сервер.
    fireEvent.click(await screen.findByRole('button', { name: 'Вернуть кадр' }))
    await waitFor(() => expect(mocks.revertProposal).toHaveBeenCalledWith('p1', 'p1'))
    expect(await screen.findByText('Кадр вернулся на прежнее место.')).toBeTruthy()
    expect(await screen.findByText(/Удалить кадр «Лишний кадр»/)).toBeTruthy()
  })

  it('отклонённое предложение не меняет проект', async () => {
    const proposal: AIProposal = {
      id: 'p1',
      kind: 'delete_event',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Лишний кадр',
      oldTitle: 'Лишний кадр',
      oldBody: 'текст',
      newTitle: '',
      newBody: '',
  oldSpan: '',
  oldDate: '',
  newDate: '',
  oldParentId: '',
  newParentId: '',
  oldParentTitle: '',
  newParentTitle: '',
  newSpan: '',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([proposal])
    renderPanel()

    expect(await screen.findByText(/Удалить кадр «Лишний кадр»/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }))
    await waitFor(() => expect(mocks.discardProposal).toHaveBeenCalledWith('p1', 'p1'))
    expect(await screen.findByText(/проект не изменился/)).toBeTruthy()
    expect(screen.queryByText('Предложенные правки')).toBeNull()
  })

  it('предложение из потока появляется сразу, не дожидаясь конца ответа', async () => {
    const proposal: AIProposal = {
      id: 'p1',
      kind: 'update_text',
      status: 'pending',
      eventId: 'e1',
      eventTitle: 'Пролог',
      oldTitle: 'Пролог',
      oldBody: 'Старый текст.',
      newTitle: 'Пролог',
      newBody: 'Новый текст.',
      oldSpan: '',
      oldDate: '',
      newDate: '',
      oldParentId: '',
      newParentId: '',
      oldParentTitle: '',
      newParentTitle: '',
      newSpan: '',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockImplementation(async (...args: unknown[]) => {
      const options = args[4] as { handlers?: { onProposal?: (p: AIProposal) => void } }
      options.handlers?.onProposal?.(proposal)
      return TURN
    })
    renderPanel()

    const input = await screen.findByLabelText('Сообщение помощнику')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Перепиши пролог' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    expect(await screen.findByText(/Переписать кадр «Пролог»/)).toBeTruthy()
  })

  it('применённую правку видно и после перезагрузки: «Вернуть» не теряется', async () => {
    // Сервер отдаёт и ожидающие, и применённые за последнюю неделю — иначе отмена
    // доставалась бы только тем, кто не закрыл вкладку.
    const applied: AIProposal = {
      id: 'p1',
      kind: 'update_text',
      status: 'applied',
      eventId: 'e1',
      eventTitle: 'Пролог',
      oldTitle: 'Пролог',
      oldBody: 'Старый текст.',
      newTitle: 'Пролог',
      newBody: 'Новый текст.',
      oldSpan: '',
      oldDate: '',
      newDate: '',
      oldParentId: '',
      newParentId: '',
      oldParentTitle: '',
      newParentTitle: '',
      newSpan: '',
    }
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.proposals.mockResolvedValue([applied])
    mocks.revertProposal.mockResolvedValue({
      proposal: { ...applied, status: 'pending' },
      warning: '',
    })
    renderPanel()

    expect(await screen.findByText('Правки применены')).toBeTruthy()
    expect(screen.queryByText('Предложенные правки')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть прежний текст' }))
    await waitFor(() => expect(mocks.revertProposal).toHaveBeenCalledWith('p1', 'p1'))
  })

  it('Enter отправляет вопрос, Shift+Enter оставляет перенос строки', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockResolvedValue(TURN)
    renderPanel()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.change(input, { target: { value: 'Первая строка' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(mocks.stream).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(1))
  })

  it('у своего сервера не предлагает вводить ключ отдельно: он задан вместе с адресом', async () => {
    // Свой сервер с ключом: в списке провайдеров он уже готов (hasKey, не keyRequired),
    // и формы «ключ провайдера» быть не должно — хранить его там негде, сервер отказал бы.
    mocks.config.mockResolvedValue({
      ...REMOTE,
      consents: ['own:e1'],
      providers: [
        {
          id: 'own:e1',
          title: 'Моя машина',
          note: 'свой сервер моделей',
          local: false,
          freeByDefault: true,
          hasKey: true,
          standKey: false,
          keyless: false,
          own: true,
          keyRequired: false,
        },
      ],
    })
    mocks.models.mockResolvedValue([{ ...MODELS[0], provider: 'own:e1', ref: 'own:e1:model' }])
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    expect(await screen.findByText(/Ключ этого сервера хранится вместе с адресом/)).toBeTruthy()
    expect(screen.queryByLabelText('Ключ провайдера')).toBeNull()
    // Свой сервер не «нужен ключ»: он готов, и отправлять с него уже можно.
    expect(screen.queryByText(/нужен ключ: добавьте свой/)).toBeNull()
    // И согласие у него спрашивают: он не в своей сети, текст уходит наружу.
    expect(await screen.findByText(/помощник спросит согласие/)).toBeTruthy()
  })

  it('у своего сервера без ключа пишет, что менять нечего', async () => {
    mocks.config.mockResolvedValue({
      ...REMOTE,
      consents: ['own:e1'],
      providers: [
        {
          id: 'own:e1',
          title: 'llama.cpp дома',
          note: 'свой сервер моделей',
          local: true,
          freeByDefault: true,
          hasKey: true,
          standKey: false,
          keyless: true,
          own: true,
          keyRequired: false,
        },
      ],
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    expect(await screen.findByText(/Ключ этому серверу не нужен/)).toBeTruthy()
    expect(await screen.findByText(/llama.cpp дома — свой сервер/)).toBeTruthy()
  })

  it('называет агента по имени в шапке и в подписи ответов', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockResolvedValue(TURN)
    renderPanel()

    expect(await screen.findByText('Нестор')).toBeTruthy()
    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Привет' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    // Ответ подписан именем агента, а не словом «Помощник».
    await waitFor(() => expect(screen.getAllByText('Нестор').length).toBeGreaterThan(1))
    expect(screen.queryByText('Помощник')).toBeNull()
  })

  it('владелец задаёт роль и указания агента', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    const role = await screen.findByLabelText('Роль агента')
    fireEvent.change(role, { target: { value: 'chronicler' } })
    fireEvent.change(screen.getByLabelText('Указания агенту'), {
      target: { value: 'Пиши сдержанно.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить роль' }))

    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith('p1', {
        role: 'chronicler',
        instructions: 'Пиши сдержанно.',
        enabled: true,
        generation: 'auto',
        imageStyle: '',
        imageNegative: '',
      }),
    )
    expect(await screen.findByText(/роль «Летописец»/)).toBeTruthy()
  })

  it('показывает режим генерации, причину недоступности и стиль иллюстраций', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    const mode = (await screen.findByLabelText('Режим генерации')) as HTMLSelectElement
    expect(mode.value).toBe('auto')

    // Режимы с картинками видны, но недоступны — и рядом написана причина, а не
    // загадочное «недоступно».
    const both = screen.getByRole('option', { name: /Текст и картинки/ }) as HTMLOptionElement
    expect(both.disabled).toBe(true)
    expect(document.querySelector('[data-assistant-generation-hint]')?.textContent).toMatch(
      /недоступн/i,
    )
    expect(document.querySelector('[data-assistant-images-unavailable]')?.textContent).toMatch(
      /не настроен/,
    )

    // Стиль сохраняется вместе с ролью: он пригодится, когда генератор появится.
    fireEvent.change(screen.getByLabelText('Стиль иллюстраций'), {
      target: { value: 'акварель, тёплый свет' },
    })
    // Негативный промпт — тоже настройка проекта (0.105.0), и пустое поле объясняется словами:
    // «как на стенде», а не «без ограничений».
    expect(document.querySelector('[data-assistant-negative-hint]')?.textContent).toMatch(
      /как на стенде/,
    )
    fireEvent.change(screen.getByLabelText('Чего не должно быть на картинке'), {
      target: { value: 'люди, современная одежда' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить роль' }))
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith('p1', {
        role: '',
        instructions: '',
        enabled: true,
        generation: 'auto',
        imageStyle: 'акварель, тёплый свет',
        imageNegative: 'люди, современная одежда',
      }),
    )
  })

  // Загруженный негативный промпт виден в поле, а не «сохранился, но показывается пустым».
  it('показывает сохранённый негативный промпт проекта', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.settings.mockResolvedValue({
      ...AGENT,
      generation: 'both',
      imageStyle: 'акварель',
      imageNegative: 'без текста и водяных знаков',
      capabilities: { ...AGENT.capabilities, images: true, imageStyle: 'акварель' },
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    const negative = (await screen.findByLabelText(
      'Чего не должно быть на картинке',
    )) as HTMLInputElement
    expect(negative.value).toBe('без текста и водяных знаков')
  })

  it('редактору роль агента показывают, но менять не дают', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.settings.mockResolvedValue({ ...AGENT, canEdit: false, roleTitle: 'Летописец' })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Настройка помощника' }))
    expect(await screen.findByText(/Роль агента задаёт владелец проекта/)).toBeTruthy()
    expect(screen.queryByLabelText('Роль агента')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Сохранить роль' })).toBeNull()
  })

  /**
   * 0.125.0: подписи окна — из словаря. Проверяем главное: поле ввода, кнопки отправки и
   * настройка помощника говорят по-английски, а имя агента и модели остаются данными
   * (его задаёт сервер: «Нестор», «Llama 3.1 8B»).
   */
  it('на английском подписи окна переведены', async () => {
    setLang('en')
    mocks.config.mockResolvedValue(LOCAL)
    renderPanel()

    const input = (await screen.findByLabelText('Message to the assistant')) as HTMLTextAreaElement
    expect(input.disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Assistant settings' })).toBeTruthy()
    // Данные: имя агента приходит с сервера.
    expect(screen.getByText('Нестор')).toBeTruthy()

    // Настройка: провайдер, модель, свой сервер.
    fireEvent.click(screen.getByRole('button', { name: 'Assistant settings' }))
    expect(await screen.findByText('Own model servers')).toBeTruthy()
    expect(screen.getByLabelText('Provider')).toBeTruthy()
    expect(screen.getByLabelText('Own server address')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add the server' })).toBeTruthy()
    expect(screen.getByText('Agent role and behaviour')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save the role' })).toBeTruthy()
  })

  /**
   * 0.132.0: цитата из показа проекта. В поле подставляется готовый вопрос про фрагмент, но
   * отправки нет — человек дописывает, что именно хочет узнать.
   */
  it('цитата из показа подставляется в поле помощника и не отправляется', async () => {
    mocks.config.mockResolvedValue(LOCAL)
    renderPanel({
      prefill: {
        tab: 'assistant',
        nonce: 1,
        frameId: 'f1',
        frameTitle: 'Пролог',
        quote: 'Аня стоит на пороге',
      },
    })

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toContain('Аня стоит на пороге'))
    expect(input.value).toContain('Пролог')
    // Подсказка про фрагмент, но отправки нет: решает человек.
    expect(mocks.stream).not.toHaveBeenCalled()
  })

  it('цитата, адресованная чату, помощника не трогает', async () => {
    mocks.config.mockResolvedValue(LOCAL)
    renderPanel({
      prefill: { tab: 'chat', nonce: 3, frameId: 'f1', frameTitle: 'Пролог', quote: 'не сюда' },
    })
    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    expect(input.value).toBe('')
  })

  /**
   * 0.147.0: беседы с помощником — часть проекта, они лежат на сервере и переживают закрытие
   * страницы. Окно при открытии возвращает человека в ту беседу, которую он смотрел последней.
   */
  const savedConversation = (projectId: string, conversationId: string) =>
    localStorage.setItem(`sf-ai-last:${projectId}`, conversationId)

  it('восстанавливает последнюю беседу проекта после перезагрузки (0.147.0)', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    savedConversation('p1', 'c2')
    mocks.conversations.mockResolvedValue([
      { id: 'c2', title: 'Правки главы', model: 'm', updatedAt: '2026-11-03T10:00:00Z' },
      { id: 'c1', title: 'Старая беседа', model: 'm', updatedAt: '2026-11-02T10:00:00Z' },
    ])
    mocks.conversation.mockResolvedValue({
      conversation: null,
      messages: [
        { id: 'm1', role: 'user', content: 'Поправь второй абзац', createdAt: '2026-11-03T09:59:00Z' },
        { id: 'm2', role: 'assistant', content: 'Предлагаю правку второго абзаца.', createdAt: '2026-11-03T10:00:00Z' },
        // Служебные строки в переписке не показываются: это результаты инструментов.
        { id: 'm3', role: 'tool', content: '{"events":[]}', createdAt: '2026-11-03T10:00:01Z' },
        { id: 'm4', role: 'assistant', content: '', createdAt: '2026-11-03T10:00:02Z' },
      ],
    })
    renderPanel()

    // Человек видит продолжение того разговора, а не пустое окно.
    expect(await screen.findByText('Предлагаю правку второго абзаца.')).toBeTruthy()
    expect(screen.getByText('Поправь второй абзац')).toBeTruthy()
    expect(mocks.conversation).toHaveBeenCalledWith('p1', 'c2')
    // Служебное не попало в переписку: плашек ровно две.
    expect(document.querySelectorAll('[data-assistant-log] .ai-msg').length).toBe(2)
    // Вопрос можно продолжать: окно не в состоянии «новый разговор».
    expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('без подсказки открывает самую свежую беседу проекта (0.147.0)', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.conversations.mockResolvedValue([
      { id: 'c9', title: 'Свежая', model: 'm', updatedAt: '2026-11-03T10:00:00Z' },
      { id: 'c8', title: 'Прежняя', model: 'm', updatedAt: '2026-11-01T10:00:00Z' },
    ])
    mocks.conversation.mockResolvedValue({
      conversation: null,
      messages: [{ id: 'm1', role: 'assistant', content: 'Продолжаем с этого места.', createdAt: '' }],
    })
    renderPanel()

    expect(await screen.findByText('Продолжаем с этого места.')).toBeTruthy()
    expect(mocks.conversation).toHaveBeenCalledWith('p1', 'c9')
  })

  it('«История» открывает другую беседу проекта (0.147.0)', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.conversations.mockResolvedValue([
      { id: 'c2', title: 'Правки главы', model: 'm', updatedAt: '2026-11-03T10:00:00Z' },
      { id: 'c1', title: 'Старая беседа', model: 'm', updatedAt: '2026-11-02T10:00:00Z' },
    ])
    mocks.conversation.mockResolvedValue({
      conversation: null,
      messages: [{ id: 'm1', role: 'assistant', content: 'Ответ из свежей беседы.', createdAt: '' }],
    })
    renderPanel()
    await screen.findByText('Ответ из свежей беседы.')

    fireEvent.click(screen.getByRole('button', { name: /История/ }))
    const item = await screen.findByRole('menuitem', { name: /Старая беседа/ })
    mocks.conversation.mockResolvedValue({
      conversation: null,
      messages: [{ id: 'm7', role: 'assistant', content: 'Ответ из старой беседы.', createdAt: '' }],
    })
    fireEvent.click(item)

    expect(await screen.findByText('Ответ из старой беседы.')).toBeTruthy()
    expect(mocks.conversation).toHaveBeenLastCalledWith('p1', 'c1')
    // Подсказка «последняя беседа» переключилась на выбранную.
    expect(localStorage.getItem('sf-ai-last:p1')).toBe('c1')
  })

  it('«Новый» начинает разговор заново и забывает прежнюю беседу (0.147.0)', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    savedConversation('p1', 'c2')
    mocks.conversations.mockResolvedValue([
      { id: 'c2', title: 'Правки главы', model: 'm', updatedAt: '2026-11-03T10:00:00Z' },
    ])
    mocks.conversation.mockResolvedValue({
      conversation: null,
      messages: [
        { id: 'm1', role: 'user', content: 'Поправь второй абзац', createdAt: '' },
        { id: 'm2', role: 'assistant', content: 'Предлагаю правку.', createdAt: '' },
      ],
    })
    renderPanel()
    await screen.findByText('Предлагаю правку.')

    fireEvent.click(screen.getByRole('button', { name: 'Новый' }))
    await waitFor(() => expect(screen.queryByText('Предлагаю правку.')).toBeNull())
    // Подсказки больше нет: следующее открытие проекта начнётся с чистого окна.
    expect(localStorage.getItem('sf-ai-last:p1')).toBeNull()
  })

  /**
   * 0.148.0: беседы копятся, и человек должен уметь убрать и одну, и всю историю.
   *
   * Проверяем именно то, что видно: крестик удаляет беседу из списка и, если она была
   * открыта, окно начинает новый разговор; очистка спрашивает второго нажатия и не трогает
   * сервер до него.
   */
  it('крестик удаляет беседу, а открытую — очищает (0.148.0)', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    savedConversation('p1', 'c2')
    mocks.conversations.mockResolvedValue([
      { id: 'c2', title: 'Правки главы', model: 'm', updatedAt: '2026-11-03T10:00:00Z' },
      { id: 'c1', title: 'Старая беседа', model: 'm', updatedAt: '2026-11-02T10:00:00Z' },
    ])
    mocks.conversation.mockResolvedValue({
      conversation: null,
      messages: [{ id: 'm2', role: 'assistant', content: 'Предлагаю правку.', createdAt: '' }],
    })
    renderPanel()
    await screen.findByText('Предлагаю правку.')

    fireEvent.click(screen.getByRole('button', { name: /История/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить беседу «Правки главы»' }))

    await waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledWith('p1', 'c2'))
    // Открытая беседа удалена — окно начинает новый разговор.
    await waitFor(() => expect(screen.queryByText('Предлагаю правку.')).toBeNull())
    expect(localStorage.getItem('sf-ai-last:p1')).toBeNull()
    // В списке осталась только вторая.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Удалить беседу «Правки главы»' })).toBeNull(),
    )
    expect(screen.getByRole('button', { name: 'Удалить беседу «Старая беседа»' })).toBeTruthy()
  })

  it('«Очистить историю» удаляет только со второго нажатия (0.148.0)', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.conversations.mockResolvedValue([
      { id: 'c2', title: 'Правки главы', model: 'm', updatedAt: '2026-11-03T10:00:00Z' },
    ])
    mocks.conversation.mockResolvedValue({
      conversation: null,
      messages: [{ id: 'm2', role: 'assistant', content: 'Предлагаю правку.', createdAt: '' }],
    })
    mocks.clearConversations.mockResolvedValue(1)
    renderPanel()
    await screen.findByText('Предлагаю правку.')

    fireEvent.click(screen.getByRole('button', { name: /История/ }))
    const clear = await screen.findByRole('menuitem', { name: 'Очистить историю' })
    fireEvent.click(clear)
    // Первое нажатие только спрашивает — сервер не тронут.
    expect(mocks.clearConversations).not.toHaveBeenCalled()
    const armed = await screen.findByRole('menuitem', { name: 'Точно очистить?' })
    fireEvent.click(armed)

    await waitFor(() => expect(mocks.clearConversations).toHaveBeenCalledWith('p1'))
    // История пуста, окно новое, подсказка снята.
    await waitFor(() => expect(screen.queryByText('Предлагаю правку.')).toBeNull())
    expect(localStorage.getItem('sf-ai-last:p1')).toBeNull()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /История/ })).toBeNull(),
    )
  })
})
