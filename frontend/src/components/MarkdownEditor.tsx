import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownBlock } from './MarkdownBlock'
import { resolveLiveText } from '../collab/liveText'
import {
  DIAGRAM_KINDS,
  codeSkeleton,
  diagramSkeleton,
  formulaSkeleton,
  heading,
  insertBlock,
  prefixLines,
  tableSkeleton,
  wrapSelection,
  type Selection,
} from '../lib/markdownInsert'

interface Props {
  /** Текущий текст события. */
  value: string
  /** Сохранение: пишем в CRDT только по кнопке или Ctrl+Enter. */
  onSave: (value: string) => void
  /**
   * Взять версию соавтора из CRDT вместо собственного черновика. Отдельное
   * действие: без него «Сохранить» затирало бы чужую правку, а автоматически
   * подменять текст под руками у печатающего — хуже, чем конфликт.
   */
  onAdopt?: (value: string) => void
  onClose: () => void
  /** Заголовок окна — обычно название события. */
  title?: string
}

type Mode = 'split' | 'edit' | 'preview'

/**
 * Большое окно редактирования текста события с поддержкой Markdown.
 *
 * Зачем отдельное окно: в панели редакторов поле узкое, а разметка требует места
 * и предпросмотра. Здесь три режима — только текст, только предпросмотр и «рядом»
 * (на широком экране), панель вставок для тех, кто разметку не помнит, и подсказка
 * по синтаксису для тех, кто пишет её руками. Предпросмотр — тот же рендер, что и
 * в кадре таймлайна, поэтому «как вижу здесь» совпадает с «как увидят читатели».
 *
 * Окно живое: пока оно открыто, чужие правки больше не теряются. Если человек
 * ничего не печатал, текст молча обновляется на пришедший из CRDT; если печатает —
 * ничего не затирается, но появляется предупреждение и кнопка «взять версию
 * соавтора». Правило «что делать» целиком живёт в `resolveLiveText` и покрыто
 * тестом, здесь только его исполнение.
 */
export function MarkdownEditor({ value, onSave, onAdopt, onClose, title }: Props) {
  const [text, setText] = useState(value)
  const [mode, setMode] = useState<Mode>('split')
  const [diagramKind, setDiagramKind] = useState<string>(DIAGRAM_KINDS[0].id)
  /** На телефоне панель вставок свёрнута: в строку она не влезает (см. CSS). */
  const [insertsOpen, setInsertsOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const windowRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  /**
   * Версия текста, которую человек считает «сохранённой» последней. Не то же
   * самое, что props.value после сохранения: пока идёт merge с соавтором,
   * значение в CRDT успевает измениться, и сравнивать черновик нужно с базой.
   */
  const [base, setBase] = useState(value)
  /** Есть ли чужая правка, которую мы не стали применять автоматически. */
  const [conflict, setConflict] = useState(false)
  /** Последнее значение CRDT, на которое мы уже отреагировали. */
  const valueRef = useRef(value)

  const dirty = text !== base

  /**
   * Реакция на изменения `value` из CRDT.
   *
   * `valueRef` хранит последнее увиденное значение: эффект перезапускается и на
   * локальные правки (`text`/`base` — его зависимости), и без этой проверки
   * «изменением» считался бы каждый такой перезапуск.
   */
  useEffect(() => {
    const remote = value
    if (remote === valueRef.current) return
    valueRef.current = remote
    const decision = resolveLiveText({ local: text, base, remote })
    setBase(decision.base)
    if (decision.action === 'adopt') {
      setText(decision.text)
      setConflict(false)
    } else if (decision.action === 'notify') {
      setConflict(true)
    }
  }, [value, text, base])

  /** Принять версию соавтора: это запись в CRDT, а не только замена текста в окне. */
  const adopt = useCallback(() => {
    setText(valueRef.current)
    setBase(valueRef.current)
    setConflict(false)
    onAdopt?.(valueRef.current)
  }, [onAdopt])

  // Фокус уходит в окно, страница под ним не прокручивается; при закрытии
  // возвращаем и фокус, и прокрутку.
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.documentElement.classList.add('sf-viewer-open')
    textareaRef.current?.focus()
    return () => {
      document.documentElement.classList.remove('sf-viewer-open')
      restoreFocus.current?.focus?.()
    }
  }, [])

  // Экранная клавиатура на телефоне не меняет 100vh: окно оставалось во весь
  // макетный экран, и футер с «Сохранить» уезжал под клавиатуру — редактор
  // «уходил за край». Пишем фактическую видимую высоту и её смещение в CSS
  // переменные, по ним окно и считается (--md-vvh / --md-vvtop).
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return undefined
    const root = document.documentElement
    const apply = () => {
      root.style.setProperty('--md-vvh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--md-vvtop', `${Math.round(vv.offsetTop)}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      root.style.removeProperty('--md-vvh')
      root.style.removeProperty('--md-vvtop')
    }
  }, [])

  const save = useCallback(() => {
    // После сохранения значение из CRDT снова становится базовым: конфликта
    // с соавтором больше нет, и предупреждение в окне гаснет вместе с ним.
    setBase(text)
    setConflict(false)
    onSave(text)
    onClose()
  }, [onSave, onClose, text])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, save])

  const selection = useCallback((): Selection => {
    const el = textareaRef.current
    if (!el) return { start: text.length, end: text.length }
    return { start: el.selectionStart, end: el.selectionEnd }
  }, [text.length])

  /** Применяет правку, возвращает фокус и восстанавливает выделение. */
  const apply = useCallback((result: { text: string; selection: Selection }) => {
    setText(result.text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(result.selection.start, result.selection.end)
    })
  }, [])

  const tools = useMemo(
    () => [
      { label: 'Ж', title: 'Жирный (Ctrl+B)', run: () => apply(wrapSelection(text, selection(), '**')) },
      { label: 'К', title: 'Курсив (Ctrl+I)', run: () => apply(wrapSelection(text, selection(), '*')) },
      { label: 'S', title: 'Зачёркнутый', run: () => apply(wrapSelection(text, selection(), '~~')) },
      { label: 'H1', title: 'Заголовок 1', run: () => apply(heading(text, selection(), 1)) },
      { label: 'H2', title: 'Заголовок 2', run: () => apply(heading(text, selection(), 2)) },
      { label: 'H3', title: 'Заголовок 3', run: () => apply(heading(text, selection(), 3)) },
      { label: '•', title: 'Маркированный список', run: () => apply(prefixLines(text, selection(), '- ')) },
      { label: '1.', title: 'Нумерованный список', run: () => apply(prefixLines(text, selection(), '1. ')) },
      { label: '❝', title: 'Цитата', run: () => apply(prefixLines(text, selection(), '> ')) },
      { label: 'код', title: 'Блок кода', run: () => apply(insertBlock(text, selection(), codeSkeleton())) },
      { label: 'ссылка', title: 'Ссылка', run: () => apply(wrapSelection(text, selection(), '[', '](https://)')) },
      { label: 'таблица', title: 'Таблица 3×3', run: () => apply(insertBlock(text, selection(), tableSkeleton(3, 3))) },
      { label: 'формула', title: 'Формула в строке ($…$)', run: () => apply(wrapSelection(text, selection(), '$')) },
      { label: 'Σ', title: 'Формула отдельной строкой ($$…$$)', run: () => apply(insertBlock(text, selection(), formulaSkeleton(true))) },
      { label: '—', title: 'Разделитель', run: () => apply(insertBlock(text, selection(), '---')) },
    ],
    [apply, selection, text],
  )

  return createPortal(
    <div className="md-editor" role="dialog" aria-modal="true" aria-label="Редактор текста с Markdown">
      <div className="md-editor__window" ref={windowRef}>
        <div className="md-editor__head">
          <div className="md-editor__titles">
            <strong>Текст события</strong>
            {title && <span className="muted">{title}</span>}
          </div>
          <div className="md-editor__modes" role="group" aria-label="Режим редактора">
            {([['split', 'Текст и предпросмотр'], ['edit', 'Только текст'], ['preview', 'Только предпросмотр']] as const).map(
              ([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={mode === id ? 'is-active' : 'secondary'}
                  onClick={() => setMode(id)}
                >
                  {label}
                </button>
              ),
            )}
          </div>
          <button type="button" className="secondary md-editor__close" onClick={onClose} aria-label="Закрыть редактор">
            закрыть ✕
          </button>
        </div>

        {/* Чужая правка при несохранённом черновике: ничего не затираем, но и не
            молчим. Кнопка — явное действие человека, а не автомат. */}
        {conflict && (
          <div className="md-editor__alert" role="status" aria-live="polite">
            <span className="md-editor__alert-text">
              Соавтор изменил текст. Ваши несохранённые правки не тронуты.
            </span>
            <button type="button" className="secondary" onClick={adopt}>
              взять версию соавтора
            </button>
          </div>
        )}

        <div className="md-editor__toolbar" role="toolbar" aria-label="Вставки Markdown" data-inserts={insertsOpen ? 'open' : 'closed'}>
          {/* На телефоне кнопки вставок не влезают в строку (их пятнадцать плюс
              выбор вида диаграммы) и раньше уезжали за правый край экрана.
              Поэтому там они живут в сворачиваемой панели, а в строке остаётся
              одна кнопка. На широком экране панель «раскрыта» всегда. */}
          <button
            type="button"
            className="secondary md-editor__inserts-toggle"
            aria-expanded={insertsOpen}
            aria-controls="md-editor-inserts"
            onClick={() => setInsertsOpen((open) => !open)}
          >
            вставки {insertsOpen ? '▴' : '▾'}
          </button>
          <div className="md-editor__inserts" id="md-editor-inserts">
            {tools.map((tool) => (
              <button key={tool.label} type="button" className="secondary" title={tool.title} onClick={tool.run}>
                {tool.label}
              </button>
            ))}
            <span className="md-editor__toolbar-sep" aria-hidden />
            <select
              className="md-editor__diagram"
              value={diagramKind}
              aria-label="Вид диаграммы"
              onChange={(e) => setDiagramKind(e.target.value)}
            >
              {DIAGRAM_KINDS.map((kind) => (
                <option key={kind.id} value={kind.id}>{kind.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              title="Вставить диаграмму Mermaid"
              onClick={() => apply(insertBlock(text, selection(), diagramSkeleton(diagramKind)))}
            >
              диаграмма
            </button>
          </div>
        </div>

        <div className="md-editor__body" data-mode={mode}>
          <div className="md-editor__pane md-editor__pane--edit">
            <textarea
              ref={textareaRef}
              className="md-editor__textarea"
              value={text}
              spellCheck
              aria-label="Текст события в Markdown"
              onChange={(e) => setText(e.target.value)}
              placeholder={'Обычный текст, **жирный**, списки и таблицы.\n\nФормула: $E = mc^2$\nДиаграмма:\n```mermaid\ngraph TD\n  A --> B\n```'}
            />
            <div className="md-editor__hint">
              <span className="md-editor__hint-syntax">
                Разметка: <code>**жирный**</code> <code>*курсив*</code> <code># заголовок</code>{' '}
                <code>- список</code> <code>| таблица |</code> <code>$формула$</code>{' '}
                <code>```mermaid</code> — диаграмма
              </span>
              <span className="muted md-editor__hint-count">{text.length} символов</span>
            </div>
          </div>
          <div className="md-editor__pane md-editor__pane--preview">
            <div className="md-editor__preview">
              {text.trim() === ''
                ? <p className="muted">Здесь появится то, как текст увидят читатели.</p>
                : <MarkdownBlock source={text} />}
            </div>
          </div>
        </div>

        <div className="md-editor__foot">
          <span className="muted">
            {dirty ? 'Есть несохранённые правки' : 'Всё сохранено'}
            <span className="md-editor__foot-keys"> · Ctrl+Enter — сохранить, Esc — закрыть</span>
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="secondary" onClick={onClose}>Отмена</button>
            <button type="button" onClick={save} disabled={!dirty}>Сохранить текст</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
