import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AIConfig, AIModel, AITurn } from '../../api/assistant'
import { AssistantPanel } from './AssistantPanel'

/**
 * Панель помощника: то, что видит и чего не видит человек.
 *
 * Сеть подменена целиком. Проверяем правила, а не разметку:
 *   - пока нет согласия на отправку текста внешнему провайдеру, поле ввода
 *     заблокировано, а согласие можно выдать одной кнопкой;
 *   - у локальной модели согласия не спрашивают вовсе (текст никуда не уходит);
 *   - «что изменилось» показывается из ответа СЕРВЕРА, а не из текста модели;
 *   - выключенный помощник не притворяется работающим.
 *
 * Markdown-рендер подменён: панель проверяется как поведение, а сам рендер разметки
 * покрыт своими тестами (MarkdownBlock).
 */

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  models: vi.fn(),
  send: vi.fn(),
  consent: vi.fn(),
  revoke: vi.fn(),
  saveKey: vi.fn(),
  deleteKey: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../api/assistant')>('../../api/assistant')
  return {
    // Разбор и правила оставляем настоящими: панель должна ходить через них.
    parseAIConfig: actual.parseAIConfig,
    parseAITurn: actual.parseAITurn,
    needsConsent: actual.needsConsent,
    isCloudModelRef: actual.isCloudModelRef,
    changeLabel: actual.changeLabel,
    getAIConfig: mocks.config,
    listAIModels: mocks.models,
    sendAIMessage: mocks.send,
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

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Открыть' }))
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.error.mockResolvedValue({ message: null, consentRequired: false })
  mocks.models.mockResolvedValue(MODELS)
  mocks.consent.mockResolvedValue(undefined)
  mocks.saveKey.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('AssistantPanel', () => {
  it('выключенный помощник честно об этом говорит и не даёт поля ввода', async () => {
    mocks.config.mockResolvedValue({ ...LOCAL, enabled: false })
    render(<AssistantPanel projectId="p1" onProjectChanged={() => {}} onOpenEditors={() => {}} />)
    open()
    expect(await screen.findByText(/Помощник выключен на этом стенде/)).toBeTruthy()
    expect(screen.queryByLabelText('Сообщение помощнику')).toBeNull()
  })

  it('без согласия поле ввода заблокировано, кнопка согласия его открывает', async () => {
    mocks.config.mockResolvedValue(REMOTE)
    render(<AssistantPanel projectId="p1" onProjectChanged={() => {}} onOpenEditors={() => {}} />)
    open()

    const consent = await screen.findByText(/уйдёт провайдеру «Groq»/)
    expect(consent).toBeTruthy()
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
    render(<AssistantPanel projectId="p1" onProjectChanged={() => {}} onOpenEditors={() => {}} />)
    open()
    expect(await screen.findByText(/текст проекта не покидает сервер стенда/)).toBeTruthy()
    expect(screen.queryByText(/уйдёт провайдеру/)).toBeNull()
    expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('показывает ответ модели и отдельный блок «что изменилось» из ответа сервера', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.send.mockResolvedValue(TURN)
    const changed = vi.fn()
    render(<AssistantPanel projectId="p1" onProjectChanged={changed} onOpenEditors={() => {}} />)
    open()

    const input = (await screen.findByLabelText('Сообщение помощнику')) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Добавь главу «Пролог»' } })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))

    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('p1', 'new', 'Добавь главу «Пролог»', 'groq:llama-3.1-8b'))
    expect(await screen.findByText('Создал главу «Пролог».')).toBeTruthy()
    const block = await screen.findByText('Изменения в проекте')
    expect(block).toBeTruthy()
    expect(screen.getByText('создана глава «Пролог»')).toBeTruthy()
    // Страница должна узнать об изменениях: без realtime иначе не перечитать проект.
    expect(changed).toHaveBeenCalled()
  })

  it('на просьбу о согласии в ответе показывает согласие, а не «ошибку сервера»', async () => {
    // Согласие считалось выданным, а сервер его не видит (отозвали в другой вкладке):
    // панель должна показать просьбу о согласии и не потерять набранный вопрос.
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    mocks.send.mockRejectedValue(new Error('409'))
    mocks.error.mockResolvedValue({ message: 'нужно согласие', consentRequired: true })
    render(<AssistantPanel projectId="p1" onProjectChanged={() => {}} onOpenEditors={() => {}} />)
    open()

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
    render(<AssistantPanel projectId="p1" onProjectChanged={() => {}} onOpenEditors={() => {}} />)
    open()

    // По умолчанию выбрана локальная: ни предупреждения, ни согласия.
    expect(await screen.findByText(/текст проекта не покидает сервер стенда/)).toBeTruthy()
    expect(screen.queryByText(/Выбрана ОБЛАЧНАЯ модель/)).toBeNull()

    fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'ollama:glm-5.2:cloud' } })

    expect(await screen.findByText(/Выбрана ОБЛАЧНАЯ модель/)).toBeTruthy()
    expect(screen.getByText(/уйдёт ОБЛАЧНОЙ модели/)).toBeTruthy()
    expect((screen.getByLabelText('Сообщение помощнику') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('сохраняет ключ провайдера и не отправляет его куда-либо ещё', async () => {
    mocks.config.mockResolvedValue({ ...REMOTE, consents: ['groq'] })
    render(<AssistantPanel projectId="p1" onProjectChanged={() => {}} onOpenEditors={() => {}} />)
    open()

    fireEvent.click(await screen.findByRole('button', { name: 'Ключи и доступ' }))
    const field = screen.getByLabelText('Ключ провайдера')
    fireEvent.change(field, { target: { value: 'gsk_secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ключ' }))

    await waitFor(() => expect(mocks.saveKey).toHaveBeenCalledWith('groq', 'gsk_secret'))
    expect(await screen.findByText(/Ключ сохранён/)).toBeTruthy()
  })
})
