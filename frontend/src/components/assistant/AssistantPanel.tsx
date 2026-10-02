import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  changeLabel,
  deleteAIConsent,
  deleteAIKey,
  getAIConfig,
  getAIConversation,
  isCloudModelRef,
  listAIModels,
  needsConsent,
  readAIError,
  saveAIKey,
  sendAIMessage,
  setAIConsent,
  type AIConfig,
  type AIChange,
  type AIMessage,
  type AIModel,
} from '../../api/assistant'
import { serverErrorMessage } from '../../api/client'
import { MarkdownBlock } from '../MarkdownBlock'

/**
 * Панель «ИИ-помощник» на странице проекта.
 *
 * Что здесь решено и почему именно так:
 *
 *   - **Отдельное поле для разговора**, а не «кнопка, которая сделает красиво».
 *     Человек пишет, что хочет, видит ответ и — главное — отдельный блок «что
 *     изменилось»: список созданных кадров приходит от сервера, а не вычитывается из
 *     текста модели. Модель может описать свои действия как угодно; интерфейс верит
 *     только серверу.
 *   - **Согласие спрашивается один раз и по каждому провайдеру.** Пока его нет,
 *     поле ввода заблокировано: текст проекта не должен уходить на чужую машину по
 *     случайному нажатию. Для локальной модели согласия не спрашиваем — текст никуда
 *     не уходит.
 *   - **Настройка (ключи и модели) живёт здесь же**, свёрнутая: человек, который
 *     только что получил «нужен ключ», не должен искать другой экран.
 *   - **Правки видит и вкладка без realtime.** После ответа с изменениями страница
 *     перечитывает состояние с сервера (см. onProjectChanged в ProjectTimelinePage):
 *     с открытым сокетом апдейт и так приезжает сам, без сокета — только так.
 */
interface Props {
  projectId: string
  /** Сообщить странице, что проект изменился (перечитать состояние без realtime). */
  onProjectChanged: () => void
  /** Перейти к панели редакторов: там созданные кадры видно в дереве. */
  onOpenEditors: () => void
}

export function AssistantPanel({ projectId, onProjectChanged, onOpenEditors }: Props) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<AIConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [models, setModels] = useState<AIModel[]>([])
  const [modelsNote, setModelsNote] = useState<string | null>(null)
  const [modelRef, setModelRef] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [keyNote, setKeyNote] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [conversationId, setConversationId] = useState('new')
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [changes, setChanges] = useState<AIChange[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [consentNeeded, setConsentNeeded] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Настройка грузится при первом открытии панели: до этого мы не знаем ни включён
  // ли помощник, ни какие провайдеры доступны, и показывать пустую панель незачем.
  useEffect(() => {
    if (!open || config !== null || configError !== null) return
    let alive = true
    getAIConfig()
      .then((loaded) => {
        if (!alive) return
        setConfig(loaded)
        const first =
          loaded.providers.find((p) => p.hasKey || p.local) ?? loaded.providers[0] ?? null
        if (first) setProviderId(first.id)
        if (loaded.defaultModel) setModelRef(loaded.defaultModel)
      })
      .catch(async (e) => {
        if (alive) setConfigError((await serverErrorMessage(e)) ?? 'Не удалось получить настройки помощника.')
      })
    return () => {
      alive = false
    }
  }, [open, config, configError])

  // Модели спрашиваются у провайдера, поэтому только когда человек выбрал провайдера:
  // иначе каждое открытие панели дёргало бы чужие API.
  useEffect(() => {
    if (!open || !providerId) return
    let alive = true
    setModelsNote(null)
    listAIModels(providerId)
      .then((list) => {
        if (!alive) return
        setModels(list)
        if (list.length === 0) {
          setModelsNote('У этого провайдера нет доступных моделей — проверьте ключ.')
          return
        }
        // Модель по умолчанию и выбранную ранее оставляем, если она есть у провайдера.
        setModelRef((current) => {
          if (current.startsWith(providerId + ':')) return current
          const preferred = list.find((m) => m.ref === config?.defaultModel) ?? list[0]
          return preferred.ref || `${providerId}:${preferred.id}`
        })
      })
      .catch(async (e) => {
        if (!alive) return
        setModels([])
        setModelsNote((await serverErrorMessage(e)) ?? 'Не удалось получить список моделей.')
      })
    return () => {
      alive = false
    }
  }, [open, providerId, config?.defaultModel])

  useEffect(() => {
    // Новые сообщения должны быть видны без прокрутки вручную. Проверяем наличие
    // scrollTo: в jsdom (и в очень старых браузерах) его нет, а падать из-за
    // прокрутки панель не должна.
    const list = listRef.current
    if (list && typeof list.scrollTo === 'function') {
      list.scrollTo({ top: list.scrollHeight })
    }
  }, [messages.length, sending])

  const provider = useMemo(
    () => config?.providers.find((item) => item.id === providerId) ?? null,
    [config, providerId],
  )
  const modelLabel = useMemo(() => {
    const found = models.find((m) => m.ref === modelRef)
    return found ? found.title : modelRef
  }, [models, modelRef])
  /** Выбранная модель считается на удалённом сервере (облачные модели Ollama). */
  const modelIsCloud = useMemo(() => {
    const found = models.find((m) => m.ref === modelRef)
    return found ? found.cloud === true : isCloudModelRef(modelRef)
  }, [models, modelRef])

  // Согласие — по выбранной МОДЕЛИ, а не по провайдеру: у Ollama рядом с локальными
  // живут облачные, и они уходят наружу точно так же, как чужой сервис.
  const consentBlocked = needsConsent(config, providerId, modelRef)

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await getAIConfig())
    } catch {
      /* настройка не критична для уже открытого разговора */
    }
  }, [])

  const agree = useCallback(async () => {
    setSendError(null)
    try {
      await setAIConsent(providerId)
      setConsentNeeded(false)
      await refreshConfig()
    } catch (e) {
      setSendError((await serverErrorMessage(e)) ?? 'Не удалось сохранить согласие.')
    }
  }, [providerId, refreshConfig])

  const revoke = useCallback(async () => {
    try {
      await deleteAIConsent(providerId)
      await refreshConfig()
    } catch (e) {
      setKeyNote((await serverErrorMessage(e)) ?? 'Не удалось отозвать согласие.')
    }
  }, [providerId, refreshConfig])

  const saveKey = useCallback(async () => {
    const value = keyDraft.trim()
    if (!value) {
      setKeyNote('Вставьте ключ провайдера.')
      return
    }
    setKeyBusy(true)
    setKeyNote(null)
    try {
      await saveAIKey(providerId, value)
      setKeyDraft('')
      setKeyNote('Ключ сохранён: он хранится на сервере зашифрованным и в браузер не возвращается.')
      await refreshConfig()
      // Модели перечитываем сразу: до сохранения ключа провайдер отвечал 428, и
      // человек видел пустой список — после сохранения он должен ожить без перезагрузки.
      setModels(await listAIModels(providerId))
    } catch (e) {
      setKeyNote((await serverErrorMessage(e)) ?? 'Не удалось сохранить ключ.')
    } finally {
      setKeyBusy(false)
    }
  }, [keyDraft, providerId, refreshConfig])

  const removeKey = useCallback(async () => {
    setKeyBusy(true)
    setKeyNote(null)
    try {
      await deleteAIKey(providerId)
      setKeyNote('Ключ удалён.')
      await refreshConfig()
      setModels([])
    } catch (e) {
      setKeyNote((await serverErrorMessage(e)) ?? 'Не удалось удалить ключ.')
    } finally {
      setKeyBusy(false)
    }
  }, [providerId, refreshConfig])

  const openConversation = useCallback(
    async (id: string) => {
      if (id === 'new') {
        setConversationId('new')
        setMessages([])
        setChanges([])
        return
      }
      try {
        const loaded = await getAIConversation(projectId, id)
        setConversationId(id)
        setMessages(loaded.messages)
        setChanges([])
        if (loaded.conversation?.model) setModelRef(loaded.conversation.model)
      } catch (e) {
        setSendError((await serverErrorMessage(e)) ?? 'Не удалось открыть беседу.')
      }
    },
    [projectId],
  )

  const ask = useCallback(async () => {
    const question = text.trim()
    if (!question || sending) return
    if (!modelRef) {
      setSendError('Выберите модель: без неё помощник не знает, к кому обращаться.')
      return
    }
    setSending(true)
    setSendError(null)
    setConsentNeeded(false)
    // Вопрос показываем сразу: ждать ответа модели, глядя на пустое поле, — худший
    // вариант, а история всё равно придёт с сервера в следующий раз.
    const pending: AIMessage = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content: question,
      createdAt: new Date().toISOString(),
    }
    setMessages((current) => [...current, pending])
    setText('')
    try {
      const turn = await sendAIMessage(projectId, conversationId, question, modelRef)
      setConversationId(turn.conversationId || conversationId)
      setMessages((current) => [
        ...current.filter((m) => m.id !== pending.id),
        { ...pending, id: `${pending.id}-sent` },
        turn.message,
      ])
      setChanges(turn.changes)
      if (turn.changes.length > 0) onProjectChanged()
    } catch (e) {
      const { message, consentRequired } = await readAIError(e)
      setConsentNeeded(consentRequired)
      setMessages((current) => current.filter((m) => m.id !== pending.id))
      setText(question)
      setSendError(
        message ??
          (await serverErrorMessage(e)) ??
          'Помощник не ответил. Проверьте связь и модель.',
      )
    } finally {
      setSending(false)
    }
  }, [text, sending, modelRef, projectId, conversationId, onProjectChanged])

  return (
    <section className="ai-panel" data-assistant-panel>
      <div className="ai-panel__head">
        <h3 className="ai-panel__title">ИИ-помощник</h3>
        <p className="muted ai-panel__hint">
          Помощник создаёт главы и под-события с описанием в Markdown. Изменения применяются
          сразу и видны всем, у кого проект открыт.
        </p>
        <button className="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Свернуть' : 'Открыть'}
        </button>
      </div>

      {open && configError != null && <p className="ai-panel__error">{configError}</p>}

      {open && config != null && !config.enabled && (
        <p className="ai-panel__note">
          Помощник выключен на этом стенде. Включить его может администратор: текст проекта
          уходит провайдеру модели, поэтому это осознанное решение, а не настройка по умолчанию
          (<code>AI_ENABLED=true</code>).
        </p>
      )}

      {open && config != null && config.enabled && (
        <div className="ai-panel__body">
          <div className="ai-panel__controls">
            <label className="ai-panel__field">
              <span>Провайдер</span>
              <select
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value)
                  setKeyNote(null)
                }}
              >
                {config.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.local ? ' — локальная' : p.hasKey ? '' : ' — нужен ключ'}
                  </option>
                ))}
              </select>
            </label>

            <label className="ai-panel__field">
              <span>Модель</span>
              <select
                value={modelRef}
                onChange={(e) => setModelRef(e.target.value)}
                disabled={models.length === 0}
              >
                {models.length === 0 && <option value="">нет доступных моделей</option>}
                {models.map((m) => (
                  <option key={m.ref || m.id} value={m.ref || `${m.provider}:${m.id}`}>
                    {m.title}
                    {m.cloud ? ' · облачная' : m.local ? ' · локальная' : m.free ? ' · бесплатная' : ''}
                    {m.tools ? '' : ' · без инструментов'}
                  </option>
                ))}
              </select>
            </label>

            <button className="secondary" onClick={() => setSettingsOpen((v) => !v)}>
              {settingsOpen ? 'Скрыть настройку' : 'Ключи и доступ'}
            </button>
          </div>

          {provider != null && (
            <p className={modelIsCloud ? 'ai-panel__warn' : 'muted ai-panel__provider-note'}>
              {modelIsCloud
                ? 'Выбрана ОБЛАЧНАЯ модель: она считается на удалённом сервере (ollama.com), и текст проекта уходит туда. Локальные модели того же Ollama считаются на машине стенда — выберите «локальная».'
                : provider.local
                  ? 'Локальная модель: текст проекта не покидает сервер стенда, ключ не нужен.'
                  : provider.standKey
                    ? 'Модели доступны по ключу стенда — свой ключ не обязателен.'
                    : provider.keyRequired
                      ? 'Для этого провайдера нужен ключ: добавьте свой — он хранится на сервере зашифрованным.'
                      : provider.note}
            </p>
          )}

          {modelsNote != null && <p className="muted ai-panel__note">{modelsNote}</p>}

          {settingsOpen && provider != null && (
            <div className="ai-panel__settings">
              <div className="ai-panel__key">
                <input
                  type="password"
                  placeholder="ключ провайдера"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  disabled={provider.local || !config.keysReady}
                  aria-label="Ключ провайдера"
                />
                <button onClick={saveKey} disabled={keyBusy || provider.local || !config.keysReady}>
                  Сохранить ключ
                </button>
                {provider.hasKey && !provider.local && (
                  <button className="secondary" onClick={removeKey} disabled={keyBusy}>
                    Удалить
                  </button>
                )}
              </div>
              {!config.keysReady && (
                <p className="muted ai-panel__note">
                  На стенде не настроено хранение своих ключей (<code>AI_SECRET_KEY</code>): можно
                  пользоваться локальной моделью или ключом стенда.
                </p>
              )}
              {keyNote != null && <p className="muted ai-panel__note">{keyNote}</p>}

              {!provider.local && (
                <label className="ai-panel__consent-check">
                  <input
                    type="checkbox"
                    checked={config.consents.includes(provider.id)}
                    onChange={(e) => {
                      if (e.target.checked) void agree()
                      else void revoke()
                    }}
                  />
                  <span>
                    Отправлять текст проекта провайдеру «{provider.title}» (это чужая
                    инфраструктура: в запрос уходит оглавление проекта и те кадры, которые
                    помощник прочитает)
                  </span>
                </label>
              )}
            </div>
          )}

          {consentBlocked && (
            <div className="ai-panel__consent" data-consent-required>
              <p>
                {modelIsCloud
                  ? `Чтобы продолжить, подтвердите: текст проекта (оглавление и прочитанные кадры) уйдёт ОБЛАЧНОЙ модели «${modelLabel}» — она считается на удалённом сервере, а не на машине стенда.`
                  : `Чтобы продолжить, подтвердите: текст проекта (оглавление и прочитанные кадры) уйдёт провайдеру «${provider?.title ?? providerId}».`}
              </p>
              <button onClick={agree}>Согласен, продолжить</button>
            </div>
          )}

          {consentNeeded && !consentBlocked && (
            <p className="ai-panel__error">
              Сервер запросил согласие заново — откройте «Ключи и доступ» и подтвердите отправку.
            </p>
          )}

          {messages.length > 0 && (
            <div className="ai-panel__log" ref={listRef} data-assistant-log>
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === 'user' ? 'ai-msg ai-msg--user' : 'ai-msg ai-msg--assistant'
                  }
                >
                  <span className="ai-msg__who">{message.role === 'user' ? 'Вы' : 'Помощник'}</span>
                  {message.role === 'user' ? (
                    <p className="ai-msg__text">{message.content}</p>
                  ) : (
                    <MarkdownBlock source={message.content} className="ai-msg__text" />
                  )}
                </div>
              ))}
              {sending && <p className="muted ai-panel__thinking">Помощник думает…</p>}
            </div>
          )}

          {changes.length > 0 && (
            <div className="ai-panel__changes" data-assistant-changes>
              <strong>Изменения в проекте</strong>
              <ul>
                {changes.map((change) => (
                  <li key={`${change.action}-${change.id}`}>{changeLabel(change)}</li>
                ))}
              </ul>
              <button className="secondary" onClick={onOpenEditors}>
                Посмотреть в дереве
              </button>
            </div>
          )}

          {sendError != null && <p className="ai-panel__error">{sendError}</p>}

          <div className="ai-panel__ask">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Например: добавь главу «Пролог» с описанием мира в Markdown"
              rows={3}
              disabled={sending || consentBlocked}
              aria-label="Сообщение помощнику"
            />
            <div className="ai-panel__ask-row">
              <button onClick={ask} disabled={sending || consentBlocked || text.trim() === ''}>
                {sending ? 'Отправляю…' : 'Спросить'}
              </button>
              <span className="muted ai-panel__note">
                {modelLabel ? `Модель: ${modelLabel}. ` : ''}
                До {config.maxToolCalls} новых кадров за один ответ; изменения применяются сразу.
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
