import { useCallback, useEffect, useState } from 'react'
import {
  addEntityLink,
  aliasesText,
  connectionsOf,
  createEntity,
  deleteEntity,
  deleteEntityLink,
  kindLabel,
  listEntities,
  updateEntity,
  type EntityKind,
  type EntityLink,
  type ProjectEntity,
} from '../../api/entities'
import { serverErrorMessage } from '../../api/client'
import { cardTemplateFor, typeTitle, type EntityCardTemplate, type EntityType } from '../../api/entityTypes'
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

/**
 * Три стартовых ключа — резервный список, пока типы проекта не приехали (0.81.0).
 *
 * Нужен, чтобы форма создания карточки не была пустым списком в первые миллисекунды: подписи
 * берём из `typeTitle`, а они для трёх стартовых ключей известны и без сервера.
 */
const DEFAULT_TYPE_KEYS = ['character', 'place', 'theme']

/** Значение пункта «+ новый тип…» в списке видов. */
const NEW_TYPE = '__new_type__'

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
  /**
   * Матрица раскрыта сразу (0.79.0). В области «Связи» она — часть ответа на «кто с кем
   * встречается», и прятать её за свёрнутым заголовком значит заставлять искать.
   */
  matrixOpen?: boolean
  /**
   * Типы карточек проекта (0.81.0). Три стартовых есть всегда; свои человек заводит здесь же.
   * Подписи видов берутся отсюда, а не из констант: «Фракция» — это название из его проекта.
   */
  types?: EntityType[]
  /** Завести свой тип: вызывает владелец данных и перечитывает список (появится в выборе). */
  onCreateType?: (title: string, cardTemplate?: EntityCardTemplate) => Promise<void>
  /** Связи карточек проекта (0.74.0): чипы «Аня — живёт на → Земля». */
  links?: EntityLink[]
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
  matrixOpen = false,
  types = [],
  onCreateType,
  links,
}: Props) {
  // Вид новой карточки — первый тип проекта (у стартовых это «Персонаж»). Состояние хранит КЛЮЧ
  // типа: человек мог переименовать «Персонаж» в «Героя», и ключ остаётся `character`.
  const [kind, setKind] = useState<string>('character')
  /** Раскрыта ли форма нового типа (0.81.0). */
  const [typeDraftOpen, setTypeDraftOpen] = useState(false)
  const [typeDraft, setTypeDraft] = useState('')
  /**
   * Заготовка карточки нового типа (0.85.0, docs/entity-types.md §4).
   *
   * Тип отвечает «что это за класс» («Фракция»), а заготовка — «что написать в карточке этого
   * класса»: описание с подстановкой `{{name}}` и типичные алиасы. Пустые поля — норма: у
   * большинства типов заготовки нет.
   */
  const [typeTemplateDesc, setTypeTemplateDesc] = useState('')
  const [typeTemplateAliases, setTypeTemplateAliases] = useState('')
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')
  /** Описание новой карточки: раньше его нельзя было написать из интерфейса вовсе (0.85.0). */
  const [description, setDescription] = useState('')
  /** Правка описания руками: после неё заготовка типа больше не переписывает поле. */
  const [descriptionEdited, setDescriptionEdited] = useState(false)
  const [aliasesEdited, setAliasesEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** Какая карточка сейчас правится: правка на месте, без отдельного окна. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftAliases, setDraftAliases] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** У какой карточки раскрыта хронология. Одна за раз: две открытые — это уже не список. */
  const [chronology, setChronology] = useState<string | null>(null)
  /**
   * У какой карточки раскрывается «связать» (0.76.0): выбор второй карточки и подпись.
   * Тоже одна за раз — форма занимает строку целиком.
   */
  const [linking, setLinking] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState('')
  const [linkLabel, setLinkLabel] = useState('')
  /**
   * Раскрыт ли блок (0.72.1). По умолчанию — да, если карточек ещё нет: иначе фичу просто не
   * находят («не видно, где заводить персонажей» — так и было на практике). Выбор человека
   * запоминается, чтобы блок не раскрывался каждый раз заново.
   */
  const [open, setOpen] = useState(() => readEntitiesOpen(projectId) ?? entities.length === 0)

  /** Связи карточки в обе стороны: прямые и обратные (0.74.0). */
  const entityLinks = (entityId: string) => connectionsOf(entityId, links ?? [], entities)

  /**
   * Название вида для человека (0.81.0): из типов проекта, а не из констант. Если типы ещё не
   * приехали, `typeTitle` покажет стартовую подпись — она совпадает с прежним поведением.
   */
  const kindTitle = (key: string) => typeTitle(types, key)

  /**
   * Заготовка карточки выбранного типа (0.85.0): подставляется в описание и алиасы.
   *
   * Почему эффектом, а не «только при смене вида»: в заготовке есть `{{name}}`, и текст должен
   * обновиться, когда человек ввёл имя. Но переписать уже правленное руками поле нельзя — он мог
   * изменить текст, а мы бы его стёрли. Поэтому `descriptionEdited`/`aliasesEdited`: после первой
   * ручной правки заготовка эти поля больше не трогает.
   */
  useEffect(() => {
    const prefill = cardTemplateFor(types, kind, name)
    if (!descriptionEdited) setDescription(prefill.description)
    if (!aliasesEdited) setAliases(prefill.aliases)
  }, [aliasesEdited, descriptionEdited, kind, name, types])

  /**
   * Завести свой тип. Название вводит человек («Фракция»), ключ придумывает сервер.
   *
   * Почему форма раскрывается в том же списке видов: тип придумывают В МОМЕНТ, когда заводят
   * карточку, а не в настройках проекта. Отдельный экран «управление типами» заставил бы уйти
   * с формы и вернуться.
   */
  const createType = useCallback(async () => {
    const title = typeDraft.trim()
    if (!title || !onCreateType) return
    setBusy(true)
    setNote(null)
    try {
      const cardTemplate: EntityCardTemplate = {
        description: typeTemplateDesc.trim(),
        aliases: splitAliases(typeTemplateAliases),
      }
      await onCreateType(title, cardTemplate)
      setTypeDraft('')
      setTypeTemplateDesc('')
      setTypeTemplateAliases('')
      setTypeDraftOpen(false)
      setNote({ kind: 'ok', text: `Тип «${title}» создан.` })
    } catch (e) {
      setNote({ kind: 'error', text: await explain(e, 'Не удалось создать тип.') })
    } finally {
      setBusy(false)
    }
  }, [onCreateType, typeDraft, typeTemplateAliases, typeTemplateDesc])

  /** Убрать связь. Спрашиваем подтверждение браузером? Нет: связь — не данные человека, а
   *  метка между карточками, и вернуть её — одно действие. */
  const removeLink = useCallback(
    async (linkId: string) => {
      setNote(null)
      try {
        await deleteEntityLink(projectId, linkId)
        reload()
      } catch (e) {
        setNote({ kind: 'error', text: await explain(e, 'Не удалось убрать связь.') })
      }
    },
    [projectId, reload],
  )
  /**
   * Создать связь (0.76.0). До этого связь заводилась только через API: чипы связей
   * рисовались, «убрать» работало, а «связать» — нет («связать негде»).
   * Подпись человеческая («живёт на», «сестра»), направление задаёт карточка-источник.
   */
  const link = useCallback(
    async (fromId: string) => {
      const label = linkLabel.trim()
      if (linkTarget === '' || label === '') return
      setBusy(true)
      setNote(null)
      try {
        await addEntityLink(projectId, fromId, linkTarget, label)
        setLinking(null)
        setLinkTarget('')
        setLinkLabel('')
        setNote({ kind: 'ok', text: 'Связь добавлена.' })
        reload()
      } catch (e) {
        setNote({ kind: 'error', text: await explain(e, 'Не удалось связать карточки.') })
      } finally {
        setBusy(false)
      }
    },
    [linkLabel, linkTarget, projectId, reload],
  )

  const add = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const created = await createEntity(projectId, {
        kind,
        name: name.trim(),
        aliases: splitAliases(aliases),
        description: description.trim(),
      })
      setName('')
      setAliases('')
      setDescription('')
      setDescriptionEdited(false)
      setAliasesEdited(false)
      setNote({ kind: 'ok', text: `Карточка «${created.name}» создана.` })
      reload()
    } catch (e) {
      setNote({ kind: 'error', text: await explain(e, 'Не удалось создать карточку.') })
    } finally {
      setBusy(false)
    }
  }, [aliases, description, kind, name, projectId, reload])

  const save = useCallback(
    async (id: string) => {
      setBusy(true)
      setNote(null)
      try {
        await updateEntity(projectId, id, {
          name: draftName.trim(),
          aliases: splitAliases(draftAliases),
          description: draftDescription.trim(),
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
    [draftAliases, draftDescription, draftName, projectId, reload],
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
    <details
      className="ent"
      data-entities
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open
        setOpen(next)
        writeEntitiesOpen(projectId, next)
      }}
    >
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
                  {/* Описание правится здесь же (0.85.0): раньше его можно было только
                      прочитать, если оно приехало из импорта или от помощника. */}
                  <textarea
                    value={draftDescription}
                    onChange={(e) => setDraftDescription(e.target.value)}
                    placeholder="описание: кто это, чем важен"
                    aria-label={`Описание карточки ${entity.name}`}
                    rows={2}
                    data-entity-desc-edit
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
                  <span className="ent__kind">{kindTitle(entity.kind)}</span>
                  <span className="ent__name">{entity.name}</span>
                  {entity.aliases.length > 0 && (
                    <span className="muted ent__aliases">({aliasesText(entity)})</span>
                  )}
                  {/* Описание (0.85.0): то, что подставила заготовка типа или написал человек. */}
                  {entity.description !== '' && (
                    <span className="muted ent__desc" data-entity-desc>
                      {entity.description}
                    </span>
                  )}
                  {/* Связи с другими карточками (0.74.0): чип показывает подпись и сторону. */}
                  {!editing && entityLinks(entity.id).length > 0 && (
                    <span className="ent__links" data-entity-links>
                      {entityLinks(entity.id).map((connection) => (
                        <span
                          key={connection.link.id}
                          className="ent__link"
                          data-entity-link={connection.link.id}
                        >
                          <span className="ent__link-label">
                            {connection.direction === 'out'
                              ? `→ ${connection.link.label}`
                              : `← ${connection.link.label}`}
                          </span>
                          <span className="ent__link-name">{connection.other.name}</span>
                          {canEdit && (
                            <button
                              type="button"
                              className="ent__link-remove"
                              onClick={() => void removeLink(connection.link.id)}
                              aria-label={`Убрать связь с ${connection.other.name}`}
                              title="Убрать связь"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </span>
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
                          setDraftDescription(entity.description)
                          setNote(null)
                        }}
                        aria-label={`Изменить карточку ${entity.name}`}
                        data-entity-edit
                      >
                        Изменить
                      </button>
                      {/* «Связать» — только если есть с чем: одна карточка связей не имеет. */}
                      {entities.length > 1 && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setLinking((current) => (current === entity.id ? null : entity.id))
                            setLinkTarget('')
                            setLinkLabel('')
                            setNote(null)
                          }}
                          aria-expanded={linking === entity.id}
                          aria-label={`Связать карточку ${entity.name}`}
                          data-entity-link-add
                        >
                          {linking === entity.id ? 'Не связывать' : 'Связать'}
                        </button>
                      )}
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
              {/* Форма связи (0.76.0): вторая карточка и подпись. Направление — от этой
                  карточки к выбранной, поэтому «→ живёт на» читается сверху вниз. */}
              {canEdit && linking === entity.id && (
                <span className="ent__link-form" data-entity-link-form>
                  <select
                    value={linkTarget}
                    onChange={(e) => setLinkTarget(e.target.value)}
                    aria-label={`С какой карточкой связать ${entity.name}`}
                    data-entity-link-target
                  >
                    <option value="">карточка…</option>
                    {entities
                      .filter((other) => other.id !== entity.id)
                      .map((other) => (
                        <option key={other.id} value={other.id}>
                          {kindTitle(other.kind)}: {other.name}
                        </option>
                      ))}
                  </select>
                  <input
                    value={linkLabel}
                    onChange={(e) => setLinkLabel(e.target.value)}
                    placeholder="подпись: живёт на"
                    aria-label={`Подпись связи от ${entity.name}`}
                    maxLength={40}
                    data-entity-link-label
                  />
                  <button
                    type="button"
                    onClick={() => void link(entity.id)}
                    disabled={busy || linkTarget === '' || linkLabel.trim() === ''}
                    data-entity-link-save
                  >
                    {busy ? 'Связываю…' : 'Связать'}
                  </button>
                </span>
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
            onChange={(e) => {
              // «+ новый тип…» в списке: открываем форму названия вместо выбора вида.
              if (e.target.value === NEW_TYPE) {
                setTypeDraftOpen(true)
                return
              }
              setKind(e.target.value)
            }}
            aria-label="Вид карточки"
            data-entity-kind-select
          >
            {(types.length > 0 ? types : DEFAULT_TYPE_KEYS.map((key) => ({ key, title: kindTitle(key) }))).map(
              (item) => (
                <option key={item.key} value={item.key}>
                  {item.title}
                </option>
              ),
            )}
            {onCreateType && <option value={NEW_TYPE}>+ новый тип…</option>}
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
            onChange={(e) => {
              setAliases(e.target.value)
              setAliasesEdited(true)
            }}
            placeholder="алиасы: Аня, Анны"
            aria-label="Алиасы карточки"
          />
          {/* Описание (0.85.0): пусто у типа без заготовки, предзаполнено у типа с заготовкой.
              Правка руками отменяет автоподстановку — человек решает сам. */}
          <textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setDescriptionEdited(true)
            }}
            placeholder="описание: кто это, чем важен"
            aria-label="Описание карточки"
            rows={2}
            data-entity-desc-input
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

      {/* Новый тип карточки (0.81.0 → 0.85.0). Форма в той же строке, где заводят карточку:
          тип придумывают в этот момент, а не в настройках проекта. Заготовка — то, что потом
          подставится в форму карточки этого типа (docs/entity-types.md §4). */}
      {canEdit && onCreateType && typeDraftOpen && (
        <div className="ent__form ent__form--type" data-entity-type-form>
          <input
            value={typeDraft}
            onChange={(e) => setTypeDraft(e.target.value)}
            placeholder="название типа: Фракция"
            aria-label="Название нового типа"
            maxLength={40}
            autoFocus
          />
          <input
            value={typeTemplateAliases}
            onChange={(e) => setTypeTemplateAliases(e.target.value)}
            placeholder="алиасы заготовки: фракция, союз"
            aria-label="Алиасы заготовки типа"
            data-entity-type-aliases
          />
          <textarea
            value={typeTemplateDesc}
            onChange={(e) => setTypeTemplateDesc(e.target.value)}
            placeholder="заготовка описания: {{name}} — союз городов…"
            aria-label="Заготовка описания карточки типа"
            rows={2}
            maxLength={2000}
            data-entity-type-template
          />
          <button
            type="button"
            onClick={() => void createType()}
            disabled={busy || typeDraft.trim() === ''}
            data-entity-type-add
          >
            {busy ? 'Создаю…' : 'Создать тип'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setTypeDraftOpen(false)
              setTypeDraft('')
              setTypeTemplateDesc('')
              setTypeTemplateAliases('')
            }}
          >
            Отмена
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
        <details className="ent__matrix" data-entity-matrix open={matrixOpen}>
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
                    {row.cells.map((cell, index) => (
                      <td
                        key={`${row.entity.id}-${matrix.chapters[index].id}`}
                        className={cell.count === 0 ? 'muted' : undefined}
                      >
                        {cell.count === 0 ? (
                          '·'
                        ) : (
                          <button
                            type="button"
                            className="ent__matrix-link"
                            title={`Открыть кадр и показать «${cell.first?.mention.quote ?? ''}»`}
                            onClick={() =>
                              cell.first && onOpenFrame?.(cell.first.frameId, cell.first.mention)
                            }
                            data-matrix-cell={matrix.chapters[index].id}
                          >
                            {cell.count}
                          </button>
                        )}
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

/**
 * Запомненное состояние раскрытия блока «Связи проекта» (0.72.1).
 *
 * `null` — человек ещё ничего не решал: тогда блок раскрыт, если карточек нет (надо показать,
 * где их заводить). Ключ по проекту: в одном проекте блок может быть открыт, в другом закрыт.
 */
const ENTITIES_OPEN_PREFIX = 'skyfraze-entities-open:'

export function readEntitiesOpen(projectId: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(ENTITIES_OPEN_PREFIX + projectId)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    // Приватный режим или запрет хранилища — не повод падать: просто нет запомненного выбора.
  }
  return null
}

export function writeEntitiesOpen(projectId: string, open: boolean): void {
  try {
    window.localStorage.setItem(ENTITIES_OPEN_PREFIX + projectId, open ? '1' : '0')
  } catch {
    // Молча: состояние блока — удобство, а не данные.
  }
}
