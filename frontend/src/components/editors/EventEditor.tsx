import { useState } from 'react'
import type { Asset } from '../../api/assets'
import type { YMap } from '../../collab/yprovider'
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
}

const eventDateText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 10) return ''
  return value.slice(0, 10)
}

/**
 * Редактор одного события: заголовок, текст, дата, вложения и фон кадра.
 * Всё редактирование проекта живёт здесь — стадия ничего не меняет.
 *
 * Миниатюры вложений открывают тот же полноэкранный просмотрщик, что и в кадре
 * стадии: смотреть картинку удобно и во время правки, не выходя из проекта.
 */
export function EventEditor({
  ymap, assets, images, assetUrls, onUpload, onAttach, onDetach, onBackgroundChange, background, onChange,
}: Props) {
  const title = (ymap.get('title') as string | undefined) ?? ''
  const body = (ymap.get('body') as string | undefined) ?? ''
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
          onChange={(e) => {
            ymap.set('title', e.target.value)
            onChange?.()
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
          onChange={(e) => {
            ymap.set('body', e.target.value)
            onChange?.()
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
            ymap.set('body', next)
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
            if (value) ymap.set('event_date', value)
            else ymap.delete('event_date')
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
