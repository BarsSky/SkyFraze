import { useCallback, useEffect, useState } from 'react'
import {
  applyAIEntityProposal,
  discardAIEntityProposal,
  listAIEntityProposals,
  notifyEntitiesChanged,
  type AIEntityProposal,
  type AIEntityProposalResult,
} from '../../api/assistant'
import { serverErrorMessage } from '../../api/client'
import { kindLabel } from '../../api/entities'

/**
 * Предложения карточек мира от помощника (0.77.0).
 *
 * Зачем отдельный блок, а не строки в переписке. Предложение — это действие, которое ждёт
 * решения: человек должен увидеть состав («две карточки, одна связь»), а не разбирать его из
 * текста ответа модели. Поэтому блок стоит рядом с окном помощника и живёт на сервере: закрыл
 * вкладку — предложение на месте.
 *
 * Почему карточки создаёт сервер по кнопке, а не модель сразу. Карточка меняет весь проект
 * (упоминания, хронологию, матрицу, граф), а не одну сцену; неверное имя испортит связи везде,
 * где встретится. Это же правило, что и у правки кадра.
 *
 * Чего здесь нет:
 *   - кнопки «Вернуть»: созданная карточка удаляется одной кнопкой в панели связей, снимок для
 *     этого не нужен;
 *   - скрытия кнопок от читателя: предложение личное, а роль участника панель не знает. Если
 *     прав на создание нет, сервер ответит отказом, и человек прочитает причину словами — это
 *     честнее, чем спрятать кнопку и оставить его гадать, почему её нет.
 */
interface Props {
  projectId: string
  /**
   * Меняется, когда от помощника пришёл новый ответ: список перечитывается. Число, а не
   * колбэк: компоненту важно только «что-то было».
   */
  refreshKey?: number
}

/** Итог применения одной пачки: остаётся на экране, чтобы человек видел, что появилось. */
interface AppliedSummary {
  proposalId: string
  result: AIEntityProposalResult
}

export function EntityProposals({ projectId, refreshKey = 0 }: Props) {
  const [proposals, setProposals] = useState<AIEntityProposal[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [applied, setApplied] = useState<AppliedSummary[]>([])

  const load = useCallback(async () => {
    try {
      const list = await listAIEntityProposals(projectId)
      setProposals(list)
    } catch {
      // Проект может быть недоступен (закрыт доступ): пустой список лучше вечной загрузки.
      setProposals([])
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const apply = useCallback(
    async (proposal: AIEntityProposal) => {
      setBusy(proposal.id)
      setNote(null)
      try {
        const { result } = await applyAIEntityProposal(projectId, proposal.id)
        setProposals((list) => list.filter((item) => item.id !== proposal.id))
        // Отчёт — в список применённых, а не в «последнее сообщение»: человек должен видеть,
        // что появилось, и после того, как нажмёт что-то ещё. Заодно одна и та же фраза не
        // показывается дважды.
        setApplied((list) => [...list, { proposalId: proposal.id, result }])
        // Панель связей живёт в другом дереве компонентов: сообщаем ей, что карточки изменились.
        notifyEntitiesChanged()
      } catch (e) {
        setNote({
          kind: 'error',
          text: (await serverErrorMessage(e)) ?? 'Не удалось добавить карточки.',
        })
      } finally {
        setBusy(null)
      }
    },
    [projectId],
  )

  const discard = useCallback(
    async (proposal: AIEntityProposal) => {
      setBusy(proposal.id)
      setNote(null)
      try {
        await discardAIEntityProposal(projectId, proposal.id)
        setProposals((list) => list.filter((item) => item.id !== proposal.id))
        setNote({ kind: 'ok', text: 'Предложение отклонено — в проекте ничего не изменилось.' })
      } catch (e) {
        setNote({
          kind: 'error',
          text: (await serverErrorMessage(e)) ?? 'Не удалось отклонить предложение.',
        })
      } finally {
        setBusy(null)
      }
    },
    [projectId],
  )

  if (proposals.length === 0 && applied.length === 0 && note === null) return null

  return (
    <div className="ent-proposals" data-entity-proposals>
      {proposals.map((proposal) => (
        <div
          key={proposal.id}
          className="ent-proposals__item"
          data-entity-proposal={proposal.id}
        >
          <p className="ent-proposals__title">
            Помощник предлагает карточки
            <span className="muted"> · {countLabel(proposal.cards.length, 'карточка', 'карточки', 'карточек')}</span>
            {proposal.links.length > 0 && (
              <span className="muted">
                {' '}
                · {countLabel(proposal.links.length, 'связь', 'связи', 'связей')}
              </span>
            )}
          </p>
          {proposal.note !== '' && <p className="ent-proposals__note">{proposal.note}</p>}
          <ul className="ent-proposals__cards">
            {proposal.cards.map((card) => (
              <li key={`${proposal.id}-${card.name}`} className="ent-proposals__card">
                <span className="ent__kind">{kindLabel(card.kind)}</span>
                <span className="ent__name">{card.name}</span>
                {card.aliases.length > 0 && (
                  <span className="muted ent__aliases">({card.aliases.join(', ')})</span>
                )}
                {card.description !== '' && (
                  <span className="muted ent-proposals__description">{card.description}</span>
                )}
              </li>
            ))}
          </ul>
          {proposal.links.length > 0 && (
            <ul className="ent-proposals__links">
              {proposal.links.map((link) => (
                <li key={`${proposal.id}-${link.from}-${link.to}-${link.label}`}>
                  {link.from} <span className="muted">→ {link.label} →</span> {link.to}
                </li>
              ))}
            </ul>
          )}
          <div className="ent-proposals__actions">
            <button
              type="button"
              onClick={() => void apply(proposal)}
              disabled={busy !== null}
              data-entity-proposal-apply
            >
              {busy === proposal.id ? 'Добавляю…' : 'Добавить карточки'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void discard(proposal)}
              disabled={busy !== null}
              data-entity-proposal-discard
            >
              Не надо
            </button>
          </div>
        </div>
      ))}
      {applied.map((item) => (
        <div key={item.proposalId} className="ent-proposals__applied" data-entity-proposal-done>
          {describeResult(item.result)}
        </div>
      ))}
      {note !== null && (
        <p
          className={note.kind === 'error' ? 'ent-proposals__note ed-danger' : 'ent-proposals__note'}
          role="status"
          data-entity-proposals-note
        >
          {note.text}
        </p>
      )}
    </div>
  )
}

/**
 * Отчёт словами: «добавлено: Анна, Земля; уже было: Марс; связей: одна».
 *
 * Именно списком имён, а не «2 карточки»: человек подтверждал конкретные карточки, и увидеть
 * надо их названия — по числу нельзя понять, та ли это «Анна».
 */
export function describeResult(result: AIEntityProposalResult): string {
  const parts: string[] = []
  if (result.created.length > 0) parts.push(`добавлено: ${result.created.join(', ')}`)
  if (result.existing.length > 0) parts.push(`уже было: ${result.existing.join(', ')}`)
  if (result.linksCreated.length > 0) parts.push(`связей: ${result.linksCreated.length}`)
  if (result.failed.length > 0) {
    parts.push(
      `не вышло: ${result.failed.map((item) => `${item.name} (${item.reason})`).join('; ')}`,
    )
  }
  if (result.linksSkipped.length > 0) {
    parts.push(
      `связи пропущены: ${result.linksSkipped
        .map((item) => `${item.name} (${item.reason})`)
        .join('; ')}`,
    )
  }
  if (parts.length === 0) return 'В проекте ничего не изменилось: создавать было нечего.'
  return parts.join(' · ')
}

/** Склонение по-русски: «1 карточка», «2 карточки», «5 карточек». */
export function countLabel(count: number, one: string, few: string, many: string): string {
  const tail = count % 100
  if (tail >= 11 && tail <= 14) return `${count} ${many}`
  switch (count % 10) {
    case 1:
      return `${count} ${one}`
    case 2:
    case 3:
    case 4:
      return `${count} ${few}`
    default:
      return `${count} ${many}`
  }
}
