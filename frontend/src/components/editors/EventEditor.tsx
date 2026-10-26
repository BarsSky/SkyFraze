import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../../api/assets'
import type { YMap } from '../../collab/yprovider'
import { applyLocalEdit, ensureText, setText, textString, type TextField } from '../../collab/text'
import { encodeAnchor } from '../../collab/anchors'
import { ImageViewer } from '../ImageViewer'
import { MarkdownBlock } from '../MarkdownBlock'
import { MarkdownEditor } from '../MarkdownEditor'
import { looksLikeMarkdown } from '../../lib/markdown'
import { BackgroundPicker, type BackgroundValue } from './BackgroundPicker'

/** Выделенный фрагмент текста, к которому можно поставить замечание. */
export interface FrameFragment {
  start: string
  end: string
  quote: string
}

interface Props {
  ymap: YMap
  assets: Asset[]
  images: Asset[]
  /** id ассета → blob-URL (ассеты требуют авторизации, прямые ссылки дают 401). */
  assetUrls: Record<string, string>
  onUpload: (file: File) => void
  /** Несколько файлов сразу: очередь загрузки и сводка — в панели редакторов. */
  onUploadMany: (files: File[]) => void
  onAttach: (assetId: string) => void
  onDetach: (assetId: string) => void
  onBackgroundChange: (value: BackgroundValue) => void
  background: BackgroundValue
  /** Уведомление об изменении текста — страница отложенно синхронизирует дерево. */
  onChange?: () => void
  /**
   * Ввод в заголовок или текст. Отдельно от `onChange`: там отложенная проекция
   * дерева, здесь — «я печатаю» для соседей (панель гасит его по тишине).
   */
  onTyping?: () => void
  /**
   * Замечание к фрагменту: человек выделил текст и нажал «Замечание к фрагменту».
   * Якорь уже закодирован (позиции — `Y.RelativePosition`), панели остаётся отправить его
   * вместе с комментарием.
   */
  onFragmentSelected?: (fragment: FrameFragment) => void
  /**
   * Диапазон, который надо показать в тексте (клик по замечанию к фрагменту). 
once
   * меняется при каждом нажатии: без него повторный клик по тому же замечанию не сдвинул бы
   * выделение, если оно уже стоит там.
   */
  focusRange?: { from: number; to: number; nonce: number } | null
}

const eventDateText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 10) return ''
  return value.slice(0, 10)
}

/**
 * Текст поля, пока в нём стоит человек.
 *
 * Почему так, а не «обновлять поле из CRDT и восстанавливать каретку». Пока идёт
 * набор, чужие правки приезжают постоянно, и каждое обновление `value` из React
 * переписывает DOM — а вместе с ним уезжает каретка. Восстанавливать её при
 * каждом апдейте можно только приблизительно, и ошибка в один символ сдвигает
 * следующую букву (это воспроизводилось живым набором двух авторов и выглядело
 * как перемешанный текст). Поэтому пока поле в фокусе, его содержимым владеет
 * человек: правки уходят в `Y.Text` дифом, чужие в поле не подставляются, а после
 * потери фокуса поле показывает уже слитый текст. Состояние соавторов при этом
 * видно — в баре присутствия и «печатает…».
 */
function useFieldDraft(field: TextField, ymap: YMap, write: (field: TextField, mine: string, next: string) => void) {
  const [draft, setDraft] = useState<string | null>(null)
  const remote = textString(ymap, field)
  const value = draft ?? remote

  // Смена события (или проекта) черновик сбрасывает: он относится к прошлому полю.
  useEffect(() => {
    setDraft(null)
  }, [ymap])

  return {
    value,
    focused: draft !== null,
    onFocus: () => setDraft(textString(ymap, field)),
    onBlur: () => setDraft(null),
    onChange: (el: HTMLInputElement | HTMLTextAreaElement) => {
      const mine = draft ?? textString(ymap, field)
      const next = el.value
      setDraft(next)
      write(field, mine, next)
    },
  }
}

/**
 * Редактор одного события: заголовок, текст, дата, вложения и фон кадра.
 * Всё редактирование проекта живёт здесь — стадия ничего не меняет.
 *
 * Миниатюры вложений открывают тот же полноэкранный просмотрщик, что и в кадре
 * стадии: смотреть картинку удобно и во время правки, не выходя из проекта.
 */
export function EventEditor({
  ymap, assets, images, assetUrls, onUpload, onUploadMany, onAttach, onDetach, onBackgroundChange, background, onChange, onTyping,
  onFragmentSelected,
  focusRange,
}: Props) {
  /**
   * Записать правку поля.
   *
   * Если CRDT с момента, когда человек начал править, не менялся, достаточно
   * обычного дифа. Если менялся (соавтор успел вставить своё), диф от CRDT стёр бы
   * его буквы — тогда применяется только локальная дельта (`applyLocalEdit`),
   * которая чужой текст не удаляет никогда.
   */
  const editField = (field: TextField, mine: string, next: string) => {
    const text = ensureText(ymap, field)
    const remote = text.toString()
    if (remote === mine) setText(ymap, field, next)
    else applyLocalEdit(text, mine, next, remote)
  }

  // Заголовок и текст: пока поле в фокусе, его содержимым владеет человек
  // (см. useFieldDraft), а в CRDT каждая правка уходит дифом.
  const titleField = useFieldDraft('title', ymap, editField)
  const bodyField = useFieldDraft('body', ymap, editField)
  const title = titleField.value
  const body = bodyField.value
  // Выделение в поле текста запоминаем, чтобы кнопка «Замечание к фрагменту» появлялась только
  // когда есть что выделять. Храним номера, а не текст: текст берём из Y.Text в момент нажатия.
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)

  /**
   * Показать замечание в тексте: выделяем фрагмент прямо в поле и прокручиваем к нему.
   *
   * Почему выделение, а не подсветка поверх textarea. Подсветка потребовала бы зеркального
   * слоя под полем (своя разметка, синхронизация прокрутки и шрифта) — заметная сложность ради
   * того же результата. Нативное выделение видно сразу, прокручивается само и не расходится с
   * текстом ни на символ. Минус честно назван: выделение живёт, пока в поле не щёлкнули.
   */
  useEffect(() => {
    if (!focusRange) return
    const el = bodyRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(focusRange.from, focusRange.to)
    // Прокручиваем так, чтобы фрагмент оказался в середине поля, а не у края.
    const lineHeight = 20
    const line = el.value.slice(0, focusRange.from).split('\n').length - 1
    el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 2)
  }, [focusRange])

  const updateSelection = () => {
    const el = bodyRef.current
    if (!el) return
    const from = el.selectionStart ?? 0
    const to = el.selectionEnd ?? 0
    setSelection(to > from ? { from, to } : null)
  }

  /**
   * Поставить замечание к фрагменту.
   *
   * Якорь считается по `Y.Text` (а не по строке в `textarea`) — и только после того, как
   * черновик применён: пока поле в фокусе, его содержимым владеет человек, и CRDT может
   * отставать на одну правку. Поэтому сначала снимаем фокус (это фиксирует диф), затем
   * сверяем выделенный текст с тем, что лежит в CRDT по тем же индексам, и только при
   * совпадении отдаём якорь.
   */
  const selectFragment = () => {
    if (!selection) return
    const el = bodyRef.current
    const quote = el ? el.value.slice(selection.from, selection.to) : ''
    bodyRef.current?.blur()
    const text = ensureText(ymap, 'body')
    const remote = text.toString()
    if (remote.slice(selection.from, selection.to) !== quote) {
      // Расхождение возможно, если соавтор правил этот же кусок. Честнее промолчать
      // кнопкой, чем привязать замечание к другому тексту.
      setSelection(null)
      return
    }
    const encoded = encodeAnchor(text, selection.from, selection.to)
    if (!encoded) return
    onFragmentSelected?.({ ...encoded })
    setSelection(null)
  }
  const attachedIds = ((ymap.get('assets') as string[] | undefined) ?? []).filter(Boolean)
  const eventDate = eventDateText(ymap.get('event_date'))
  const [viewer, setViewer] = useState<number | null>(null)
  const [mdOpen, setMdOpen] = useState(false)

  const unattached = assets.filter((a) => !attachedIds.includes(a.id))
  const attached = assets.filter((a) => attachedIds.includes(a.id))
  const attachedImages = attached.filter((a) => a.mime.startsWith('image/') && assetUrls[a.id])

  return (
    <div className="ed-form" data-editor-section>
      <label className="ed-field">
        <span className="ed-field__label">Заголовок</span>
        <input
          value={title}
          onFocus={titleField.onFocus}
          onBlur={titleField.onBlur}
          onChange={(e) => {
            titleField.onChange(e.currentTarget)
            onChange?.()
            onTyping?.()
          }}
          placeholder="Заголовок события"
        />
      </label>

      {/* Поле с Markdown: div, а не label — внутри есть кнопка, и клик по ней не
          должен переводить фокус в textarea. */}
      <div className="ed-field">
        <span className="ed-field__label">
          Текст <span className="ed-field__hint">Markdown: таблицы, формулы, диаграммы</span>
        </span>
        <textarea
          ref={bodyRef}
          value={body}
          onFocus={bodyField.onFocus}
          onBlur={bodyField.onBlur}
          onSelect={updateSelection}
          onMouseUp={updateSelection}
          onKeyUp={updateSelection}
          onChange={(e) => {
            bodyField.onChange(e.currentTarget)
            updateSelection()
            onChange?.()
            onTyping?.()
          }}
          rows={7}
          placeholder={'Описание события. Разметка: **жирный**, - список, | таблица |, $формула$'}
        />
        <div className="ed-md__actions">
          {onFragmentSelected && selection && (
            <button
              type="button"
              className="secondary"
              data-select-fragment
              title="Поставить замечание к выделенному фрагменту текста"
              onClick={selectFragment}
            >
              Замечание к фрагменту
            </button>
          )}
          <button type="button" className="secondary" onClick={() => setMdOpen(true)}>
            Открыть редактор Markdown
          </button>
          {looksLikeMarkdown(body) && (
            <span className="muted">разметка распознана — предпросмотр под полем</span>
          )}
        </div>
        {looksLikeMarkdown(body) && (
          <MarkdownBlock source={body} className="ed-md__preview" assetUrls={assetUrls} />
        )}
      </div>

      {mdOpen && (
        <MarkdownEditor
          value={body}
          title={title}
          // Ссылки на вложения в тексте должны открываться и в предпросмотре.
          assetUrls={assetUrls}
          onSave={(next) => {
            setText(ymap, 'body', next)
            onChange?.()
          }}
          onAdopt={(next) => {
            // Осознанно взяли версию соавтора: это такая же запись в CRDT, как
            // сохранение, поэтому дерево синхронизируем тем же путём.
            setText(ymap, 'body', next)
            onChange?.()
          }}
          onClose={() => setMdOpen(false)}
        />
      )}

      <label className="ed-field ed-field--short">
        <span className="ed-field__label">Дата (для мета-чипа в кадре)</span>
        <input
          type="date"
          value={eventDate}
          onChange={(e) => {
            const value = e.target.value
            // Пустая строка, а не delete: для проекции дерева «поля нет» значит
            // «дату не трогать» (клиент мог её не видеть), а пустое значение —
            // осознанную очистку даты в базе.
            ymap.set('event_date', value)
            onChange?.()
          }}
        />
      </label>

      <div className="ed-field">
        <span className="ed-field__label">Фон кадра</span>
        <BackgroundPicker
          value={background}
          images={images}
          assetUrls={assetUrls}
          onUpload={onUpload}
          onChange={onBackgroundChange}
        />
      </div>

      <div className="ed-field">
        <span className="ed-field__label">Вложения ({attached.length})</span>
        <div className="ed-assets">
          {attached.map((asset) => (
            <div key={asset.id} className="ed-assets__item">
              {asset.mime.startsWith('image/') && assetUrls[asset.id] ? (
                <button
                  type="button"
                  className="ed-assets__preview"
                  title="Открыть в полный размер"
                  onClick={() => setViewer(attachedImages.findIndex((a) => a.id === asset.id))}
                >
                  <img src={assetUrls[asset.id]} alt={asset.filename} loading="lazy" />
                </button>
              ) : (
                <span className="ed-assets__file">файл</span>
              )}
              <span className="ed-assets__name" title={asset.filename}>{asset.filename}</span>
              <button
                type="button"
                className="ed-assets__detach"
                title="Открепить от события"
                onClick={() => onDetach(asset.id)}
              >
                ×
              </button>
            </div>
          ))}
          {attached.length === 0 && <p className="muted">Пока ничего не прикреплено.</p>}
        </div>

        <div className="ed-assets__actions">
          <label className="ed-upload">
            <input
              type="file"
              multiple
              accept="image/*,.pdf,.svg"
              onChange={(e) => {
                // Несколько файлов сразу: очередь разберётся с ними по одному и
                // расскажет, что вышло по каждому (см. lib/uploadQueue.ts).
                const files = Array.from(e.target.files ?? [])
                if (files.length > 0) onUploadMany(files)
                e.target.value = ''
              }}
            />
            + загрузить файлы
          </label>
          {unattached.length > 0 && (
            <select
              className="ed-attach"
              value=""
              onChange={(e) => {
                if (e.target.value) onAttach(e.target.value)
              }}
            >
              <option value="">прикрепить из загруженных…</option>
              {unattached.map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.filename}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {viewer !== null && viewer >= 0 && (
        <ImageViewer
          images={attachedImages.map((a) => ({ id: a.id, url: assetUrls[a.id], caption: a.filename }))}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          title={title}
        />
      )}
    </div>
  )
}
