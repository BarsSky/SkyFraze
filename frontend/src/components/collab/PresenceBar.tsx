import { typingLabel, type PeerState } from '../../collab/awareness'
// Стили тянет за собой сам компонент: так бар остаётся одним самодостаточным
// куском (styles/presence.css), и его подключение не требует правок в main.tsx,
// где перечислены стили остальных страниц.
import '../../styles/presence.css'

/** Событие проекта в том виде, в каком он нужен подписи «кто что правит». */
export interface PresenceEvent {
  id: string
  title: string
}

interface Props {
  /**
   * Соседи без меня — уже отсортированы провайдером (печатающие первыми).
   * Пустой список — это норма: один человек в проекте, показывать нечего.
   */
  peers: PeerState[]
  /** События проекта: по id находим название того, что правит сосед. */
  events: PresenceEvent[]
}

/** Сосед правит событие, которого нет в приехавшем списке (удалили/ещё не пришло). */
const UNKNOWN_EVENT = 'правит другое событие'

/**
 * Короткая подпись для узкого экрана. Полная формулировка («Аня и Борис
 * печатают…») живёт только в `collab/awareness.ts` — здесь лишь тот случай, когда
 * на 320px места хватает на одно слово. Оба варианта лежат в разметке рядом, а
 * какой виден, решает CSS: так текст не зависит от замера ширины в JS.
 */
const SHORT_TYPING = 'печатает…'

/**
 * Кто сейчас в проекте: инициалы на цвете человека, имя и что он правит.
 *
 * Бар ничего не решает и никуда не ведёт — это витрина эфемерного состояния
 * (`collab.presence`). Поэтому он молчит, когда соседей нет: пустая панель
 * «в проекте только вы» — шум, который занимает место над редакторами.
 *
 * Строки для «печатает…» считает `typingLabel`: подпись одна на событие, потому
 * что она перечисляет всех печатающих на нём, и повторять её у второго соседа
 * было бы дважды одним и тем же текстом.
 */
export function PresenceBar({ peers, events }: Props) {
  if (peers.length === 0) return null

  const titles = new Map(
    events.map((event) => [event.id, event.title.trim() || 'без названия']),
  )
  const typingShown = new Set<string>()

  return (
    <div className="presence" data-presence aria-label="Кто сейчас в проекте">
      <span className="presence__lead">В проекте:</span>
      <ul className="presence__list">
        {peers.map((peer) => {
          const where = peer.eventId ? titles.get(peer.eventId) : null
          // Сосед без события (ещё не открыл форму) — отдельная «группа»: у
          // typingLabel для такого нет id, и подпись остаётся короткой.
          const typingKey = peer.eventId ?? ''
          const showTyping = peer.typing && !typingShown.has(typingKey)
          if (showTyping) typingShown.add(typingKey)

          return (
            <li
              key={peer.clientId}
              className="presence__peer"
              data-presence-peer
              data-peer-name={peer.name}
            >
              <span
                className="presence__avatar"
                style={{ backgroundColor: peer.color }}
                aria-hidden="true"
              >
                {peer.initials}
              </span>
              <span className="presence__name" title={peer.name} aria-label={peer.name}>
                {peer.name}
              </span>
              {peer.eventId && (
                <span className="presence__where" title={where ?? peer.eventId}>
                  {where ? `правит «${where}»` : UNKNOWN_EVENT}
                </span>
              )}
              {showTyping && (
                <span className="presence__typing" data-presence-typing>
                  <span className="presence__typing-full">
                    {typingLabel(peers, typingKey) ?? SHORT_TYPING}
                  </span>
                  {/* Для скринридера короткий дубль не нужен: полный текст уже прочитан. */}
                  <span className="presence__typing-short" aria-hidden="true">
                    {SHORT_TYPING}
                  </span>
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
