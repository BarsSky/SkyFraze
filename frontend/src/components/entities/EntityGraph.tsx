import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pluralWord, useT } from '../../i18n'
import { useLang, type Lang } from '../../store/lang'
import type { EntityLink, ProjectEntity } from '../../api/entities'
import { connectionsOf } from '../../api/entities'
import { typeTitle, type EntityType } from '../../api/entityTypes'
import {
  RAIL_WINDOW,
  edgeLabel,
  edgePieces,
  layoutEgoGraph,
  type GraphNeighbor,
} from '../../collab/graph'
import { buildNeighborhood } from '../../collab/neighborhood'
import { buildEntityIndex, searchEntities, type EntitySearchHit } from '../../lib/entitySearch'
import { readGraphView, writeGraphView } from '../../lib/graphView'

/**
 * Эго-граф связей: карточка в центре, её связи вокруг (0.75.0).
 *
 * Почему эго-граф, а не весь граф проекта: при тридцати карточках это клубок, нечитаемый ни на
 * телефоне, ни на ноутбуке. Задача окна — перейти от одной карточки к другой, поэтому центром
 * становится та, на которую кликнули, а история переходов позволяет вернуться.
 *
 * Отображение: рёбра — SVG-кривые с подписью связи, узлы — HTML-«пилюли» поверх SVG (текст
 * остаётся резким и стилизуется тем же CSS, что и остальные карточки). Библиотеку графов не
 * берём: раскладка здесь — эллипс и столбик, это `collab/graph.ts` под тестами.
 */

interface Props {
  entities: ProjectEntity[]
  links: EntityLink[]
  /**
   * Высокий холст (0.79.0): в области «Связи» граф — главное, а не полоска между блоками.
   * Меньше 320 px по высоте не бывает, поэтому режим «список» (он для низких экранов) здесь
   * включается только на телефоне в альбомной ориентации.
   */
  tall?: boolean
  /**
   * Типы карточек проекта (0.81.0): подпись вида в карточке узла берётся из них, а не из
   * констант — «Фракция» это название из проекта человека.
   */
  types?: EntityType[]
  /**
   * Проект, к которому относится граф (0.101.0). Нужен, чтобы запомнить выбранный уровень
   * («мир» или карточка) и открытую группу: без него состояние приходилось бы выбирать заново.
   */
  projectId?: string
}

const HISTORY_LIMIT = 10
/**
 * Сколько длится перелёт выбранной карточки в центр (0.84.0).
 *
 * 320 мс — как у обычного перехода в интерфейсе: заметно, но не заставляет ждать. Дольше — уже
 * «анимация ради анимации», короче — не читается как перелёт.
 */
const FLY_MS = 320

/** Уважает ли система «меньше движения»: тогда перелёт не рисуется вовсе. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return undefined
    const apply = () => setReduced(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
  return reduced
}

export function EntityGraph({ entities, links, tall = false, types = [], projectId }: Props) {
  const t = useT()
  const [lang] = useLang()
  /** Откуда пришли: стек последних центров, «назад» снимает верхний. */
  const [history, setHistory] = useState<string[]>([])
  const [centerId, setCenterId] = useState<string | null>(null)
  /**
   * Уровень просмотра (0.100.0): «мир» (группы по видам) или карточка с её сетью.
   *
   * Заказ: «как группировать карточки и ориентироваться в них — с акцентом на главную группу и
   * погружением в подгруппы». Мир — это группы; вход в группу не меняет данных, только вид.
   * По умолчанию открывается карточка (как раньше): человек пришёл смотреть связи, а не каталог.
   */
  const [level, setLevel] = useState<'world' | 'card'>('card')
  /** Какая группа показана на уровне «мир»; `null` — мир целиком. */
  const [groupKind, setGroupKind] = useState<string | null>(null)
  /**
   * Глубина окрестности (0.100.0): 1 — прямые соседи, 2 — соседи соседей и так далее.
   *
   * Решение из отчёта: «глубина без верхней границы». Ограничивает не число, а данные — обход
   * останавливается, когда новых карточек нет (`buildNeighborhood`).
   */
  const [depth, setDepth] = useState(1)
  /** Свёрнутые подгруппы (0.101.0): подписи связей, которые человек свернул в открытой группе. */
  const [collapsedClusters, setCollapsedClusters] = useState<string[]>([])
  /**
   * Какая карточка раскрыта в окне графа (0.78.0 → 0.84.0).
   *
   * С 0.84.0 раскрытая карточка всегда одна — та, что стоит в центре холста: нажатие на узел
   * переводит его в центр и разворачивает значения (имя, вид, алиасы, описание, связи), поэтому
   * содержимое видно всегда и не приходится читать его «сбоку», поверх соседей.
   */
  const [expanded, setExpanded] = useState<string | null>(null)
  /** Карточка, которая сейчас летит в центр: откуда и куда — считает раскладка. */
  const [flying, setFlying] = useState<{ id: string; from: { x: number; y: number } } | null>(null)
  const flyTimer = useRef<number | null>(null)
  const reducedMotion = useReducedMotion()
  const [query, setQuery] = useState('')
  const [windowStart, setWindowStart] = useState(0)
  const [size, setSize] = useState({ width: 720, height: 340 })
  /**
   * Холст берём состоянием, а не ref: карточки приходят с сервера ПОСЛЕ первого рендера, и до
   * них компонент рисует строку «граф появится, когда будут карточки» — холста в дереве нет.
   * Пока размер мерился эффектом с пустыми зависимостями, наблюдатель создавался в тот момент,
   * когда `hostRef.current` был null, и больше не создавался никогда: раскладка навсегда
   * оставалась в размере по умолчанию (720×340). На широком экране это выглядело как «граф
   * прижат влево и пустует», а на телефоне (холст 318 px) узлы уезжали за правый край — граф
   * казался пустым (нашлось живой проверкой 0.77.0).
   */
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  /** На низком экране граф честно уступает место списку (см. рендер). */
  const [compact, setCompact] = useState(false)

  // Центр по умолчанию — карточка с наибольшим числом связей: с неё видно больше всего.
  useEffect(() => {
    if (centerId !== null) return
    const first = entities[0]
    if (!first) return
    let best = first.id
    let bestCount = -1
    for (const entity of entities) {
      const count = connectionsOf(entity.id, links, entities).length
      if (count > bestCount) {
        bestCount = count
        best = entity.id
      }
    }
    setCenterId(best)
  }, [centerId, entities, links])

  // Размер холста по факту: жёсткая высота не годится — окно стоит в потоке страницы.
  //
  // Замер делается сразу при появлении холста и повторяется на каждое изменение размера:
  // первый замер важен отдельно, потому что ResizeObserver при отсутствии (jsdom, старые
  // браузеры) не сработает вовсе, а без замера раскладка осталась бы в размере по умолчанию.
  useEffect(() => {
    if (!host) return undefined
    const measure = () => {
      const rect = host.getBoundingClientRect()
      // Скрытый или ещё не разложенный холст даёт нули: такими размерами раскладку не портим.
      if (rect.width < 1 || rect.height < 1) return
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [host])

  useEffect(() => {
    const media = window.matchMedia?.('(max-height: 480px)')
    if (!media) return undefined
    const apply = () => setCompact(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  const center = useMemo(
    () => entities.find((entity) => entity.id === centerId) ?? null,
    [centerId, entities],
  )

  /**
   * Карточки, которых нет в эго-графе: у них нет ни одной связи.
   *
   * Показываем их строкой под холстом: иначе добавленная карточка «исчезает» до тех пор, пока
   * её с кем-нибудь не свяжут, и выглядит это как «область не обновилась» (0.81.0).
   */
  const isolated = useMemo(
    () => entities.filter((entity) => connectionsOf(entity.id, links, entities).length === 0),
    [entities, links],
  )
  const expandedCard = useMemo(
    () => entities.find((entity) => entity.id === expanded) ?? null,
    [entities, expanded],
  )  // Escape закрывает карточку: это окно поверх графа, и клавиатурой его тоже надо закрывать.

  /**
   * Группы по видам (0.100.0) — для уровня «мир».
   *
   * Порядок — как виды заведены в проекте: **главная группа та, что создана первой** (ответ на
   * вопрос «какой акцент»). Тип с самым ранним `created_at` идёт первым и получает акцент; если дат
   * нет (старые данные), порядок задаёт `position`. Карточки вида вне `types` (импорт до 0.81.0) —
   * отдельной группой в конце, чтобы не потерялись.
   */
  const groups = useMemo(() => {
    const byKind = new Map<string, ProjectEntity[]>()
    for (const entity of entities) {
      const list = byKind.get(entity.kind)
      if (list) list.push(entity)
      else byKind.set(entity.kind, [entity])
    }
    const known = [...types].sort((a, b) => {
      const aTime = a.created_at ?? ''
      const bTime = b.created_at ?? ''
      if (aTime !== bTime) return aTime < bTime ? -1 : 1
      return a.position - b.position
    })
    const out: Array<{ kind: string; title: string; cards: ProjectEntity[]; links: number; isolated: number }> = []
    const push = (kind: string, cards: ProjectEntity[]) => {
      const linksCount = cards.reduce(
        (sum, card) => sum + connectionsOf(card.id, links, entities).length,
        0,
      )
      const isolatedCount = cards.filter(
        (card) => connectionsOf(card.id, links, entities).length === 0,
      ).length
      out.push({
        kind,
        title: typeTitle(types, kind),
        cards,
        links: linksCount,
        isolated: isolatedCount,
      })
    }
    for (const type of known) {
      const cards = byKind.get(type.key)
      if (cards) {
        push(type.key, cards)
        byKind.delete(type.key)
      }
    }
    for (const [kind, cards] of byKind) push(kind, cards)
    return out
  }, [entities, links, types])

  /** Главная группа: первая созданная (см. комментарий выше). */
  const mainKind = groups[0]?.kind ?? null

  /**
   * Подгруппы открытой группы — по **подписям связей** (0.101.0, решение из отчёта: «подгруппа как
   * предлагаешь»).
   *
   * Почему так, а не ручные группы: подпись связи уже есть в данных («живёт на», «боится»), и она
   * отвечает на вопрос «что связывает этих людей внутри группы». Одна карточка может попасть в две
   * подгруппы — у Ани есть и «живёт на», и «боится», — и это честно: подгруппа здесь не папка, а
   * отношение. Карточки без связей идут отдельной подгруппой «вне связей», чтобы их было видно.
   */
  const clusters = useMemo(() => {
    const active = groups.find((group) => group.kind === groupKind) ?? null
    if (active === null) return { labels: [], isolated: [] as ProjectEntity[] }
    const byLabel = new Map<
      string,
      Array<{ card: ProjectEntity; other: string; direction: 'out' | 'in' }>
    >()
    for (const card of active.cards) {
      for (const connection of connectionsOf(card.id, links, entities)) {
        const list = byLabel.get(connection.link.label) ?? []
        // Одна строка на пару «подпись × карточка»: две одинаковые связи не должны дублировать строку.
        if (list.some((item) => item.card.id === card.id)) continue
        list.push({ card, other: connection.other.name, direction: connection.direction })
        byLabel.set(connection.link.label, list)
      }
    }
    const labels = [...byLabel.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label, 'ru'))
    const isolated = active.cards.filter((card) => connectionsOf(card.id, links, entities).length === 0)
    return { labels, isolated }
  }, [entities, groupKind, groups, links])

  const toggleCluster = useCallback((label: string) => {
    setCollapsedClusters((current) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    )
  }, [])

  // Запомненный уровень (0.101.0): человек, который смотрит мир по группам, возвращается туда же.
  //
  // Запись делается НЕ эффектом «на любое изменение», а явно в переходах (`persist`): в dev-режиме
  // компонент монтируется дважды (StrictMode), и эффект записи на монтировании успевал записать
  // значение по умолчанию раньше, чем второй монтаж прочитает сохранённое. Живая проверка ловила
  // это как «уровень не запомнился». Явная запись в действиях человека от порядка монтирования не
  // зависит.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (projectId) {
      const saved = readGraphView(projectId)
      if (saved !== null) {
        setLevel(saved.level)
        setGroupKind(saved.groupKind)
      }
    }
    restoredRef.current = true
  }, [projectId])

  const persist = useCallback(
    (next: { level: 'world' | 'card'; groupKind: string | null }) => {
      if (projectId) writeGraphView(projectId, next)
    },
    [projectId],
  )

  /**
   * Окрестность по уровням: «глубже» без верхней границы (0.100.0).
   *
   * Уровень 1 — то, что уже нарисовано вокруг центра; уровни 2+ показываем списком под холстом.
   * Так «погружение» не требует новой раскладки: человек видит, что за соседями, и может уйти в
   * любую карточку нажатием.
   */
  const neighborhood = useMemo(() => {
    if (!center) return { levels: [], total: 0, truncated: false }
    const nodes = entities.map((entity) => ({ id: entity.id, name: entity.name, kind: entity.kind }))
    return buildNeighborhood(center.id, links, nodes, depth)
  }, [center, depth, entities, links])

  /**
   * Индекс меток и поиск по нему (0.100.0): имя, алиасы, вид, подписи связей.
   *
   * Раньше поиск шёл только по имени — алиасы не участвовали, и «Анна» не находила «Аню».
   */
  const searchIndex = useMemo(() => buildEntityIndex(entities, links, types), [entities, links, types])
  const matches = useMemo<EntitySearchHit[]>(
    () => searchEntities(searchIndex, query, 8),
    [query, searchIndex],
  )

  /**
   * Крошки уровня карточки (0.100.0): «Мир / Персонажи».
   *
   * Имени карточки здесь нет намеренно: оно уже написано в центре холста, и вторая его копия в
   * крошках дублировала бы центр (и ломала текстовые запросы в тестах «найди карточку Аня»).
   * Крошка ведёт в группу — то есть туда, откуда карточку и открыли.
   */
  const crumbsFor = useCallback((): Array<{ label: string; onClick: (() => void) | null }> => {
    const kind = center?.kind ?? null
    const group = groups.find((item) => item.kind === kind) ?? null
    const out: Array<{ label: string; onClick: (() => void) | null }> = [
      {
label: t('graph.world'),
        onClick: () => {
          setLevel('world')
          setGroupKind(null)
          persist({ level: 'world', groupKind: null })
        },
      },
    ]
    if (group) {
      out.push({
        label: group.title,
        onClick: () => {
          setLevel('world')
          setGroupKind(group.kind)
          persist({ level: 'world', groupKind: group.kind })
        },
      })
    }
    return out
  }, [center, groups, persist])
  useEffect(() => {
    if (expanded === null) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const neighbors = useMemo<GraphNeighbor[]>(() => {
    if (!center) return []
    // Карточка — ОДИН узел, сколько бы связей её ни соединяло с центром. Без этого две связи
    // между одной парой давали два узла с одинаковым id («два ребёнка с одним ключом» в React,
    // узлы рисуются друг на друге) и две линии с одной подписью. Подписи соединяем:
    // «живёт на · получает». Направление берём у первой связи — при связях в обе стороны
    // стрелка одна, а полный список с направлениями виден в чипах карточки.
    const merged = new Map<string, GraphNeighbor>()
    for (const connection of connectionsOf(center.id, links, entities)) {
      const existing = merged.get(connection.other.id)
      if (!existing) {
        merged.set(connection.other.id, {
          id: connection.other.id,
          name: connection.other.name,
          kind: connection.other.kind,
          linkId: connection.link.id,
          label: connection.link.label,
          direction: connection.direction,
        })
        continue
      }
      const labels = existing.label.split(' · ')
      if (!labels.includes(connection.link.label)) {
        existing.label = `${existing.label} · ${connection.link.label}`
      }
    }
    return [...merged.values()]
  }, [center, entities, links])

  const layout = useMemo(
    () => layoutEgoGraph({ width: size.width, height: size.height, center: center ?? { id: '', name: '', kind: '' }, neighbors, windowStart }),
    [center, neighbors, size.height, size.width, windowStart],
  )

  /**
   * Где сейчас нарисован узел: у центра — середина холста, у соседа — его место в раскладке.
   * `null` означает «узла на холсте нет» (карточка вне связей, результат поиска) — для неё
   * перелёт не рисуем, она появляется сразу в центре.
   */
  const positionOf = useCallback(
    (id: string): { x: number; y: number } | null => {
      if (layout.center.node.id === id) return { x: layout.center.x, y: layout.center.y }
      const neighbor = layout.neighbors.find((positioned) => positioned.node.id === id)
      return neighbor ? { x: neighbor.x, y: neighbor.y } : null
    },
    [layout.center, layout.neighbors],
  )

  const go = useCallback(
    (id: string) => {
      if (!id || id === centerId) return
      setHistory((prev) => (centerId ? [...prev, centerId].slice(-HISTORY_LIMIT) : prev))
      setCenterId(id)
      setWindowStart(0)
    },
    [centerId],
  )

  /**
   * Выбор карточки: перелёт в центр с разворотом значений (0.84.0).
   *
   * Заказ: «по выбору карточки делать её анимированный переход в центр с развёртыванием
   * значений — так всегда будет видно содержимое карточки». Раньше (0.78.0) нажатие только
   * раскрывало карточку СБОКУ от узла, а переход был отдельной кнопкой: на узком холсте карточка
   * ложилась поверх соседей и центра, и её содержимое читалось плохо.
   *
   * Теперь нажатие на соседа: карточка сразу показывается (значения развёрнуты), её «пилюля»
   * летит в центр холста, а по окончании перелёта центр графа становится этой карточкой — и
   * карточка остаётся открытой уже в центре. Нажатие на центральный узел просто раскрывает или
   * сворачивает карточку: двигать нечего.
   *
   * При «меньше движения» перелёт не рисуется: переход происходит сразу.
   */
  const select = useCallback(
    (id: string) => {
      if (!id) return
      if (id === centerId) {
        setExpanded((current) => (current === id ? null : id))
        return
      }
      setExpanded(id)
      const from = positionOf(id)
      if (from === null || reducedMotion) {
        go(id)
        return
      }
      setFlying({ id, from })
      if (flyTimer.current !== null) window.clearTimeout(flyTimer.current)
      flyTimer.current = window.setTimeout(() => {
        flyTimer.current = null
        setFlying(null)
        go(id)
      }, FLY_MS)
    },
    [centerId, go, positionOf, reducedMotion],
  )

  // Таймер перелёта — не «висящий»: уход со страницы или смена центра не должны оставить
  // отложенный setState, который переключит центр уже после ухода.
  useEffect(
    () => () => {
      if (flyTimer.current !== null) window.clearTimeout(flyTimer.current)
    },
    [],
  )

  const back = useCallback(() => {
    setExpanded(null)
    setHistory((prev) => {
      const last = prev[prev.length - 1]
      if (last === undefined) return prev
      setCenterId(last)
      setWindowStart(0)
      return prev.slice(0, -1)
    })
  }, [])

  // Поиск по меткам — выше (`matches` из `searchIndex`): имя, алиасы, вид, подписи связей (0.100.0).

  if (entities.length === 0) {
    return (
      <p className="muted ent__hint" data-entity-graph-empty>
      {t('graph.empty')}
      </p>
    )
  }

  if (!center) return null

  /**
   * Уровень «мир» (0.100.0): группы по видам.
   *
   * Заказ: «можно ли свапом перебирать существующие группы или иначе группировать карточки, и как
   * ориентироваться». Здесь группы — плитки: главная (созданная первой) крупнее и с акцентом,
   * у каждой видно число карточек, связей и «вне связей». Внутрь — нажатием; между группами, когда
   * одна открыта, можно листать свайпом влево/вправо или стрелками (свайп пока пробный — решение
   * из отчёта: «сначала испробовать»).
   */
  if (level === 'world') {
    const active = groups.find((group) => group.kind === groupKind) ?? null
    const index = active ? groups.findIndex((group) => group.kind === active.kind) : -1
    const step = (delta: number) => {
      if (groups.length === 0) return
      const next = index < 0 ? 0 : (index + delta + groups.length) % groups.length
      setGroupKind(groups[next].kind)
      persist({ level: 'world', groupKind: groups[next].kind })
    }
    return (
      <div className={tall ? 'egraph egraph--tall' : 'egraph'} data-entity-graph="world">
        <GraphHeader
          query={query}
          setQuery={setQuery}
          matches={matches}
          onPick={select}
          onBack={history.length > 0 ? back : null}
          crumbs={
            active
              ? [
              { label: t('graph.world'), onClick: () => setGroupKind(null) },
                  { label: active.title, onClick: null },
                ]
              : null
          }
        />
        {active === null ? (
          <div className="egraph__groups" data-entity-graph-groups>
            {groups.map((group) => (
              <button
                key={group.kind}
                type="button"
                className={group.kind === mainKind ? 'egraph__group is-main' : 'egraph__group'}
                onClick={() => {
                  setGroupKind(group.kind)
                  persist({ level: 'world', groupKind: group.kind })
                }}
                data-entity-graph-group={group.kind}
                aria-label={t('graph.groupAria', {
                  title: group.title,
                  cards: withUnit(lang, 'ent.unit.card', group.cards.length),
                })}
              >
                <span className="egraph__group-name">{group.title}</span>
                <span className="egraph__group-count">{group.cards.length}</span>
                <span className="muted egraph__group-meta">
                  {group.links === 0
                    ? t('graph.linksNone')
                    : t('graph.linksCount', {
                        links: withUnit(lang, 'ent.unit.link', group.links),
                      })}
                  {group.isolated > 0
                    ? t('graph.isolatedCount', {
                        cards: withUnit(lang, 'ent.unit.card', group.isolated),
                      })
                    : ''}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="egraph__group-cards" data-entity-graph-group-cards={active.kind}>
            <div className="egraph__group-nav">
              <button type="button" className="secondary" onClick={() => step(-1)} aria-label={t('graph.prevGroup')} data-entity-graph-group-prev>
                ←
              </button>
              <span className="muted">
              {t('graph.groupIndex', { index: index + 1, total: groups.length })}
              </span>
              <button type="button" className="secondary" onClick={() => step(1)} aria-label={t('graph.nextGroup')} data-entity-graph-group-next>
                →
              </button>
            </div>
            <ul className="egraph__list" data-entity-graph-group-list>
              {/* Подгруппы по подписям связей (0.101.0): «живёт на · 2», «боится · 1». Свёрнутые
                  запоминаются на время просмотра — это движение внутри группы, а не настройка. */}
              {clusters.labels.map((cluster) => {
                const collapsed = collapsedClusters.includes(cluster.label)
                return (
                  <li key={cluster.label} className="egraph__cluster" data-entity-graph-cluster={cluster.label}>
                    <button
                      type="button"
                      className="egraph__cluster-head"
                      aria-expanded={!collapsed}
                      onClick={() => toggleCluster(cluster.label)}
                      data-entity-graph-cluster-toggle={cluster.label}
                    >
                      <span className="egraph__cluster-name">{cluster.label}</span>
                      <span className="muted">{cluster.items.length}</span>
                    </button>
                    {!collapsed && (
                      <ul className="egraph__cluster-list">
                        {cluster.items.map((item) => (
                          <li key={item.card.id}>
                            <button
                              type="button"
                              className="egraph__row"
                              onClick={() => {
                                setLevel('card')
                                setDepth(1)
                                setExpanded(item.card.id)
                                setCenterId(item.card.id)
                                persist({ level: 'card', groupKind: null })
                              }}
                              data-entity-graph-group-card={item.card.id}
                            >
                              <span className="egraph__row-name">{item.card.name}</span>
                              <span className="muted">
                                {item.direction === 'out' ? '→' : '←'} {item.other}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
              {clusters.isolated.length > 0 && (
                <li className="egraph__cluster" data-entity-graph-cluster="isolated">
                  <span className="egraph__cluster-head" data-entity-graph-cluster-isolated>
<span className="egraph__cluster-name">{t('graph.outsideLinks')}</span>
                    <span className="muted">{clusters.isolated.length}</span>
                  </span>
                  <ul className="egraph__cluster-list">
                    {clusters.isolated.map((card) => (
                      <li key={card.id}>
                        <button
                          type="button"
                          className="egraph__row"
                          onClick={() => {
                            setLevel('card')
                            setDepth(1)
                            setExpanded(card.id)
                            setCenterId(card.id)
                            persist({ level: 'card', groupKind: null })
                          }}
                          data-entity-graph-group-card={card.id}
                        >
                          <span className="egraph__row-name">{card.name}</span>
<span className="muted">{t('graph.linksNone')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
            {active.cards.length === 0 && (
              <p className="muted">
              {t('graph.emptyGroup')}
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  // Низкий экран: вместо графа — список соседей с подписями. Граф на 390 px с шестью узлами
  // читается, с двадцатью — нет, а список читается всегда.
  if (compact || layout.mode === 'rail') {
    const all = neighbors
    const windowNodes =
      layout.mode === 'rail'
        ? Array.from({ length: RAIL_WINDOW }, (_, i) => all[(windowStart + i) % all.length]).filter(Boolean)
        : all
    return (
      <div className="egraph" data-entity-graph={layout.mode}>
        <GraphHeader
          query={query}
          setQuery={setQuery}
          matches={matches}
          onPick={select}
          onBack={history.length > 0 ? back : null}
          crumbs={crumbsFor()}
        />
        <div className="egraph__center">{center.name}</div>
        <ul className="egraph__list" data-entity-graph-list>
          {windowNodes.map((neighbor) => (
            <li key={neighbor.linkId}>
              <button type="button" className="egraph__row" onClick={() => go(neighbor.id)}>
                <span className="muted">{edgeLabel(neighbor)}</span>
                <span className="egraph__row-name">{neighbor.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {layout.mode === 'rail' && all.length > RAIL_WINDOW && (
          <div className="egraph__rail-controls">
            <button
              type="button"
              className="secondary"
              onClick={() => setWindowStart((start) => (start - 1 + all.length) % all.length)}
              aria-label={t('graph.prevLinks')}
            >
              ↑
            </button>
            <span className="muted">
            {t('graph.railRange', { from: layout.windowStart + 1, to: layout.windowStart + Math.min(RAIL_WINDOW, all.length), total: all.length })}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => setWindowStart((start) => (start + 1) % all.length)}
              aria-label={t('graph.nextLinks')}
            >
              ↓
            </button>
          </div>
        )}
        {neighbors.length === 0 && (
          <p className="muted" data-entity-graph-lonely>
          {t('graph.noLinksHint')}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className={tall ? 'egraph egraph--tall' : 'egraph'} data-entity-graph="canvas">
      <GraphHeader
        query={query}
        setQuery={setQuery}
        matches={matches}
        onPick={select}
        onBack={history.length > 0 ? back : null}
        crumbs={crumbsFor()}
      />
      {/* Холст — «пространство»: у него свой фон с сеткой и звёздами (0.79.0). Сеть карточек
          читается как карта, а не как белое поле, и не сливается с полотном страницы. */}
      <div
        className={flying === null ? 'egraph__canvas' : 'egraph__canvas is-focusing'}
        ref={setHost}
        data-entity-graph-canvas
      >
        <div className="egraph__space" aria-hidden="true" />
        <svg className="egraph__edges" width="100%" height="100%" aria-hidden="true">
          {/* Наконечник стрелки (0.81.0): без него линия есть, а направления не видно — и связь
              читается как «просто линия», хотя подпись у неё направленная. `currentColor` —
              цвет темы: стрелки не должны выбиваться из палитры. */}
          <defs>
            <marker
              id="egraph-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>
          {/* Рёбра — ДВУМЯ половинами с разрывом под подписью (0.84.0). Подпись лежала поверх
              линии, и её «плашка» цветом фона на градиенте холста читалась как замазка, а длинная
              подпись — как обрубок связи. Теперь линия прерывается там, где стоит текст. */}
          {layout.edges.map((edge) => {
            const label = shortLabel(edgeLabel(edge))
            const pieces = edgePieces(edge, label.length)
            return (
              <g key={edge.linkId} data-entity-graph-edge={edge.linkId}>
                <line
                  {...pieces.before}
                  className="egraph__edge"
                  /* Направление: «→» — стрелка у соседа, «←» — у центра. Наконечник ставится на
                     тот конец, где связь заканчивается, поэтому у «входящей» он у центра. */
                  markerStart={edge.direction === 'in' ? 'url(#egraph-arrow)' : undefined}
                />
                <line
                  {...pieces.after}
                  className="egraph__edge"
                  markerEnd={edge.direction === 'out' ? 'url(#egraph-arrow)' : undefined}
                />
                <text
                  x={edge.labelAt.x}
                  y={edge.labelAt.y}
                  className="egraph__edge-label"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  /* Подпись на ребре — короткая: полный список связей показывает карточка.
                     Иначе длинная подпись вылезает за холст (замер: 366 px текста в холсте
                     292 px — обрезано с обеих сторон). */
                  data-entity-graph-edge-label
                >
                  {label}
                </text>
              </g>
            )
          })}
        </svg>
        <button
          type="button"
          className="egraph__node egraph__node--center"
          style={{ left: layout.center.x, top: layout.center.y }}
          data-entity-graph-center
          aria-expanded={expanded === center.id}
          title={expanded === center.id ? t('graph.centerCollapse', { name: center.name }) : t('graph.centerOpen', { name: center.name })}
          onClick={() => select(center.id)}
        >
          {center.name}
        </button>
        {layout.neighbors.map((positioned) => (
          <button
            key={positioned.node.id}
            type="button"
            className="egraph__node"
            style={{ left: positioned.x, top: positioned.y }}
            /* Нажатие на соседа — перелёт в центр с развёрнутой карточкой (0.84.0). */
            onClick={() => select(positioned.node.id)}
            aria-expanded={expanded === positioned.node.id}
            data-entity-graph-node={positioned.node.id}
            title={t('graph.nodeTitle', { name: positioned.node.name })}
          >
            {positioned.node.name}
          </button>
        ))}
        {/* Перелетающая «пилюля» (0.84.0): летит из места узла в центр холста, пока идёт
            переход. Ключ — id карточки, чтобы React не переиспользовал чужой узел. */}
        {flying !== null && (
          <div
            key={flying.id}
            className="egraph__fly"
            style={{ left: flying.from.x, top: flying.from.y }}
            data-entity-graph-fly
            aria-hidden="true"
          >
            {entities.find((entity) => entity.id === flying.id)?.name ?? ''}
          </div>
        )}
        {expandedCard !== null && (
          <NodeCard
            card={expandedCard}
            links={links}
            entities={entities}
            types={types}
            /* Карточка раскрыта В ЦЕНТРЕ холста (0.84.0): выбранная карточка туда же и перелетает,
               поэтому содержимое («что за карточка», алиасы, описание, связи) всегда на виду и не
               ложится поверх соседей. */
            width={size.width}
            onClose={() => setExpanded(null)}
          />
        )}
      </div>
      {neighbors.length === 0 && (
        <p className="muted" data-entity-graph-lonely>
          {t('graph.noLinksHint')}
        </p>
      )}
      {/* Карточки вне графа (0.81.0). Эго-граф показывает только соседей центра, поэтому
          добавленная карточка без связей в нём не появлялась — и выглядело так, будто область
          не обновилась после создания (отчёт). Теперь связи-сироты видны строкой, и по нажатию
          становятся центром: карточка не «пропадает», даже пока у неё нет ни одной связи. */}
      {isolated.length > 0 && (
        <div className="egraph__isolated" data-entity-graph-isolated>
<span className="muted">{t('graph.isolatedLine', { count: isolated.length })}</span>
          <ul className="egraph__isolated-list">
            {isolated.slice(0, 12).map((entity) => (
              <li key={entity.id}>
                <button
                  type="button"
                  className="egraph__isolated-chip"
                  onClick={() => select(entity.id)}
                  title={t('graph.makeCenter', { name: entity.name })}
                  data-entity-graph-isolated-item
                >
                  {entity.name}
                </button>
              </li>
            ))}
{isolated.length > 12 && <li className="muted">{t('graph.isolatedMore', { count: isolated.length - 12 })}</li>}
          </ul>
        </div>
      )}
      {/* «Глубже» (0.100.0): уровни окрестности, без верхней границы. Холст показывает только
          прямых соседей (кольцо из шести), а что за ними — видно здесь: уровень 2, 3 и дальше, пока
          обход не исчерпает проект. Кнопка «ещё уровень» показывается, только когда глубже
          действительно что-то есть (`truncated`), — иначе она выглядела бы сломанной. */}
      {(neighborhood.levels.length > 1 || neighborhood.truncated) && (
        <div className="egraph__levels" data-entity-graph-levels>
          {neighborhood.levels.slice(1).map((levelData) => (
            <div key={levelData.level} className="egraph__level" data-entity-graph-level={levelData.level}>
<span className="muted egraph__level-title">{t('graph.level', { level: levelData.level })}</span>
              {levelData.nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className="egraph__level-chip"
                  onClick={() => select(node.id)}
                  data-entity-graph-level-node={node.id}
                >
                  {node.name}
                </button>
              ))}
            </div>
          ))}
          <div className="egraph__level-controls">
            <button
              type="button"
              className="secondary"
              onClick={() => setDepth((current) => current + 1)}
              disabled={!neighborhood.truncated}
              data-entity-graph-deeper
            >
            {t('graph.moreLevel')}
            </button>
            {depth > 1 && (
              <button
                type="button"
                className="secondary"
                onClick={() => setDepth(1)}
                data-entity-graph-flatter
              >
              {t('graph.collapse')}
              </button>
            )}
            <span className="muted">
{neighborhood.total === 0 ? t('graph.neighborhoodNone') : t('graph.neighborhood', { count: neighborhood.total })}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Карточка узла: имя, вид, алиасы и ближайшие связи (0.78.0 → 0.79.0).
 *
 * Зачем: таблетка с именем отвечает только «как зовут». Чтобы понять, ТА ли это карточка и
 * куда ведут её связи, нужно раскрыть её — и это ожидаемое действие по нажатию на узел.
 * Раньше нажатие на соседа сразу делало его центром: переход без права посмотреть.
 *
 * 0.79.0: карточка раскрывалась РЯДОМ с узлом — полоса во всю ширину холста читалась как
 * подпись к графу, а не как карточка (отчёт: «лучше не подпись, а раскрывающаяся карточка»).
 *
 * 0.84.0: карточка раскрывается В ЦЕНТРЕ холста, а выбранная карточка туда перелетает (заказ:
 * «по выбору карточки — анимированный переход в центр с развёртыванием значений, так всегда
 * будет видно содержимое карточки»). Сбоку карточка ложилась поверх соседей и центра: на холсте
 * 300–400 px её приходилось читать «сквозь» граф.
 */
function NodeCard({
  card,
  links,
  entities,
  types,
  width,
  onClose,
}: {
  card: ProjectEntity
  links: EntityLink[]
  entities: ProjectEntity[]
  types: EntityType[]
  /** Ширина холста: на узком экране карточка не должна вылезать за него. */
  width: number
  onClose: () => void
}) {
  const t = useT()
  const connections = connectionsOf(card.id, links, entities)
  const shown = connections.slice(0, MAX_CARD_LINKS)
  const cardWidth = Math.max(220, Math.min(CARD_WIDTH, width - 16))
  return (
    <div
      className="egraph__card egraph__card--center"
      role="dialog"
      aria-label={t('graph.cardAria', { name: card.name })}
      data-entity-graph-card
      style={{ width: cardWidth }}
    >
      <div className="egraph__card-head">
        <span className="ent__kind">{typeTitle(types, card.kind)}</span>
        <strong className="egraph__card-name">{card.name}</strong>
        <button
          type="button"
          className="secondary egraph__card-close"
          onClick={onClose}
          aria-label={t('graph.closeCard')}
          data-entity-graph-card-close
        >
          ×
        </button>
      </div>
      <p className="egraph__card-aliases" data-entity-graph-card-aliases>
{card.aliases.length > 0 ? t('graph.aliases', { list: card.aliases.join(', ') }) : t('graph.noAliases')}
      </p>
      {card.description !== '' && <p className="egraph__card-desc">{card.description}</p>}
      <p className="muted egraph__card-sub">
        {connections.length === 0
? t('graph.linksNone')
: t('graph.linksTotal', { count: connections.length }) +
(connections.length > shown.length ? t('graph.linksShownSuffix', { count: shown.length }) : '')}
      </p>
      {shown.length > 0 && (
        <ul className="egraph__card-links" data-entity-graph-card-links>
          {shown.map((connection) => (
            <li key={connection.link.id}>
              <span className="muted">
                {connection.direction === 'out' ? '→' : '←'} {connection.link.label}
              </span>{' '}
              <span className="egraph__card-link-name">{connection.other.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Сколько связей показывать в карточке: остальное — по переходу в панель связей.
 *
 * 8, а не всё: карточка стоит в центре холста высотой 320–620 px, и список из двадцати связей
 * вытолкнул бы её за край. Остаток назван числом, полный список — в панели связей.
 */
const MAX_CARD_LINKS = 8

/** Ширина раскрывающейся карточки узла: 320 px — как у обычной карточки в интерфейсе. */
const CARD_WIDTH = 320

/**
 * Короткая подпись ребра: одна связь целиком, несколько — первая и «+N».
 *
 * Длина в знаках, а не в пикселях: подпись рисуется в SVG, где измерить текст до отрисовки
 * нельзя, а обрезка по знакам предсказуема и проверяется тестом. Полный список — в карточке.
 */
export function shortLabel(label: string): string {
  if (label.length <= EDGE_LABEL_CHARS) return label
  return `${label.slice(0, EDGE_LABEL_CHARS - 1).trimEnd()}…`
}

/** Предел подписи на ребре: при 12px шрифте это ~150 px, влезает в холст 248 px. */
const EDGE_LABEL_CHARS = 22

/** Поиск, крошки и «назад»: одинаковы во всех режимах, поэтому отдельным блоком. */
function GraphHeader({
  query,
  setQuery,
  matches,
  onPick,
  onBack,
  crumbs = null,
}: {
  query: string
  setQuery: (value: string) => void
  matches: EntitySearchHit[]
  onPick: (id: string) => void
  onBack: (() => void) | null
  /**
   * Крошки уровня (0.100.0): «Мир / Персонажи». Нужны затем, чтобы человек всегда видел, где он, и
   * мог подняться на уровень выше одним нажатием, а не искать кнопку «назад».
   */
  crumbs?: Array<{ label: string; onClick: (() => void) | null }> | null
}) {
  const t = useT()
  const first = matches[0]
  return (
    <div className="egraph__head">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('graph.searchPlaceholder')}
        aria-label={t('graph.searchAria')}
        className="ed-filter"
        data-entity-graph-search
        onKeyDown={(e) => {
          if (e.key === 'Enter' && first) {
            onPick(first.entity.id)
            setQuery('')
          }
        }}
      />
      {onBack && (
        <button type="button" className="secondary" onClick={onBack} data-entity-graph-back>
        {t('graph.back')}
        </button>
      )}
      {crumbs !== null && crumbs.length > 0 && (
        <nav className="egraph__crumbs" aria-label={t('graph.crumbsAria')} data-entity-graph-crumbs>
          {crumbs.map((crumb, index) => (
            <span key={crumb.label} className="egraph__crumb">
              {index > 0 && <span className="muted" aria-hidden="true"> / </span>}
              {crumb.onClick ? (
                <button type="button" className="egraph__crumb-link" onClick={crumb.onClick}>
                  {crumb.label}
                </button>
              ) : (
                <span aria-current="page">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      {matches.length > 0 && (
        <ul className="egraph__matches" data-entity-graph-matches>
          {matches.map((match) => (
            <li key={match.entity.id}>
              <button
                type="button"
                className="egraph__match"
                onClick={() => {
                  onPick(match.entity.id)
                  setQuery('')
                }}
                data-entity-graph-match={match.entity.id}
                data-entity-graph-match-source={match.source}
              >
                {/* Подсказка объясняет, ПОЧЕМУ карточка в выдаче: без этого «Аня» в ответ на «Анна»
                    выглядит случайной. Совпавший кусок подчёркнут. */}
                <span className="egraph__match-name">
                  {match.source === 'name' ? (
                    highlight(match.matched, match.at, match.length)
                  ) : (
                    match.entity.name
                  )}
                </span>
                <span className="muted egraph__match-why">
                  {match.source === 'name'
                    ? ''
                    : match.source === 'alias'
? t('graph.matchAlias', { value: match.matched })
                      : match.source === 'kind'
? t('graph.matchKind', { value: match.matched })
: t('graph.matchLink', { value: match.matched })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * «2 карточки» / «2 cards» (0.122.0): число и слово в нужной форме языка.
 *
 * Зачем не в шаблоне: словарь подставляет значения как есть и не умеет склонять. Отдать «1 links»
 * в английском — ошибка, которую видно на первом же скриншоте, а держать отдельный ключ на каждую
 * форму значило бы дублировать склонение в разметке.
 */
function withUnit(lang: Lang, prefix: string, count: number): string {
  return `${count} ${pluralWord(lang, prefix, count)}`
}

/** Подсветка совпавшего куска в подсказке: три части текста, средняя — `<mark>`. */
function highlight(text: string, at: number, length: number) {
  if (at < 0 || length <= 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + length)}</mark>
      {text.slice(at + length)}
    </>
  )
}
