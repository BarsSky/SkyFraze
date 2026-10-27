import type { Mention } from '../../collab/mentions'

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
 */

interface Props {
  mentions: Mention[]
  /** Показать упоминание в тексте: панель выставит выделение и прокрутит к нему. */
  onShow: (mention: Mention) => void
}

/**
 * Отличается ли цитата от имени по буквам.
 *
 * Регистр не считается отличием: «анна» в середине фразы — то же имя, и подпись «Анна анна»
 * только шумит. А вот «Анны» или «Аню» — уже полезная подсказка, по какой форме нашлось.
 */
export function differs(quote: string, name: string): boolean {
  return quote.toLowerCase() !== name.toLowerCase()
}

export function FrameMentions({ mentions, onShow }: Props) {
  if (mentions.length === 0) return null

  return (
    <div className="frame-mentions" data-frame-mentions>
      <span className="frame-mentions__label">Упоминания:</span>
      <ul className="frame-mentions__list">
        {mentions.map((mention) => (
          <li key={`${mention.entityId}-${mention.field}-${mention.from}`}>
            <button
              type="button"
              className="frame-mentions__chip"
              onClick={() => onShow(mention)}
              title={`Показать в тексте: «${mention.quote}»`}
              data-frame-mention={mention.entityId}
            >
              <span className="frame-mentions__name">{mention.entityName}</span>
              {/* Цитата — только когда она отличается от имени по буквам: «Анна Анна» и
                  «Письмо письмо» ничего не добавляют, а место в списке занимают. */}
              {differs(mention.quote, mention.entityName) && (
                <span className="frame-mentions__quote">{mention.quote}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
