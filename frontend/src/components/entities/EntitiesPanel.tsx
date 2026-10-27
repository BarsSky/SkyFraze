import { useCallback, useState } from 'react'
import {
  aliasesText,
  createEntity,
  deleteEntity,
  kindLabel,
  listEntities,
  updateEntity,
  type EntityKind,
  type ProjectEntity,
} from '../../api/entities'
import { serverErrorMessage } from '../../api/client'
import type { FrameWithMentions, Mention, MentionMatrix } from '../../collab/mentions'

/**
 * «Связи проекта» — карточки персонажей, мест и тем (docs/entity-links.md, фаза 1).
 *
 * Что здесь, а что в следующих фазах. Здесь: создать карточку, назвать её, задать алиасы
 * (падежи и краткие формы), переименовать, удалить. Связи «упоминание в кадре → карточка» —
 * фаза 2: они рождаются из текста и требуют якорей, а не ручного приклеивания.
 *
 * Почему `details`, а не панель с кнопкой: блок редкий (его открывают, чтобы завести
 * персонажа, а не каждую минуту), и раскрытый постоянно он отнимал бы место у дерева кадров.
 * Поведение раскрытия при этом бесплатное и доступное с клавиатуры.
 */

const KINDS: EntityKind[] = ['character', 'place', 'theme']

// Panel получает карточки от владельца данных (панель редакторов) и после правок просит
// перечитать список: карточки нужны ещё и поиску упоминаний в тексте, а два независимых
// списка разъезжались бы — создал карточку, а упоминания не появились.

interface Props {
  projectId: string
  /** Читатель видит карточки, но не меняет их: кнопки прячем, а не показываем и отказываем. */
  canEdit: boolean
  entities: ProjectEntity[]
  /** Данные уже загружены? До этого «пусто» и «не пришло» неразличимы. */
  loaded: boolean
  /** Перечитать список после создания/правки/удаления. */
  reload: () => void
  /** Сколько кадров и упоминаний у каждой карточки (считается по тексту, фаза 2). */
  usage?: Record<string, { frames: number; mentions: number }>
  /**
   * Хронология: где карточка появляется (фаза 3). Список раскрывается у карточки, а клик
   * ведёт в кадр и подсвечивает упоминание — это и есть «где на таймлайне появляется Анна».
   */
  framesByEntity?: Record<string, FrameWithMentions[]>
  onOpenFrame?: (frameId: string, mention: Mention) => void
  /**
   * Матрица «персонажи × главы» (0.71.0): кто с кем в одной главе. Единственный вид, где видно,
   * что два «главных» персонажа ни разу не встречаются вместе.
   */
  matrix?: MentionMatrix
}

export function EntitiesPanel({
  projectId,
  canEdit,
  entities,
  loaded,
  reload,
  usage,
  framesByEntity,
  onOpenFrame,
  matrix,
}: Props) {
  const [kind, setKind] = useState<EntityKind>('character')
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** Какая карточка сейчас правится: правка на месте, без отдельного окна. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftAliases, setDraftAliases] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** У какой карточки раскрыта хронология. Одна за раз: две открытые — это уже не список. */
  const [chronology, setChronology] = useState<string | null>(null)

  const add = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const created = await createEntity(projectId, {
        kind,
        name: name.trim(),
        aliases: splitAliases(aliases),
      })
      setName('')
      setAliases('')
      setNote({ kind: 'ok', text: `Карточка «${created.name}» создана.` })
      reload()
    } catch (e) {
      setNote({ kind: 'error', text: await explain(e, 'Не удалось создать карточку.') })
    } finally {
      setBusy(false)
    }
  }, [aliases, kind, name, projectId, reload])

  const save = useCallback(
    async (id: string) => {
      setBusy(true)
      setNote(null)
      try {
        await updateEntity(projectId, id, {
          name: draftName.trim(),
          aliases: splitAliases(draftAliases),
        })
        setEditing(null)
        setNote({ kind: 'ok', text: 'Изменения сохранены.' })
        reload()
      } catch (e) {
        setNote({ kind: 'error', text: await explain(e, 'Не удалось сохранить.') })
      } finally {
        setBusy(false)
      }
    },
    [draftAliases, draftName, projectId, reload],
  )

  const remove = useCallback(
    async (id: string) => {
      setBusy(true)
      setNote(null)
      try {
        await deleteEntity(projectId, id)
        setPendingDelete(null)
        setNote({ kind: 'ok', text: 'Карточка удалена.' })
        reload()
      } catch (e) {
        setNote({ kind: 'error', text: await explain(e, 'Не удалось удалить.') })
      } finally {
        setBusy(false)
      }
    },
    [projectId, reload],
  )

  return (
    <details className="ent" data-entities>
      <summary className="ent__summary">
        Связи проекта
        <span className="muted ent__count" data-entities-count>
          {loaded ? `карточек: ${entities.length}` : 'загружаю…'}
        </span>
      </summary>

      <p className="muted ent__hint">
        Персонажи, места и темы проекта с алиасами («Анна», «Аня», «Анны») — по ним кадры
        связываются между собой. Связи из упоминаний в тексте появятся следом.
      </p>

      {entities.length === 0 && loaded && (
        <p className="muted" data-entities-empty>
          Карточек пока нет. Начните с главного героя и места, где всё происходит.
        </p>
      )}

      {entities.length > 0 && (
        <ul className="ent__list" data-entities-list>
          {entities.map((entity) => (
            <li key={entity.id} className="ent__item" data-entity-kind={entity.kind}>
              {editing === entity.id ? (
                <div className="ent__edit">
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    aria-label={`Имя карточки ${entity.name}`}
                    maxLength={80}
                  />
                  <input
                    value={draftAliases}
                    onChange={(e) => setDraftAliases(e.target.value)}
                    placeholder="алиасы через запятую"
                    aria-label={`Алиасы карточки ${entity.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => void save(entity.id)}
                    disabled={busy || draftName.trim() === ''}
                    data-entity-save
                  >
                    Сохранить
                  </button>
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>
                    Отмена
                  </button>
                </div>
              ) : (
                <>
                  <span className="ent__kind">{kindLabel(entity.kind)}</span>
                  <span className="ent__name">{entity.name}</span>
                  {entity.aliases.length > 0 && (
                    <span className="muted ent__aliases">({aliasesText(entity)})</span>
                  )}
                  {/* Сколько кадров и упоминаний: «сирота» (ноль) — повод либо добавить
                      алиас, либо убрать карточку. */}
                  {usage?.[entity.id] !== undefined && (
                    <span className="muted ent__usage" data-entity-usage>
                      {describeUsage(usage[entity.id])}
                    </span>
                  )}
                  {canEdit && (
                    <span className="ent__actions">
                      {(framesByEntity?.[entity.id]?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            setChronology((current) => (current === entity.id ? null : entity.id))
                          }
                          aria-expanded={chronology === entity.id}
                          aria-label={`Где встречается ${entity.name}`}
                          data-entity-chronology
                        >
                          {chronology === entity.id ? 'Скрыть кадры' : 'Где встречается'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setEditing(entity.id)
                          setDraftName(entity.name)
                          setDraftAliases(aliasesText(entity))
                          setNote(null)
                        }}
                        aria-label={`Изменить карточку ${entity.name}`}
                        data-entity-edit
                      >
                        Изменить
                      </button>
                      {pendingDelete === entity.id ? (
                        <>
                          <button
                            type="button"
                            className="secondary ed-danger"
                            onClick={() => void remove(entity.id)}
                            disabled={busy}
                            data-entity-delete-confirm
                          >
                            Удалить
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setPendingDelete(null)}
                          >
                            Оставить
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setPendingDelete(entity.id)}
                          aria-label={`Удалить карточку ${entity.name}`}
                          data-entity-delete
                        >
                          Удалить
                        </button>
                      )}
                    </span>
                  )}
                </>
              )}
              {/* Хронология карточки: кадры по датам, потом без даты — в порядке дерева.
                  Кадр без даты не исчезает: он просто в конце, и это видно по отсутствию
                  даты в строке. */}
              {chronology === entity.id && (framesByEntity?.[entity.id]?.length ?? 0) > 0 && (
                <ol className="ent__chronology" data-entity-frames>
                  {framesByEntity?.[entity.id].map((frame) => (
                    <li key={frame.frameId} className="ent__frame">
                      <button
                        type="button"
                        className="ent__frame-open"
                        onClick={() => onOpenFrame?.(frame.frameId, frame.mentions[0])}
                        title={`Открыть кадр и показать «${frame.mentions[0]?.quote ?? ''}»`}
                        data-entity-frame={frame.frameId}
                      >
                        <span className="ent__frame-number">{frame.number || '—'}</span>
                        <span className="ent__frame-title">{frame.title || 'без названия'}</span>
                        {frame.date !== '' && <span className="muted ent__frame-date">{frame.date}</span>}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="ent__form">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as EntityKind)}
            aria-label="Вид карточки"
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {kindLabel(value)}
              </option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="имя: Анна"
            aria-label="Имя карточки"
            maxLength={80}
          />
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="алиасы: Аня, Анны"
            aria-label="Алиасы карточки"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || name.trim() === ''}
            data-entity-add
          >
            {busy ? 'Сохраняю…' : 'Добавить'}
          </button>
        </div>
      )}

      {note !== null && (
        <p
          className={note.kind === 'error' ? 'ent__note ed-danger' : 'ent__note'}
          role="status"
          data-entities-note
        >
          {note.text}
        </p>
      )}
      {/* Матрица связей: строки — карточки, столбцы — главы, в клетке число упоминаний.
          «Точка» у нуля вместо пустоты: пустая клетка читается как «не загрузилось». */}
      {matrix !== undefined && matrix.chapters.length > 0 && matrix.rows.length > 0 && (
        <details className="ent__matrix" data-entity-matrix>
          <summary className="ent__matrix-summary">Матрица: персонажи × главы</summary>
          <div className="ent__matrix-scroll">
            <table className="ent__matrix-table">
              <thead>
                <tr>
                  <th scope="col">Карточка</th>
                  {matrix.chapters.map((chapter) => (
                    <th key={chapter.id} scope="col" title={chapter.title}>
                      {chapter.number || chapter.title}
                    </th>
                  ))}
                  <th scope="col">всего</th>
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr key={`${row.entity.id}-matrix`} data-matrix-row={row.entity.id}>
                    <th scope="row">{row.entity.name}</th>
                    {row.cells.map((count, index) => (
                      <td
                        key={`${row.entity.id}-${matrix.chapters[index].id}`}
                        className={count === 0 ? 'muted' : undefined}
                      >
                        {count === 0 ? '·' : count}
                      </td>
                    ))}
                    <td>{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted ent__note">
            Число — упоминания в главе. «·» — не встречается: так и видно, кто ни разу не был в
            одной сцене с другими.
          </p>
        </details>
      )}
    </details>
  )
}

/** «Аня, Анны» → ['Аня', 'Анны']. Пустые куски выбрасываются: их не должен видеть сервер. */
export function splitAliases(raw: string): string[] {
  return raw
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean)
}

/**
 * Подпись использования карточки: «2 кадра · 3 упоминания» или честное «пока не упоминается».
 *
 * Ноль кадров — не мелочь: карточка, которую нигде не назвали, ничего не связывает, и человек
 * должен это видеть, а не догадываться.
 */
export function describeUsage(usage: { frames: number; mentions: number }): string {
  if (usage.frames === 0) return 'пока не упоминается'
  const frames = plural(usage.frames, 'кадр', 'кадра', 'кадров')
  const mentions = plural(usage.mentions, 'упоминание', 'упоминания', 'упоминаний')
  return `${frames} · ${mentions}`
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  const word =
    mod10 === 1 && mod100 !== 11
      ? one
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? few
        : many
  return `${count} ${word}`
}

/**
 * Текст ошибки: сервер объясняет отказы сам («сущность с таким именем уже есть»), и это
 * полезнее кода 409. Своя фраза — только если сервер молчит.
 */
async function explain(e: unknown, fallback: string): Promise<string> {
  return (await serverErrorMessage(e)) ?? fallback
}
