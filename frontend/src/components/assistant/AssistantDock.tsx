import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import type { DockPrefill } from '../chat/ProjectChat'
import { AssistantPanel } from './AssistantPanel'
import { KnowledgeTab } from './KnowledgeTab'
import { ProjectChat } from '../chat/ProjectChat'

/**
 * Плавающий помощник: кнопка в углу экрана + окно поверх проекта.
 *
 * Почему так, а не панелью в потоке страницы. Стадия таймлайна — fixed-слой на весь
 * экран и непрозрачный: панель в обычном потоке оказывалась под ним и под нижней кромкой
 * окна (человек видел обрезанный блок настроек и пустую рамку). Плавающая кнопка не
 * зависит ни от прокрутки, ни от слоёв стадии, а окно раскрывается поверх проекта.
 *
 * Что здесь живёт:
 *   - **кнопка** (слева-снизу от окна, правый нижний угол) — открыть/закрыть. На ней
 *     маркер: сколько ответов пришло, пока окно было закрыто, и «думает» — пока идёт
 *     запрос (человек может закрыть окно и вернуться к проекту, не теряя запрос);
 *   - **маркер сбрасывается** при открытии окна: непрочитанное прочитано;
 *   - **Esc** закрывает окно, фокус возвращается на кнопку — с клавиатуры так ожидаемо.
 *
 * Панель при закрытии НЕ размонтируется (окно просто скрыто, `hidden`): история,
 * выбранная модель и набранный вопрос остаются на месте, а ответ, пришедший после
 * закрытия, отмечается маркером.
 */
interface Props {
  projectId: string
  /** Открыто ли окно (управляется страницей: кнопку «ИИ-помощник» в шапке стадии тоже). */
  open: boolean
  onOpenChange: (open: boolean) => void
  onProjectChanged: () => void
  onOpenEditors: () => void
  /**
   * Пуст ли проект (нет ни одного кадра). Нужно подсказкам в пустом чате: в пустом
   * проекте первое осмысленное предложение — «собери проект с нуля», а не «продолжи».
   */
  projectIsEmpty?: boolean
  /** Открыть кадр из ссылки в чате проекта (0.95.0): страница переключит вкладку редакторов. */
  onOpenFrame?: (frameId: string) => void
  /** Цитата из показа проекта: вкладка и предзаполненное поле (0.132.0). */
  prefill?: DockPrefill | null
}

/**
 * Две вкладки одного окна (0.95.0): «Помощник» и «Чат проекта».
 *
 * Почему в одном плавающем окне, а не двумя кнопками. Кнопка уже одна и узнаваемая; участник,
 * который открыл её, обычно хочет либо спросить Нестора, либо написать людям — и переключение
 * вкладкой дешевле, чем второе плавающее окно поверх первого.
 */
type DockTab = 'assistant' | 'chat' | 'knowledge'

/**
 * Широкое окно (0.149.0) — по просьбе людей с большим экраном: переписка, карточки знаний
 * и настройки в 420px читаются тесно. Выбор запоминаем: это настройка «как я работаю», а не
 * разовое действие, и возвращаться к ней после каждой перезагрузки было бы наказанием.
 */
const WIDE_KEY = 'sf-ai-wide'

function readWide(): boolean {
  try {
    return localStorage.getItem(WIDE_KEY) === '1'
  } catch {
    return false // приватный режим: окно обычной ширины, это рабочее состояние
  }
}

function writeWide(wide: boolean): void {
  try {
    localStorage.setItem(WIDE_KEY, wide ? '1' : '0')
  } catch {
    // Приватный режим: выбор просто не запомнится.
  }
}

export function AssistantDock({
  projectId,
  open,
  onOpenChange,
  onProjectChanged,
  onOpenEditors,
  projectIsEmpty = true,
  onOpenFrame,
  prefill = null,
}: Props) {
  const t = useT()
  const [unread, setUnread] = useState(0)
  const [chatUnread, setChatUnread] = useState(0)
  const [tab, setTab] = useState<DockTab>('assistant')
  const [wide, setWide] = useState(readWide)

  const toggleWide = useCallback(() => {
    setWide((current) => {
      writeWide(!current)
      return !current
    })
  }, [])

  // Цитату принесли из показа проекта: открываем нужную вкладку сами, чтобы человек не искал
  // её вкладкой после действия (0.132.0).
  useEffect(() => {
    if (!prefill) return
    setTab(prefill.tab)
  }, [prefill?.nonce, prefill])
  const [thinking, setThinking] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const windowRef = useRef<HTMLDivElement | null>(null)

  const openDock = useCallback(() => {
    setUnread(0)
    onOpenChange(true)
  }, [onOpenChange])

  const closeDock = useCallback(
    (returnFocus = false) => {
      onOpenChange(false)
      if (returnFocus) buttonRef.current?.focus()
    },
    [onOpenChange],
  )

  // Esc закрывает окно: для окна поверх контента это ожидаемое поведение, а без него
  // человек, открывший помощника с клавиатуры, остаётся в ловушке фокуса.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDock(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeDock])

  const badge = unread + chatUnread > 0 ? (unread + chatUnread > 9 ? '9+' : String(unread + chatUnread)) : null

  return (
    <div className={`ai-dock${open ? ' ai-dock--open' : ''}`} data-assistant-dock>
      <div
        className={`ai-window${wide ? ' ai-window--wide' : ''}`}
        ref={windowRef}
        hidden={!open}
        role="dialog"
        aria-label={t('dock.aria')}
        data-assistant-panel
        data-dock-wide-state={wide ? 'on' : 'off'}
      >
        {/* Вкладки окна (0.95.0): помощник и общий чат проекта в одном месте. */}
        <div className="ai-window__tabs" role="tablist" aria-label={t('dock.tabsAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'assistant'}
            className={tab === 'assistant' ? 'ai-window__tab is-active' : 'ai-window__tab'}
            onClick={() => setTab('assistant')}
            data-dock-tab="assistant"
          >
            {t('dock.assistant')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className={tab === 'chat' ? 'ai-window__tab is-active' : 'ai-window__tab'}
            onClick={() => setTab('chat')}
            data-dock-tab="chat"
          >
            {t('dock.chat')}
            {chatUnread > 0 && (
              <span className="ai-window__tab-badge" data-chat-badge>
                {chatUnread > 9 ? '9+' : chatUnread}
              </span>
            )}
          </button>
          {/* Третья вкладка (0.149.0): знания проекта. На телефоне она и есть «ещё одна
              вкладка в чате»: окно узкое, и знания рядом с перепиской не помещаются. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'knowledge'}
            className={tab === 'knowledge' ? 'ai-window__tab is-active' : 'ai-window__tab'}
            onClick={() => setTab('knowledge')}
            data-dock-tab="knowledge"
          >
            {t('dock.knowledge')}
          </button>
          {/* Широкая ширина (0.149.0): на большом экране 420px тесны, но на телефоне
              кнопка бесполезна — CSS её там скрывает. */}
          <button
            type="button"
            className="ai-window__wide"
            aria-pressed={wide}
            aria-label={wide ? t('dock.narrowTitle') : t('dock.wideTitle')}
            title={wide ? t('dock.narrowTitle') : t('dock.wideTitle')}
            onClick={toggleWide}
            data-dock-wide
          >
            {wide ? t('dock.narrow') : t('dock.wide')}
          </button>
          {/* Один крестик на всё окно (0.146.0). Раньше он был только в шапке помощника, и на
              вкладке «Чат проекта» закрыть окно было нечем — приходилось переключаться на
              помощника. Здесь он общий для обеих вкладок и всегда на месте. */}
          <button
            type="button"
            className="ai-window__close"
            aria-label={t('dock.closeWindow')}
            title={t('dock.closeWindow')}
            data-dock-close
            onClick={() => closeDock(true)}
          >
            <CloseCross />
          </button>
        </div>
        {/* Панель помощника не размонтируется при переключении вкладок: история, модель и
            набранный вопрос должны остаться на месте. */}
        <div className="ai-window__pane" hidden={tab !== 'assistant'}>
          <AssistantPanel
            projectId={projectId}
            open={open && tab === 'assistant'}
            projectIsEmpty={projectIsEmpty}
            onUnread={() => setUnread((n) => n + 1)}
            onThinkingChange={setThinking}
            onProjectChanged={onProjectChanged}
            onOpenEditors={onOpenEditors}
            prefill={prefill}
          />
        </div>
        <div className="ai-window__pane" hidden={tab !== 'chat'}>
          <ProjectChat
            projectId={projectId}
            visible={open && tab === 'chat'}
            onOpenFrame={onOpenFrame}
            onUnread={setChatUnread}
            prefill={prefill}
          />
        </div>
        {/* Знания держим в своей панели и не размонтируем: набранное знание не должно
            исчезать от переключения вкладки. */}
        <div className="ai-window__pane" hidden={tab !== 'knowledge'}>
          <KnowledgeTab projectId={projectId} visible={open && tab === 'knowledge'} />
        </div>
      </div>

      <button
        type="button"
        ref={buttonRef}
        className={`ai-fab${thinking ? ' is-thinking' : ''}${badge ? ' has-unread' : ''}`}
        aria-expanded={open}
        aria-label={
          badge
            ? t('dock.unread', { count: badge })
            : open
              ? t('dock.close')
              : t('dock.open')
        }
        title={open ? t('dock.collapse') : t('dock.openTitle')}
        data-assistant-fab
        /* Помечаем кнопку как НАМЕРЕННЫЙ слой поверх контента: она плавающая по
           замыслу, и аудит интерфейса не должен считать её пересечением с тем, что
           можно прокрутить (см. правило в ui-visual-audit). Всё, что закреплено на
           экране, кнопка обязана не перекрывать — это проверяется отдельно. */
        data-overlay="assistant"
        onClick={() => (open ? closeDock() : openDock())}
      >
        <ChatIcon />
        {badge && (
          <span className="ai-fab__badge" data-assistant-badge>
            {badge}
          </span>
        )}
        {/* «Думает» — пульсирующая точка: запрос ушёл, ответ ждём. */}
        {thinking && !badge && <span className="ai-fab__pulse" aria-hidden="true" />}
      </button>
    </div>
  )
}

/** Крестик окна: одна и та же кнопка на обеих вкладках. */
function CloseCross() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M6 6l12 12M18 6L6 18"
      />
    </svg>
  )
}

/** Значок помощника: реплика со «вспышкой» — узнаваемо и не эмодзи. */
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9.4l-4.2 3.4A1 1 0 0 1 3.6 20v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v9h14V6H5Z"
      />
      <path
        fill="currentColor"
        d="M9.2 8.4 10.3 11l2.5 1.1-2.5 1.1-1.1 2.6-1.1-2.6L5.6 12l2.5-1.1 1.1-2.5Zm6.1-2.1.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8.8-1.8Z"
      />
    </svg>
  )
}
