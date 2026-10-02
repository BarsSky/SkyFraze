import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Разбор ответов помощника и запросы к серверу.
 *
 * Сеть подменена целиком (как в `storyFiles.test.ts`): проверяем форму запроса и
 * разбор ответа. Отдельно закреплены два правила, на которых держится вся панель:
 * согласие требуется только для НЕлокального провайдера, а «что изменилось» берётся
 * из `changes` сервера, а не из текста модели.
 */
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))

vi.mock('./client', () => ({ http: { get: mocks.get, post: mocks.post, delete: mocks.del } }))

import {
  changeLabel,
  deleteAIConsent,
  getAIConfig,
  isCloudModelRef,
  listAIModels,
  needsConsent,
  parseAIConfig,
  parseAIModels,
  parseAITurn,
  readAIError,
  saveAIKey,
  sendAIMessage,
  setAIConsent,
  type AIConfig,
} from './assistant'

function reply(body: unknown, headers: Record<string, string> = {}) {
  return { json: async () => body, headers: new Headers(headers) }
}

beforeEach(() => {
  mocks.get.mockReset()
  mocks.post.mockReset()
  mocks.del.mockReset()
})

const config: AIConfig = {
  enabled: true,
  keysReady: true,
  defaultModel: 'groq:llama-3.1-8b',
  maxToolCalls: 10,
  providers: [
    {
      id: 'ollama',
      title: 'Локальная модель (Ollama)',
      note: 'работает без ключа',
      local: true,
      freeByDefault: true,
      hasKey: true,
      standKey: false,
      keyRequired: false,
    },
    {
      id: 'groq',
      title: 'Groq',
      note: 'бесплатный тариф',
      local: false,
      freeByDefault: true,
      hasKey: false,
      standKey: false,
      keyRequired: true,
    },
  ],
  consents: [],
}

describe('needsConsent', () => {
  it('не спрашивает согласие у локальной модели', () => {
    expect(needsConsent(config, 'ollama', 'ollama:qwen2.5:7b')).toBe(false)
  })

  it('спрашивает согласие у внешнего провайдера и перестаёт после выдачи', () => {
    expect(needsConsent(config, 'groq', 'groq:llama-3.1-8b')).toBe(true)
    expect(needsConsent({ ...config, consents: ['groq'] }, 'groq', 'groq:llama-3.1-8b')).toBe(false)
  })

  it('спрашивает согласие у ОБЛАЧНОЙ модели локального провайдера', () => {
    // Провайдер тот же Ollama, но модель считается на ollama.com: текст проекта
    // уходит наружу, значит без согласия отправлять нельзя.
    expect(needsConsent(config, 'ollama', 'ollama:qwen3.5:cloud')).toBe(true)
    expect(
      needsConsent({ ...config, consents: ['ollama'] }, 'ollama', 'ollama:qwen3.5:cloud'),
    ).toBe(false)
  })

  it('молчит, если настройка ещё не пришла или провайдер неизвестен', () => {
    expect(needsConsent(null, 'groq', 'groq:x')).toBe(false)
    expect(needsConsent(config, '', '')).toBe(false)
    expect(needsConsent(config, 'nope', 'nope:x')).toBe(false)
  })
})

describe('isCloudModelRef', () => {
  it('узнаёт облачную модель по суффиксу, который ставит Ollama', () => {
    expect(isCloudModelRef('ollama:glm-5.2:cloud')).toBe(true)
    expect(isCloudModelRef('OLLAMA:GLM:CLOUD')).toBe(true)
    expect(isCloudModelRef('ollama:qwen2.5:7b')).toBe(false)
    expect(isCloudModelRef('')).toBe(false)
  })
})

describe('changeLabel', () => {
  it('называет созданное по данным сервера, а не по тексту модели', () => {
    expect(changeLabel({ action: 'created_chapter', id: '1', title: 'Пролог' })).toBe(
      'создана глава «Пролог»',
    )
    expect(changeLabel({ action: 'created_sub_event', id: '2', title: 'Мир' })).toBe(
      'создано под-событие «Мир»',
    )
    expect(changeLabel({ action: 'unknown', id: '3', title: 'Что-то' })).toBe(
      'изменение: «Что-то»',
    )
    expect(changeLabel({ action: 'unknown', id: '4', title: '' })).toBe('изменение проекта')
  })
})

describe('parseAIConfig', () => {
  it('читает провайдеров и согласия, не падая на мусоре', () => {
    const parsed = parseAIConfig({
      enabled: true,
      keys_ready: false,
      default_model: 'groq:x',
      max_tool_calls: 5,
      providers: [
        { id: 'groq', title: 'Groq', local: false, has_key: true, key_required: false },
        { title: 'без идентификатора' },
        'мусор',
      ],
      consents: ['groq', 42],
    })
    expect(parsed.enabled).toBe(true)
    expect(parsed.keysReady).toBe(false)
    expect(parsed.maxToolCalls).toBe(5)
    expect(parsed.providers.map((p) => p.id)).toEqual(['groq'])
    expect(parsed.providers[0].hasKey).toBe(true)
    expect(parsed.consents).toEqual(['groq'])
  })

  it('пустой ответ — выключенный помощник без провайдеров', () => {
    const parsed = parseAIConfig(null)
    expect(parsed.enabled).toBe(false)
    expect(parsed.providers).toEqual([])
    expect(parsed.consents).toEqual([])
  })
})

describe('parseAIModels', () => {
  it('модель без поля tools считается умеющей: отказ виден в чате', () => {
    const models = parseAIModels({
      models: [
        { id: 'a', ref: 'groq:a', provider: 'groq', title: 'A', tools: false },
        { id: 'b', ref: 'groq:b', provider: 'groq', title: 'B' },
        { id: '' },
      ],
    })
    expect(models).toHaveLength(2)
    expect(models[0].tools).toBe(false)
    expect(models[1].tools).toBe(true)
    expect(models[1].free).toBe(false)
  })

  it('облачность видна и без поля cloud: по имени модели', () => {
    const models = parseAIModels({
      models: [
        { id: 'glm-5.2:cloud', ref: 'ollama:glm-5.2:cloud', provider: 'ollama', title: 'glm', local: true },
        { id: 'qwen2.5:7b', ref: 'ollama:qwen2.5:7b', provider: 'ollama', title: 'qwen', local: true },
      ],
    })
    expect(models[0].cloud).toBe(true)
    expect(models[1].cloud).toBe(false)
  })
})

describe('parseAITurn', () => {
  it('берёт изменения из ответа сервера и сохраняет отчёт о вызовах', () => {
    const turn = parseAITurn({
      conversation_id: 'c1',
      answer: 'Создал главу «Пролог».',
      model: 'llama',
      calls: [{ name: 'create_chapter', ok: true, detail: 'создал главу «Пролог»' }],
      changes: [{ action: 'created_chapter', id: 'e1', title: 'Пролог' }],
      message: { id: 'm2', role: 'assistant', content: 'Создал главу «Пролог».' },
    })
    expect(turn.conversationId).toBe('c1')
    expect(turn.changes).toEqual([
      { action: 'created_chapter', id: 'e1', title: 'Пролог', parentId: null },
    ])
    expect(turn.calls[0].ok).toBe(true)
    expect(turn.message.id).toBe('m2')
  })

  it('изменение без идентификатора не показывается: открыть нечего', () => {
    const turn = parseAITurn({ changes: [{ action: 'created_chapter', title: 'Без id' }] })
    expect(turn.changes).toEqual([])
  })
})

describe('запросы', () => {
  it('настройка, модели, ключ и согласие уходят на свои адреса', async () => {
    mocks.get.mockReturnValueOnce(reply({ enabled: true }))
    await getAIConfig()
    expect(mocks.get).toHaveBeenCalledWith('ai/config')

    mocks.get.mockReturnValueOnce(reply({ models: [] }))
    await listAIModels('groq')
    expect(mocks.get).toHaveBeenCalledWith('ai/models', {
      searchParams: { provider: 'groq' },
      timeout: 30000,
    })

    mocks.post.mockReturnValueOnce(reply({}))
    await saveAIKey('groq', 'secret')
    expect(mocks.post).toHaveBeenCalledWith('ai/keys', {
      json: { provider: 'groq', key: 'secret' },
      timeout: 30000,
    })

    mocks.post.mockReturnValueOnce(reply({}))
    await setAIConsent('groq')
    expect(mocks.post).toHaveBeenCalledWith('ai/consent', { json: { provider: 'groq' } })

    mocks.del.mockReturnValueOnce(reply({}))
    await deleteAIConsent('groq')
    expect(mocks.del).toHaveBeenCalledWith('ai/consent/groq')
  })

  it('сообщение уходит с моделью и длинным таймаутом: модель думает долго', async () => {
    mocks.post.mockReturnValueOnce(reply({ answer: 'готово', conversation_id: 'c9' }))
    const turn = await sendAIMessage('p1', 'new', 'Привет', 'groq:llama')
    expect(mocks.post).toHaveBeenCalledWith('projects/p1/ai/conversations/new/messages', {
      json: { text: 'Привет', model: 'groq:llama' },
      timeout: 300000,
    })
    expect(turn.answer).toBe('готово')
  })
})

describe('readAIError', () => {
  it('отличает просьбу о согласии от обычной ошибки', async () => {
    const consent = await readAIError({
      response: {
        clone: () => ({
          json: async () => ({ error: 'нужно согласие', consent_required: true }),
        }),
      },
    })
    expect(consent).toEqual({ message: 'нужно согласие', consentRequired: true })

    const plain = await readAIError({ response: { clone: () => ({ json: async () => ({}) }) } })
    expect(plain).toEqual({ message: null, consentRequired: false })

    const none = await readAIError(new Error('сеть'))
    expect(none).toEqual({ message: null, consentRequired: false })
  })
})
