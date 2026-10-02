import { useCallback, useEffect, useRef, useState } from 'react'
import { AssistantPanel } from './AssistantPanel'

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
}

export function AssistantDock({
  projectId,
  open,
  onOpenChange,
  onProjectChanged,
  onOpenEditors,
  projectIsEmpty = true,
}: Props) {
  const [unread, setUnread] = useState(0)
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

  const badge = unread > 0 ? (unread > 9 ? '9+' : String(unread)) : null

  return (
    <div className={`ai-dock${open ? ' ai-dock--open' : ''}`} data-assistant-dock>
      <div
        className="ai-window"
        ref={windowRef}
        hidden={!open}
        role="dialog"
        aria-label="ИИ-помощник"
        data-assistant-panel
      >
        <AssistantPanel
          projectId={projectId}
          open={open}
          projectIsEmpty={projectIsEmpty}
          onClose={() => closeDock(true)}
          onUnread={() => setUnread((n) => n + 1)}
          onThinkingChange={setThinking}
          onProjectChanged={onProjectChanged}
          onOpenEditors={onOpenEditors}
        />
      </div>

      <button
        type="button"
        ref={buttonRef}
        className={`ai-fab${thinking ? ' is-thinking' : ''}${badge ? ' has-unread' : ''}`}
        aria-expanded={open}
        aria-label={
          badge
            ? `ИИ-помощник: непрочитанных ответов ${badge}`
            : open
              ? 'Закрыть помощника'
              : 'Открыть помощника'
        }
        title={open ? 'Свернуть помощника' : 'ИИ-помощник: создать главы и под-события'}
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
