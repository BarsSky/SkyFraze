import { formatBytes, formatDaysLeft } from '../../lib/format'
import { useT } from '../../i18n'
import { useLang } from '../../store/lang'
import type { TrashedProject } from '../../api/projects'

/**
 * Корзина проектов: что удалено и сколько ещё можно вернуть.
 *
 * Отдельный блок, а не строка в общем списке. Список отвечает на вопрос «над чем я работаю»,
 * а корзина — «что я потерял и можно ли это вернуть»; смешать их значило бы держать удалённое
 * на виду постоянно. Показывается по кнопке и говорит срок прямым текстом: «вернуть можно
 * ещё 30 дней» — это и есть смысл корзины, и человек должен его видеть, а не догадываться.
 *
 * Кнопка «Удалить навсегда» намеренно отдельная и спрашивает подтверждение: ошибка здесь
 * необратима, а «удалил дважды» — не то действие, которое стоит поощрять одной кнопкой.
 *
 * «Скачать архив» здесь потому, что «удалить можно, а посмотреть — нельзя» звучит как шутка:
 * архив проекта (текст, вложения, история) собирается и для проекта в корзине, поэтому перед
 * необратимым удалением человек может забрать своё, не возвращая проект в список.
 */
export function TrashPanel({
  items,
  retentionDays,
  busyId,
  onRestore,
  onPurge,
  onExport,
}: {
  items: TrashedProject[]
  retentionDays: number
  busyId: string | null
  onRestore: (p: TrashedProject) => void
  onPurge: (p: TrashedProject) => void
  onExport: (p: TrashedProject) => void
}) {
  const t = useT()
  const [lang] = useLang()
  return (
    <div className="card trash-panel" data-project-trash>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{t('trash.title')}</h3>
        <span className="muted" data-trash-retention>
           {t('trash.retention', { days: formatDaysLeft(retentionDays, lang) })}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }} data-trash-empty>
          {t('trash.empty')}
        </p>
      ) : (
        <div className="trash-panel__list">
          {items.map((p) => (
            <div key={p.id} className="trash-panel__item" data-trash-item={p.id}>
              <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                <b className="trash-panel__title">{p.title}</b>
                <p className="muted" style={{ margin: 0 }} data-trash-days-left={p.days_left}>
                  {p.days_left > 0
                    ? t('trash.restoreLeft', { days: formatDaysLeft(p.days_left, lang) })
                    : t('trash.expired')}
                  {typeof p.asset_bytes === 'number' && p.asset_bytes > 0 && (
                    <>{t('trash.files', { size: formatBytes(p.asset_bytes, lang) })}</>
                  )}
                </p>
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button
                  type="button"
                  disabled={busyId === p.id}
                  title={t('trash.restoreTitle')}
                  onClick={() => onRestore(p)}
                >
                  {t('trash.restore')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busyId === p.id}
                  title={t('trash.exportTitle')}
                  onClick={() => onExport(p)}
                >
                  {t('trash.export')}
                </button>
                <button
                  type="button"
                  className="secondary danger-text"
                  disabled={busyId === p.id}
                  title={t('trash.purgeTitle')}
                  onClick={() => onPurge(p)}
                >
                  {t('trash.purge')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
