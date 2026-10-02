import { useEffect, useState } from 'react'
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
  if (usage.limit <= 0) return `${usage.used_text} — без предела`
  return `${usage.used_text} из ${usage.limit_text}`
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
    <section className="ed-files" aria-label="Файлы проекта">
      <div className="ed-files__head">
        <span className="ed-field__label">Файлы проекта ({assets.length})</span>
        <span className={tight ? 'ed-files__usage ed-files__usage--tight' : 'ed-files__usage'}>
          {usageLabel(usage, assets)}
          {tight && ' — место заканчивается'}
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
            + файлы
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
                    ? 'В проекте некуда переносить: кадров, где этого файла ещё нет, нет'
                    : inUse
                      ? 'Перенести файл в другой кадр'
                      : 'Прикрепить файл к кадру'
                }
                aria-expanded={open}
                onClick={() => {
                  setChoosen(targets[0]?.id ?? '')
                  setMoving(open ? null : asset.id)
                }}
              >
                {inUse ? 'перенести' : 'прикрепить'}
              </button>
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

              {open && (
                <div className="ed-files__move">
                  <label className="ed-field">
                    <span className="ed-field__label">
                      {inUse ? 'Перенести в кадр' : 'Прикрепить к кадру'}
                    </span>
                    <select
                      value={choosen}
                      aria-label={`Кадр для ${asset.filename}`}
                      onChange={(e) => setChoosen(e.target.value)}
                    >
                      <option value="">выберите кадр…</option>
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
                    {inUse ? 'Перенести' : 'Прикрепить'}
                  </button>
                  <button type="button" className="secondary" onClick={() => setMoving(null)}>
                    Отмена
                  </button>
                </div>
              )}
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
