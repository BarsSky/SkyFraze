import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EntityLink, ProjectEntity } from '../../api/entities'
import { connectionsOf, kindLabel } from '../../api/entities'
import {
  RAIL_WINDOW,
  edgeLabel,
  layoutEgoGraph,
  type GraphNeighbor,
} from '../../collab/graph'

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
}

const HISTORY_LIMIT = 10

export function EntityGraph({ entities, links, tall = false }: Props) {
  /** Откуда пришли: стек последних центров, «назад» снимает верхний. */
  const [history, setHistory] = useState<string[]>([])
  const [centerId, setCenterId] = useState<string | null>(null)
  /** Какая карточка раскрыта в окне графа: имя, вид, алиасы и ближайшие связи (0.78.0). */
  const [expanded, setExpanded] = useState<string | null>(null)
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

  /** Раскрытая карточка: ищем по id в актуальном списке — карточку могли переименовать. */
  const expandedCard = useMemo(
    () => entities.find((entity) => entity.id === expanded) ?? null,
    [entities, expanded],
  )

  // Escape закрывает карточку: это окно поверх графа, и клавиатурой его тоже надо закрывать.
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
   * Точка, у которой раскрывать карточку: центр холста для центральной карточки и место узла
   * для соседа. В режиме «рулетки» соседи стоят списком справа — карточка прижмётся к своему
   * узлу так же.
   */
  const anchorFor = useCallback(
    (id: string) => {
      if (layout.center.node.id === id) return { x: layout.center.x, y: layout.center.y }
      const neighbor = layout.neighbors.find((positioned) => positioned.node.id === id)
      return neighbor ? { x: neighbor.x, y: neighbor.y } : { x: size.width / 2, y: size.height / 2 }
    },
    [layout.center, layout.neighbors, size.height, size.width],
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

  const back = useCallback(() => {
    setHistory((prev) => {
      const last = prev[prev.length - 1]
      if (last === undefined) return prev
      setCenterId(last)
      setWindowStart(0)
      return prev.slice(0, -1)
    })
  }, [])

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return []
    return entities.filter((entity) => entity.name.toLowerCase().includes(text)).slice(0, 6)
  }, [entities, query])

  if (entities.length === 0) {
    return (
      <p className="muted ent__hint" data-entity-graph-empty>
        Граф появится, когда будут карточки: связи между ними — это и есть рёбра.
      </p>
    )
  }

  if (!center) return null

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
          onPick={go}
          onBack={history.length > 0 ? back : null}
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
              aria-label="Предыдущие связи"
            >
              ↑
            </button>
            <span className="muted">
              {layout.windowStart + 1}–{layout.windowStart + Math.min(RAIL_WINDOW, all.length)} из {all.length}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => setWindowStart((start) => (start + 1) % all.length)}
              aria-label="Следующие связи"
            >
              ↓
            </button>
          </div>
        )}
        {neighbors.length === 0 && (
          <p className="muted" data-entity-graph-lonely>
            У карточки пока нет связей. Их задают в карточке — «связана с».
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
        onPick={go}
        onBack={history.length > 0 ? back : null}
      />
      {/* Холст — «пространство»: у него свой фон с сеткой и звёздами (0.79.0). Сеть карточек
          читается как карта, а не как белое поле, и не сливается с полотном страницы. */}
      <div className="egraph__canvas" ref={setHost} data-entity-graph-canvas>
        <div className="egraph__space" aria-hidden="true" />
        <svg className="egraph__edges" width="100%" height="100%" aria-hidden="true">
          {layout.edges.map((edge) => (
            <g key={edge.linkId}>
              <line
                x1={edge.from.x}
                y1={edge.from.y}
                x2={edge.to.x}
                y2={edge.to.y}
                className="egraph__edge"
              />
              <text x={edge.labelAt.x} y={edge.labelAt.y} className="egraph__edge-label" textAnchor="middle">
                {/* Подпись на ребре — короткая: полный список связей показывает карточка.
                    Иначе длинная подпись вылезает за холст (замер: 366 px текста в холсте
                    292 px — обрезано с обеих сторон). */}
                {shortLabel(edgeLabel(edge))}
              </text>
            </g>
          ))}
        </svg>
        <button
          type="button"
          className="egraph__node egraph__node--center"
          style={{ left: layout.center.x, top: layout.center.y }}
          data-entity-graph-center
          aria-expanded={expanded === center.id}
          title={`${center.name} — открыть карточку`}
          onClick={() => setExpanded((current) => (current === center.id ? null : center.id))}
        >
          {center.name}
        </button>
        {layout.neighbors.map((positioned) => (
          <button
            key={positioned.node.id}
            type="button"
            className="egraph__node"
            style={{ left: positioned.x, top: positioned.y }}
            onClick={() => setExpanded((current) => (current === positioned.node.id ? null : positioned.node.id))}
            aria-expanded={expanded === positioned.node.id}
            data-entity-graph-node={positioned.node.id}
            title={`${positioned.node.name} — открыть карточку`}
          >
            {positioned.node.name}
          </button>
        ))}
        {expandedCard !== null && (
          <NodeCard
            card={expandedCard}
            links={links}
            entities={entities}
            /* Карточка раскрывается РЯДОМ с узлом, а не полосой внизу холста (0.79.0):
               полоса читалась как подпись к графу, а не как карточка. Позицию считаем по
               координатам узла и прижимаем к краям, чтобы карточка не уезжала за холст. */
            anchor={anchorFor(expandedCard.id)}
            canvasWidth={size.width}
            canvasHeight={size.height}
            isCenter={expandedCard.id === center.id}
            onCenter={() => {
              go(expandedCard.id)
              setExpanded(null)
            }}
            onClose={() => setExpanded(null)}
          />
        )}
      </div>
      {neighbors.length === 0 && (
        <p className="muted" data-entity-graph-lonely>
          У карточки пока нет связей. Их задают в карточке — «связана с».
        </p>
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
 * Теперь нажатие раскрывает карточку, а переход — отдельной кнопкой «Сделать центром».
 *
 * С 0.79.0 карточка раскрывается РЯДОМ с узлом: полоса во всю ширину холста читалась как
 * подпись к графу, а не как карточка (отчёт: «лучше не подпись, а раскрывающаяся карточка»).
 */
function NodeCard({
  card,
  links,
  entities,
  anchor,
  canvasWidth,
  canvasHeight,
  isCenter,
  onCenter,
  onClose,
}: {
  card: ProjectEntity
  links: EntityLink[]
  entities: ProjectEntity[]
  anchor: { x: number; y: number }
  canvasWidth: number
  canvasHeight: number
  isCenter: boolean
  onCenter: () => void
  onClose: () => void
}) {
  const connections = connectionsOf(card.id, links, entities)
  const shown = connections.slice(0, MAX_CARD_LINKS)
  // Карточка ставится справа от узла; если справа не хватает места — слева. По вертикали
  // центрируется на узле и прижимается к краям: узел у нижней кромки не должен тянуть карточку
  // за холст.
  const preferRight = anchor.x + CARD_WIDTH + 24 <= canvasWidth
  const left = preferRight
    ? Math.min(anchor.x + 22, Math.max(8, canvasWidth - CARD_WIDTH - 8))
    : Math.max(8, anchor.x - CARD_WIDTH - 22)
  const top = Math.min(Math.max(anchor.y, 60), Math.max(60, canvasHeight - 60))
  return (
    <div
      className="egraph__card"
      role="dialog"
      aria-label={`Карточка ${card.name}`}
      data-entity-graph-card
      style={{ left, top, width: CARD_WIDTH }}
    >
      <div className="egraph__card-head">
        <span className="ent__kind">{kindLabel(card.kind)}</span>
        <strong className="egraph__card-name">{card.name}</strong>
        <button
          type="button"
          className="secondary egraph__card-close"
          onClick={onClose}
          aria-label="Закрыть карточку"
          data-entity-graph-card-close
        >
          ×
        </button>
      </div>
      <p className="egraph__card-aliases" data-entity-graph-card-aliases>
        {card.aliases.length > 0 ? `также: ${card.aliases.join(', ')}` : 'алиасов нет'}
      </p>
      {card.description !== '' && <p className="egraph__card-desc">{card.description}</p>}
      <p className="muted egraph__card-sub">
        {connections.length === 0
          ? 'связей нет'
          : `связей: ${connections.length}${connections.length > shown.length ? ` (показаны ${shown.length})` : ''}`}
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
      {!isCenter && (
        <button type="button" className="secondary" onClick={onCenter} data-entity-graph-card-center>
          Сделать центром
        </button>
      )}
    </div>
  )
}

/** Сколько связей показывать в карточке: остальное — по переходу в панель связей. */
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

/** Поиск и «назад»: одинаковы в обоих режимах, поэтому отдельным блоком. */
function GraphHeader({
  query,
  setQuery,
  matches,
  onPick,
  onBack,
}: {
  query: string
  setQuery: (value: string) => void
  matches: ProjectEntity[]
  onPick: (id: string) => void
  onBack: (() => void) | null
}) {
  const first = matches[0]
  return (
    <div className="egraph__head">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Найти карточку…"
        aria-label="Поиск по карточкам в графе"
        className="ed-filter"
        data-entity-graph-search
        onKeyDown={(e) => {
          if (e.key === 'Enter' && first) {
            onPick(first.id)
            setQuery('')
          }
        }}
      />
      {onBack && (
        <button type="button" className="secondary" onClick={onBack} data-entity-graph-back>
          назад
        </button>
      )}
      {matches.length > 0 && (
        <ul className="egraph__matches" data-entity-graph-matches>
          {matches.map((match) => (
            <li key={match.id}>
              <button
                type="button"
                className="egraph__match"
                onClick={() => {
                  onPick(match.id)
                  setQuery('')
                }}
              >
                {match.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
