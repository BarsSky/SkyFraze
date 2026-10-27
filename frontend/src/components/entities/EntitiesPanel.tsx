import { useCallback, useEffect, useState } from 'react'
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

interface Props {
  projectId: string
  /** Читатель видит карточки, но не меняет их: кнопки прячем, а не показываем и отказываем. */
  canEdit: boolean
}

export function EntitiesPanel({ projectId, canEdit }: Props) {
  const [entities, setEntities] = useState<ProjectEntity[]>([])
  const [loaded, setLoaded] = useState(false)
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

  const load = useCallback(async () => {
    try {
      // Сортируем и здесь, а не только на сервере: порядок карточек не должен зависеть от
      // того, в каком порядке их вернул конкретный ответ.
      setEntities((await listEntities(projectId)).slice().sort(byKindThenName))
    } catch {
      setEntities([])
    } finally {
      setLoaded(true)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const add = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const created = await createEntity(projectId, {
        kind,
        name: name.trim(),
        aliases: splitAliases(aliases),
      })
      setEntities((prev) => [...prev, created].sort(byKindThenName))
      setName('')
      setAliases('')
      setNote({ kind: 'ok', text: `Карточка «${created.name}» создана.` })
    } catch (e) {
      setNote({ kind: 'error', text: await explain(e, 'Не удалось создать карточку.') })
    } finally {
      setBusy(false)
    }
  }, [aliases, kind, name, projectId])

  const save = useCallback(
    async (id: string) => {
      setBusy(true)
      setNote(null)
      try {
        const updated = await updateEntity(projectId, id, {
          name: draftName.trim(),
          aliases: splitAliases(draftAliases),
        })
        setEntities((prev) => prev.map((e) => (e.id === id ? updated : e)).sort(byKindThenName))
        setEditing(null)
        setNote({ kind: 'ok', text: 'Изменения сохранены.' })
      } catch (e) {
        setNote({ kind: 'error', text: await explain(e, 'Не удалось сохранить.') })
      } finally {
        setBusy(false)
      }
    },
    [draftAliases, draftName, projectId],
  )

  const remove = useCallback(
    async (id: string) => {
      setBusy(true)
      setNote(null)
      try {
        await deleteEntity(projectId, id)
        setEntities((prev) => prev.filter((e) => e.id !== id))
        setPendingDelete(null)
        setNote({ kind: 'ok', text: 'Карточка удалена.' })
      } catch (e) {
        setNote({ kind: 'error', text: await explain(e, 'Не удалось удалить.') })
      } finally {
        setBusy(false)
      }
    },
    [projectId],
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
                  {canEdit && (
                    <span className="ent__actions">
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

/** Порядок списка: персонажи, места, темы; внутри вида — по имени. */
function byKindThenName(a: ProjectEntity, b: ProjectEntity): number {
  const order: Record<EntityKind, number> = { character: 0, place: 1, theme: 2 }
  if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind]
  return a.name.localeCompare(b.name, 'ru')
}

/**
 * Текст ошибки: сервер объясняет отказы сам («сущность с таким именем уже есть»), и это
 * полезнее кода 409. Своя фраза — только если сервер молчит.
 */
async function explain(e: unknown, fallback: string): Promise<string> {
  return (await serverErrorMessage(e)) ?? fallback
}
