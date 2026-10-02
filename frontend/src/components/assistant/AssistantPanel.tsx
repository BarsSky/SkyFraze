import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  changeLabel,
  deleteAIConsent,
  deleteAIKey,
  getAIConfig,
  getAISettings,
  isCloudModelRef,
  listAIModels,
  needsConsent,
  readAIError,
  saveAIKey,
  saveAISettings,
  streamAIMessage,
  setAIConsent,
  type AIConfig,
  type AIChange,
  type AIMessage,
  type AIModel,
  type AIProviderInfo,
  type AISettings,
} from '../../api/assistant'
import { serverErrorMessage } from '../../api/client'
import { MarkdownBlock } from '../MarkdownBlock'

/**
 * Содержимое плавающего окна помощника: переписка и настройка (два вида в одном окне).
 *
 * Почему окно, а не панель в потоке страницы. Стадия таймлайна — fixed-слой на весь
 * экран (`z-index: 10`) и непрозрачный, поэтому панель в обычном потоке оказывалась под
 * ним и под нижней кромкой окна: человек видел то обрезанный блок настроек, то пустую
 * рамку. Плавающее окно решает это по построению: оно всегда доступно, не зависит от
 * прокрутки и не спорит со слоями стадии.
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
 *   - **Настройка (провайдер, модель, ключ, согласие) — второй вид того же окна**:
 *     человек, который только что получил «нужен ключ», не должен искать другой экран
 *     и не должен видеть половину настроек за краем страницы.
 *   - **Состояние не теряется при закрытии.** Окно прячется, а не размонтируется:
 *     история, выбранная модель и набранный вопрос остаются на месте, а ответ,
 *     пришедший после закрытия, отмечается маркером на плавающей кнопке (`onUnread`).
 */
interface Props {
  projectId: string
  /** Открыто ли окно: нужно, чтобы отличить «ответ на глазах» от «ответ в фоне». */
  open: boolean
  onClose: () => void
  /** Ответ пришёл, пока окно было закрыто: кнопка показывает маркер. */
  onUnread: () => void
  /** Идёт запрос к модели: кнопка показывает «думает», даже если окно закрыто. */
  onThinkingChange: (thinking: boolean) => void
  /** Сообщить странице, что проект изменился (перечитать состояние без realtime). */
  onProjectChanged: () => void
  /** Перейти к панели редакторов: там созданные кадры видно в дереве. */
  onOpenEditors: () => void
}

type View = 'chat' | 'settings'

export function AssistantPanel({
  projectId,
  open,
  onClose,
  onUnread,
  onThinkingChange,
  onProjectChanged,
  onOpenEditors,
}: Props) {
  const [view, setView] = useState<View>('chat')
  const [config, setConfig] = useState<AIConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
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
  /**
   * Текст, который модель уже сказала, но который ещё не стал сообщением истории.
   *
   * `null` — поток не идёт. Пустая строка — идёт, но модель ещё молчит («думает…»).
   * Показываем его отдельным блоком, а не сообщением в списке: пока ответ не пришёл
   * целиком, это ещё не факт истории, и подменять им переписку нельзя — при обрыве
   * человек увидел бы текст, которого на сервере нет.
   */
  const [streaming, setStreaming] = useState<string | null>(null)
  /** Живые вызовы инструментов: счётчик того, что помощник успел сделать. */
  const [liveCalls, setLiveCalls] = useState<string[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [consentNeeded, setConsentNeeded] = useState(false)
  const [agent, setAgent] = useState<AISettings | null>(null)
  const [agentDraft, setAgentDraft] = useState<{ role: string; instructions: string; enabled: boolean }>({
    role: '',
    instructions: '',
    enabled: true,
  })
  const [agentNote, setAgentNote] = useState<string | null>(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** Текущий поток ответа: `abort()` — это и есть кнопка «стоп». */
  const abortRef = useRef<AbortController | null>(null)
  /**
   * Открыто ли окно — в ref, а не только в пропсе.
   *
   * Запрос к модели живёт долго, и человек может закрыть окно, пока ответ ещё едет.
   * Если решение «ответили в фоне или на глазах» читать из замыкания, оно увидит
   * СТАРОЕ значение (`open === true`, каким оно было при отправке), и непрочитанный
   * ответ не отметится — человек просто не узнает, что помощник ответил.
   */
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  // Настройка грузится при первом открытии окна: до этого мы не знаем ни включён ли
  // помощник, ни какие провайдеры доступны, и показывать пустое окно незачем.
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
    // Роль и поведение агента — свойство проекта: грузим вместе с настройкой.
    getAISettings(projectId)
      .then((loaded) => {
        if (!alive) return
        setAgent(loaded)
        setAgentDraft({
          role: loaded.role,
          instructions: loaded.instructions,
          enabled: loaded.enabled,
        })
      })
      .catch(() => {
        /* без настроек агента окно работает: имя покажем зашитое, роль — «не задана» */
      })
    return () => {
      alive = false
    }
  }, [open, config, configError, projectId])

  // Модели спрашиваются у провайдера, поэтому только когда он выбран: иначе каждое
  // открытие окна дёргало бы чужие API.
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
    // прокрутки окно не должно.
    const list = listRef.current
    if (open && list && typeof list.scrollTo === 'function') {
      list.scrollTo({ top: list.scrollHeight })
    }
  }, [messages.length, sending, open])

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

  /**
   * Перечитать список моделей: кнопка «Проверить связь» в настройке.
   *
   * Нужна именно человеку: если своего сервера нет на месте или ключ не принят, он видит
   * пустой список моделей и не понимает, дело в сети, в ключе или в адресе. Кнопка
   * повторяет запрос и говорит словами, что вышло.
   */
  const checkModels = useCallback(async () => {
    if (!providerId) return
    setModelsNote('Проверяю…')
    try {
      const list = await listAIModels(providerId)
      setModels(list)
      setModelsNote(
        list.length === 0
          ? 'Сервер ответил, но моделей нет: проверьте, что модель скачана или загружена на сервере.'
          : `Связь есть, моделей: ${list.length}.`,
      )
    } catch (e) {
      setModels([])
      setModelsNote((await serverErrorMessage(e)) ?? 'Модель не ответила: проверьте адрес и ключ.')
    }
  }, [providerId])

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

  const startNewConversation = useCallback(() => {
    setConversationId('new')
    setMessages([])
    setChanges([])
    setSendError(null)
  }, [])

  /**
   * Сохранить роль и поведение агента (владелец проекта).
   *
   * Роль — не украшение: она уходит в правила, по которым агент пишет, вместе с
   * указаниями владельца. Поэтому после сохранения показываем, что именно уехало
   * модели, а не просто «сохранено».
   */
  const saveAgent = useCallback(async () => {
    setAgentBusy(true)
    setAgentNote(null)
    try {
      const saved = await saveAISettings(projectId, agentDraft)
      setAgent(saved)
      setAgentNote(
        saved.roleTitle
          ? `Сохранено: роль «${saved.roleTitle}». Агент пишет с этими правилами.`
          : 'Сохранено: роль не выбрана — агент работает как внимательный соавтор.',
      )
    } catch (e) {
      setAgentNote((await serverErrorMessage(e)) ?? 'Не удалось сохранить роль агента.')
    } finally {
      setAgentBusy(false)
    }
  }, [projectId, agentDraft])

  /**
   * Отправка вопроса. Ответ читается ПОТОКОМ: пока модель пишет, текст появляется на
   * глазах, а не после минутной тишины.
   *
   * «Стоп» — обрыв запроса (`AbortController`), а не отдельная ручка: сервер видит
   * отмену контекста, прекращает генерацию у провайдера и сохраняет то, что успел
   * сказать. Показанный на лету текст остаётся в переписке с пометкой «остановлено» —
   * иначе человек потерял бы то, что уже прочитал.
   */
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
    setStreaming('')
    setLiveCalls([])
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

    const controller = new AbortController()
    abortRef.current = controller
    let answer = ''
    try {
      const turn = await streamAIMessage(
        projectId,
        conversationId,
        question,
        modelRef,
        {
          // Беседа могла быть только что создана: её идентификатор нужен сразу, иначе
          // остановленный ответ остался бы в беседе, о которой интерфейс не знает.
          onStart: (id) => setConversationId(id),
          onDelta: (piece) => {
            answer += piece
            setStreaming(answer)
          },
          onCall: (call) => setLiveCalls((current) => [...current, call.detail || call.name]),
          onChange: (change) => setChanges((current) => [...current, change]),
        },
        controller.signal,
      )
      setConversationId(turn.conversationId || conversationId)
      setMessages((current) => [
        ...current.filter((m) => m.id !== pending.id),
        { ...pending, id: `${pending.id}-sent` },
        turn.message,
      ])
      setChanges(turn.changes)
      // Счётчик расхода обновляем локально: расход пришёл вместе с ответом, и лишний
      // запрос к серверу ради одной цифры не нужен.
      const spentNow = (turn.message.tokensIn ?? 0) + (turn.message.tokensOut ?? 0)
      if (spentNow > 0) {
        setConfig((current) =>
          current ? { ...current, tokensToday: current.tokensToday + spentNow } : current,
        )
      }
      if (turn.changes.length > 0) onProjectChanged()
      // Ответ пришёл, пока окно закрыто: человек узнает об этом по маркеру на кнопке.
      if (!openRef.current) onUnread()
    } catch (e) {
      if (isAbort(e)) {
        // Остановили сами: сказанное остаётся в переписке помеченным, а не исчезает.
        setMessages((current) => [
          ...current.filter((m) => m.id !== pending.id),
          { ...pending, id: `${pending.id}-sent` },
          {
            id: `stopped-${Date.now()}`,
            role: 'assistant',
            content: answer,
            createdAt: new Date().toISOString(),
            stopped: true,
          },
        ])
      } else {
        const { message, consentRequired, tokenBudget } = await readAIError(e)
        setConsentNeeded(consentRequired)
        setMessages((current) => current.filter((m) => m.id !== pending.id))
        setText(question)
        setSendError(
          message ??
            (await serverErrorMessage(e)) ??
            'Помощник не ответил. Проверьте связь и модель.',
        )
        // Упёрлись в предел — перечитываем настройку: счётчик должен показать правду
        // (локальная цифра могла отстать), а кнопка — заблокироваться.
        if (tokenBudget) void refreshConfig()
      }
    } finally {
      abortRef.current = null
      setStreaming(null)
      setLiveCalls([])
      setSending(false)
    }
  }, [text, sending, modelRef, projectId, conversationId, onProjectChanged, onUnread, refreshConfig])

  /** «Стоп»: обрываем запрос — сервер сохранит то, что модель успела сказать. */
  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // Фокус в поле ввода при открытии: человек открыл окно, чтобы написать.
  useEffect(() => {
    if (!open || view !== 'chat') return
    inputRef.current?.focus()
  }, [open, view])

  // Состояние запроса наружу: плавающая кнопка показывает «думает», пока ответ не пришёл,
  // — в том числе если человек закрыл окно и вернулся к проекту.
  useEffect(() => {
    onThinkingChange(sending)
  }, [sending, onThinkingChange])

  const hasAnswer = messages.some((m) => m.role === 'assistant')
  /** Имя агента: зашито на сервере, в интерфейсе — как имя соавтора. */
  const agentName = agent?.agentName || 'Агент'
  /**
   * Исчерпан ли предел расхода за сутки.
   *
   * Считаем по счётчику из настройки: сервер всё равно откажет, но человек должен
   * видеть, ПОЧЕМУ поле ввода заблокировано, до нажатия, а не после.
   */
  const budgetExhausted =
    config != null && config.tokenLimit > 0 && config.tokensToday >= config.tokenLimit

  /**
   * Куда уходит текст проекта — одной строкой. Это главное, что человек должен знать о
   * помощнике, поэтому подпись висит в переписке всегда, а не только в настройке:
   * «локальная модель» и «чужой сервис» — разные вещи, и путать их нельзя.
   */
  const privacy = privacyNote(provider, modelIsCloud)

  return (
    <>
      <header className="ai-head">
        <div className="ai-head__title">
          <span className="ai-head__name">{agentName}</span>
          <span className="ai-head__model" title={modelRef || 'модель не выбрана'}>
            {agent?.roleTitle ? `${agent.roleTitle} · ` : 'соавтор проекта · '}
            {modelLabel || 'модель не выбрана'}
          </span>
        </div>
        <div className="ai-head__actions">
          <button
            type="button"
            className="ai-icon"
            aria-pressed={view === 'settings'}
            aria-label="Настройка помощника"
            title="Провайдер, модель, ключ и согласие"
            data-assistant-settings
            onClick={() => setView((v) => (v === 'settings' ? 'chat' : 'settings'))}
          >
            <GearIcon />
          </button>
          <button
            type="button"
            className="ai-icon"
            aria-label="Закрыть помощника"
            title="Закрыть (Esc)"
            data-assistant-close
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      {configError != null && <p className="ai-error ai-error--padded">{configError}</p>}

      {config != null && !config.enabled && (
        <div className="ai-body">
          <p className="ai-note">
            Помощник выключен на этом стенде. Включить его может администратор: текст проекта
            уходит провайдеру модели, поэтому это осознанное решение, а не настройка по
            умолчанию (<code>AI_ENABLED=true</code>).
          </p>
        </div>
      )}

      {config != null && config.enabled && view === 'settings' && (
        <div className="ai-body ai-body--settings" data-assistant-settings-view>
          <label className="ai-field">
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
                  {p.keyless ? ' — без ключа' : p.local ? ' — локальная' : p.hasKey ? '' : ' — нужен ключ'}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-field">
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

          {provider != null && (
            <p className={modelIsCloud ? 'ai-warn' : 'ai-note'}>
              {modelIsCloud
                ? 'Выбрана ОБЛАЧНАЯ модель: она считается на удалённом сервере (ollama.com), и текст проекта уходит туда. Локальные модели того же Ollama считаются на машине стенда — выберите «локальная».'
                : provider.local
                  ? provider.keyless
                    ? 'Свой сервер моделей: считает на вашей машине (или в вашей сети), ключ не нужен и текст проекта никуда не уходит.'
                    : 'Локальная модель: текст проекта не покидает сервер стенда, ключ не нужен.'
                  : provider.standKey
                    ? 'Модели доступны по ключу стенда — свой ключ не обязателен.'
                    : provider.keyRequired
                      ? 'Для этого провайдера нужен ключ: добавьте свой — он хранится на сервере зашифрованным.'
                      : provider.note}
            </p>
          )}

          {modelsNote != null && <p className="ai-note">{modelsNote}</p>}

          {provider != null && !provider.local && (
            <div className="ai-key">
              <input
                type="password"
                placeholder="ключ провайдера"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                disabled={!config.keysReady}
                aria-label="Ключ провайдера"
              />
              <button onClick={saveKey} disabled={keyBusy || !config.keysReady}>
                Сохранить
              </button>
              {provider.hasKey && (
                <button className="secondary" onClick={removeKey} disabled={keyBusy}>
                  Удалить
                </button>
              )}
            </div>
          )}

          {!config.keysReady && (
            <p className="ai-note">
              На стенде не настроено хранение своих ключей (<code>AI_SECRET_KEY</code>): можно
              пользоваться локальной моделью или ключом стенда.
            </p>
          )}
          {keyNote != null && <p className="ai-note">{keyNote}</p>}

          {provider != null && !provider.local && (
            <label className="ai-consent-check">
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

          <button className="secondary ai-body__back" onClick={() => setView('chat')}>
            Вернуться к переписке
          </button>

          {/* Роль и поведение агента: он пишет текст проекта, поэтому у него есть
              характер — и задаёт его владелец проекта, а не админ стенда. */}
          <div className="ai-agent" data-assistant-agent>
            <p className="ai-about__title">Роль и поведение агента</p>
            <p className="ai-note">
              {agentName} — соавтор проекта: его правки подписаны его именем, и он пишет по тем
              правилам, которые вы зададите. {agent?.member ? 'Сейчас он в участниках проекта с правом правки.' : ''}
            </p>

            {agent == null ? (
              <p className="ai-note">Настройки агента не загрузились — попробуйте открыть окно заново.</p>
            ) : agent.canEdit ? (
              <>
                <label className="ai-field">
                  <span>Роль</span>
                  <select
                    value={agentDraft.role}
                    aria-label="Роль агента"
                    onChange={(e) => setAgentDraft((d) => ({ ...d, role: e.target.value }))}
                  >
                    <option value="">без роли — внимательный соавтор</option>
                    {agent.roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.title} — {role.hint}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="ai-field">
                  <span>Указания владельца (уходят в каждый запрос)</span>
                  <textarea
                    value={agentDraft.instructions}
                    rows={3}
                    aria-label="Указания агенту"
                    placeholder="Например: пиши сдержанно, без эпитетов; имена героев не менять; даты сверяй с главой 2"
                    onChange={(e) => setAgentDraft((d) => ({ ...d, instructions: e.target.value }))}
                  />
                </label>

                <label className="ai-consent-check">
                  <input
                    type="checkbox"
                    checked={agentDraft.enabled}
                    aria-label="Агент включён в этом проекте"
                    onChange={(e) => setAgentDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  />
                  <span>
                    Агент работает в этом проекте. Снимите галочку, чтобы попросить его не трогать
                    эту историю — не выключая помощника для всего стенда.
                  </span>
                </label>

                <button onClick={saveAgent} disabled={agentBusy}>
                  {agentBusy ? 'Сохраняю…' : 'Сохранить роль'}
                </button>
              </>
            ) : (
              <p className="ai-note">
                Роль агента задаёт владелец проекта.{' '}
                {agent.roleTitle ? `Сейчас: ${agent.roleTitle}.` : 'Сейчас роль не выбрана.'}
                {agent.instructions ? ` Указания: ${agent.instructions}` : ''}
              </p>
            )}
            {agentNote != null && <p className="ai-note">{agentNote}</p>}
          </div>

          {/* Что помощник умеет и чем ограничен — прямо в настройке: вопрос «а что он
              может?» возникает именно здесь, а не в переписке. */}
          <div className="ai-about">
            <p className="ai-about__title">Что умеет</p>
            <ul className="ai-note">
              <li>создавать главы верхнего уровня и под-события с текстом в Markdown;</li>
              <li>смотреть дерево проекта и читать отдельный кадр перед тем, как дописать;</li>
              <li>ставить дату кадра (вид ГГГГ-ММ-ДД).</li>
            </ul>
            <p className="ai-note">
              Чего не делает: не удаляет, не переписывает существующие кадры и не перемещает их —
              это делается руками в редакторах. За один ответ — до {config.maxToolCalls} новых
              кадров; всё созданное видно отдельным блоком над полем ввода.
            </p>
            <button className="secondary" onClick={checkModels}>
              Проверить связь с моделью
            </button>
          </div>
        </div>
      )}

      {config != null && config.enabled && view === 'chat' && (
        <>
          {privacy && (
            <p className={modelIsCloud ? 'ai-warn ai-head__privacy' : 'ai-note ai-head__privacy'} data-assistant-privacy>
              {privacy}
            </p>
          )}
          <div className="ai-body" ref={listRef} data-assistant-log>
            {messages.length === 0 && (
              <div className="ai-empty">
                <p className="ai-empty__title">О чём спросить</p>
                <p className="ai-note">
                  Помощник создаёт главы и под-события с описанием в Markdown — например,
                  «добавь главу «Пролог» с описанием мира» или «разбей главу 2 на три
                  под-события».
                </p>
                <p className="ai-note">
                  Изменения применяются сразу и видны всем, у кого проект открыт.
                </p>
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === 'user' ? 'ai-msg ai-msg--user' : 'ai-msg ai-msg--assistant'
                }
              >
                <span className="ai-msg__who">{message.role === 'user' ? 'Вы' : agentName}</span>
                {message.role === 'user' ? (
                  <p className="ai-msg__text">{message.content}</p>
                ) : (
                  <>
                    <MarkdownBlock source={message.content} className="ai-msg__text" />
                    {message.stopped && (
                      <p className="ai-msg__stopped" data-assistant-stopped>
                        Остановлено — в историю попало то, что модель успела сказать.
                      </p>
                    )}
                  </>
                )}
              </div>
            ))}
            {/* Текст, который модель пишет прямо сейчас. Отдельным блоком, а не
                сообщением: пока ответ не пришёл целиком, это ещё не история. */}
            {streaming !== null && streaming !== '' && (
              <div className="ai-msg ai-msg--assistant ai-msg--live" data-assistant-live>
                <span className="ai-msg__who">{agentName}</span>
                <MarkdownBlock source={streaming} className="ai-msg__text" />
                <span className="ai-caret" aria-hidden="true" />
              </div>
            )}
            {sending && streaming === '' && <p className="ai-thinking">Помощник думает…</p>}
            {sending && liveCalls.length > 0 && (
              <p className="ai-note ai-note--padded" data-assistant-live-calls>
                Уже сделано: {liveCalls.length}
              </p>
            )}
          </div>

          {changes.length > 0 && (
            <div className="ai-changes" data-assistant-changes>
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

          {consentBlocked && (
            <div className="ai-consent" data-consent-required>
              <p>
                {modelIsCloud
                  ? `Чтобы продолжить, подтвердите: текст проекта (оглавление и прочитанные кадры) уйдёт ОБЛАЧНОЙ модели «${modelLabel}» — она считается на удалённом сервере, а не на машине стенда.`
                  : `Чтобы продолжить, подтвердите: текст проекта (оглавление и прочитанные кадры) уйдёт провайдеру «${provider?.title ?? providerId}».`}
              </p>
              <button onClick={agree}>Согласен, продолжить</button>
            </div>
          )}

          {consentNeeded && !consentBlocked && (
            <p className="ai-error ai-error--padded">
              Сервер запросил согласие заново — откройте настройку и подтвердите отправку.
            </p>
          )}

          {sendError != null && <p className="ai-error ai-error--padded">{sendError}</p>}

          {budgetExhausted && (
            <p className="ai-error ai-error--padded" data-assistant-budget>
              Предел расхода на сутки исчерпан ({config?.tokensToday} из {config?.tokenLimit}{' '}
              токенов). Помощник заработает снова, когда счётчик за сутки сбросится.
            </p>
          )}

          <footer className="ai-composer">
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter отправляет, Shift+Enter — перенос строки: так ждёт человек,
                // привыкший к мессенджерам.
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault()
                  void ask()
                }
              }}
              placeholder="Например: добавь главу «Пролог» с описанием мира в Markdown"
              rows={2}
              disabled={sending || consentBlocked || budgetExhausted || !config.enabled}
              aria-label="Сообщение помощнику"
            />
            <div className="ai-composer__row">
              {sending ? (
                // Пока ответ идёт, главная кнопка — «стоп»: остановить генерацию
                // человек должен уметь в любой момент, а не ждать конца.
                <button type="button" className="secondary" onClick={stop} data-assistant-stop>
                  Стоп
                </button>
              ) : (
                <button
                  onClick={ask}
                  disabled={consentBlocked || budgetExhausted || text.trim() === ''}
                >
                  Спросить
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={startNewConversation}
                disabled={sending || !hasAnswer}
                title="Начать разговор заново: прежняя история остаётся на сервере"
              >
                Новый
              </button>
              <span className="ai-note ai-composer__hint" data-assistant-tokens>
                {config.tokenLimit > 0
                  ? `Израсходовано ${config.tokensToday} из ${config.tokenLimit} токенов за сутки`
                  : `Израсходовано ${config.tokensToday} токенов за сутки`}
                {' · '}до {config.maxToolCalls} кадров за ответ
              </span>
            </div>
          </footer>
        </>
      )}
    </>
  )
}

/**
 * Куда уходит текст проекта — одной строкой. Возвращает пустую строку, если провайдер
 * ещё не приехал: лучше ничего, чем неверное «локальная» или «чужая».
 */
function privacyNote(provider: AIProviderInfo | null, modelIsCloud: boolean): string {
  if (provider == null) return ''
  if (modelIsCloud) {
    return 'Облачная модель: считается на удалённом сервере (ollama.com), текст проекта уходит туда.'
  }
  if (provider.local) {
    return provider.keyless
      ? 'Свой сервер моделей: считает на вашей машине (или в вашей сети) — текст проекта никуда не уходит.'
      : 'Локальная модель: текст проекта не покидает сервер стенда.'
  }
  if (provider.standKey) {
    return `Провайдер «${provider.title}» по ключу стенда: текст проекта уходит ему. Согласие спрашивается один раз.`
  }
  return `Провайдер «${provider.title}»: текст проекта уходит ему — согласие спрашивается один раз.`
}

/** Шестерёнка: настройка помощника (провайдер, модель, ключ, согласие). */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"
      />
      <path
        fill="currentColor"
        d="m19.6 12.7-.1.9 1.2 1.6-1.4 2.4-2-.5-.8.6-1.5 1v2.1h-2.8v-2.1l-1.5-1-.8-.6-2 .5-1.4-2.4 1.2-1.6-.1-.9.1-.9L6.4 10l1.4-2.4 2 .5.8-.6 1.5-1V4.4h2.8v2.1l1.5 1 .8.6 2-.5 1.4 2.4-1.2 1.6.1.9ZM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
      />
    </svg>
  )
}

/** Крестик: закрыть окно. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"
      />
    </svg>
  )
}

/**
 * Оборван ли запрос кнопкой «стоп» (или закрытой вкладкой).
 *
 * `AbortError` — не сбой помощника: это решение человека, и показывать на него
 * красную плашку «не ответил» значило бы ругать его за собственную кнопку.
 */
function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError'
}
