import { useEffect, useState } from 'react'
import { tStatic, useT, type Key } from '../../i18n'
import type { Asset, AssetUsage } from '../../api/assets'
import { formatBytes } from '../../lib/format'
import { attachmentLabel, type TransferFrame } from '../../lib/assetTransfer'

/**
 * Файлы проекта: вес, занятое место, перенос между кадрами и удаление.
 *
 * Зачем отдельный список. До квоты файлы проекта жили только «внутри кадров»:
 * чтобы освободить место, надо было открепить картинку от каждого кадра и всё
 * равно негде было её удалить. Здесь видно всё, что проект хранит, сколько это
 * занимает из предела и что можно убрать.
 *
 * Здесь же — перенос вложения из кадра в кадр (глава ↔ под-событие). Почему не
 * перетаскиванием файла на строку дерева: список файлов и дерево лежат в разных
 * колонках, а на телефоне перетаскивание между ними почти невозможно. Выбор кадра
 * списком работает везде одинаково и заодно показывает, ГДЕ файл лежит сейчас —
 * без этого «перенести» непонятно: тот же файл может быть прикреплён к нескольким
 * кадрам (дедупликация по содержимому).
 *
 * Файл, прикреплённый к кадрам, удалить нельзя — кнопка выключена и объясняет
 * почему. Так порядок «открепить → удалить» виден до нажатия, а не после отказа
 * сервера.
 */
export interface ProjectFilesProps {
  assets: Asset[]
  usage: AssetUsage | null
  /** Идентификаторы файлов, прикреплённых хотя бы к одному кадру. */
  attached: Set<string>
  /** Кадры проекта: для выбора «куда перенести» и подписи «где файл сейчас». */
  frames: TransferFrame[]
  /** Файл, который удаляется прямо сейчас: кнопки на нём блокируются. */
  busyId?: string | null
  /** Сообщение под списком: отказ сервера, итог загрузки или переноса. */
  note?: string | null
  onDelete: (asset: Asset) => void
  /** Загрузить файлы в проект, ни к чему не прикрепляя. */
  onUploadFiles: (files: File[]) => void
  /** Перенести файл из кадра в кадр (`fromId: null` — «прикрепить»). */
  onMove: (assetId: string, fromId: string | null, toId: string) => void
}

/** Доля занятого места: по ней видно, близко ли предел. */
export function usageShare(usage: AssetUsage | null): number {
  if (!usage || usage.limit <= 0) return 0
  return Math.min(1, usage.used / usage.limit)
}

/** Строка про место: «4.2 МБ из 10 МБ», либо просто вес без предела. */
export function usageLabel(usage: AssetUsage | null, assets: Asset[]): string {
  if (!usage) {
    const total = assets.reduce((sum, asset) => sum + asset.size, 0)
    return formatBytes(total)
  }
  // `usageLabel` — модульная функция (её зовут и тесты): берём текущий язык через tStatic.
  if (usage.limit <= 0) return tStatic('pf.noLimit', { used: usage.used_text })
  return tStatic('pf.of', { used: usage.used_text, limit: usage.limit_text })
}

/** Куда файл можно перенести: кадры, у которых его ещё нет. */
export function moveTargets(frames: TransferFrame[], assetId: string): TransferFrame[] {
  return frames.filter((f) => !f.assetIds.includes(assetId))
}

export function ProjectFiles({
  assets,
  usage,
  attached,
  frames,
  busyId,
  note,
  onDelete,
  onUploadFiles,
  onMove,
}: ProjectFilesProps) {
  const t = useT()
  // Больше 80% — говорим прямо: иначе отказ при следующей загрузке выглядит
  // необъяснимым («вроде бы ничего не менял»).
  const tight = usageShare(usage) >= 0.8
  /** Открыт ли выбор кадра у файла: `null` — ни у какого. */
  const [moving, setMoving] = useState<string | null>(null)
  const [choosen, setChoosen] = useState<string>('')

  // Список файлов меняется (загрузка, удаление) — закрываем выбор, если файла больше нет.
  useEffect(() => {
    if (moving !== null && !assets.some((a) => a.id === moving)) setMoving(null)
  }, [assets, moving])

  return (
<section className="ed-files" aria-label={t('pf.sectionAria')}>
      <div className="ed-files__head">
<span className="ed-field__label">{t('pf.title', { count: assets.length })}</span>
        <span className={tight ? 'ed-files__usage ed-files__usage--tight' : 'ed-files__usage'}>
          {usageLabel(usage, assets)}
{tight && t('pf.nearlyFull')}
        </span>
        <label className="ed-upload ed-files__upload">
          <input
            type="file"
            multiple
            accept="image/*,.pdf,.svg"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) onUploadFiles(files)
              e.target.value = ''
            }}
          />
          {t('pf.upload')}
        </label>
      </div>

      <div className="ed-assets">
        {assets.map((asset) => {
          const inUse = attached.has(asset.id)
          const busy = busyId === asset.id
          const where = frames.filter((f) => f.assetIds.includes(asset.id))
          const open = moving === asset.id
          const targets = moveTargets(frames, asset.id)
          return (
            <div key={asset.id} className="ed-assets__item">
              <span className="ed-assets__name" title={asset.filename}>
                {asset.filename}
              </span>
              <span className="muted ed-files__size">{formatBytes(asset.size)}</span>
              <span className="muted ed-files__where" title={attachmentLabel(where)}>
                {attachmentLabel(where)}
              </span>
              <button
                type="button"
                className="ed-assets__move"
                disabled={busy || targets.length === 0}
                title={
                  targets.length === 0
? t('pf.noTargets')
                    : inUse
? t('pf.moveTitle')
: t('pf.attachTitle')
                }
                aria-expanded={open}
                onClick={() => {
                  setChoosen(targets[0]?.id ?? '')
                  setMoving(open ? null : asset.id)
                }}
              >
{inUse ? t('pf.move') : t('pf.attach')}
              </button>
              <button
                type="button"
                className="ed-assets__detach"
                disabled={inUse || busy}
                title={
                  inUse
? t('pf.detachFirst')
: t('pf.deleteTitle')
                }
                aria-label={t('pf.deleteAria', { name: asset.filename })}
                onClick={() => onDelete(asset)}
              >
                {busy ? '…' : '×'}
              </button>

              {open && (
                <div className="ed-files__move">
                  <label className="ed-field">
                    <span className="ed-field__label">
{inUse ? t('pf.moveToFrame') : t('pf.attachToFrame')}
                    </span>
                    <select
                      value={choosen}
                      aria-label={t('pf.frameFor', { name: asset.filename })}
                      onChange={(e) => setChoosen(e.target.value)}
                    >
<option value="">{t('pf.chooseFrame')}</option>
                      {targets.map((frame) => (
                        <option key={frame.id} value={frame.id}>
                          {frame.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={choosen === ''}
                    onClick={() => {
                      // «Откуда» — кадр, который человек выбрал в дереве (первый из
                      // тех, где файл лежит): файл может быть в нескольких, и перенос
                      // убирает его только из одного — об этом сказано в подписи выше.
                      onMove(asset.id, where[0]?.id ?? null, choosen)
                      setMoving(null)
                    }}
                  >
{inUse ? t('pf.moveButton') : t('pf.attachButton')}
                  </button>
                  <button type="button" className="secondary" onClick={() => setMoving(null)}>
                  {t('pf.cancel')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
{assets.length === 0 && <p className="muted">{t('pf.empty')}</p>}
      </div>
      {note && (
        <p className="ed-panel__note ed-panel__note--upload" role="status">
          {note}
        </p>
      )}
    </section>
  )
}
