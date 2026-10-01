import type { Asset, AssetUsage } from '../../api/assets'
import { formatBytes } from '../../lib/format'

/**
 * Файлы проекта: вес, занятое место и удаление.
 *
 * Зачем отдельный список. До квоты файлы проекта жили только «внутри кадров»:
 * чтобы освободить место, надо было открепить картинку от каждого кадра и всё
 * равно негде было её удалить. Здесь видно всё, что проект хранит, сколько это
 * занимает из предела и что можно убрать.
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
  /** Файл, который удаляется прямо сейчас: кнопки на нём блокируются. */
  busyId?: string | null
  /** Сообщение под списком: отказ сервера или подтверждение. */
  note?: string | null
  onDelete: (asset: Asset) => void
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
  if (usage.limit <= 0) return `${usage.used_text} — без предела`
  return `${usage.used_text} из ${usage.limit_text}`
}

export function ProjectFiles({ assets, usage, attached, busyId, note, onDelete }: ProjectFilesProps) {
  // Больше 80% — говорим прямо: иначе отказ при следующей загрузке выглядит
  // необъяснимым («вроде бы ничего не менял»).
  const tight = usageShare(usage) >= 0.8
  return (
    <section className="ed-files" aria-label="Файлы проекта">
      <div className="ed-files__head">
        <span className="ed-field__label">Файлы проекта ({assets.length})</span>
        <span className={tight ? 'ed-files__usage ed-files__usage--tight' : 'ed-files__usage'}>
          {usageLabel(usage, assets)}
          {tight && ' — место заканчивается'}
        </span>
      </div>
      <div className="ed-assets">
        {assets.map((asset) => {
          const inUse = attached.has(asset.id)
          const busy = busyId === asset.id
          return (
            <div key={asset.id} className="ed-assets__item">
              <span className="ed-assets__name" title={asset.filename}>
                {asset.filename}
              </span>
              <span className="muted ed-files__size">{formatBytes(asset.size)}</span>
              <button
                type="button"
                className="ed-assets__detach"
                disabled={inUse || busy}
                title={
                  inUse
                    ? 'Файл прикреплён к кадрам — сначала открепите его в кадре'
                    : 'Удалить файл из проекта'
                }
                aria-label={`Удалить ${asset.filename}`}
                onClick={() => onDelete(asset)}
              >
                {busy ? '…' : '×'}
              </button>
            </div>
          )
        })}
        {assets.length === 0 && <p className="muted">В проекте пока нет файлов.</p>}
      </div>
      {note && (
        <p className="ed-panel__note ed-panel__note--upload" role="status">
          {note}
        </p>
      )}
    </section>
  )
}
