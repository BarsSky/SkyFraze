import { useMemo, useState } from 'react'
import { groupMentions, type Mention } from '../../collab/mentions'

/**
 * «Упоминания в кадре» — кто из карточек мира назван в этом кадре (фаза 2).
 *
 * Почему отдельным блоком под редактором, а не подсветкой внутри поля: поле кадра — обычный
 * `textarea`, и подсветка потребовала бы зеркального слоя под ним (своя разметка, синхронизация
 * прокрутки и шрифта). Список с цитатами даёт то же знание — кто здесь есть — а клик ведёт к
 * самому месту через нативное выделение, которое уже умеет «показать в тексте» (0.63.0).
 *
 * Ложные срабатывания видны прямо здесь: человек видит цитату и понимает, то ли это слово.
 * Поэтому список, а не молчаливая подсветка.
 *
 * 0.92.1 — один чип на КАРТОЧКУ, а не на каждое вхождение. Отчёт: «упоминания дублируются
 * слишком много раз… при большем количестве будет расти список и вылезать». В кадре, где карточка
 * названа шесть раз, было шесть одинаковых чипов: список переставал быть списком персонажей и
 * становился списком мест в тексте. Теперь у чипа счётчик вхождений, а клик ПЕРЕБИРАЕТ вхождения
 * («1 из 3» → «2 из 3»), поэтому ни одно место не потерялось.
 */

interface Props {
  mentions: Mention[]
  /** Показать упоминание в тексте: панель выставит выделение и прокрутит к нему. */
  onShow: (mention: Mention) => void
  /**
   * Есть ли у проекта карточки (0.72.1). Нужно для подсказки в кадре без упоминаний: молчание
   * здесь читается как «фича не работает», хотя на самом деле в тексте просто нет имён из
   * карточек — и лечится это алиасом.
   */
  hasEntities?: boolean
}

/**
 * Сколько чипов видно до «ещё N».
 *
 * Шесть — это две строки на телефоне: список карточек в кадре остаётся обозримым, а редкие
 * кадры с десятком персонажей не растягивают панель на пол-экрана. Остальные не теряются —
 * они за кнопкой.
 */
export const MENTIONS_VISIBLE = 6

/**
 * Отличается ли цитата от имени по буквам.
 *
 * Регистр не считается отличием: «анна» в середине фразы — то же имя, и подпись «Анна анна»
 * только шумит. А вот «Анны» или «Аню» — уже полезная подсказка, по какой форме нашлось.
 */
export function differs(quote: string, name: string): boolean {
  return quote.toLowerCase() !== name.toLowerCase()
}

export function FrameMentions({ mentions, onShow, hasEntities }: Props) {
  /** Сколько раз нажали на карточку — по этому числу выбирается вхождение. */
  const [cursor, setCursor] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState(false)

  const groups = useMemo(() => groupMentions(mentions), [mentions])

  if (groups.length === 0) {
    // Подсказка вместо молчания: карточки есть, а в кадре ни одного имени из них. Человек
    // должен узнать, что делать (добавить падеж в алиасы), а не решить, что связи сломаны.
    if (!hasEntities) return null
    return (
      <p className="muted frame-mentions__empty" data-frame-mentions-empty>
        В этом кадре не названо ни одной карточки. Если герой здесь под другим именем — добавьте
        его в алиасы карточки, и связь появится.
      </p>
    )
  }

  const visible = expanded ? groups : groups.slice(0, MENTIONS_VISIBLE)
  const hidden = groups.length - visible.length

  /** Показать следующее вхождение карточки: каждое нажатие ведёт к следующему месту в тексте. */
  const show = (entityId: string, found: Mention[]) => {
    const index = (cursor[entityId] ?? 0) % found.length
    onShow(found[index])
    if (found.length > 1) {
      setCursor((current) => ({ ...current, [entityId]: (current[entityId] ?? 0) + 1 }))
    }
  }

  return (
    <div className="frame-mentions" data-frame-mentions>
      <span className="frame-mentions__label">Упоминания:</span>
      <ul className="frame-mentions__list">
        {visible.map((group) => {
          const total = group.mentions.length
          const index = (cursor[group.entityId] ?? 0) % total
          const current = group.mentions[index]
          const title = total > 1
            ? `Показать в тексте: «${current.quote}» (${index + 1} из ${total} — нажатие ведёт к следующему)`
            : `Показать в тексте: «${current.quote}»`
          return (
            <li key={group.entityId}>
              <button
                type="button"
                className="frame-mentions__chip"
                onClick={() => show(group.entityId, group.mentions)}
                title={title}
                aria-label={total > 1 ? `${group.entityName}, упоминаний: ${total}` : group.entityName}
                data-frame-mention={group.entityId}
                data-frame-mention-count={total}
                data-frame-mention-index={index}
              >
                <span className="frame-mentions__name">{group.entityName}</span>
                {/* Счётчик вместо повторов: «Ганимед ×6» занимает один чип, а не шесть. */}
                {total > 1 && <span className="frame-mentions__count">×{total}</span>}
                {/* Цитата — только когда она отличается от имени по буквам: «Анна Анна» и
                    «Письмо письмо» ничего не добавляют, а место в списке занимают. */}
                {differs(current.quote, group.entityName) && (
                  <span className="frame-mentions__quote">{current.quote}</span>
                )}
              </button>
            </li>
          )
        })}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              className="frame-mentions__more"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              ещё {hidden}
            </button>
          </li>
        )}
        {expanded && groups.length > MENTIONS_VISIBLE && (
          <li>
            <button
              type="button"
              className="frame-mentions__more"
              aria-expanded
              onClick={() => setExpanded(false)}
            >
              свернуть
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}
