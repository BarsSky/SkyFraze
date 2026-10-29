import { useCallback, useEffect, useMemo, useState } from 'react'
import { tStatic, useT } from '../../i18n'
import { listEventRows } from '../../api/events'
import {
  buildEventTree,
  DEFAULT_MAX_DEPTH,
  type EventLike,
  type EventTreeNode,
} from '../../collab/eventTree'
import {
  countNameMentions,
  entityUsage,
  framesByEntity,
  mentionMatrix,
  type DatedFrame,
  type FrameChapter,
  type FrameWithMentions,
  type Mention,
  type MentionFrame,
} from '../../collab/mentions'
import { dateFromServer } from '../../collab/eventDate'
import { useProjectEntities } from './useProjectEntities'
import { EntityGraph } from './EntityGraph'
import { EntitiesPanel } from './EntitiesPanel'
import { requestOpenFrame } from '../../lib/openFrame'
import { ENTITIES_CHANGED_EVENT } from '../../api/assistant'
import { createEntityType } from '../../api/entityTypes'
import {
  clearMentionImage as clearMentionImageRequest,
  listMentionImages,
  mentionImageKey,
  setMentionImage as setMentionImageRequest,
} from '../../api/mentionImages'

/**
 * Область «Связи» (0.79.0): всё про карточки мира — в одном месте.
 *
 * Почему отдельной областью. До этого граф и список карточек стояли ВНУТРИ панели
 * «Редакторы», между кнопками правки кадров и деревом (см. отчёт: «сейчас всё в перемешку»).
 * Редакторы — про текст, карточки — про мир вокруг него; в общей колонке одно мешало другому:
 * форма создания карточки оказывалась между «+ глава» и фильтром дерева.
 *
 * Где стоит: между показом проекта (стадией) и панелью «Редакторы» — как и просили. Порядок
 * вкладок сверху вниз получается осмысленным: смотрю проект → смотрю его связи → правлю текст.
 *
 * Данные берутся из ПРОЕКЦИИ (`listEventRows`), а не из живого документа: области «Связи»
 * нужны заголовки, текст, даты и дерево, чтобы посчитать упоминания, хронологию и матрицу.
 * Это же и позволяет области быть независимой от панели редакторов: у неё свой список и своя
 * загрузка. Отставание проекции — секунды, и для обзора связей это не важно; переход «открыть
 * кадр» ведёт в редактор, где текст всегда актуальный.
 */
interface Props {
  projectId: string
  canEdit: boolean
  /**
   * Переход к кадру (0.87.0): из всплывающей карточки упоминания — «к редактированию» или
   * «к проекту». Владелец страницы решает, что это значит (переключить вкладку и передать
   * просьбу панели редакторов либо прокрутить показ проекта на кадр).
   *
   * Почему проп, а не событие: панель редакторов монтируется только на своей вкладке, и событие
   * из «Связей» слышать было некому — переходы по матрице и хронологии перестали работать.
   */
  onOpenFrame?: (frameId: string, mention: Mention, place: 'editors' | 'project') => void
}

/** Строка дерева в том же виде, что нужно хронологии и матрице. */
interface RelationsRow {
  id: string
  parentId: string | null
  number: string
  title: string
  body: string
  date: string
  order: number
  isChapter: boolean
}

export function RelationsPanel({ projectId, canEdit, onOpenFrame }: Props) {
  const t = useT()
  const { entities, links, types, loaded, reload } = useProjectEntities(projectId)
  const [rows, setRows] = useState<RelationsRow[]>([])
  const [eventsLoaded, setEventsLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Картинки упоминаний (0.93.0): ключ `карточка:кадр` → id вложения.
   *
   * Держим словарём в состоянии панели, а не в карточке: карточка раскрывается и закрывается, и
   * при каждом открытии заново ходить в базу за тем же списком было бы расточительно. После
   * привязки состояние правится локально — ответ сервера уже подтвердил изменение.
   */
  const [mentionImages, setMentionImages] = useState<Record<string, string>>({})

  const loadMentionImages = useCallback(async () => {
    try {
      setMentionImages(await listMentionImages(projectId))
    } catch {
      // Без картинок карточка работает: это дополнение, а не основа. Ошибку не кричим.
      setMentionImages({})
    }
  }, [projectId])

  useEffect(() => {
    void loadMentionImages()
  }, [loadMentionImages])

  const setMentionImage = useCallback(
    async (entityId: string, eventId: string, assetId: string) => {
      const key = mentionImageKey(entityId, eventId)
      const previous = mentionImages[key]
      setMentionImages((current) => ({ ...current, [key]: assetId }))
      try {
        await setMentionImageRequest(projectId, entityId, eventId, assetId)
      } catch {
        // Сервер отказал — возвращаем как было, иначе карточка показывала бы картинку, которой нет.
        setMentionImages((current) => {
          const next = { ...current }
          if (previous) next[key] = previous
          else delete next[key]
          return next
        })
      }
    },
    [mentionImages, projectId],
  )

  const clearMentionImage = useCallback(
    async (entityId: string, eventId: string) => {
      const key = mentionImageKey(entityId, eventId)
      const previous = mentionImages[key]
      setMentionImages((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      try {
        await clearMentionImageRequest(projectId, entityId, eventId)
      } catch {
        if (previous) setMentionImages((current) => ({ ...current, [key]: previous }))
      }
    },
    [mentionImages, projectId],
  )

  const loadEvents = useCallback(async () => {
    try {
      const flat = await listEventRows(projectId)
      // Плоский список с сервера — в snake_case; дерево и нумерацию считаем по `parentId`.
      setRows(
        numberRows(
          flat.map((row) => ({
            id: row.id,
            parentId: row.parent_id ?? null,
            title: row.title,
            body: row.body,
            event_date: row.event_date ?? null,
          })),
        ),
      )
      setError(null)
    } catch {
      // Нет доступа или проект закрылся: пустой список честнее вечной загрузки.
      setRows([])
    } finally {
      setEventsLoaded(true)
    }
  }, [projectId])

  useEffect(() => {
    setEventsLoaded(false)
    void loadEvents()
  }, [loadEvents])

  // Карточку могли создать в помощнике или в другом окне (0.77.0): перечитываем оба списка.
  useEffect(() => {
    const onChanged = () => {
      void reload()
      void loadEvents()
    }
    window.addEventListener(ENTITIES_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(ENTITIES_CHANGED_EVENT, onChanged)
  }, [loadEvents, reload])

  const mentionFrames = useMemo<MentionFrame[]>(
    () => rows.map((row) => ({ id: row.id, title: row.title, body: row.body })),
    [rows],
  )

  const usage = useMemo(() => entityUsage(mentionFrames, entities), [mentionFrames, entities])

  /**
   * Сколько раз имя встречается в тексте проекта — для переименования (0.97.4).
   *
   * Считается тем же поиском, что и упоминания: панель карточек получает ответ и, если старое имя
   * ещё есть в тексте, оставляет его алиасом. Иначе «Анна» → «Аня» рвёт все связи карточки с
   * кадрами, не сказав об этом ни слова.
   */
  const countMentionsOf = useCallback(
    (name: string) => countNameMentions(mentionFrames, name),
    [mentionFrames],
  )

  const framesByEntityData = useMemo<Record<string, FrameWithMentions[]>>(() => {
    const dated: DatedFrame[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      date: row.date,
      number: row.number,
      order: row.order,
    }))
    return framesByEntity(dated, entities)
  }, [entities, rows])

  /** Матрица «карточки × главы»: главу ищем подъёмом по родителям, как в панели редакторов. */
  const matrix = useMemo(() => {
    const chapters = rows
      .filter((row) => row.isChapter)
      .map((row) => ({ id: row.id, title: row.title, number: row.number }))
    const byId = new Map(rows.map((row) => [row.id, row]))
    const frameChapters: FrameChapter[] = []
    for (const row of rows) {
      let current = byId.get(row.id)
      let chapterId: string | undefined
      while (current) {
        if (current.isChapter) {
          chapterId = current.id
          break
        }
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
      if (chapterId) frameChapters.push({ frameId: row.id, chapterId })
    }
    return mentionMatrix(mentionFrames, frameChapters, chapters, entities)
  }, [entities, mentionFrames, rows])

  /**
   * Переход к кадру из хронологии карточки и из матрицы (0.79.0 → 0.87.0).
   *
   * Сначала пробуем проп страницы: она переключит вкладку и передаст просьбу панели редакторов
   * либо прокрутит показ проекта. Событие осталось запасным путём — для случаев, когда панель
   * встроена без страницы (сценарии, тесты).
   */
  const openFrame = useCallback(
    (frameId: string, mention?: Mention, place: 'editors' | 'project' = 'editors') => {
      if (onOpenFrame && mention) {
        onOpenFrame(frameId, mention, place)
        return
      }
      requestOpenFrame(frameId, mention)
    },
    [onOpenFrame],
  )

  const chapters = rows.filter((row) => row.isChapter).length
  const framesCount = rows.length

  return (
    <section className="relations" data-relations aria-labelledby="relations-title">
      <header className="relations__head">
        <div className="relations__titles">
          <h2 className="relations__title" id="relations-title">
          {t('rel.title')}
          </h2>
          <p className="muted relations__hint">
          {t('rel.hint')}

          </p>
        </div>
        <p className="muted relations__stats" data-relations-stats>
          {loaded
? t('rel.stats', { cards: entities.length, links: links.length, frames: framesCount, chapters })
: t('rel.loadingCards')}
        </p>
      </header>

      {error !== null && <p className="ed-danger">{error}</p>}

      {entities.length > 0 ? (
        <EntityGraph entities={entities} links={links} types={types} projectId={projectId} tall />
      ) : (
        <p className="muted relations__empty" data-relations-empty>
          {eventsLoaded && loaded
? t('rel.empty')
: t('rel.loading')}
        </p>
      )}

      <EntitiesPanel
        projectId={projectId}
        canEdit={canEdit}
        entities={entities}
        loaded={loaded}
        reload={() => void reload()}
        usage={usage}
        countMentionsOf={countMentionsOf}
        framesByEntity={framesByEntityData}
        onOpenFrame={openFrame}
        matrix={matrix}
        matrixOpen
        types={types}
        onCreateType={
          canEdit
            ? async (title: string, cardTemplate?: { description?: string; aliases?: string[] }) => {
                await createEntityType(projectId, { title, cardTemplate })
                await reload()
              }
            : undefined
        }
        links={links}
        mentionImages={mentionImages}
        onSetMentionImage={(entityId, eventId, assetId) => void setMentionImage(entityId, eventId, assetId)}
        onClearMentionImage={(entityId, eventId) => void clearMentionImage(entityId, eventId)}
      />
    </section>
  )
}

/**
 * Плоский список событий → строки с номерами вида «01.2».
 *
 * Номер считается обходом дерева, а не берётся из сервера: «01.2» — это место в структуре, и
 * оно должно совпадать с тем, что человек видит в дереве редакторов.
 */
export function numberRows(flat: Array<EventLike & { title: string; body?: string; event_date?: string | null }>): RelationsRow[] {
  const out: RelationsRow[] = []
  const walk = (
    node: EventTreeNode<(typeof flat)[number]>,
    number: string,
    parentId: string | null,
  ) => {
    out.push({
      id: node.item.id,
      parentId,
      number,
title: node.item.title || tStatic('rel.untitled'),
      body: node.item.body ?? '',
      date: dateFromServer(node.item.event_date ?? null),
      order: out.length,
      isChapter: node.depth === 0,
    })
    node.children.forEach((child, index) => walk(child, `${number}.${index + 1}`, node.item.id))
  }
  buildEventTree(flat, DEFAULT_MAX_DEPTH).forEach((root, index) => {
    walk(root, String(index + 1).padStart(2, '0'), null)
  })
  return out
}
