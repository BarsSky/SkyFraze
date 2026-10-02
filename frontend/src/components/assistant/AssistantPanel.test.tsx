import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AIConfig, AIModel, AISettings, AITurn } from '../../api/assistant'
import { AssistantPanel } from './AssistantPanel'

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
    getAIConversation: vi.fn(),
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
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.error.mockResolvedValue({ message: null, consentRequired: false })
  mocks.models.mockResolvedValue(MODELS)
  mocks.consent.mockResolvedValue(undefined)
  mocks.saveKey.mockResolvedValue(undefined)
  mocks.settings.mockResolvedValue(AGENT)
  mocks.saveSettings.mockResolvedValue({ ...AGENT, role: 'chronicler', roleTitle: 'Летописец' })
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

  it('показывает текст ответа по мере генерации, а не после конца', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    let finish: (turn: AITurn) => void = () => {}
    mocks.stream.mockImplementation(
      (
        _projectId: string,
        _conversationId: string,
        _text: string,
        _model: string,
        handlers: { onDelta?: (text: string) => void } = {},
      ) =>
        new Promise<AITurn>((resolve) => {
          // Сервер сначала присылает куски текста, и только потом — итог.
          handlers.onDelta?.('Создал ')
          handlers.onDelta?.('главу «Пролог».')
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

  it('«стоп» обрывает ответ и оставляет сказанное с пометкой', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.stream.mockImplementation(
      (
        _projectId: string,
        _conversationId: string,
        _text: string,
        _model: string,
        handlers: { onDelta?: (text: string) => void } = {},
        signal?: AbortSignal,
      ) =>
        new Promise<AITurn>((_resolve, reject) => {
          handlers.onDelta?.('Первый абзац')
          signal?.addEventListener('abort', () => {
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
      }),
    )
    expect(await screen.findByText(/роль «Летописец»/)).toBeTruthy()
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
})
