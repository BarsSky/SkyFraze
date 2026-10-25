import { formatDaysLeft } from '../../lib/format'
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
 */
export function TrashPanel({
  items,
  retentionDays,
  busyId,
  onRestore,
  onPurge,
}: {
  items: TrashedProject[]
  retentionDays: number
  busyId: string | null
  onRestore: (p: TrashedProject) => void
  onPurge: (p: TrashedProject) => void
}) {
  return (
    <div className="card trash-panel" data-project-trash>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Корзина</h3>
        <span className="muted" data-trash-retention>
          Удалённое хранится {formatDaysLeft(retentionDays)} и не видно другим
        </span>
      </div>
      {items.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }} data-trash-empty>
          Пусто. Удалённые проекты появятся здесь и будут доступны для возврата.
        </p>
      ) : (
        <div className="trash-panel__list">
          {items.map((p) => (
            <div key={p.id} className="trash-panel__item" data-trash-item={p.id}>
              <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                <b className="trash-panel__title">{p.title}</b>
                <p className="muted" style={{ margin: 0 }} data-trash-days-left={p.days_left}>
                  {p.days_left > 0
                    ? `вернуть можно ещё ${formatDaysLeft(p.days_left)}`
                    : 'срок восстановления истёк — проект удалится при следующей уборке'}
                </p>
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button
                  type="button"
                  disabled={busyId === p.id}
                  title="Вернуть проект со всем текстом, файлами и историей"
                  onClick={() => onRestore(p)}
                >
                  Вернуть
                </button>
                <button
                  type="button"
                  className="secondary danger-text"
                  disabled={busyId === p.id}
                  title="Удалить проект окончательно: файлы и история исчезнут"
                  onClick={() => onPurge(p)}
                >
                  Удалить навсегда
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
