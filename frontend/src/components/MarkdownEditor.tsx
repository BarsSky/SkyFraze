import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pluralWord, useT } from '../i18n'
import { useLang } from '../store/lang'
import { MarkdownBlock } from './MarkdownBlock'
import { resolveLiveText } from '../collab/liveText'
import { MARKER_TEMPLATES, beginMarker, insertMarker, styleMarker } from '../lib/docxMarkers'
import { DocxHelp } from './docx/DocxHelp'
import {
  DIAGRAM_KINDS,
  codeSkeleton,
  diagramLabel,
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
  /**
   * Файлы проекта (id → адрес): ссылки на вложения в тексте заменяются на них, и
   * предпросмотр показывает ту же картинку, что увидят читатели.
   */
  assetUrls?: Record<string, string>
  /**
   * Стили абзаца действующего шаблона DOCX (0.92.0) — из чего выбирать в панели «Разметка DOCX».
   * Пусто — шаблона нет, и панель предлагает только разрыв страницы и оглавление: список
   * несуществующих стилей хуже, чем его отсутствие.
   */
  docxStyles?: string[]
  /**
   * Открыть окно с уже раскрытой панелью «Разметка DOCX» (0.94.1).
   *
   * Зачем: панель маркеров живёт в этом окне, и человека, который нажал «Разметка DOCX» в
   * редакторе, незачем заставлять искать ещё одну кнопку внутри. При обычном открытии окна
   * панель свёрнута — маркеры нужны не каждый раз.
   */
  initialDocxOpen?: boolean
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
export function MarkdownEditor({ value, onSave, onAdopt, onClose, title, assetUrls, docxStyles, initialDocxOpen = false }: Props) {
  const t = useT()
  const [lang] = useLang()
  const [text, setText] = useState(value)
  const [mode, setMode] = useState<Mode>('split')
  const [diagramKind, setDiagramKind] = useState<string>(DIAGRAM_KINDS[0])
  /** На телефоне панель вставок свёрнута: в строку она не влезает (см. CSS). */
  const [insertsOpen, setInsertsOpen] = useState(false)
  /**
   * Панель «Разметка DOCX» (0.92.0). Свёрнута по умолчанию: маркеры нужны не каждый раз, а
   * человек, который их не знает, не должен упираться в них при первом открытии редактора.
   */
  const [docxOpen, setDocxOpen] = useState(initialDocxOpen)
  /** Выбранный стиль шаблона. Пусто — список ещё не пришёл или шаблона нет. */
  const [docxStyle, setDocxStyle] = useState('')
  /** Открыта справка «Как сделать шаблон» (0.94.0). */
  const [docxHelpOpen, setDocxHelpOpen] = useState(false)
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

  /**
   * Стили шаблона для панели «Разметка DOCX» и выбранный из них.
   *
   * `currentStyle` — не просто состояние: список приходит асинхронно (шаблоны грузятся после
   * открытия панели), и без сверки с ним `select` показывал бы пустое значение, а кнопки
   * вставляли маркер с пустым именем.
   */
  const styleNames = useMemo(
    () => (docxStyles ?? []).map((name) => name.trim()).filter((name) => name !== ''),
    [docxStyles],
  )
  const currentStyle = styleNames.includes(docxStyle) ? docxStyle : styleNames[0] ?? ''

  /** Вставка маркера на место курсора: тем же путём, что и остальные вставки. */
  const insertDocxMarker = useCallback(
    (marker: string) => apply(insertMarker(text, selection(), marker)),
    [apply, selection, text],
  )

  const tools = useMemo(
    () => [
      { label: t('md.toolBoldShort'), title: t('md.toolBold'), run: () => apply(wrapSelection(text, selection(), '**')) },
      { label: t('md.toolItalicShort'), title: t('md.toolItalic'), run: () => apply(wrapSelection(text, selection(), '*')) },
      { label: 'S', title: t('md.toolStrike'), run: () => apply(wrapSelection(text, selection(), '~~')) },
      { label: 'H1', title: t('md.toolH1'), run: () => apply(heading(text, selection(), 1)) },
      { label: 'H2', title: t('md.toolH2'), run: () => apply(heading(text, selection(), 2)) },
      { label: 'H3', title: t('md.toolH3'), run: () => apply(heading(text, selection(), 3)) },
      { label: '•', title: t('md.toolBullet'), run: () => apply(prefixLines(text, selection(), '- ')) },
      { label: '1.', title: t('md.toolNumbered'), run: () => apply(prefixLines(text, selection(), '1. ')) },
      { label: '❝', title: t('md.toolQuote'), run: () => apply(prefixLines(text, selection(), '> ')) },
      { label: t('md.toolCodeShort'), title: t('md.toolCode'), run: () => apply(insertBlock(text, selection(), codeSkeleton())) },
      { label: t('md.toolLinkShort'), title: t('md.toolLink'), run: () => apply(wrapSelection(text, selection(), '[', '](https://)')) },
      { label: t('md.toolTableShort'), title: t('md.toolTable'), run: () => apply(insertBlock(text, selection(), tableSkeleton(3, 3, lang))) },
      { label: t('md.toolFormulaShort'), title: t('md.toolFormulaInline'), run: () => apply(wrapSelection(text, selection(), '$')) },
      { label: 'Σ', title: t('md.toolFormulaBlock'), run: () => apply(insertBlock(text, selection(), formulaSkeleton(true))) },
      { label: '—', title: t('md.toolDivider'), run: () => apply(insertBlock(text, selection(), '---')) },
    ],
    [apply, selection, text, t, lang],
  )

  return createPortal(
    <div className="md-editor" role="dialog" aria-modal="true" aria-label={t('md.dialogAria')}>
      {docxHelpOpen && <DocxHelp onClose={() => setDocxHelpOpen(false)} />}
      <div className="md-editor__window" ref={windowRef}>
        <div className="md-editor__head">
          <div className="md-editor__titles">
            <strong>{t('md.title')}</strong>
            {title && <span className="muted">{title}</span>}
          </div>
          <div className="md-editor__modes" role="group" aria-label={t('md.modesAria')}>
            {([
              ['split', t('md.modeSplit')],
              ['edit', t('md.modeEdit')],
              ['preview', t('md.modePreview')],
              ] as const).map(
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
          <button type="button" className="secondary md-editor__close" onClick={onClose} aria-label={t('md.closeAria')}>
            {t('md.close')}
          </button>
        </div>

        {/* Чужая правка при несохранённом черновике: ничего не затираем, но и не
            молчим. Кнопка — явное действие человека, а не автомат. */}
        {conflict && (
          <div className="md-editor__alert" role="status" aria-live="polite">
            <span className="md-editor__alert-text">
              {t('md.peerChanged')}
            </span>
            <button type="button" className="secondary" onClick={adopt}>
              {t('md.takePeer')}
            </button>
          </div>
        )}

        <div className="md-editor__toolbar" role="toolbar" aria-label={t('md.toolbarAria')} data-inserts={insertsOpen ? 'open' : 'closed'}>
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
            {t('md.inserts')} {insertsOpen ? '▴' : '▾'}
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
              aria-label={t('md.diagramAria')}
              onChange={(e) => setDiagramKind(e.target.value)}
            >
              {DIAGRAM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {diagramLabel(kind, lang)}
                  </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              title={t('md.diagramTitle')}
              onClick={() => apply(insertBlock(text, selection(), diagramSkeleton(diagramKind, lang)))}
            >
              {t('md.diagram')}
            </button>
          </div>
        </div>

        {/* Разметка DOCX (0.92.0, docs/docx-template.md §3). Отдельная панель, а не кнопки в
            строке: это не Markdown, а служебные пометки для выгрузки, и рядом с «жирный/цитата»
            они выглядели бы частью обычной разметки. Понимает их только скачивание .docx —
            в показе маркеры невидимы, потому что их вырезает maskDocxMarkers. */}
        <div className="md-editor__docx" data-docx-markup={docxOpen ? 'open' : 'closed'}>
          <button
            type="button"
            className="secondary md-editor__docx-toggle"
            aria-expanded={docxOpen}
            aria-controls="md-editor-docx"
            onClick={() => setDocxOpen((open) => !open)}
          >
            {t('md.docxMarkup')} {docxOpen ? '▴' : '▾'}
          </button>
          <div className="md-editor__docx-body" id="md-editor-docx">
            <button
              type="button"
              className="secondary"
              title={t('md.pagebreakTitle')}
              onClick={() => insertDocxMarker(MARKER_TEMPLATES[0].marker)}
            >
              {t('md.pagebreak')}
            </button>
            <button
              type="button"
              className="secondary"
              title={t('md.tocTitle')}
              onClick={() => insertDocxMarker(MARKER_TEMPLATES[1].marker)}
            >
              {t('md.toc')}
            </button>
            {styleNames.length > 0 ? (
              <>
                <span className="md-editor__toolbar-sep" aria-hidden />
                <select
                  className="md-editor__docx-style"
                  aria-label={t('md.styleAria')}
                  value={currentStyle}
                  onChange={(e) => setDocxStyle(e.target.value)}
                >
                  {styleNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary"
                  title={t('md.styleBelowTitle')}
                  disabled={currentStyle === ''}
                  onClick={() => insertDocxMarker(styleMarker(currentStyle))}
                >
                  {t('md.styleBelow')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  title={t('md.beginBlockTitle')}
                  disabled={currentStyle === ''}
                  onClick={() => insertDocxMarker(beginMarker(currentStyle))}
                >
                  {t('md.beginBlock')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  title={t('md.endBlockTitle')}
                  onClick={() => insertDocxMarker(MARKER_TEMPLATES[2].marker)}
                >
                  {t('md.endBlock')}
                </button>
              </>
            ) : (
              <span className="muted md-editor__docx-hint">
                {t('md.stylesEmpty')}
              </span>
            )}
            <span className="muted md-editor__docx-hint">{t('md.markersHint')}</span>
            {/* Справка (0.94.0): из редактора её раньше не было видно вовсе, и вопрос «как
                работает разметка DOCX» оставался без ответа прямо в том месте, где её ставят. */}
            <button
              type="button"
              className="secondary"
              title={t('md.helpTitle')}
              onClick={() => setDocxHelpOpen(true)}
              data-docx-help-open
            >
              {t('md.help')}
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
              aria-label={t('md.textAria')}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('md.placeholder')}
            />
            <div className="md-editor__hint">
              <span className="md-editor__hint-syntax">
                {t('md.markupHint')} <code>**bold**</code> <code>*italic*</code> <code># heading</code>{' '}
                <code>- list</code> <code>| table |</code> <code>$formula$</code>{' '}
                <code>```mermaid</code>
                  {t('md.diagramChip')}
              </span>
              <span className="muted md-editor__hint-count">{text.length} {pluralWord(lang, 'md.unit.char', text.length)}</span>
            </div>
          </div>
          <div className="md-editor__pane md-editor__pane--preview">
            <div className="md-editor__preview">
              {text.trim() === ''
                ? <p className="muted">{t('md.previewEmpty')}</p>
                : <MarkdownBlock source={text} assetUrls={assetUrls} />}
            </div>
          </div>
        </div>

        <div className="md-editor__foot">
          <span className="muted">
            {dirty ? t('md.dirty') : t('md.saved')}
            <span className="md-editor__foot-keys">{t('md.keysHint')}</span>
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="secondary" onClick={onClose}>
              {t('md.cancel')}
              </button>
            <button type="button" onClick={save} disabled={!dirty}>
              {t('md.save')}
              </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
