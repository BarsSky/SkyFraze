import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addAIEndpoint,
  applyAIProposal,
  changeLabel,
  deleteAIConsent,
  deleteAIEndpoint,
  deleteAIKey,
  discardAIProposal,
  getAIConfig,
  getAISettings,
  isCloudModelRef,
  listAIEndpoints,
  listAIModels,
  listAIProposals,
  needsConsent,
  readAIError,
  revertAIProposal,
  saveAIKey,
  saveAISettings,
  streamAIMessage,
  setAIConsent,
  type AIConfig,
  type AIChange,
  type AIEndpoint,
  type AIProposal,
  type AISuggestion,
  type AIMessage,
  type AIModel,
  type AIProviderInfo,
  type AISettings,
} from '../../api/assistant'
import { serverErrorMessage } from '../../api/client'
import { MarkdownBlock } from '../MarkdownBlock'
import { EntityProposals } from '../entities/EntityProposals'
import { MAX_IMAGES, imageFileError, readImageFile } from './imageAttach'
import { promptHints } from './promptHints'
import { tStatic, useT } from '../../i18n'
import { useLang } from '../../store/lang'

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
  /** Пуст ли проект: от этого зависят подсказки в пустом чате. */
  projectIsEmpty?: boolean
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
  projectIsEmpty = true,
}: Props) {
  const [view, setView] = useState<View>('chat')
  const t = useT()
    const [lang] = useLang()
    const [config, setConfig] = useState<AIConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [providerId, setProviderId] = useState('')
  const [models, setModels] = useState<AIModel[]>([])
  const [modelsNote, setModelsNote] = useState<string | null>(null)
  const [modelRef, setModelRef] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [keyNote, setKeyNote] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  /**
   * Свои серверы моделей: адрес задаёт сам человек.
   *
   * Без этого списка подключиться со своим llama.cpp было нельзя: провайдеров на стенде
   * ровно столько, сколько прописал админ, а поля для адреса не существовало нигде.
   */
  const [endpoints, setEndpoints] = useState<AIEndpoint[] | null>(null)
  const [endpointDraft, setEndpointDraft] = useState({
    title: '',
    url: '',
    key: '',
    local: true,
  })
  const [endpointNote, setEndpointNote] = useState<string | null>(null)
  const [endpointBusy, setEndpointBusy] = useState(false)
  /**
   * Предложенные агентом правки существующих кадров.
   *
   * Живут на сервере, а не в окне: загружаем при открытии, чтобы «я закрыл вкладку, пока
   * агент предлагал правку» не означало «предложение пропало».
   */
  const [proposals, setProposals] = useState<AIProposal[]>([])
  /** Применённые в этой сессии: и у перезаписи, и у удаления есть «Вернуть». */
  const [appliedProposals, setAppliedProposals] = useState<AIProposal[]>([])
  const [proposalNote, setProposalNote] = useState<string | null>(null)
  /** Какую правку сейчас применяем — чтобы не применить две по двойному клику. */
  const [proposalBusy, setProposalBusy] = useState<string | null>(null)
  /**
   * Счётчик «пришёл ответ с предложением карточек» (0.77.0). Сам список читает компонент
   * `EntityProposals` с сервера, а счётчик говорит ему: перечитай.
   */
  const [entitiesRefresh, setEntitiesRefresh] = useState(0)
  const [conversationId, setConversationId] = useState('new')
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [changes, setChanges] = useState<AIChange[]>([])
  /** Что сервер предлагает сделать дальше (считается по состоянию проекта). */
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([])
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
  /**
   * Приложенные картинки (data URL). Живут до отправки: история их не помнит, и это
   * осознанно — хранить мегабайты в переписке незачем (см. SendStreamImages на сервере).
   */
  const [images, setImages] = useState<string[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [consentNeeded, setConsentNeeded] = useState(false)
  const [agent, setAgent] = useState<AISettings | null>(null)
  const [agentDraft, setAgentDraft] = useState<{
    role: string
    instructions: string
    enabled: boolean
    generation: string
    imageStyle: string
    imageNegative: string
  }>({
    role: '',
    instructions: '',
    enabled: true,
    generation: 'auto',
    imageStyle: '',
    imageNegative: '',
  })
  const [agentNote, setAgentNote] = useState<string | null>(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** Текущий поток ответа: `abort()` — это и есть кнопка «стоп». */
  const abortRef = useRef<AbortController | null>(null)
  /** Поле выбора файлов: своя кнопка «Картинка» нажимает его программно. */
  const fileRef = useRef<HTMLInputElement | null>(null)
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
        if (alive)
          setConfigError((await serverErrorMessage(e)) ?? tStatic('as.errConfig'))
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
          generation: loaded.generation,
          imageStyle: loaded.imageStyle,
          imageNegative: loaded.imageNegative,
        })
      })
      .catch(() => {
        /* без настроек агента окно работает: имя покажем зашитое, роль — «не задана» */
      })
    return () => {
      alive = false
    }
  }, [open, config, configError, projectId])

  // Свои серверы грузим вместе с настройкой: их список нужен и для формы, и для
  // объяснения «почему в списке провайдеров нет вашего сервера».
  useEffect(() => {
    if (!open || config?.enabled !== true || endpoints !== null) return
    let alive = true
    listAIEndpoints()
      .then((list) => {
        if (alive) setEndpoints(list)
      })
      .catch(() => {
        // Сбой чтения не должен показывать «серверов нет»: это разные вещи. Оставляем
        // `null` — блок честно скажет, что список не загрузился.
      })
    return () => {
      alive = false
    }
  }, [open, config?.enabled, endpoints])

  // Предложения правок живут на сервере: загружаем их при открытии окна, чтобы
  // «закрыл вкладку, пока агент предлагал правку» не означало «предложение пропало».
  useEffect(() => {
    if (!open || config?.enabled !== true) return
    let alive = true
    listAIProposals(projectId)
      .then((list) => {
        if (!alive) return
        // Сервер отдаёт и ожидающие, и применённые за последнюю неделю: у вторых есть
        // «Вернуть», и это не должно пропадать при перезагрузке страницы.
        setProposals(list.filter((item) => item.status !== 'applied'))
        setAppliedProposals(list.filter((item) => item.status === 'applied'))
      })
      .catch(() => {
        // Не показать список — не то же самое, что «предложений нет»: молчим, а не врём.
      })
    return () => {
      alive = false
    }
  }, [open, config?.enabled, projectId])

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
          setModelsNote(t('as.modelsEmpty'))
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
        setModelsNote((await serverErrorMessage(e)) ?? t('as.errModels'))
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
  /**
   * Видит ли выбранная модель картинки.
   *
   * Признак приходит от провайдера (или по имени модели — см. vision.go на сервере).
   * Если он не подтверждён, кнопка «приложить» не показывается: обещать зрение и молча
   * отправить картинку туда, где её не увидят, — обман.
   */
  const modelSeesImages = useMemo(() => {
    const found = models.find((m) => m.ref === modelRef)
    return found?.vision === true
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
    setModelsNote(t('as.checking'))
    try {
      const list = await listAIModels(providerId)
      setModels(list)
      setModelsNote(
        list.length === 0
          ? t('as.checkNoModels')
            : t('as.checkOk', { count: list.length }),
      )
    } catch (e) {
      setModels([])
      setModelsNote((await serverErrorMessage(e)) ?? t('as.errModelNoAnswer'))
    }
  }, [providerId])

  const agree = useCallback(async () => {
    setSendError(null)
    try {
      await setAIConsent(providerId)
      setConsentNeeded(false)
      await refreshConfig()
    } catch (e) {
      setSendError((await serverErrorMessage(e)) ?? t('as.errConsentSave'))
    }
  }, [providerId, refreshConfig])

  const revoke = useCallback(async () => {
    try {
      await deleteAIConsent(providerId)
      await refreshConfig()
    } catch (e) {
      setKeyNote((await serverErrorMessage(e)) ?? t('as.errConsentRevoke'))
    }
  }, [providerId, refreshConfig])

  const saveKey = useCallback(async () => {
    const value = keyDraft.trim()
    if (!value) {
      setKeyNote(t('as.keyEmpty'))
      return
    }
    setKeyBusy(true)
    setKeyNote(null)
    try {
      await saveAIKey(providerId, value)
      setKeyDraft('')
      setKeyNote(t('as.keySaved'))
      await refreshConfig()
      // Модели перечитываем сразу: до сохранения ключа провайдер отвечал 428, и
      // человек видел пустой список — после сохранения он должен ожить без перезагрузки.
      setModels(await listAIModels(providerId))
    } catch (e) {
      setKeyNote((await serverErrorMessage(e)) ?? t('as.errKeySave'))
    } finally {
      setKeyBusy(false)
    }
  }, [keyDraft, providerId, refreshConfig])

  const removeKey = useCallback(async () => {
    setKeyBusy(true)
    setKeyNote(null)
    try {
      await deleteAIKey(providerId)
      setKeyNote(t('as.keyRemoved'))
      await refreshConfig()
      setModels([])
    } catch (e) {
      setKeyNote((await serverErrorMessage(e)) ?? t('as.errKeyRemove'))
    } finally {
      setKeyBusy(false)
    }
  }, [providerId, refreshConfig])

  /**
   * Добавить свой сервер моделей.
   *
   * После сохранения перечитываем настройку и СРАЗУ выбираем новый сервер: человек
   * добавил его, чтобы им пользоваться, а не чтобы найти его в списке.
   */
  const saveEndpoint = useCallback(async () => {
    const title = endpointDraft.title.trim()
    const url = endpointDraft.url.trim()
    if (title === '') {
      setEndpointNote(t('as.serverTitleEmpty'))
      return
    }
    if (url === '') {
      setEndpointNote(t('as.serverUrlExample'))
      return
    }
    setEndpointBusy(true)
    setEndpointNote(null)
    try {
      const added = await addAIEndpoint({
        title,
        url,
        key: endpointDraft.key.trim(),
        local: endpointDraft.local,
      })
      setEndpointDraft({ title: '', url: '', key: '', local: true })
      setEndpoints(await listAIEndpoints())
      const fresh = await getAIConfig()
      setConfig(fresh)
      // Выбираем добавленный сервер сразу: его добавили, чтобы им пользоваться.
      const freshProvider = added === null ? '' : added.providerId
      if (freshProvider !== '') {
        setProviderId(freshProvider)
        setKeyNote(null)
      }
      if (added === null) {
        // Запись, скорее всего, создана — не разобрали только ответ. Не выдаём это за
        // ошибку добавления: человеку нужно перечитать список, а не добавлять заново.
        setEndpointNote(t('as.serverUnparsed'))
      } else if (added.hasKey) {
        setEndpointNote(t('as.serverAddedKeyed', { title: added.title }))
      } else {
        setEndpointNote(t('as.serverAdded', { title: added.title }))
      }
    } catch (e) {
      setEndpointNote((await serverErrorMessage(e)) ?? t('as.errServerAdd'))
    } finally {
      setEndpointBusy(false)
    }
  }, [endpointDraft])

  /**
   * Убрать свой сервер.
   *
   * Если убран именно выбранный провайдер, возвращаем выбор на первого доступного:
   * оставить выбор на исчезнувшем сервере значило бы показать пустой список моделей
   * без объяснения.
   */
  const removeEndpoint = useCallback(
    async (endpoint: AIEndpoint) => {
      setEndpointBusy(true)
      setEndpointNote(null)
      try {
        await deleteAIEndpoint(endpoint.id)
        const list = await listAIEndpoints()
        setEndpoints(list)
        const fresh = await getAIConfig()
        setConfig(fresh)
        if (providerId === endpoint.providerId) {
          const first =
            fresh.providers.find((p) => p.hasKey || p.local) ?? fresh.providers[0] ?? null
          setProviderId(first ? first.id : '')
        }
        setEndpointNote(t('as.serverRemoved', { title: endpoint.title }))
      } catch (e) {
        setEndpointNote((await serverErrorMessage(e)) ?? t('as.errServerRemove'))
      } finally {
        setEndpointBusy(false)
      }
    },
    [providerId],
  )

  /**
   * Применить предложенную правку.
   *
   * Правку в документ пишет сервер — окно не правит текст само. После применения
   * предложение уходит из «ждут решения» в «применены», и там у обоих видов есть
   * «Вернуть»: у перезаписи это прежний текст, у удаления — снимок кадра, который сервер
   * сохранил в момент удаления.
   */
  const applyProposal = useCallback(
    async (proposal: AIProposal) => {
      setProposalBusy(proposal.id)
      setProposalNote(null)
      try {
        const result = await applyAIProposal(projectId, proposal.id)
        setProposals((list) => list.filter((item) => item.id !== proposal.id))
        setAppliedProposals((list) => [...list, result.proposal ?? proposal])
        setProposalNote(
          result.warning ||
            (proposal.kind === 'delete_event'
              ? t('as.appliedDeleted')
                : t('as.appliedEdited')),
        )
        // Дерево и лента на странице должны увидеть правку без перезагрузки.
        onProjectChanged()
      } catch (e) {
        setProposalNote((await serverErrorMessage(e)) ?? t('as.errApply'))
      } finally {
        setProposalBusy(null)
      }
    },
    [projectId, onProjectChanged],
  )

  const revertProposal = useCallback(
    async (proposal: AIProposal) => {
      setProposalBusy(proposal.id)
      setProposalNote(null)
      try {
        const result = await revertAIProposal(projectId, proposal.id)
        setAppliedProposals((list) => list.filter((item) => item.id !== proposal.id))
        setProposals((list) => [...list, result.proposal ?? proposal])
        setProposalNote(
          result.warning ||
            (proposal.kind === 'delete_event'
              ? t('as.revertedDelete')
                : t('as.revertedText')),
        )
        onProjectChanged()
      } catch (e) {
        setProposalNote((await serverErrorMessage(e)) ?? t('as.errRevert'))
      } finally {
        setProposalBusy(null)
      }
    },
    [projectId, onProjectChanged],
  )

  const discardProposal = useCallback(
    async (proposal: AIProposal) => {
      setProposalBusy(proposal.id)
      setProposalNote(null)
      try {
        await discardAIProposal(projectId, proposal.id)
        setProposals((list) => list.filter((item) => item.id !== proposal.id))
        setProposalNote(t('as.discarded'))
      } catch (e) {
        setProposalNote((await serverErrorMessage(e)) ?? t('as.errDiscard'))
      } finally {
        setProposalBusy(null)
      }
    },
    [projectId],
  )

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
          ? t('as.roleSaved', { role: saved.roleTitle })
            : t('as.roleSavedNone'),
      )
    } catch (e) {
      setAgentNote((await serverErrorMessage(e)) ?? t('as.errRoleSave'))
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
      setSendError(t('as.errNoModel'))
      return
    }
    if (images.length > 0 && !modelSeesImages) {
      setSendError(t('as.errNoVision'))
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
    // Картинки уходят с вопросом и после отправки не нужны: в истории их нет, и держать
    // их в поле значило бы отправить ту же картинку со следующим вопросом «за компанию».
    setImages([])

    const controller = new AbortController()
    abortRef.current = controller
    let answer = ''
    try {
      const turn = await streamAIMessage(projectId, conversationId, question, modelRef, {
        images,
        // Беседа могла быть только что создана: её идентификатор нужен сразу, иначе
        // остановленный ответ остался бы в беседе, о которой интерфейс не знает.
        handlers: {
          onStart: (id) => setConversationId(id),
          onDelta: (piece) => {
            answer += piece
            setStreaming(answer)
          },
          onCall: (call) => setLiveCalls((current) => [...current, call.detail || call.name]),
          onChange: (change) => setChanges((current) => [...current, change]),
          // Предложение показываем сразу, как только оно пришло: пока идёт ответ, оно уже
          // существует на сервере, и человек может применить его, не дожидаясь конца.
          onProposal: (proposal) =>
            setProposals((current) =>
              current.some((item) => item.id === proposal.id) ? current : [...current, proposal],
            ),
        },
        signal: controller.signal,
      })
      setConversationId(turn.conversationId || conversationId)
      setMessages((current) => [
        ...current.filter((m) => m.id !== pending.id),
        { ...pending, id: `${pending.id}-sent` },
        turn.message,
      ])
      setChanges(turn.changes)
      setSuggestions(turn.suggestions ?? [])
      // Предложения из итога — на случай, если потоковое событие не доехало (обрыв
      // соединения ровно между вызовом инструмента и его событием).
      if (turn.proposals !== undefined && turn.proposals.length > 0) {
        const fromTurn = turn.proposals
        setProposals((current) => {
          const known = new Set(current.map((item) => item.id))
          return [...current, ...fromTurn.filter((item) => !known.has(item.id))]
        })
      }
      // Предложения карточек мира (0.77.0): компонент грузит их сам, ему нужен только сигнал
      // «пришёл новый ответ». Счётчик, а не список: предложения живут на сервере, и второй
      // копии в состоянии переписки быть не должно.
      if ((turn.entityProposals?.length ?? 0) > 0) {
        setEntitiesRefresh((current) => current + 1)
      }
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
            t('as.errNoAnswer'),
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
  }, [
    text,
    sending,
    modelRef,
    images,
    modelSeesImages,
    projectId,
    conversationId,
    onProjectChanged,
    onUnread,
    refreshConfig,
  ])

  /** «Стоп»: обрываем запрос — сервер сохранит то, что модель успела сказать. */
  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /**
   * Прикрепить выбранные файлы.
   *
   * Проверяем каждый файл и говорим словами, что не так: молча «не прикрепилось» —
   * худший вариант, человек не поймёт, что произошло. Файлы читаются по очереди: так
   * порядок превью совпадает с порядком, в котором человек их выбирал.
   */
  const attachFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setAttachError(null)
      const next = [...images]
      for (const file of Array.from(files)) {
        const problem = imageFileError(file, next.length, lang)
        if (problem) {
          setAttachError(problem)
          continue
        }
        try {
          next.push(await readImageFile(file))
        } catch {
          setAttachError(t('as.attachFailed', { name: file.name }))
        }
      }
      setImages(next)
    },
    [images],
  )

  const removeImage = useCallback((index: number) => {
    setImages((current) => current.filter((_, i) => i !== index))
    setAttachError(null)
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
  const agentName = agent?.agentName || t('ai.agentName')
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
          <span className="ai-head__model" title={modelRef || t('as.modelNotChosen')}>
            {agent?.roleTitle ? `${agent.roleTitle} · ` : t('as.coauthorOfProject')}
            {modelLabel || t('as.modelNotChosen')}
          </span>
        </div>
        <div className="ai-head__actions">
          <button
            type="button"
            className="ai-icon"
            aria-pressed={view === 'settings'}
            aria-label={t('as.settingsAria')}
            title={t('as.settingsTitle')}
            data-assistant-settings
            onClick={() => setView((v) => (v === 'settings' ? 'chat' : 'settings'))}
          >
            <GearIcon />
          </button>
          <button
            type="button"
            className="ai-icon"
            aria-label={t('as.closeAria')}
            title={t('as.closeTitle')}
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
            {t('as.disabled1')}
              <code>AI_ENABLED=true</code>
              {t('as.disabled2')}
          </p>
        </div>
      )}

      {config != null && config.enabled && view === 'settings' && (
        <div className="ai-body ai-body--settings" data-assistant-settings-view>
          <label className="ai-field">
            <span>{t('as.provider')}</span>
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
                  {p.own
                    ? t('as.tagOwn')
                      : p.keyless
                      ? t('as.tagKeyless')
                      : p.local
                      ? t('as.tagLocal')
                      : p.hasKey
                      ? ''
                      : t('as.tagNeedsKey')}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-field">
            <span>{t('as.model')}</span>
            <select
              value={modelRef}
              onChange={(e) => setModelRef(e.target.value)}
              disabled={models.length === 0}
            >
              {models.length === 0 && <option value="">{t('as.noModelsOption')}</option>}
              {models.map((m) => (
                <option key={m.ref || m.id} value={m.ref || `${m.provider}:${m.id}`}>
                  {m.title}
                  {m.cloud
                    ? t('as.tagCloud')
                    : m.local
                    ? t('as.tagLocalOption')
                    : m.free
                    ? t('as.tagFree')
                    : ''}
                    {m.tools ? '' : t('as.tagNoTools')}
                </option>
              ))}
            </select>
          </label>

          {provider != null && (
            <p className={modelIsCloud ? 'ai-warn' : 'ai-note'}>
              {providerNote(provider, modelIsCloud)}
            </p>
          )}

          {modelsNote != null && <p className="ai-note">{modelsNote}</p>}

          {/* Ключ своего сервера задаётся вместе с адресом: отдельного места для него
              нет, поэтому форму не показываем — иначе она предлагала бы ввести то, что
              уже введено, и заканчивалась бы отказом сервера. */}
          {provider != null && !provider.local && !provider.own && (
            <div className="ai-key">
              <input
                type="password"
                placeholder={t('as.keyPlaceholder')}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                disabled={!config.keysReady}
                aria-label={t('as.keyAria')}
              />
              <button onClick={saveKey} disabled={keyBusy || !config.keysReady}>
                {t('as.save')}
              </button>
              {provider.hasKey && (
                <button className="secondary" onClick={removeKey} disabled={keyBusy}>
                  {t('as.delete')}
                </button>
              )}
            </div>
          )}

          {provider != null && provider.own && (
            <p className="ai-note" data-assistant-own-key>
              {provider.keyless
                ? t('as.ownKeylessNote')
                  : t('as.ownKeyNote')}
            </p>
          )}

          {!config.keysReady && (
            <p className="ai-note">
              {t('as.keysNotReady1')}
                <code>AI_SECRET_KEY</code>
                {t('as.keysNotReady2')}
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
                {t('as.consentCheck', { title: provider.title })}
              </span>
            </label>
          )}

          {/* Свои серверы моделей. Провайдеров на стенде ровно столько, сколько прописал
              админ: если у человека llama.cpp на своей машине, без этого блока ему
              подключиться нечем — поля для адреса нет больше нигде. */}
          <div className="ai-endpoints" data-assistant-endpoints>
            <p className="ai-about__title">{t('as.ownServersTitle')}</p>
            <p className="ai-note">
              {t('as.ownServersHint1')}{' '}
                <strong>{t('as.ownServersHintStrong')}</strong>
                {t('as.ownServersHint2')}{' '}
                <code>http://localhost:8080/v1</code>
                {t('as.ownServersHint3')}
            </p>

            {endpoints === null ? (
              <p className="ai-note">{t('as.endpointsFailed')}</p>
            ) : endpoints.length === 0 ? (
              <p className="ai-note" data-assistant-endpoints-empty>
                {t('as.endpointsEmpty')}
              </p>
            ) : (
              <ul className="ai-endpoints__list" data-assistant-endpoints-list>
                {endpoints.map((endpoint) => (
                  <li key={endpoint.id} className="ai-endpoints__item">
                    <span className="ai-endpoints__title">{endpoint.title}</span>
                    <span className="ai-endpoints__url" title={endpoint.url}>
                      {endpoint.url}
                    </span>
                    <span className="ai-note">
                      {endpoint.local ? t('as.endpointLocal') : t('as.endpointExternal')}
                        {endpoint.hasKey ? t('as.endpointHasKey') : t('as.endpointNoKey')}
                    </span>
                    <button
                      className="secondary"
                      onClick={() => void removeEndpoint(endpoint)}
                      disabled={endpointBusy}
                      aria-label={t('as.endpointRemoveAria', { title: endpoint.title })}
                    >
                      {t('as.delete')}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <label className="ai-field">
              <span>{t('as.endpointTitleLabel')}</span>
              <input
                type="text"
                value={endpointDraft.title}
                aria-label={t('as.endpointTitleAria')}
                placeholder={t('as.endpointTitlePlaceholder')}
                onChange={(e) => setEndpointDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </label>

            <label className="ai-field">
              <span>{t('as.endpointUrlLabel')}</span>
              <input
                type="text"
                value={endpointDraft.url}
                aria-label={t('as.endpointUrlAria')}
                placeholder="http://192.168.1.10:8080/v1"
                onChange={(e) => setEndpointDraft((d) => ({ ...d, url: e.target.value }))}
              />
            </label>

            <label className="ai-field">
              <span>{t('as.endpointKeyLabel')}</span>
              <input
                type="password"
                value={endpointDraft.key}
                aria-label={t('as.endpointKeyAria')}
                placeholder={t('as.endpointKeyPlaceholder')}
                disabled={!config.keysReady}
                onChange={(e) => setEndpointDraft((d) => ({ ...d, key: e.target.value }))}
              />
            </label>

            <label className="ai-consent-check">
              <input
                type="checkbox"
                checked={endpointDraft.local}
                aria-label={t('as.endpointLocalAria')}
                onChange={(e) => setEndpointDraft((d) => ({ ...d, local: e.target.checked }))}
              />
              <span>
                {t('as.endpointLocalHint')}
              </span>
            </label>

            {!config.keysReady && (
              <p className="ai-note">
                {t('as.noSecret1')}
                  <code>AI_SECRET_KEY</code>
                  {t('as.noSecret2')}
              </p>
            )}

            <button onClick={() => void saveEndpoint()} disabled={endpointBusy}>
              {endpointBusy ? t('as.saving') : t('as.addServer')}
            </button>
            {endpointNote != null && <p className="ai-note">{endpointNote}</p>}
          </div>

          <button className="secondary ai-body__back" onClick={() => setView('chat')}>
            {t('as.backToChat')}
          </button>

          {/* Роль и поведение агента: он пишет текст проекта, поэтому у него есть
              характер — и задаёт его владелец проекта, а не админ стенда. */}
          <div className="ai-agent" data-assistant-agent>
            <p className="ai-about__title">{t('as.agentTitle')}</p>
            <p className="ai-note">
              {t('as.agentIntro', { name: agentName })}
                {agent?.member ? t('as.agentMember') : ''}
            </p>

            {agent == null ? (
              <p className="ai-note">{t('as.agentFailed')}</p>
            ) : agent.canEdit ? (
              <>
                <label className="ai-field">
                  <span>{t('as.roleLabel')}</span>
                  <select
                    value={agentDraft.role}
                    aria-label={t('as.roleAria')}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, role: e.target.value }))}
                  >
                    <option value="">{t('as.roleNone')}</option>
                    {agent.roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {t('as.roleOption', { title: role.title, hint: role.hint })}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="ai-field">
                  <span>{t('as.genLabel')}</span>
                  <select
                    value={agentDraft.generation}
                    aria-label={t('as.genAria')}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, generation: e.target.value }))}
                  >
                    {agent.generations.map((option) => (
                      <option key={option.id} value={option.id} disabled={!option.available}>
                        {option.title}
                        {option.available ? '' : t('as.genUnavailable')}
                      </option>
                    ))}
                  </select>
                  {/* Причину недоступного режима показываем словами: «недоступно» без
                      объяснения — это загадка, а не интерфейс. */}
                  <span className="ai-note" data-assistant-generation-hint>
                    {generationHint(agent)}
                  </span>
                </label>

                <label className="ai-field">
                  <span>{t('as.styleLabel')}</span>
                  <input
                    type="text"
                    value={agentDraft.imageStyle}
                    aria-label={t('as.styleAria')}
                    placeholder={t('as.stylePlaceholder')}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, imageStyle: e.target.value }))}
                  />
                </label>

                {/* Негативный промпт (0.105.0). Раньше он задавался только на стенде, и автор не
                    мог сказать «в этой книге нет людей»: это часть замысла, а не техника сервера.
                    Пустое поле — не «без ограничений», а «как на стенде», и так и написано. */}
                <label className="ai-field">
                  <span>{t('as.negativeLabel')}</span>
                  <input
                    type="text"
                    value={agentDraft.imageNegative}
                    aria-label={t('as.negativeAria')}
                    maxLength={400}
                    placeholder={t('as.negativePlaceholder')}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, imageNegative: e.target.value }))}
                  />
                  <span className="ai-note" data-assistant-negative-hint>
                    {t('as.negativeHint')}
                  </span>
                </label>

                <label className="ai-field">
                  <span>{t('as.instructionsLabel')}</span>
                  <textarea
                    value={agentDraft.instructions}
                    rows={3}
                    aria-label={t('as.instructionsAria')}
                    placeholder={t('as.instructionsPlaceholder')}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, instructions: e.target.value }))}
                  />
                </label>

                <label className="ai-consent-check">
                  <input
                    type="checkbox"
                    checked={agentDraft.enabled}
                    aria-label={t('as.agentEnabledAria')}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  />
                  <span>
                    {t('as.agentEnabledHint')}
                  </span>
                </label>

                <button onClick={saveAgent} disabled={agentBusy}>
                  {agentBusy ? t('as.saving') : t('as.saveRole')}
                </button>
              </>
            ) : (
              <p className="ai-note">
                {t('as.roleOwnerOnly')}{' '}
                  {agent.roleTitle ? t('as.roleNow', { role: agent.roleTitle }) : t('as.roleNowNone')}
                  {agent.instructions ? t('as.instructionsNow', { text: agent.instructions }) : ''}
              </p>
            )}
            {agentNote != null && <p className="ai-note">{agentNote}</p>}
          </div>

          {/* Что помощник умеет и чем ограничен — прямо в настройке: вопрос «а что он
              может?» возникает именно здесь, а не в переписке. */}
          <div className="ai-about">
            <p className="ai-about__title">{t('as.aboutTitle')}</p>
            <ul className="ai-note">
              <li>{t('as.ability1')}</li>
                <li>{t('as.ability2')}</li>
                <li>{t('as.ability3')}</li>
              {/* Картинки — только если они действительно доступны. Обещать их в
                  списке «что умеет» при выключенном генераторе нельзя. */}
              {agent?.capabilities.images ? (
                <li>{t('as.abilityImages')}</li>
              ) : (
                <li className="ai-note" data-assistant-images-unavailable>
                  {t('as.imagesUnavailable', {
                    note: agent?.capabilities.imageNote || agent?.imageNote || '',
                  })}
                </li>
              )}
            </ul>
            <p className="ai-note">
              {t('as.notDoing', { count: config.maxToolCalls })}
            </p>
            <button className="secondary" onClick={checkModels}>
              {t('as.checkConnection')}
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
                <p className="ai-empty__title">{t('as.emptyTitle')}</p>
                <p className="ai-note">
                  {t('as.emptyHint')}
                </p>
                <div className="ai-hints" data-assistant-hints>
                  {promptHints(agent?.role ?? '', projectIsEmpty, lang).map((hint) => (
                    <button
                      key={hint.label}
                      type="button"
                      className="ai-hint"
                      onClick={() => {
                        // Подставляем, а не отправляем: человек должен увидеть, что именно
                        // уйдёт модели (и сколько это будет стоить), до отправки.
                        setText(hint.prompt)
                        inputRef.current?.focus()
                      }}
                    >
                      {hint.label}
                    </button>
                  ))}
                </div>
                <p className="ai-note">
                  {t('as.emptyChanges')}
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
                <span className="ai-msg__who">{message.role === 'user' ? t('as.you') : agentName}</span>
                {message.role === 'user' ? (
                  <p className="ai-msg__text">{message.content}</p>
                ) : (
                  <>
                    <MarkdownBlock source={message.content} className="ai-msg__text" />
                    {message.stopped && (
                      <p className="ai-msg__stopped" data-assistant-stopped>
                        {t('as.stopped')}
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
            {sending && streaming === '' && <p className="ai-thinking">{t('as.thinking')}</p>}
            {sending && liveCalls.length > 0 && (
              <p className="ai-note ai-note--padded" data-assistant-live-calls>
                {t('as.liveCalls', { count: liveCalls.length })}
              </p>
            )}
          </div>

          {changes.length > 0 && (
            <div className="ai-changes" data-assistant-changes>
              <strong>{t('as.changesTitle')}</strong>
              <ul>
                {changes.map((change) => (
                  <li key={`${change.action}-${change.id}`}>{changeLabel(change)}</li>
                ))}
              </ul>
              <button className="secondary" onClick={onOpenEditors}>
                {t('as.viewInTree')}
              </button>
            </div>
          )}

          {/* Предложенные правки существующих кадров. Отдельный блок и отдельные кнопки:
              проект ещё НЕ изменился, и «применить» — решение человека, а не агента. */}
          {proposals.length > 0 && (
            <div className="ai-proposals" data-assistant-proposals>
              <strong>{t('as.proposalsTitle')}</strong>
              <ul>
                {proposals.map((proposal) => (
                  <li key={proposal.id} className="ai-proposals__item" data-proposal-id={proposal.id}>
                    <span className="ai-proposals__title">{proposalTitle(proposal, 'pending')}</span>
                    {proposal.kind === 'update_span' ? (
                      <span className="ai-proposals__diff" data-proposal-span>
                        <del>{proposal.oldSpan}</del> → <ins>{proposal.newSpan}</ins>
                      </span>
                    ) : (
                      proposal.kind !== 'delete_event' && (
                        <span className="ai-proposals__diff">{diffSummary(proposal)}</span>
                      )
                    )}
                    <span className="ai-proposals__actions">
                      <button
                        onClick={() => void applyProposal(proposal)}
                        disabled={proposalBusy !== null}
                      >
                        {proposalBusy === proposal.id ? t('as.applying') : t('as.apply')}
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void discardProposal(proposal)}
                        disabled={proposalBusy !== null}
                      >
                        {t('as.discard')}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Предложения карточек мира (0.77.0). Отдельный компонент со своей загрузкой: карточки
              живут в Postgres, а не в документе, и переживают перезагрузку страницы — значит,
              список надо читать с сервера, а не держать в состоянии переписки. */}
          <EntityProposals projectId={projectId} refreshKey={entitiesRefresh} />

          {/* Применённые: правка уже в документе, но «Вернуть» ещё имеет смысл — пока
              человек не закрыл окно. У удаления это возврат кадра по снимку, который
              сервер сохранил в момент удаления (ai_changes.frame). */}
          {appliedProposals.length > 0 && (
            <div className="ai-proposals ai-proposals--applied" data-assistant-applied>
              <strong>{t('as.appliedTitle')}</strong>
              <ul>
                {appliedProposals.map((proposal) => (
                  <li key={proposal.id} className="ai-proposals__item" data-proposal-id={proposal.id}>
                    <span className="ai-proposals__title">{proposalTitle(proposal, 'applied')}</span>
                    <span className="ai-proposals__actions">
                      <button
                        className="secondary"
                        onClick={() => void revertProposal(proposal)}
                        disabled={proposalBusy !== null}
                      >
                        {proposal.kind === 'delete_event'
                          ? t('as.revertFrame')
                            : proposal.kind === 'update_span'
                            ? t('as.revertSpan')
                            : proposal.kind === 'update_date'
                            ? t('as.revertDate')
                            : proposal.kind === 'move_event'
                            ? t('as.revertPlace')
                            : t('as.revertText')}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Итог последнего действия с правкой — ОТДЕЛЬНО от блоков: после отклонения
              или применения предложение исчезает, а «проект не изменился» / «текст
              изменён» человек должен успеть прочитать. */}
          {proposalNote != null && (
            <p className="ai-note ai-note--padded" data-assistant-proposal-note>
              {proposalNote}
            </p>
          )}

          {/* Что дальше — предложения сервера. Нажатие ПОДСТАВЛЯЕТ текст в поле ввода
              (как подсказки в пустом чате): человек видит, что уйдёт модели, и может
              поправить формулировку до отправки. */}
          {suggestions.length > 0 && !sending && (
            <div className="ai-hints ai-hints--next" data-assistant-suggestions>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="ai-hint"
                  data-suggestion-kind={suggestion.kind}
                  onClick={() => {
                    setText(suggestion.prompt)
                    inputRef.current?.focus()
                  }}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          )}

          {consentBlocked && (
            <div className="ai-consent" data-consent-required>
              <p>
                {modelIsCloud
                  ? t('as.consentCloud', { model: modelLabel })
                    : t('as.consentProvider', { provider: provider?.title ?? providerId })}
              </p>
              <button onClick={agree}>{t('as.agreeContinue')}</button>
            </div>
          )}

          {consentNeeded && !consentBlocked && (
            <p className="ai-error ai-error--padded">
              {t('as.consentAgain')}
            </p>
          )}

          {sendError != null && <p className="ai-error ai-error--padded">{sendError}</p>}

          {budgetExhausted && (
            <p className="ai-error ai-error--padded" data-assistant-budget>
              {t('as.budget', { used: config?.tokensToday, limit: config?.tokenLimit })}
            </p>
          )}

          <footer className="ai-composer">
            {images.length > 0 && (
              <div className="ai-attach" data-assistant-attach>
                {images.map((image, index) => (
                  <span className="ai-attach__item" key={`${index}-${image.length}`}>
                    <img src={image} alt={t('as.attachAlt', { index: index + 1 })} />
                    <button
                      type="button"
                      className="ai-attach__remove"
                      onClick={() => removeImage(index)}
                      aria-label={t('as.removeImageAria', { index: index + 1 })}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachError != null && <p className="ai-error ai-error--padded">{attachError}</p>}
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
              placeholder={t('as.inputPlaceholder')}
              rows={2}
              disabled={sending || consentBlocked || budgetExhausted || !config.enabled}
              aria-label={t('as.inputAria')}
            />
            <div className="ai-composer__row">
              {sending ? (
                // Пока ответ идёт, главная кнопка — «стоп»: остановить генерацию
                // человек должен уметь в любой момент, а не ждать конца.
                <button type="button" className="secondary" onClick={stop} data-assistant-stop>
                  {t('as.stop')}
                </button>
              ) : (
                <button
                  onClick={ask}
                  disabled={consentBlocked || budgetExhausted || text.trim() === ''}
                >
                  {t('as.ask')}
                </button>
              )}
              {/* Кнопка прикрепления — только у модели, которая картинки видит: иначе
                  она обещала бы то, чего модель не умеет. */}
              {modelSeesImages && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    hidden
                    data-assistant-file
                    onChange={(e) => {
                      void attachFiles(e.target.files)
                      // Очищаем поле: иначе повторный выбор того же файла не сработает.
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => fileRef.current?.click()}
                    disabled={sending || images.length >= MAX_IMAGES}
                    title={
                      images.length >= MAX_IMAGES
                        ? t('as.tooManyImages', { limit: MAX_IMAGES })
                          : t('as.attachTitle')
                    }
                    data-assistant-attach-button
                  >
                    {t('as.image')}
                  </button>
                </>
              )}
              <button
                type="button"
                className="secondary"
                onClick={startNewConversation}
                disabled={sending || !hasAnswer}
                title={t('as.newConversationTitle')}
              >
                {t('as.newConversation')}
              </button>
              <span className="ai-note ai-composer__hint" data-assistant-tokens>
                {config.tokenLimit > 0
                  ? t('as.tokensLimit', { used: config.tokensToday, limit: config.tokenLimit })
                    : t('as.tokensUsed', { used: config.tokensToday })}
                    {' · '}
                    {t('as.framesPerAnswer', { count: config.maxToolCalls })}
              </span>
            </div>
          </footer>
        </>
      )}
    </>
  )
}

/**
 * Заголовок предложения по виду правки.
 *
 * Отдельной функцией, потому что видов три и они расходятся: кадр (переписать/удалить) и
 * фрагмент — «правка фрагмента по замечанию». Ошибка в подписи не ломает правку, но человек
 * подтверждает именно то, что прочитал, — поэтому подпись считается в одном месте.
 */
function proposalTitle(proposal: AIProposal, stage: 'pending' | 'applied'): string {
  const title = proposal.eventTitle
  const pending = stage === 'pending'
  if (proposal.kind === 'delete_event') {
    return tStatic(pending ? 'as.propDeletePending' : 'as.propDeleteApplied', { title })
  }
  if (proposal.kind === 'update_span') {
    return tStatic(pending ? 'as.propSpanPending' : 'as.propSpanApplied', { title })
  }
  if (proposal.kind === 'update_date') {
    return tStatic(pending ? 'as.propDatePending' : 'as.propDateApplied', { title })
  }
  if (proposal.kind === 'move_event') {
    // Куда переносим — в подписи: «переместить» без адреса человек подтверждал бы вслепую.
    const to =
      proposal.newParentTitle === ''
        ? tStatic('as.topLevel')
        : tStatic('as.quoted', { title: proposal.newParentTitle })
    return tStatic(pending ? 'as.propMovePending' : 'as.propMoveApplied', { title, to })
  }
  return tStatic(pending ? 'as.propRewritePending' : 'as.propRewriteApplied', { title })
}

/**
 * Коротко, что изменится: «заголовок: было → станет», место или первая строка текста.
 *
 * Полный diff здесь был бы не нужен: человек решает «применять или нет», а не читает
 * сравнение целиком — полный текст кадра он посмотрит в редакторе до или после.
 */
function diffSummary(proposal: AIProposal): string {
  const parts: string[] = []
  if (proposal.kind === 'move_event') {
    // Место в дереве — не текст: показываем прежнюю и новую главу, а «верхний уровень» —
    // словами, иначе пустое «было» читалось бы как «данных нет».
    const from = proposal.oldParentTitle === '' ? tStatic('as.topLevel') : proposal.oldParentTitle
    const to = proposal.newParentTitle === '' ? tStatic('as.topLevel') : proposal.newParentTitle
    parts.push(tStatic('as.diffPlace', { from, to }))
    return parts.join('; ')
  }
  if (proposal.newTitle !== '' && proposal.newTitle !== proposal.oldTitle) {
    parts.push(tStatic('as.diffTitle', { from: proposal.oldTitle, to: proposal.newTitle }))
  }
  if (proposal.kind === 'update_date') {
    // Дата — не текст: человеку нужно увидеть ровно «было → станет», а «без изменений» здесь
    // означало бы, что он не понял, что подтверждает.
    // Дату показываем как есть (YYYY-MM-DD): так она выглядит в дереве и в поле редактора, и
    // человек не сверяет «05.03» с «2026-03-05» в другом формате.
    const before = proposal.oldDate === '' ? tStatic('as.noDate') : proposal.oldDate
    const after = proposal.newDate === '' ? tStatic('as.noDate') : proposal.newDate
    parts.push(tStatic('as.diffDate', { from: before, to: after }))
    return parts.join('; ')
  }
  if (proposal.newBody !== proposal.oldBody) {
    const before = firstLine(proposal.oldBody)
    const after = firstLine(proposal.newBody)
    parts.push(tStatic('as.diffText', { from: before, to: after }))
  }
  return parts.length > 0 ? parts.join('; ') : tStatic('as.noChanges')
}

/** Первая содержательная строка текста, обрезанная по словам. */
function firstLine(text: string): string {
  const clean = text.replace(/[#*_>`]/g, '').trim().split('\n').find((line) => line.trim() !== '')
  if (!clean) return tStatic('as.emptyText')
  const trimmed = clean.trim()
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
}

/**
 * Куда уходит текст проекта — одной строкой. Возвращает пустую строку, если провайдер
 * ещё не приехал: лучше ничего, чем неверное «локальная» или «чужая».
 */
function privacyNote(provider: AIProviderInfo | null, modelIsCloud: boolean): string {
  if (provider == null) return ''
  if (modelIsCloud) {
    return tStatic('as.privacyCloud')
  }
  if (provider.local) {
    return provider.keyless ? tStatic('as.privacyOwnKeyless') : tStatic('as.privacyLocal')
  }
  if (provider.standKey) {
    return tStatic('as.privacyStandKey', { title: provider.title })
  }
  return tStatic('as.privacyProvider', { title: provider.title })
}

/**
 * Куда уходит текст проекта и нужен ли ключ — абзац под выбором модели (0.125.0).
 *
 * Отдельной функцией, потому что это вложенное дерево решений: облачная модель, свой сервер
 * в сети, свой сервер снаружи, локальная модель стенда, ключ стенда. Подписи — из словаря,
 * `provider.note` с сервера остаётся как есть: это текст админа стенда.
 */
function providerNote(provider: AIProviderInfo, modelIsCloud: boolean): string {
  if (modelIsCloud) return tStatic('as.cloudWarning')
  if (provider.own) {
    if (provider.local) {
      return (
        tStatic('as.ownLocal', { title: provider.title }) +
        (provider.keyless ? tStatic('as.ownLocalKeyless') : tStatic('as.ownLocalKeyed'))
      )
    }
    return (
      tStatic('as.ownExternal', { title: provider.title }) +
      (provider.keyless ? '' : tStatic('as.ownExternalKeyed'))
    )
  }
  if (provider.local) {
    return provider.keyless ? tStatic('as.standKeyless') : tStatic('as.standLocal')
  }
  if (provider.standKey) return tStatic('as.standKey')
  if (provider.keyRequired) return tStatic('as.keyRequired')
  return provider.note
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

/**
 * Что показать под выбором режима: подсказку выбранного или причину недоступности.
 *
 * Владелец должен понимать, ПОЧЕМУ режима нет, а не догадываться: «недоступно» без
 * причины — это загадка.
 */
function generationHint(agent: AISettings): string {
  const selected = agent.generations.find((option) => option.id === agent.generation)
  if (selected && !selected.available) return selected.hint
  if (!agent.capabilities.images && agent.capabilities.imageNote) {
    return tStatic('as.genNow', { hint: selected?.hint ?? '', note: agent.capabilities.imageNote })
  }
  return selected?.hint ?? ''
}
