import { useCallback, useEffect, useState } from 'react'
import { listAssets, type Asset } from '../../api/assets'
import { useAssetObjectUrl } from '../../api/assetObject'
import { useT } from '../../i18n'

/**
 * Картинка у упоминания карточки в кадре (0.93.0, docs/entity-links.md §3.4.1).
 *
 * Зачем именно здесь: карточка упоминания уже знает «карточка + кадр + глава», и в ней не хватало
 * одного — как это выглядит. Портрет персонажа, вид места, обложка темы берутся из ВЛОЖЕНИЙ
 * проекта: они уже проходят квоту, пережатие и дедупликацию и входят в архив переноса, поэтому
 * отдельной загрузки и отдельного хранилища не нужно.
 *
 * Одна картинка на пару «карточка × кадр»: список картинок превратил бы карточку в галерею и
 * распух бы, а «сколько их» никто не просил. Кадр переключается кнопками списка выше — значит
 * и картинка меняется вместе с ним.
 *
 * Читателю картинка видна: это часть карточки мира, а не настройка. Менять — только редактор и
 * выше (кнопки просто не показываются, как и у остальных действий карточки).
 */
interface Props {
  projectId: string
  /** Карточка и кадр: по этой паре и хранится картинка. */
  entityId: string
  entityName: string
  eventId: string
  eventTitle: string
  /** Привязанная картинка (id вложения проекта), если есть. */
  assetId?: string
  canEdit: boolean
  onSet: (assetId: string) => void
  onClear: () => void
}

export function MentionImage({
  projectId,
  entityId,
  entityName,
  eventId,
  eventTitle,
  assetId,
  canEdit,
  onSet,
  onClear,
}: Props) {
  const t = useT()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [images, setImages] = useState<Asset[] | null>(null)
  const [choice, setChoice] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const preview = useAssetObjectUrl(assetId)

  // Смена кадра в карточке — это другая картинка: незакрытый выбор от прошлого кадра врал бы.
  useEffect(() => {
    setPickerOpen(false)
    setChoice('')
    setNote(null)
  }, [entityId, eventId])

  const openPicker = useCallback(async () => {
    setPickerOpen(true)
    if (images !== null) return
    try {
      const list = await listAssets(projectId)
      // Только картинки: сервер тоже отклонит не-картинку, но человеку не нужно видеть pdf в
      // списке «как это выглядит».
      setImages(list.filter((asset) => asset.mime.startsWith('image/')))
    } catch {
      setImages([])
      setNote(t('mi.errRead'))
    }
  }, [images, projectId, t])

  const attach = useCallback(() => {
    if (!choice) return
    onSet(choice)
    setPickerOpen(false)
    setChoice('')
    setNote(null)
  }, [choice, onSet])

  const detach = useCallback(() => {
    onClear()
    setPickerOpen(false)
    setNote(null)
  }, [onClear])

  return (
    <div className="ent__mention-image" data-mention-image={assetId ? assetId : 'none'}>
      {assetId ? (
        <figure className="ent__mention-image-figure">
          {preview ? (
            <img
              className="ent__mention-image-img"
              src={preview}
              alt={t('mi.alt', {
                name: entityName,
                frame: eventTitle !== '' ? eventTitle : t('mi.frameUntitled'),
              })}
              data-mention-image-preview
            />
          ) : (
            <span className="muted ent__mention-image-loading">{t('mi.loading')}</span>
          )}
        </figure>
      ) : (
        <p className="muted ent__mention-image-empty">
          {canEdit ? t('mi.emptyEditable') : t('mi.empty')}
        </p>
      )}

      {canEdit && !pickerOpen && (
        <div className="ent__mention-image-actions">
          <button type="button" className="secondary" onClick={() => void openPicker()} data-mention-image-pick>
            {assetId ? t('mi.replace') : t('mi.attachImage')}
          </button>
          {assetId && (
            <button type="button" className="secondary" onClick={detach} data-mention-image-clear>
              {t('mi.detach')}
            </button>
          )}
        </div>
      )}

      {canEdit && pickerOpen && (
        <div className="ent__mention-image-picker" data-mention-image-picker>
          {images === null ? (
            <span className="muted">{t('mi.readingFiles')}</span>
          ) : images.length === 0 ? (
            <span className="muted">{t('mi.noImages')}</span>
          ) : (
            <>
              <select
                aria-label={t('mi.title')}
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
              >
                <option value="">{t('mi.choose')}</option>
                {images.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.filename}</option>
                ))}
              </select>
              <button type="button" onClick={attach} disabled={!choice} data-mention-image-attach>
                {t('mi.attach')}
              </button>
            </>
          )}
          <button type="button" className="secondary" onClick={() => setPickerOpen(false)}>
            {t('mi.cancel')}
          </button>
        </div>
      )}

      {note !== null && <p className="ed-danger">{note}</p>}
    </div>
  )
}
