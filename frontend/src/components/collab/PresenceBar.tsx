import { typingLabel, type PeerState } from '../../collab/awareness'
import { tStatic, useT } from '../../i18n'
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
const UNKNOWN_EVENT_KEY = 'presence.unknownEvent'

/**
 * Короткая подпись для узкого экрана. Полная формулировка («Аня и Борис
 * печатают…») живёт только в `collab/awareness.ts` — здесь лишь тот случай, когда
 * на 320px места хватает на одно слово. Оба варианта лежат в разметке рядом, а
 * какой виден, решает CSS: так текст не зависит от замера ширины в JS.
 */
const SHORT_TYPING_KEY = 'presence.typing'

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
  const t = useT()
  if (peers.length === 0) return null

  const titles = new Map(
    events.map((event) => [event.id, event.title.trim() || tStatic('presence.untitled')]),
  )
  const typingShown = new Set<string>()

  return (
    <div className="presence" data-presence aria-label={t('presence.aria')}>
      <span className="presence__lead">{t('presence.lead')}</span>
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
                  {where ? t('presence.editing', { title: where }) : t(UNKNOWN_EVENT_KEY)}
                </span>
              )}
              {showTyping && (
                <span className="presence__typing" data-presence-typing>
                  <span className="presence__typing-full">
                    {typingLabel(peers, typingKey) ?? t(SHORT_TYPING_KEY)}
                  </span>
                  {/* Для скринридера короткий дубль не нужен: полный текст уже прочитан. */}
                  <span className="presence__typing-short" aria-hidden="true">
                    {t(SHORT_TYPING_KEY)}
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
