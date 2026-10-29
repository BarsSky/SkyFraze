import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  type EntityConnection,
  type EntityKind,
  type EntityLink,
  type ProjectEntity,
} from '../../api/entities'
import { serverErrorMessage } from '../../api/client'
import { MentionImage } from './MentionImage'
import { cardTemplateFor, typeTitle, type EntityCardTemplate, type EntityType } from '../../api/entityTypes'
import type { FrameWithMentions, MatrixCell, Mention, MentionMatrix } from '../../collab/mentions'
import { MIN_ALIAS_LENGTH } from '../../collab/mentions'

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
  onOpenFrame?: (frameId: string, mention: Mention, place: 'editors' | 'project') => void
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
  /**
   * Сколько раз имя встречается в тексте проекта (0.97.4).
   *
   * Нужен только переименованию: упоминания ищутся по имени и алиасам, поэтому смена имени без
   * старого имени в алиасах молча рвёт все связи карточки с кадрами. Панель карточек текста не
   * видит — счётчик приходит от владельца, у которого кадры под рукой.
   */
  countMentionsOf?: (name: string) => number
  /**
   * Картинки упоминаний (0.93.0): ключ `карточка:кадр` → id вложения проекта.
   *
   * Словарь, а не «дай картинку этой пары»: панель «Связи» открывается на вкладке и показывает
   * карточки всех персонажей сразу — запрос на каждую пару означал бы N обращений ради экрана.
   */
  mentionImages?: Record<string, string>
  /** Привязать картинку к паре «карточка × кадр» (редактор и выше). */
  onSetMentionImage?: (entityId: string, eventId: string, assetId: string) => void
  /** Отвязать картинку у пары. */
  onClearMentionImage?: (entityId: string, eventId: string) => void
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
  countMentionsOf,
  mentionImages,
  onSetMentionImage,
  onClearMentionImage,
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
  /**
   * Карточка, у которой открыто меню «⋮» (0.102.0).
   *
   * Отчёт: «убрать в три точки и сделать выпадающим списком» — четыре кнопки в каждой строке
   * («Где встречается | Изменить | Связать | Удалить») занимали полстроки и на телефоне переносились
   * на вторую, отчего карточки в списке разъезжались по высоте.
   *
   * Одно состояние на всю панель, а не своё у каждой карточки: открытым может быть только одно
   * меню — иначе два списка действий висели бы одновременно и непонятно, к какой карточке какой.
   */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** Открытое меню: нужно, чтобы перевести в него фокус и ходить по пунктам стрелками. */
  const menuEl = useRef<HTMLSpanElement | null>(null)
  /**
   * Закрытие меню «⋮» по клику мимо и по Escape.
   *
   * Клик внутри меню и по самой кнопке не перехватываем: выбранное действие само закрывает меню,
   * а кнопка переключает его нажатием. Иначе `pointerdown` гасил бы меню раньше, чем `click`
   * успевал переключить его на другую карточку.
   *
   * Escape возвращает фокус на «⋮» этой карточки: иначе после закрытия меню фокус остаётся в
   * никуда не ведущем узле, и клавиатурный человек теряет место в списке.
   */
  useEffect(() => {
    if (menuFor === null) return undefined
    const onDown = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('[data-entity-menu-root]') !== null) return
      setMenuFor(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const trigger = document.querySelector<HTMLButtonElement>(
        `[data-entity-menu-root="${menuFor}"] [data-entity-menu]`,
      )
      setMenuFor(null)
      trigger?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuFor])
  /**
   * Меню раскрыто вверх (0.102.2): у последней карточки внизу экрана места под список нет, и
   * пункты «Связать / Удалить» уезжали бы за край. Разворот считается один раз при открытии —
   * так список не «прыгает», пока с ним работают.
   */
  const [menuUp, setMenuUp] = useState(false)
  /** Меню открылось — ставим фокус в первый пункт и проверяем, есть ли место внизу. */
  useEffect(() => {
    if (menuFor === null) return
    const el = menuEl.current
    // jsdom в тестах отдаёт нулевой прямоугольник — тогда разворот не нужен по определению.
    if (el !== null && el !== undefined && el.getBoundingClientRect().bottom > window.innerHeight - 8) {
      setMenuUp(true)
    }
    el?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [menuFor])
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
  /**
   * Раскрытая клетка матрицы (0.87.0 → 0.90.0): что где встречается и два перехода.
   *
   * 0.87.0 открывала рядом с клеткой ВСПЛЫВАЮЩУЮ карточку — по отчёту она читалась как
   * «всплывающее сообщение», а не как раскрытие элемента. Теперь клетка раскрывается В САМОЙ
   * таблице: под ней появляется карточка на всю ширину раздела, а выбранная клетка подсвечена.
   * Так элемент раскрывается «в карточку», а не показывает подсказку, и на телефоне ничего не
   * улетает за край (всплывающая карточка не помещалась рядом с клеткой).
   *
   * Заодно место под будущую фичу: в карточке появится привязка по картинке (вложение проекта к
   * упоминанию) — в потоке для этого есть место, в подсказке его не было.
   */
  const [mentionCard, setMentionCard] = useState<{
    entityId: string
    chapterIndex: number
    entityName: string
    kind: string
    chapterNumber: string
    chapterTitle: string
    cell: MatrixCell
    frameId: string
  } | null>(null)

  /** Связи карточки в обе стороны: прямые и обратные (0.74.0). */
  const entityLinks = (entityId: string) => connectionsOf(entityId, links ?? [], entities)

  /**
   * Карточки, разложенные по видам (0.97.7).
   *
   * Отчёт: «сделать группировку по темам в карточках и сделать сворачиваемыми». В проекте бывает
   * тридцать карточек трёх-пяти видов, и одним списком «Аня, Земля, Письмо, Вокзал…» искать
   * нужное приходилось глазами: вид указан в каждой строке, но порядок смешанный.
   *
   * Порядок групп — порядок видов в проекте (`position`), а не алфавит и не частота: человек сам
   * расставил виды, когда заводил их, и список должен это повторять. Вид, которого в `types` нет
   * (карточка пришла из импорта до 0.81.0), уходит в конец — но не теряется.
   */
  const groups = useMemo(() => {
    const out: Array<{ kind: string; title: string; entities: ProjectEntity[] }> = []
    const byKind = new Map<string, ProjectEntity[]>()
    for (const entity of entities) {
      const list = byKind.get(entity.kind)
      if (list) list.push(entity)
      else byKind.set(entity.kind, [entity])
    }
    const ordered = [...types].sort((a, b) => a.position - b.position).map((type) => type.key)
    for (const kind of ordered) {
      const list = byKind.get(kind)
      if (list !== undefined) {
        out.push({ kind, title: typeTitle(types, kind), entities: list })
        byKind.delete(kind)
      }
    }
    for (const [kind, list] of byKind) out.push({ kind, title: typeTitle(types, kind), entities: list })
    return out
  }, [entities, types])

  /**
   * Раскрытые группы (0.97.7, по умолчанию СВЁРНУТЫ с 0.111.0).
   *
   * Почему теперь свёрнуты. До 0.111.0 все группы были раскрыты, и при десятке карточек список
   * занимал весь экран: форма создания уезжала вниз, а до «Связей проекта» приходилось листать
   * мимо карточек, которые человек в этот момент не искал. Свёрнутые группы дают обзор: три
   * строки «Персонаж 3 · Место 5 · Тема 2» вместо тридцати карточек, и раскрывают ту, которая
   * нужна, одним нажатием.
   *
   * Состояние НЕ запоминается между заходами, в отличие от самого блока «Связи проекта»: раскрыть
   * группу — движение внутри просмотра («покажи персонажей»), а не настройка. Запоминание здесь
   * дало бы обратное прежней проблеме: человек раскрыл места месяц назад, а теперь не понимает,
   * почему персонажи свёрнуты.
   */
  const [openedGroups, setOpenedGroups] = useState<string[]>([])
  const toggleGroup = (kind: string, open: boolean) =>
    setOpenedGroups((current) =>
      open ? (current.includes(kind) ? current : [...current, kind]) : current.filter((item) => item !== kind),
    )

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

  /** Список видов: в него возвращается фокус после закрытия окна нового типа (0.111.0). */
  const kindSelectRef = useRef<HTMLSelectElement | null>(null)

  /**
   * Закрыть окно нового типа (0.111.0): поля очищаются, фокус возвращается на список видов.
   *
   * Возврат фокуса — не украшение. Окно модальное: без него после Escape человек оказывался бы в
   * начале страницы, а не там, где остановился, и на телефоне это ещё и скролл наверх.
   */
  const closeTypeDraft = useCallback(() => {
    setTypeDraftOpen(false)
    setTypeDraft('')
    setTypeTemplateDesc('')
    setTypeTemplateAliases('')
    kindSelectRef.current?.focus()
  }, [])

  /**
   * Escape закрывает окно нового типа. Слушаем документ, а не `onKeyDown` на самом окне: фокус
   * может стоять на кнопке «Создать тип», и событие всплывало бы мимо обработчика окна.
   */
  useEffect(() => {
    if (!typeDraftOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      closeTypeDraft()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [closeTypeDraft, typeDraftOpen])

  /**
   * Завести свой тип. Название вводит человек («Фракция»), ключ придумывает сервер.
   *
   * Почему окно открывается из списка видов: тип придумывают В МОМЕНТ, когда заводят карточку, а
   * не в настройках проекта. Отдельный экран «управление типами» заставил бы уйти с формы и вернуться.
   *
   * С 0.111.0 это ВСПЛЫВАЮЩЕЕ ОКНО, а не поля, достраивающиеся под формой. По отчёту «не сразу
   * понятно, как добавить новый тип, возникающие снизу поля сбивают с толку»: три поля и две
   * кнопки появлялись внутри формы карточки, сдвигали список и читались как её продолжение —
   * человек вводил имя карточки в «название типа». Окно отделяет одно действие от другого.
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
      closeTypeDraft()
      setNote({ kind: 'ok', text: `Тип «${title}» создан.` })
    } catch (e) {
      setNote({ kind: 'error', text: await explain(e, 'Не удалось создать тип.') })
    } finally {
      setBusy(false)
    }
  }, [closeTypeDraft, onCreateType, typeDraft, typeTemplateAliases, typeTemplateDesc])

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

  /**
   * Сохранить правку карточки (0.74.0 → 0.97.4).
   *
   * Переименование — не просто смена подписи: упоминания ищутся по имени и алиасам, поэтому
   * «Анна» → «Аня» без старого имени в алиасах теряет ВСЕ связи карточки с кадрами, где написано
   * «Анна», — молча, потому что счётчики в панели просто обнулятся. Поэтому перед сохранением
   * спрашиваем у владельца кадров, осталось ли старое имя в тексте, и если да — дописываем его в
   * алиасы и говорим об этом в примечании. Убрать алиас можно тут же, в списке алиасов: это не
   * скрытое решение, а сохранение уже существующих связей.
   */
  const save = useCallback(
    async (id: string) => {
      setBusy(true)
      setNote(null)
      try {
        const previous = entities.find((entity) => entity.id === id)
        const nextName = draftName.trim()
        let nextAliases = splitAliases(draftAliases)
        let keptOldName: { name: string; count: number } | null = null
        if (previous !== undefined && previous.name !== nextName && countMentionsOf !== undefined) {
          const oldName = previous.name
          const already =
            [...nextAliases, nextName].some(
              (candidate) => candidate.toLowerCase() === oldName.toLowerCase(),
            ) || [...oldName.trim()].length < MIN_ALIAS_LENGTH
          if (!already) {
            const count = countMentionsOf(oldName)
            if (count > 0) {
              nextAliases = [...nextAliases, oldName]
              keptOldName = { name: oldName, count }
            }
          }
        }
        await updateEntity(projectId, id, {
          name: nextName,
          aliases: nextAliases,
          description: draftDescription.trim(),
        })
        setEditing(null)
        if (keptOldName !== null) {
          const times = plural(keptOldName.count, 'раз', 'раза', 'раз')
          setNote({
            kind: 'ok',
            text:
              `Изменения сохранены. Прежнее имя «${keptOldName.name}» оставлено в алиасах: ` +
              `в тексте оно встречается ${times}, и без него эти связи потерялись бы.`,
          })
        } else {
          setNote({ kind: 'ok', text: 'Изменения сохранены.' })
        }
        reload()
      } catch (e) {
        setNote({ kind: 'error', text: await explain(e, 'Не удалось сохранить.') })
      } finally {
        setBusy(false)
      }
    },
    [countMentionsOf, draftAliases, draftDescription, draftName, entities, projectId, reload],
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

      {/* Форма создания — НАД списком и в своей рамке (0.111.0). По отчёту «перенеси выше создание
          карточки и сделай обрамление с явным выделением»: форма стояла ПОД группами, то есть после
          тридцати карточек, и завести карточку можно было, только пролистав список, который человек
          в этот момент не искал. Рамка отделяет действие от содержимого: полоса акцента темы по
          левому краю, заголовок «Новая карточка» и подсказка про заготовку вида. */}
      {canEdit && (
        // `div role="group"`, а не `section`: `section` с доступным именем получает роль `region`,
        // и рядом с раскрытой карточкой упоминания (тоже `section`) их становилось две — экранный
        // диктор и тесты переставали понимать, о каком разделе речь.
        <div
          className="ent__create"
          data-entity-create
          role="group"
          aria-labelledby="ent-create-title"
        >
          <div className="ent__create-head">
            <h3 className="ent__create-title" id="ent-create-title">
              Новая карточка
            </h3>
            <span className="muted ent__create-hint">вид задаёт алиасы и описание по заготовке</span>
          </div>
          <div className="ent__form">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Вид карточки"
              ref={kindSelectRef}
              data-entity-kind-select
            >
              {(types.length > 0 ? types : DEFAULT_TYPE_KEYS.map((key) => ({ key, title: kindTitle(key) }))).map(
                (item) => (
                  <option key={item.key} value={item.key}>
                    {item.title}
                  </option>
                ),
              )}
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
            {/* Отдельная кнопка, а не пункт «+ новый тип…» внутри списка видов (0.111.0): пункт в
                выпадающем списке — это действие, спрятанное среди значений, и по отчёту «не сразу
                понятно, как добавить новый тип» именно так и было. */}
            {onCreateType && (
              <button
                type="button"
                className="secondary ent__create-type"
                onClick={() => setTypeDraftOpen(true)}
                aria-haspopup="dialog"
                data-entity-type-open
              >
                + новый тип карточки
              </button>
            )}
          </div>
        </div>
      )}

      {/* Карточки по видам (0.97.7): «Персонажи · 3», «Места · 5» — каждая группа сворачивается.
          С 0.111.0 группы СВЁРНУТЫ по умолчанию: список из тридцати карточек занимал экран, и до
          формы создания (тогда она была внизу) приходилось листать мимо карточек, которые человек
          не искал. Внутри группы тот же список, что был раньше: группировка меняет только порядок
          и рамку, а не строки карточек. */}
      {entities.length > 0 &&
        groups.map((group) => (
          <details
            key={group.kind}
            className="ent__group"
            data-entity-group={group.kind}
            open={openedGroups.includes(group.kind)}
            onToggle={(e) => toggleGroup(group.kind, (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="ent__group-summary">
              {group.title}{' '}
              {/* Число карточек — пилюлей у правого края (0.102.0): по отчёту группы читались как
                  обычный серый текст и терялись между карточками. Разделитель «·» больше не нужен:
                  число показывает свою принадлежность фоном и формой. */}
              <span className="ent__group-count">{group.entities.length}</span>
            </summary>
            <ul className="ent__list" data-entities-list>
              {entities.filter((entity) => entity.kind === group.kind).map((entity) => (
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
                  {/* Связи с другими карточками (0.74.0 → 0.97.3): список под своей подписью,
                      лишние строки — за кнопкой «Показать все». */}
                  {!editing && entityLinks(entity.id).length > 0 && (
                    <LinkList
                      connections={entityLinks(entity.id)}
                      canEdit={canEdit}
                      onRemove={(linkId) => void removeLink(linkId)}
                    />
                  )}
                  {/* Сколько кадров и упоминаний: «сирота» (ноль) — повод либо добавить
                      алиас, либо убрать карточку. */}
                  {usage?.[entity.id] !== undefined && (
                    <span className="muted ent__usage" data-entity-usage>
                      {describeUsage(usage[entity.id])}
                    </span>
                  )}
                  {canEdit && (
                    <span className="ent__actions" data-entity-menu-root={entity.id}>
                      <button
                        type="button"
                        className="ent__menu-trigger secondary"
                        onClick={() => {
                          // Каждое открытие — заново «вниз»: разворот вверх решает замер, а не
                          // прошлое состояние этого меню.
                          setMenuUp(false)
                          setMenuFor((current) => (current === entity.id ? null : entity.id))
                        }}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === entity.id}
                        aria-label={`Действия с карточкой ${entity.name}`}
                        data-entity-menu
                      >
                        <span aria-hidden="true">⋮</span>
                      </button>
                      {menuFor === entity.id && (
                        <span
                          className={menuUp ? 'ent__menu is-up' : 'ent__menu'}
                          role="menu"
                          aria-label={`Меню карточки ${entity.name}`}
                          data-entity-menu-list={entity.id}
                          ref={menuEl}
                          onKeyDown={(event) => {
                            // Стрелки и Home/End внутри меню: у `role="menu"` это ожидаемое
                            // поведение, а без него пришлось бы жать Tab на каждый пункт.
                            const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
                            if (!keys.includes(event.key)) return
                            const items = Array.from(
                              menuEl.current?.querySelectorAll<HTMLButtonElement>(
                                '[role="menuitem"]',
                              ) ?? [],
                            )
                            if (items.length === 0) return
                            const at = items.indexOf(document.activeElement as HTMLButtonElement)
                            let next = at
                            if (event.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length
                            if (event.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1
                            if (event.key === 'Home') next = 0
                            if (event.key === 'End') next = items.length - 1
                            event.preventDefault()
                            items[next]?.focus()
                          }}
                        >
                          {(framesByEntity?.[entity.id]?.length ?? 0) > 0 && (
                            <button
                              type="button"
                              role="menuitem"
                              className="ent__menu-item"
                              onClick={() => {
                                setChronology((current) =>
                                  current === entity.id ? null : entity.id,
                                )
                                setMenuFor(null)
                              }}
                              aria-label={`Где встречается ${entity.name}`}
                              data-entity-chronology
                            >
                              {chronology === entity.id ? 'Скрыть кадры' : 'Где встречается'}
                            </button>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            className="ent__menu-item"
                            onClick={() => {
                              setEditing(entity.id)
                              setDraftName(entity.name)
                              setDraftAliases(aliasesText(entity))
                              setDraftDescription(entity.description)
                              setNote(null)
                              setMenuFor(null)
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
                              role="menuitem"
                              className="ent__menu-item"
                              onClick={() => {
                                setLinking((current) => (current === entity.id ? null : entity.id))
                                setLinkTarget('')
                                setLinkLabel('')
                                setNote(null)
                                setMenuFor(null)
                              }}
                              aria-label={`Связать карточку ${entity.name}`}
                              data-entity-link-add
                            >
                              {linking === entity.id ? 'Не связывать' : 'Связать'}
                            </button>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            className="ent__menu-item ent__menu-item--danger"
                            onClick={() => {
                              setPendingDelete(entity.id)
                              setMenuFor(null)
                            }}
                            aria-label={`Удалить карточку ${entity.name}`}
                            data-entity-delete
                          >
                            Удалить
                          </button>
                        </span>
                      )}
                    </span>
                  )}
                  {/* Подтверждение удаления — строкой под карточкой, а не в меню (0.102.0):
                      удаление необратимо, и вопрос должен оставаться на экране, пока на него не
                      ответили, даже если меню уже закрыто. */}
                  {canEdit && pendingDelete === entity.id && (
                    <span className="ent__confirm" data-entity-delete-confirm-row>
                      <span className="muted">Удалить карточку «{entity.name}»?</span>
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
                        onClick={() => {
                          const mention = frame.mentions[0]
                          if (mention) onOpenFrame?.(frame.frameId, mention, canEdit ? 'editors' : 'project')
                        }}
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
          </details>
        ))}

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
                            className={
                              mentionCard !== null &&
                              mentionCard.entityId === row.entity.id &&
                              mentionCard.chapterIndex === index
                                ? 'ent__matrix-link is-expanded'
                                : 'ent__matrix-link'
                            }
                            title={`Где встречается «${row.entity.name}» в главе`}
                            aria-expanded={
                              mentionCard !== null &&
                              mentionCard.entityId === row.entity.id &&
                              mentionCard.chapterIndex === index
                            }
                            onClick={() => {
                              const firstFrame = cell.frames?.[0] ?? cell.first
                              if (!firstFrame) return
                              const sameAsOpen =
                                mentionCard !== null &&
                                mentionCard.entityId === row.entity.id &&
                                mentionCard.chapterIndex === index
                              if (sameAsOpen) {
                                setMentionCard(null)
                                return
                              }
                              const chapter = matrix.chapters[index]
                              setMentionCard({
                                entityId: row.entity.id,
                                chapterIndex: index,
                                entityName: row.entity.name,
                                kind: row.entity.kind ?? '',
                                chapterNumber: chapter.number,
                                chapterTitle: chapter.title,
                                cell,
                                frameId: 'id' in firstFrame ? firstFrame.id : firstFrame.frameId,
                              })
                            }}
                            data-matrix-cell={matrix.chapters[index].id}
                            data-matrix-cell-entity={row.entity.id}
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
          {/* Клетка раскрывается карточкой прямо в разделе (0.90.0): раньше карточка всплывала
              рядом с клеткой и читалась как подсказка, а на телефоне уезжала за край. */}
          {mentionCard !== null && (
            <MentionCard
              card={mentionCard}
              projectId={projectId}
              canEdit={canEdit}
              kindTitle={kindTitle}
              mentionImages={mentionImages}
              onSetMentionImage={onSetMentionImage}
              onClearMentionImage={onClearMentionImage}
              onSelectFrame={(frameId) =>
                setMentionCard((current) => (current ? { ...current, frameId } : current))
              }
              onOpen={(place) => {
                const frame = mentionCard.cell.frames?.find((item) => item.id === mentionCard.frameId)
                const mention = frame?.mention ?? mentionCard.cell.first?.mention
                const frameId = frame?.id ?? mentionCard.cell.first?.frameId
                setMentionCard(null)
                if (mention && frameId) onOpenFrame?.(frameId, mention, place)
              }}
              onClose={() => setMentionCard(null)}
            />
          )}
        </details>
      )}

      {/* Окно нового типа (0.111.0). `position: fixed` поверх панели, а не поля, достраивающиеся
          под формой: по отчёту «возникающие снизу поля сбивают с толку» — их читали как продолжение
          формы карточки и вводили имя карточки в «название типа». Закрывается Escape, кликом мимо и
          кнопкой «Отмена»; фокус возвращается в список видов (см. `closeTypeDraft`).

          Портал в `document.body` обязателен, как у остальных модальных окон проекта (редактор
          Markdown, просмотр картинки, перенос проекта): панель редакторов живёт в своём контексте
          наложения, и окно с `z-index: 95` внутри него оказывалось ПОД плавающей кнопкой помощника
          (`z-index: 80`) — на телефоне кнопка рисовалась поверх листа с полями. Это ловилось
          скриншотом 390×844, а не тестами: те проверяют разметку, а не порядок слоёв. */}
      {canEdit &&
        onCreateType &&
        typeDraftOpen &&
        createPortal(
          <div
            className="ent-modal"
            data-entity-type-dialog
            onMouseDown={(e) => {
              // Закрываем только кликом по подложке: клик внутри карточки окна всплывает сюда же,
              // и без этой проверки окно закрывалось бы при попытке поставить курсор в поле.
              if (e.target === e.currentTarget) closeTypeDraft()
            }}
          >
            <div
              className="ent-modal__card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ent-type-title"
              data-entity-type-form
            >
              <h3 className="ent-modal__title" id="ent-type-title">
                Новый тип карточки
              </h3>
              <p className="muted ent-modal__hint">
                Тип появится в списке видов. Заготовка подставится в алиасы и описание новой карточки
                этого типа; <code>{'{{name}}'}</code> заменится на имя.
              </p>
              <label className="ent-modal__field">
                <span>Название</span>
                <input
                  value={typeDraft}
                  onChange={(e) => setTypeDraft(e.target.value)}
                  placeholder="Фракция"
                  aria-label="Название нового типа"
                  maxLength={40}
                  autoFocus
                />
              </label>
              <label className="ent-modal__field">
                <span>Алиасы заготовки</span>
                <input
                  value={typeTemplateAliases}
                  onChange={(e) => setTypeTemplateAliases(e.target.value)}
                  placeholder="фракция, союз"
                  aria-label="Алиасы заготовки типа"
                  data-entity-type-aliases
                />
              </label>
              <label className="ent-modal__field">
                <span>Заготовка описания</span>
                <textarea
                  value={typeTemplateDesc}
                  onChange={(e) => setTypeTemplateDesc(e.target.value)}
                  placeholder="{{name}} — союз городов…"
                  aria-label="Заготовка описания карточки типа"
                  rows={2}
                  maxLength={2000}
                  data-entity-type-template
                />
              </label>
              <div className="ent-modal__actions">
                <button
                  type="button"
                  onClick={() => void createType()}
                  disabled={busy || typeDraft.trim() === ''}
                  data-entity-type-add
                >
                  {busy ? 'Создаю…' : 'Создать тип'}
                </button>
                <button type="button" className="secondary" onClick={closeTypeDraft}>
                  Отмена
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </details>
  )
}

/**
 * Карточка упоминания (0.87.0 → 0.90.0): что где встречается и куда перейти.
 *
 * Зачем вместо прямого перехода: клик по клетке матрицы раньше уводил в кадр молча — человек не
 * видел ни главы, ни цитаты, — а при нескольких кадрах в главе всегда попадал в первый. Здесь
 * видно цитату, список кадров главы (можно выбрать) и два перехода: в текст («к редактированию»)
 * и в показ проекта («к проекту»). Читателю редактор недоступен — у него остаётся один переход.
 *
 * 0.90.0: карточка раскрывается В ПОТОКЕ раздела, под матрицей, а не всплывает поверх страницы.
 * Отчёт: «элемент по клику показывает всплывающее сообщение, а не сам раскрывается в карточку».
 * В потоке карточка не закрывает соседние клетки, не уезжает за край на телефоне и оставляет
 * место для будущей привязки картинки к упоминанию.
 */
function MentionCard({
  card,
  projectId,
  canEdit,
  kindTitle,
  mentionImages,
  onSetMentionImage,
  onClearMentionImage,
  onSelectFrame,
  onOpen,
  onClose,
}: {
  card: {
    entityId: string
    chapterIndex: number
    entityName: string
    kind: string
    chapterNumber: string
    chapterTitle: string
    cell: MatrixCell
    frameId: string
  }
  projectId: string
  canEdit: boolean
  kindTitle: (key: string) => string
  /** Картинки упоминаний: ключ `карточка:кадр` → id вложения (0.93.0). */
  mentionImages?: Record<string, string>
  onSetMentionImage?: (entityId: string, eventId: string, assetId: string) => void
  onClearMentionImage?: (entityId: string, eventId: string) => void
  onSelectFrame: (frameId: string) => void
  onOpen: (place: 'editors' | 'project') => void
  onClose: () => void
}) {
  const frames = card.cell.frames ?? []
  const selected = frames.find((frame) => frame.id === card.frameId) ?? frames[0]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="ent__mention-card"
      role="region"
      aria-label={`Упоминания «${card.entityName}» в главе ${card.chapterNumber}`}
      data-mention-card
    >
      <div className="ent__mention-head">
        <span className="ent__kind">{kindTitle(card.kind)}</span>
        <strong className="ent__mention-name">{card.entityName}</strong>
        <button
          type="button"
          className="secondary ent__mention-close"
          onClick={onClose}
          aria-label="Закрыть карточку упоминания"
          data-mention-close
        >
          ×
        </button>
      </div>
      <p className="muted ent__mention-sub">
        глава {card.chapterNumber} «{card.chapterTitle}» · упоминаний:{' '}
        <span data-mention-count>{card.cell.count}</span>
      </p>
      {frames.length > 0 && (
        <ul className="ent__mention-frames" data-mention-frames>
          {frames.map((frame) => (
            <li key={frame.id}>
              <button
                type="button"
                className={frame.id === selected?.id ? 'ent__mention-frame is-active' : 'ent__mention-frame'}
                onClick={() => onSelectFrame(frame.id)}
                aria-pressed={frame.id === selected?.id}
                data-mention-frame={frame.id}
              >
                <span className="ent__mention-frame-title">{frame.title || 'без названия'}</span>
                {frame.mentions > 1 && <span className="muted">×{frame.mentions}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected?.mention.quote !== undefined && (
        <p className="ent__mention-quote" data-mention-quote>
          «{selected.mention.quote}»
        </p>
      )}
      {/* Картинка упоминания (0.93.0): привязана к паре «карточка × кадр», поэтому меняется
          вместе с выбранным кадром в списке выше. */}
      {selected && (
        <MentionImage
          projectId={projectId}
          entityId={card.entityId}
          entityName={card.entityName}
          eventId={selected.id}
          eventTitle={selected.title}
          assetId={mentionImages?.[`${card.entityId}:${selected.id}`]}
          canEdit={canEdit}
          onSet={(assetId) => onSetMentionImage?.(card.entityId, selected.id, assetId)}
          onClear={() => onClearMentionImage?.(card.entityId, selected.id)}
        />
      )}
      <div className="ent__mention-actions">
        {canEdit && (
          <button type="button" onClick={() => onOpen('editors')} data-mention-to-editors>
            К редактированию
          </button>
        )}
        <button
          type="button"
          className={canEdit ? 'secondary' : undefined}
          onClick={() => onOpen('project')}
          data-mention-to-project
        >
          К проекту
        </button>
      </div>
    </div>
  )
}

/**
 * Сколько связей карточки видно, пока человек не раскрыл список (0.97.3).
 *
 * Причина — число: сервер разрешает до 20 связей у карточки, и все они раньше выводились сразу.
 * Живая проверка (`tests/diag-entity-links-load.ts`) на двадцати связях дала карточку 995 px:
 * список занимал 904 px, а кнопки «Изменить» и «Связать» уезжали на 1613 px от верха документа —
 * ниже первого экрана, то есть до них надо было догадаться прокрутить. Пять строк — это ещё
 * обозримый список, и вместе с кнопками карточка остаётся в пределах экрана.
 */
const LINKS_PREVIEW = 5

/**
 * Список связей карточки (0.97.2 → 0.97.3): каждая связь своей плашкой, лишние — за кнопкой.
 *
 * Свёрнутость — состояние ОДНОЙ карточки, поэтому компонент, а не состояние панели: раскрыть
 * связи у одной карточки не должно раскрывать их у всех.
 */
function LinkList({
  connections,
  canEdit,
  onRemove,
}: {
  connections: EntityConnection[]
  canEdit: boolean
  onRemove: (linkId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const total = connections.length
  const visible = expanded ? connections : connections.slice(0, LINKS_PREVIEW)
  const hidden = total - visible.length
  return (
    <span className="ent__links" data-entity-links>
      <span className="ent__links-title">
        Связи · {total}
      </span>
      {visible.map((connection) => (
        <span key={connection.link.id} className="ent__link" data-entity-link={connection.link.id}>
          <span className="ent__link-label">
            {connection.direction === 'out' ? `→ ${connection.link.label}` : `← ${connection.link.label}`}
          </span>
          <span className="ent__link-name">{connection.other.name}</span>
          {canEdit && (
            <button
              type="button"
              className="ent__link-remove"
              onClick={() => onRemove(connection.link.id)}
              aria-label={`Убрать связь с ${connection.other.name}`}
              title="Убрать связь"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {total > LINKS_PREVIEW && (
        <button
          type="button"
          className="ent__links-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          data-entity-links-toggle
        >
          {expanded ? 'Свернуть связи' : `Показать все ${total}`}
        </button>
      )}
      {/* Подпись того, что скрыто: «Показать все 20» говорит, сколько всего, но не сколько
          спрятано. Одна строка приглушённым — чтобы свёрнутый список не выглядел полным. */}
      {hidden > 0 && (
        <span className="muted ent__links-more-hint" data-entity-links-hidden>
          скрыто ещё {hidden}
        </span>
      )}
    </span>
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
