import { useEffect, useState } from 'react'
import type { Asset } from '../../api/assets'
import type { YMap } from '../../collab/yprovider'
import { applyLocalEdit, ensureText, setText, textString, type TextField } from '../../collab/text'
import { ImageViewer } from '../ImageViewer'
import { MarkdownBlock } from '../MarkdownBlock'
import { MarkdownEditor } from '../MarkdownEditor'
import { looksLikeMarkdown } from '../../lib/markdown'
import { BackgroundPicker, type BackgroundValue } from './BackgroundPicker'

interface Props {
  ymap: YMap
  assets: Asset[]
  images: Asset[]
  /** id ассета → blob-URL (ассеты требуют авторизации, прямые ссылки дают 401). */
  assetUrls: Record<string, string>
  onUpload: (file: File) => void
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
  ymap, assets, images, assetUrls, onUpload, onAttach, onDetach, onBackgroundChange, background, onChange, onTyping,
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
          value={body}
          onFocus={bodyField.onFocus}
          onBlur={bodyField.onBlur}
          onChange={(e) => {
            bodyField.onChange(e.currentTarget)
            onChange?.()
            onTyping?.()
          }}
          rows={7}
          placeholder={'Описание события. Разметка: **жирный**, - список, | таблица |, $формула$'}
        />
        <div className="ed-md__actions">
          <button type="button" className="secondary" onClick={() => setMdOpen(true)}>
            Открыть редактор Markdown
          </button>
          {looksLikeMarkdown(body) && (
            <span className="muted">разметка распознана — предпросмотр под полем</span>
          )}
        </div>
        {looksLikeMarkdown(body) && <MarkdownBlock source={body} className="ed-md__preview" />}
      </div>

      {mdOpen && (
        <MarkdownEditor
          value={body}
          title={title}
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
              accept="image/*,.pdf,.svg"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onUpload(file)
              }}
            />
            + загрузить файл
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
