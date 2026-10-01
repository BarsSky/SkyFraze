import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { buildEventTree, DEFAULT_MAX_DEPTH, type EventLike, type EventTreeNode } from '../../collab/eventTree'
import { checkMove, type DropPlace, type MoveReject } from '../../collab/reorder'
import { editingPeers, typingLabel, type PeerState } from '../../collab/awareness'
import { titleString } from '../../collab/text'
import {
  previewMarkdownImport,
  readImportErrorMessage,
  type MarkdownImportPreview,
  type MarkdownImportResult,
  type MarkdownImportSource,
  type MarkdownInsertPlace,
} from '../../api/storyFiles'
import { DIRECTORY_PICK } from '../../lib/directoryPick'
import { plural } from '../../lib/format'
import {
  yAddEvent,
  yDeleteEvent,
  yEventParentId,
  yMoveSubtree,
  type YArray,
  type YMap,
} from '../../collab/yprovider'
import type { Asset } from '../../api/assets'
import { EventEditor } from './EventEditor'
import type { BackgroundValue } from './BackgroundPicker'

interface Props {
  events: YArray
  assets: Asset[]
  /** id ассета → blob-URL для превью (ассеты отдаются только с авторизацией). */
  assetUrls: Record<string, string>
  syncNote?: string | null
  /** Любая правка CRDT: страница проецирует дерево на сервер. */
  onChanged: () => void
  /** Загрузка файла: страница сохраняет ассет и возвращает его. */
  onUpload: (file: File) => Promise<Asset | null>
  /**
   * Импорт «в место»: вставить разобранный кусок md в этот проект. Возвращает
   * результат сервера (сколько событий и его предупреждения); саму вставку делает
   * страница — у неё есть id проекта и перечитывание состояния без realtime.
   * Без этого колбэка возможность импорта в панели не показывается.
   */
  onImportInto?: (source: MarkdownImportSource, place: MarkdownInsertPlace) => Promise<MarkdownImportResult>
  /**
   * Кто из соседей что правит (`collab.presence`, без меня). Отсюда — отметки у
   * строк списка: без них «кто где» видно только в баре над панелью, а он
   * остаётся наверху, когда правят поле в середине длинной формы.
   */
  presence?: PeerState[]
  /**
   * Сказать соседям, какое событие я правлю и печатаю ли
   * (`collab.setEditing`). Необязательно: панель работает и без realtime.
   */
  onEditing?: (eventId: string | null, typing?: boolean) => void
}

interface NavRow {
  id: string
  parentId: string | null
  /** Иерархический номер («01», «01.2») — тот же, что у кадра в таймлайне. */
  number: string
  depth: number
  title: string
  childCount: number
  isChapter: boolean
}

const SYNC_DEBOUNCE_MS = 900

/**
 * Тишина, после которой «печатает…» гаснет.
 *
 * Состояние уходит соседям по одному разу на серию нажатий: держать `typing`
 * вечно нельзя (человек отвлёкся — а у соседей он «печатает»), а слать кадр на
 * каждую букву незачем — `setEditing` с тем же значением ничего не рассылает, но
 * локальный вызов на каждый символ всё равно лишний.
 */
const TYPING_IDLE_MS = 1500

/** Совпадает с лимитом nginx (client_max_body_size) и бэкенда (assets.maxAssetSize). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** Сдвиг, после которого нажатие становится перетаскиванием, а не выбором. */
const DRAG_THRESHOLD_PX = 6

/**
 * Зоны сброса внутри строки:
 *  - правая часть (от 62% ширины) — «вложить внутрь»;
 *  - левая часть — «между»: верхняя половина строки — «перед», нижняя — «после».
 *
 * Поэтому «внутрь» не мешает попасть в зазор между соседями (там целятся по
 * вертикали), а вложить можно только осознанно — уведя палец/курсор вправо.
 */
const INSIDE_ZONE_RATIO = 0.62

/** Полоса у верхнего/нижнего края списка, в которой он сам подкручивается. */
const AUTOSCROLL_EDGE_PX = 44
const AUTOSCROLL_MAX_PX = 14

/** Почему сюда нельзя — человеческий текст для подсказки под деревом. */
const REJECT_TEXT: Record<MoveReject, string> = {
  'unknown-source': 'перетаскиваемое событие не найдено',
  'unknown-target': 'цель переноса не найдена',
  self: 'событие нельзя вложить в само себя',
  cycle: 'нельзя вложить событие в собственное поддерево',
  depth: `глубже ${DEFAULT_MAX_DEPTH} уровней дерево не поддерживает`,
}

/** Что означает разрешённая цель — текст для строки-подсказки. */
const DROP_TEXT: Record<DropPlace, string> = {
  before: 'вставить перед строкой',
  after: 'вставить после строки',
  inside: 'вложить внутрь',
}

/** Куда положить кусок, если место выбирают не перетаскиванием, а списком. */
type ChunkMode = 'end' | 'before' | 'after' | 'inside'

const CHUNK_MODE_TEXT: Record<ChunkMode, string> = {
  end: 'в конец проекта',
  before: 'перед выбранным событием',
  after: 'после выбранного события',
  inside: 'внутрь выбранного события',
}

/**
 * Разобранный кусок md, ожидающий места: файлы на сервере уже разобраны
 * (`preview` ничего не пишет), и человек видит, что именно вставится.
 */
interface ImportChunk {
  source: MarkdownImportSource
  /** Что выбрал человек: «папка «Глава 02», 6 файлов» или «архив «часть.zip»». */
  label: string
  events: number
  /** Самая глубокая вложенность в куске: по ней считаем, влезет ли он в место. */
  maxDepth: number
}

/** Куда указывает текущий жест: строка-цель и место в ней. */
interface DropHint {
  targetId: string | null
  place: DropPlace
  allowed: boolean
  /** Текст причины, когда `allowed === false`. */
  reason: string | null
}

/** Что рисуем, пока тащим: подпись под указателем и подсветка цели. */
interface DragView {
  /** Что тащим: строка дерева или разобранный кусок md (тексты подсказок разные). */
  kind: 'row' | 'chunk'
  id: string
  x: number
  y: number
  label: string
  hint: DropHint | null
}

interface GestureHandlers {
  move: (event: PointerEvent) => void
  up: (event: PointerEvent) => void
  cancel: (event: PointerEvent) => void
  key: (event: KeyboardEvent) => void
  blur: () => void
}

/**
 * Жест живёт отдельно от состояния: pointermove приходит десятками в секунду, и
 * ждать рендера на каждое движение нельзя. В состоянии — только то, что видно
 * человеку: подпись под указателем и подсветка цели сброса.
 */
interface DragGesture {
  /** Что тащим: строку дерева (перенос) или разобранный кусок md (импорт). */
  kind: 'row' | 'chunk'
  id: string
  label: string
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  /** Палец/стилус: вертикальный жест без захвата за ручку отдаём прокрутке. */
  touch: boolean
  fromGrip: boolean
  /** 'wait' — ещё решаем, что это; 'drag' — тащим; 'scroll' — это прокрутка. */
  mode: 'wait' | 'drag' | 'scroll'
  hint: DropHint | null
  handlers: GestureHandlers
}

/** Прямые дети строки в порядке отображения (для клавиатурных переносов). */
function siblingsOf(rows: NavRow[], row: NavRow): NavRow[] {
  return rows.filter((item) => item.parentId === row.parentId)
}

/**
 * Последний потомок строки в порядке отображения (или null, если детей нет).
 *
 * Нужен для «вложить внутрь»: кусок должен встать последним ребёнком, то есть
 * после всего поддерева цели. Порядок отображения — обход дерева, поэтому
 * достаточно найти последнюю строку, у которой цель есть среди предков.
 */
function lastDescendant(rows: NavRow[], id: string): string | null {
  const byId = new Map(rows.map((row) => [row.id, row]))
  let last: string | null = null
  for (const row of rows) {
    let cursor = row.parentId
    while (cursor) {
      if (cursor === id) {
        last = row.id
        break
      }
      cursor = byId.get(cursor)?.parentId ?? null
    }
  }
  return last
}

/** Классы подсветки цели: линия «между» строками или рамка «внутрь». */
function dropClassFor(hint: DropHint): string {
  const base = `ed-row--drop-${hint.place}`
  return hint.allowed ? base : `${base} is-blocked`
}

/**
 * Модуль редактирования: навигатор по дереву, тулбар создания/удаления и
 * редактор выбранного события (текст, дата, вложения, фон кадра).
 *
 * Единственное место, где проект меняется: стадия (components/timeline)
 * намеренно только показывает и не переключает редактор.
 *
 * Перестановка событий — pointer-событиями, а не HTML5 drag-and-drop: на
 * тач-устройствах он не работает. Тянем строку мышью или пальцем; обычный клик
 * без сдвига продолжает выбирать событие, а перенос одной транзакцией делает
 * `yMoveSubtree` (порядок в Y.Array + `parent_id`).
 */
export function EditorsPanel({
  events, assets, assetUrls, syncNote, onChanged, onUpload, onImportInto, presence, onEditing,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [version, setVersion] = useState(0) // перерисовка после правок CRDT
  const [uploadNote, setUploadNote] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragView | null>(null)
  /** Подсказка для клавиатурных переносов: что не получилось и почему. */
  const [notice, setNotice] = useState<string | null>(null)
  /** Разобранный кусок md: пока он есть, его можно перетащить на дерево. */
  const [chunk, setChunk] = useState<ImportChunk | null>(null)
  const [chunkMode, setChunkMode] = useState<ChunkMode>('end')
  const [importBusy, setImportBusy] = useState(false)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navRef = useRef<HTMLElement | null>(null)
  const gestureRef = useRef<DragGesture | null>(null)
  const rowsRef = useRef<NavRow[]>([])
  const autoscrollRef = useRef<number | null>(null)
  /** Клик после настоящего перетаскивания не должен менять выбор. */
  const suppressClickRef = useRef(false)
  /** Событие, о котором я уже сообщил соседям как «правлю». */
  const editingIdRef = useRef<string | null>(null)
  /** Идёт ли сейчас серия нажатий: `true` уходит соседям один раз на серию. */
  const typingRef = useRef(false)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Свежий `onEditing` для таймеров. Через ref, а не через замыкание: таймер
   * «тишины» живёт дольше рендера, и устаревшая ссылка отправила бы состояние в
   * уже размонтированную страницу.
   */
  const onEditingRef = useRef(onEditing)

  useEffect(() => {
    onEditingRef.current = onEditing
  }, [onEditing])

  // Подписка на CRDT: заголовки/дерево в навигаторе и полях должны обновляться.
  useEffect(() => {
    if (!events) return
    const update = () => setVersion((v) => v + 1)
    events.observeDeep(update)
    return () => events.unobserveDeep(update)
  }, [events])

  /** Отложенная проекция на сервер: не отправляем PUT на каждое нажатие. */
  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null
      onChanged()
    }, SYNC_DEBOUNCE_MS)
  }, [onChanged])

  // ─── присутствие: что я правлю и печатаю ли ───────────────────────────────
  //
  // Соседи видят это в баре и отметками у строк. Состояние эфемерно и рассылается
  // только на переходах: «открыл событие» → «печатаю» → «замолчал» → «закрыл».

  /** Снять таймер тишины (смена события и уход со страницы его отменяют). */
  const stopTyping = useCallback(() => {
    if (typingTimer.current) {
      clearTimeout(typingTimer.current)
      typingTimer.current = null
    }
  }, [])

  // Открытие и смена события: правлю это, но ещё не печатаю. Смена формы гасит
  // незакрытую серию нажатий — иначе «печатает…» осталось бы у прошлого события.
  useEffect(() => {
    editingIdRef.current = selectedId
    typingRef.current = false
    stopTyping()
    onEditingRef.current?.(selectedId, false)
  }, [selectedId, stopTyping])

  // Размонтирование (уход со страницы, смена проекта): без этого соседи держали
  // бы меня «правящим» до таймаута призрака.
  useEffect(() => () => {
    stopTyping()
    onEditingRef.current?.(null, false)
  }, [stopTyping])

  /**
   * Ввод в заголовок или текст. Соседям уходит ровно одно `true` на серию
   * нажатий и одно `false` через `TYPING_IDLE_MS` тишины.
   */
  const markTyping = useCallback(() => {
    const eventId = editingIdRef.current
    if (!eventId) return
    if (!typingRef.current) {
      typingRef.current = true
      onEditingRef.current?.(eventId, true)
    }
    stopTyping()
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null
      typingRef.current = false
      onEditingRef.current?.(editingIdRef.current, false)
    }, TYPING_IDLE_MS)
  }, [stopTyping])

  const rows = useMemo<NavRow[]>(() => {
    void version
    if (!events) return []
    const flat: Array<EventLike & { title: string }> = (events.toArray() as YMap[]).map((m) => ({
      id: (m.get('id') as string | undefined) ?? '',
      parentId: yEventParentId(m),
      title: titleString(m),
    })).filter((e) => e.id.length > 0)

    // Номер считаем обходом дерева: «01», «01.2», «01.2.1» — как в кадрах
    // таймлайна, чтобы в подписи переноса число совпадало с видимым номером.
    const out: NavRow[] = []
    const walk = (node: EventTreeNode<(typeof flat)[number]>, number: string, parentId: string | null) => {
      out.push({
        id: node.item.id,
        parentId,
        number,
        depth: node.depth,
        title: node.item.title || 'Без названия',
        childCount: node.children.length,
        isChapter: node.depth === 0,
      })
      node.children.forEach((child, index) => walk(child, `${number}.${index + 1}`, node.item.id))
    }
    buildEventTree(flat, DEFAULT_MAX_DEPTH).forEach((root, index) => {
      walk(root, String(index + 1).padStart(2, '0'), null)
    })
    return out
  }, [events, version])

  // Обработчики жеста читают строки из ref: за время перетаскивания дерево
  // может приехать от соавтора, и проверять ход надо по свежему состоянию.
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  // Первое событие выбирается автоматически; дальше выбор только ручной —
  // создание события не уводит ни редактор, ни стадию.
  useEffect(() => {
    if (!selectedId && rows.length > 0) setSelectedId(rows[0].id)
  }, [rows, selectedId])

  const selectedMap = useMemo<YMap | null>(() => {
    void version
    if (!events || !selectedId) return null
    return (events.toArray() as YMap[]).find((m) => (m.get('id') as string) === selectedId) ?? null
  }, [events, selectedId, version])

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.title.toLowerCase().includes(q))
  }, [rows, filter])

  const selectedRow = rows.find((r) => r.id === selectedId)
  const attachedIds = ((selectedMap?.get('assets') as string[] | undefined) ?? []).filter(Boolean)
  const images = assets.filter((a) => attachedIds.includes(a.id) && a.mime.startsWith('image/'))

  // ─── импорт куска md «в место» ────────────────────────────────────────────
  //
  // Разбор делает сервер и НИЧЕГО не пишет: пока человек не отпустит кусок над
  // деревом (или не выберет место списком), в проекте ничего не меняется. Так
  // видно, что именно вставится, — и правила разбора можно проверить до записи.

  /** Разбирает выбранные файлы: то же окно предпросмотра, что у импорта проекта. */
  async function loadChunk(source: MarkdownImportSource, label: string) {
    setImportBusy(true)
    setNotice(null)
    setChunk(null)
    try {
      const preview: MarkdownImportPreview = await previewMarkdownImport(source)
      if (preview.events.length === 0) {
        setNotice('В выбранных файлах не нашлось событий — вставлять нечего')
        return
      }
      setChunk({
        source,
        label,
        events: preview.events.length,
        maxDepth: preview.events.reduce((max, event) => Math.max(max, event.depth), 0),
      })
      setChunkMode('end')
      setNotice(`Кусок разобран: ${preview.events.length} ${plural(preview.events.length, 'событие', 'события', 'событий')} — перетащите его на дерево`)
    } catch (e) {
      const message = await readImportErrorMessage(e)
      setNotice(message ?? 'Не удалось разобрать файлы — сервер отклонил запрос')
    } finally {
      setImportBusy(false)
    }
  }

  function onPickChunkFolder(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    // Значение поля сбрасываем: иначе повторный выбор той же папки не вызовет change.
    e.target.value = ''
    if (files.length === 0) return
    const root = files[0].webkitRelativePath.split('/')[0]
    const count = `${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}`
    void loadChunk(files, root && root !== files[0].name ? `папка «${root}», ${count}` : count)
  }

  function onPickChunkZip(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void loadChunk({ archive: file }, `архив «${file.name}»`)
  }

  /**
   * Проверка «влезет ли кусок сюда» и текст причины.
   *
   * Единственное ограничение — глубина: перенос строки не может сделать дерево
   * глубже `DEFAULT_MAX_DEPTH`, и импорт куска тоже (сервер отверг бы проекцию).
   * Циклов и «сам в себя» здесь быть не может: кусок — новые события.
   */
  function chunkHint(row: NavRow, place: DropPlace): DropHint {
    const deepest = (place === 'inside' ? row.depth + 1 : row.depth) + (chunk?.maxDepth ?? 0)
    if (deepest > DEFAULT_MAX_DEPTH) {
      return {
        targetId: row.id,
        place,
        allowed: false,
        reason: `в куске ${(chunk?.maxDepth ?? 0) + 1} уровень(ей), а глубже ${DEFAULT_MAX_DEPTH} дерево не поддерживает`,
      }
    }
    return { targetId: row.id, place, allowed: true, reason: null }
  }

  /** Место вставки для сброса: «после строки» — после неё вместе с её поддеревом. */
  function chunkPlace(hint: DropHint): MarkdownInsertPlace {
    if (hint.targetId === null) return {} // пусто под списком — в конец верхнего уровня
    const row = rowsRef.current.find((item) => item.id === hint.targetId)
    if (!row) return {}
    if (hint.place === 'before') return { parentId: row.parentId, beforeId: row.id }
    if (hint.place === 'after') return { parentId: row.parentId, afterId: row.id }
    // «Внутрь» — последним ребёнком: после последнего потомка, иначе после самой строки.
    return { parentId: row.id, afterId: lastDescendant(rowsRef.current, row.id) ?? row.id }
  }

  /**
   * Вставка куска. Ошибку показываем словами сервера: 400 у него содержательный
   * («не помещается в выбранное место»), а 503 значит «повторите» — кусок при
   * этом остаётся в панели, и повтор не требует выбирать файлы заново.
   */
  async function insertChunk(place: MarkdownInsertPlace) {
    if (!chunk || !onImportInto || importBusy) return
    setImportBusy(true)
    try {
      const result = await onImportInto(chunk.source, place)
      setChunk(null)
      // Предупреждение сервера (вставка сделана, но снапшот или таблица событий
      // отстали) — не ошибка: повторять импорт нельзя, он бы задвоил кусок.
      const warning = result.warnings[0]
      setNotice(
        warning
          ? `Вставлено событий: ${result.events}. ${warning}`
          : `Вставлено событий: ${result.events}`,
      )
    } catch (e) {
      const message = await readImportErrorMessage(e)
      setNotice(message ?? 'Вставить не удалось — сервер отклонил запрос')
    } finally {
      setImportBusy(false)
    }
  }

  /** Вставка без перетаскивания: место выбирают списком (клавиатура, тач). */
  function insertChunkByMode() {
    if (!chunk) return
    if (chunkMode === 'end') {
      void insertChunk({})
      return
    }
    const row = rows.find((item) => item.id === selectedId)
    if (!row) {
      setNotice('Сначала выберите событие в списке')
      return
    }
    const hint = chunkHint(row, chunkMode)
    if (!hint.allowed) {
      setNotice(`Сюда нельзя: ${hint.reason}`)
      return
    }
    void insertChunk(chunkPlace(hint))
  }

  const background = useMemo<BackgroundValue>(() => {
    const kind = selectedMap?.get('bg_kind')
    const tone = selectedMap?.get('bg_tone')
    const assetId = selectedMap?.get('bg_asset')
    return {
      kind: kind === 'tone' || kind === 'asset' ? kind : 'inherit',
      tone: typeof tone === 'string' ? tone : undefined,
      assetId: typeof assetId === 'string' ? assetId : undefined,
    }
  }, [selectedMap, version])

  function createChapter() {
    if (!events) return
    const map = yAddEvent(events, 'Новая глава', '')
    setSelectedId(map.get('id') as string)
    setFilter('')
    onChanged()
  }

  function createChild() {
    if (!events || !selectedId) return
    // Под-событие создаётся у выбранного события (главы или другого под-события).
    const map = yAddEvent(events, 'Новое подсобытие', '', { parentId: selectedId })
    setSelectedId(map.get('id') as string)
    onChanged()
  }

  function removeSelected() {
    if (!events || !selectedMap || !selectedId) return
    const arr = events.toArray() as YMap[]
    const descendants = countDescendants(arr, selectedId)
    const title = titleString(selectedMap) || '(без названия)'
    const warn = descendants > 0
      ? `Удалить «${title}» вместе с ${descendants} вложенным(и) событием(ями)?`
      : `Удалить «${title}»?`
    if (!window.confirm(warn)) return
    yDeleteEvent(events, selectedId)
    const nextRow = rows.find((r) => r.id !== selectedId)
    setSelectedId(nextRow?.id ?? null)
    onChanged()
  }

  function uploadAndAttach(file: File) {
    setUploadNote(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadNote(`Файл больше ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ — сервер его не примет.`)
      return
    }
    const targetId = selectedId
    void (async () => {
      const asset = await onUpload(file)
      if (!asset) {
        setUploadNote('Не удалось загрузить файл (сервер отклонил запрос).')
        return
      }
      // Прикрепляем к тому событию, для которого выбирали файл: за время
      // загрузки пользователь мог переключиться в навигаторе.
      const target = (events?.toArray() as YMap[] | undefined)?.find(
        (m) => (m.get('id') as string) === targetId,
      )
      const map = target ?? selectedMap
      if (!map) return
      const list = ((map.get('assets') as string[] | undefined) ?? []).filter(Boolean)
      map.set('assets', [...list, asset.id])
      // Первая картинка сразу становится фоном кадра — обычно это и нужно.
      if (asset.mime.startsWith('image/') && map.get('bg_kind') !== 'asset') {
        map.set('bg_kind', 'asset')
        map.set('bg_asset', asset.id)
      }
      setUploadNote(`Загружено: ${asset.filename}`)
      setVersion((v) => v + 1)
    })()
  }

  function attach(assetId: string) {
    if (!selectedMap) return
    const list = ((selectedMap.get('assets') as string[] | undefined) ?? []).filter(Boolean)
    if (list.includes(assetId)) return
    selectedMap.set('assets', [...list, assetId])
    setVersion((v) => v + 1)
  }

  function detach(assetId: string) {
    if (!selectedMap) return
    const list = ((selectedMap.get('assets') as string[] | undefined) ?? []).filter((id) => id !== assetId)
    selectedMap.set('assets', list)
    if (selectedMap.get('bg_asset') === assetId) selectedMap.delete('bg_asset')
    setVersion((v) => v + 1)
  }

  function changeBackground(value: BackgroundValue) {
    if (!selectedMap) return
    selectedMap.set('bg_kind', value.kind)
    if (value.tone) selectedMap.set('bg_tone', value.tone)
    else selectedMap.delete('bg_tone')
    if (value.assetId) selectedMap.set('bg_asset', value.assetId)
    else selectedMap.delete('bg_asset')
    setVersion((v) => v + 1)
  }

  // ─── перетаскивание строк ────────────────────────────────────────────────

  /** Проверка «можно ли сюда» и текст причины — тот же расчёт, что у переноса. */
  function dropHint(dragId: string, targetId: string | null, place: DropPlace): DropHint {
    const items = rowsRef.current.map((row) => ({ id: row.id, parentId: row.parentId }))
    const check = checkMove(items, dragId, targetId, place)
    return {
      targetId,
      place,
      allowed: check.ok,
      reason: check.ok ? null : REJECT_TEXT[check.reason],
    }
  }

  /** Строка, по которой считаем зону сброса: правая часть — «внутрь». */
  function hintFromRow(el: HTMLElement, gesture: DragGesture): DropHint {
    const rect = el.getBoundingClientRect()
    const ratio = rect.width > 0 ? (gesture.x - rect.left) / rect.width : 0.5
    const half = rect.height > 0 ? (gesture.y - rect.top) / rect.height : 0.5
    const place: DropPlace = ratio >= INSIDE_ZONE_RATIO ? 'inside' : half < 0.5 ? 'before' : 'after'
    const targetId = el.dataset.eventId ?? ''
    // Кусок md — не строка дерева: проверяем только глубину, а не цикл с самим собой.
    if (gesture.kind === 'chunk') {
      const row = rowsRef.current.find((item) => item.id === targetId)
      return row ? chunkHint(row, place) : { targetId: null, place: 'inside', allowed: true, reason: null }
    }
    if (targetId === gesture.id) return hintOnSelf(gesture, place)
    return dropHint(gesture.id, targetId || null, place)
  }

  /**
   * Указатель на самой переносимой строке.
   *
   * «Внутрь себя» действительно нельзя — об этом честно сообщаем. А вот линии
   * «перед собой» и «после себя» ничего не меняют: человек, который потянул
   * строку на пару пикселей и отпустил, раньше видел «нельзя вложить в само
   * себя» — то есть ошибка появлялась там, где переносить и не собирались.
   * Теперь такие зоны нейтральны: подсветки нет, дерево не меняется, ошибки нет.
   */
  function hintOnSelf(gesture: DragGesture, place: DropPlace): DropHint {
    if (place === 'inside') return dropHint(gesture.id, gesture.id, 'inside')
    return { targetId: null, place: 'inside', allowed: false, reason: null }
  }

  /** Ближайшая строка под указателем (событие могло прийти от дочернего span). */
  function rowElement(target: EventTarget | null): HTMLElement | null {
    const el = target as HTMLElement | null
    if (!el || typeof el.closest !== 'function') return null
    return el.closest('.ed-row') as HTMLElement | null
  }

  /**
   * Цель сброса по координатам — нужна, когда события указателя нет: список
   * подкрутился сам, и строка под пальцем сменилась. Пусто под последней строкой
   * (но внутри списка) — это «в конец верхнего уровня».
   */
  function hintAtPoint(gesture: DragGesture): DropHint | null {
    const nav = navRef.current
    if (!nav) return null
    const rect = nav.getBoundingClientRect()
    if (gesture.x < rect.left || gesture.x > rect.right) return null
    if (gesture.y < rect.top || gesture.y > rect.bottom) return null
    try {
      if (typeof document.elementFromPoint === 'function') {
        const el = rowElement(document.elementFromPoint(gesture.x, gesture.y))
        if (el) return hintFromRow(el, gesture)
      }
    } catch {
      /* jsdom и старые браузеры: просто покажем «в конец верхнего уровня» */
    }
    // Пусто под последней строкой: у строки это «в конец верхнего уровня», у куска —
    // «в конец проекта» (то же место, но без проверок переноса).
    if (gesture.kind === 'chunk') return { targetId: null, place: 'inside', allowed: true, reason: null }
    return dropHint(gesture.id, null, 'inside')
  }

  function stopAutoscroll() {
    if (autoscrollRef.current !== null) {
      cancelAnimationFrame(autoscrollRef.current)
      autoscrollRef.current = null
    }
  }

  /** Длинное дерево иначе не перетащить: у края списка он едет сам. */
  function startAutoscroll() {
    if (autoscrollRef.current !== null) return
    const step = () => {
      autoscrollRef.current = null
      const gesture = gestureRef.current
      if (!gesture || gesture.mode !== 'drag') return
      const nav = navRef.current
      if (nav) {
        const rect = nav.getBoundingClientRect()
        const fromTop = gesture.y - rect.top
        const fromBottom = rect.bottom - gesture.y
        let dy = 0
        if (fromTop < AUTOSCROLL_EDGE_PX) {
          dy = -Math.ceil(AUTOSCROLL_MAX_PX * (1 - Math.max(0, fromTop) / AUTOSCROLL_EDGE_PX))
        } else if (fromBottom < AUTOSCROLL_EDGE_PX) {
          dy = Math.ceil(AUTOSCROLL_MAX_PX * (1 - Math.max(0, fromBottom) / AUTOSCROLL_EDGE_PX))
        }
        if (dy !== 0) {
          const before = nav.scrollTop
          nav.scrollTop = before + dy
          if (nav.scrollTop !== before) {
            gesture.hint = hintAtPoint(gesture) ?? gesture.hint
            publish(gesture)
          }
        }
      }
      autoscrollRef.current = requestAnimationFrame(step)
    }
    autoscrollRef.current = requestAnimationFrame(step)
  }

  function publish(gesture: DragGesture) {
    setDrag({
      kind: gesture.kind,
      id: gesture.id,
      x: gesture.x,
      y: gesture.y,
      label: gesture.label,
      hint: gesture.hint,
    })
  }

  function detachGesture(gesture: DragGesture) {
    window.removeEventListener('pointermove', gesture.handlers.move)
    window.removeEventListener('pointerup', gesture.handlers.up)
    window.removeEventListener('pointercancel', gesture.handlers.cancel)
    window.removeEventListener('keydown', gesture.handlers.key, true)
    window.removeEventListener('blur', gesture.handlers.blur)
    stopAutoscroll()
  }

  /**
   * Завершает жест. `commit` — обычное отпускание; Esc и потеря фокуса
   * отменяют перенос, ничего не меняя в дереве.
   */
  function finishGesture(commit: boolean) {
    const gesture = gestureRef.current
    if (!gesture) return
    gestureRef.current = null
    detachGesture(gesture)
    setDrag(null)

    const moved = gesture.mode === 'drag'
    // Перенос закончился не там, где начался: клик по строке под указателем
    // уже не должен перебивать выбор.
    if (moved) suppressClickRef.current = true
    const hint = gesture.hint
    if (!commit || !moved) return

    if (gesture.kind === 'chunk') {
      // Кусок md вставляется на сервере: он один держит документ проекта.
      if (!hint) return
      if (!hint.allowed) {
        // Отказ не должен исчезать вместе с подсветкой: иначе кусок «просто не
        // вставился» без объяснения.
        setNotice(`Сюда нельзя: ${hint.reason ?? 'непонятная цель сброса'}`)
        return
      }
      void insertChunk(chunkPlace(hint))
      return
    }

    if (!hint || !hint.allowed) return

    if (yMoveSubtree(events, gesture.id, hint.targetId, hint.place)) {
      setSelectedId(gesture.id) // после переноса событие остаётся выбранным
      setNotice(`«${gesture.label}» перенесено`)
      onChanged()
    } else {
      setNotice('Перенести не удалось: дерево изменилось')
    }
  }

  function onPointerMove(event: PointerEvent, gesture: DragGesture) {
    if (event.pointerId !== gesture.pointerId) return
    gesture.x = event.clientX
    gesture.y = event.clientY
    if (gesture.mode === 'scroll') return

    if (gesture.mode === 'wait') {
      const dx = gesture.x - gesture.startX
      const dy = gesture.y - gesture.startY
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      // Палец без захвата за ручку и явно вертикальный жест — это прокрутка
      // списка, а не перенос: иначе длинное дерево не пролистать.
      if (gesture.touch && !gesture.fromGrip && Math.abs(dy) > Math.abs(dx)) {
        gesture.mode = 'scroll'
        return
      }
      gesture.mode = 'drag'
      startAutoscroll()
    }

    const el = rowElement(event.target)
    gesture.hint = el ? hintFromRow(el, gesture) : hintAtPoint(gesture)
    publish(gesture)
  }

  function onRowPointerDown(event: React.PointerEvent<HTMLButtonElement>, row: NavRow) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // Тащить нечего: одна строка всегда остаётся на месте.
    if (rows.length < 2) return
    const active = gestureRef.current
    if (active) {
      // Второй палец: жестов одновременно не бывает, прежний отменяем.
      if (active.pointerId === event.pointerId) return
      finishGesture(false)
    }
    // Новый жест начинается с нажатия: флаг «клик после переноса» сбрасываем,
    // иначе он съел бы первое нажатие после перетаскивания, за которым клик
    // так и не пришёл.
    suppressClickRef.current = false
    setNotice(null)
    const target = event.target as HTMLElement | null
    const fromGrip = !!(target && typeof target.closest === 'function' && target.closest('.ed-row__grip'))

    let gesture: DragGesture
    const handlers: GestureHandlers = {
      move: (e) => onPointerMove(e, gesture),
      up: (e) => {
        if (e.pointerId === gesture.pointerId) finishGesture(true)
      },
      cancel: (e) => {
        if (e.pointerId === gesture.pointerId) finishGesture(false)
      },
      key: (e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        finishGesture(false)
      },
      blur: () => finishGesture(false),
    }
    gesture = {
      kind: 'row',
      id: row.id,
      label: `${row.number} · ${row.title}`,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      touch: event.pointerType === 'touch' || event.pointerType === 'pen',
      fromGrip,
      mode: 'wait',
      hint: null,
      handlers,
    }
    gestureRef.current = gesture
    window.addEventListener('pointermove', handlers.move)
    window.addEventListener('pointerup', handlers.up)
    window.addEventListener('pointercancel', handlers.cancel)
    window.addEventListener('keydown', handlers.key, true)
    window.addEventListener('blur', handlers.blur)
  }

  /**
   * Начало перетаскивания КУСКА md: та же механика, что у строк, но источник —
   * не событие дерева, а разобранные файлы. Отдельный вход, потому что у куска
   * нет ни id события, ни места в дереве, пока его не отпустили.
   */
  function onChunkPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (!chunk || importBusy) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const active = gestureRef.current
    if (active) {
      if (active.pointerId === event.pointerId) return
      finishGesture(false)
    }
    suppressClickRef.current = false
    setNotice(null)

    let gesture: DragGesture
    const handlers: GestureHandlers = {
      move: (e) => onPointerMove(e, gesture),
      up: (e) => {
        if (e.pointerId === gesture.pointerId) finishGesture(true)
      },
      cancel: (e) => {
        if (e.pointerId === gesture.pointerId) finishGesture(false)
      },
      key: (e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        finishGesture(false)
      },
      blur: () => finishGesture(false),
    }
    gesture = {
      kind: 'chunk',
      id: '',
      label: `кусок: ${chunk.events} ${plural(chunk.events, 'событие', 'события', 'событий')}`,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      touch: event.pointerType === 'touch' || event.pointerType === 'pen',
      // Захвата за ручку у куска нет: на тач-устройствах вертикальный жест —
      // это прокрутка списка, а не перенос (как у строк без ручки).
      fromGrip: false,
      mode: 'wait',
      hint: null,
      handlers,
    }
    gestureRef.current = gesture
    window.addEventListener('pointermove', handlers.move)
    window.addEventListener('pointerup', handlers.up)
    window.addEventListener('pointercancel', handlers.cancel)
    window.addEventListener('keydown', handlers.key, true)
    window.addEventListener('blur', handlers.blur)
  }

  /** Клавиатура: та же арифметика, что у мыши, но без координат. */
  function moveByKeyboard(row: NavRow, dir: 'up' | 'down' | 'in' | 'out') {
    const siblings = siblingsOf(rows, row)
    const at = siblings.findIndex((item) => item.id === row.id)
    let targetId: string | null = null
    let place: DropPlace = 'after'

    if (dir === 'up') {
      const prev = siblings[at - 1]
      if (!prev) return setNotice('Выше соседей нет — переносить некуда')
      targetId = prev.id
      place = 'before'
    } else if (dir === 'down') {
      const next = siblings[at + 1]
      if (!next) return setNotice('Ниже соседей нет — переносить некуда')
      targetId = next.id
      place = 'after'
    } else if (dir === 'in') {
      const prev = siblings[at - 1]
      if (!prev) return setNotice('Вложить не во что: выше нет соседа')
      targetId = prev.id
      place = 'inside'
    } else {
      if (row.parentId === null) return setNotice('Это уже верхний уровень')
      targetId = row.parentId
      place = 'after'
    }

    const items = rowsRef.current.map((item) => ({ id: item.id, parentId: item.parentId }))
    const check = checkMove(items, row.id, targetId, place)
    if (!check.ok) return setNotice(`Нельзя: ${REJECT_TEXT[check.reason]}`)
    if (!yMoveSubtree(events, row.id, targetId, place)) return setNotice('Перенести не удалось')

    setSelectedId(row.id)
    setNotice(`«${row.title}» перенесено`)
    onChanged()
  }

  function onRowKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, row: NavRow) {
    if (!event.altKey) return
    const dir =
      event.key === 'ArrowUp' ? 'up'
        : event.key === 'ArrowDown' ? 'down'
          : event.key === 'ArrowRight' ? 'in'
            : event.key === 'ArrowLeft' ? 'out'
              : null
    if (!dir) return
    event.preventDefault()
    moveByKeyboard(row, dir)
  }

  // Завершение жеста при уходе со страницы: без этого слушатели окна остались бы.
  useEffect(() => () => {
    if (syncTimer.current) clearTimeout(syncTimer.current)
    const gesture = gestureRef.current
    if (gesture) detachGesture(gesture)
    stopAutoscroll()
  }, [])

  const hint = drag?.hint ?? null
  const hintText = drag
    ? !hint
      ? drag.kind === 'chunk'
        ? 'Отпустите над строкой дерева, чтобы вставить кусок'
        : 'Отпустите над строкой списка, чтобы перенести'
      : hint.allowed
        ? hint.targetId === null
          ? drag.kind === 'chunk'
            ? 'Отпустите: в конец проекта'
            : 'Отпустите: в конец верхнего уровня'
          : `Отпустите: ${DROP_TEXT[hint.place]}`
        : `Сюда нельзя: ${hint.reason}`
    : notice

  return (
    <section className="ed-panel" data-editor-panel>
      <div className="ed-panel__head">
        <h3 className="ed-panel__title">Редакторы</h3>
        <div className="ed-toolbar">
          <button type="button" onClick={createChapter}>+ глава</button>
          <button type="button" className="secondary" onClick={createChild} disabled={!selectedId}>+ подсобытие</button>
          <button type="button" className="secondary ed-danger" onClick={removeSelected} disabled={!selectedId}>удалить</button>
        </div>
        <div className="ed-panel__meta">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Фильтр по названию…"
            aria-label="Фильтр событий"
            className="ed-filter"
          />
          <span className="muted ed-panel__count">
            {filter ? `${visibleRows.length} из ${rows.length}` : `событий: ${rows.length}`}
          </span>
        </div>
      </div>

      {onImportInto && (
        <div className="ed-import" data-ed-import>
          {chunk === null ? (
            <>
              {/* Импорт «в место»: файлы разбирает сервер и ничего не пишет —
                  кусок встанет в проект только после того, как ему выберут место. */}
              <span className="muted ed-import__label">Импорт куска md:</span>
              <label className={`ed-import__pick${importBusy ? ' is-busy' : ''}`}>
                <input
                  type="file"
                  multiple
                  disabled={importBusy}
                  onChange={onPickChunkFolder}
                  {...DIRECTORY_PICK}
                />
                папка
              </label>
              <label className={`ed-import__pick${importBusy ? ' is-busy' : ''}`}>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  disabled={importBusy}
                  onChange={onPickChunkZip}
                />
                zip
              </label>
              {importBusy && <span className="muted" role="status">Разбираю файлы…</span>}
            </>
          ) : (
            <>
              <button
                type="button"
                className="ed-import__chunk"
                data-ed-chunk
                onPointerDown={onChunkPointerDown}
                title="Перетащите на строку дерева: левая часть строки — между событиями, правая — внутрь"
              >
                <span aria-hidden="true">⠿</span> {chunk.label} — {chunk.events}{' '}
                {plural(chunk.events, 'событие', 'события', 'событий')}
              </button>
              {/* Место можно выбрать и списком: перетаскивание на тач-устройствах
                  конкурирует с прокруткой, а с клавиатуры его не сделать вовсе. */}
              <label className="ed-import__mode">
                <span className="muted">место:</span>
                <select
                  value={chunkMode}
                  onChange={(e) => setChunkMode(e.target.value as ChunkMode)}
                  aria-label="Место вставки куска"
                >
                  {(Object.keys(CHUNK_MODE_TEXT) as ChunkMode[]).map((mode) => (
                    <option key={mode} value={mode}>{CHUNK_MODE_TEXT[mode]}</option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={insertChunkByMode} disabled={importBusy}>
                вставить
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setChunk(null)}
                disabled={importBusy}
              >
                отмена
              </button>
            </>
          )}
        </div>
      )}

      {syncNote && <p className="muted ed-panel__note">{syncNote}</p>}
      {uploadNote && <p className="ed-panel__note ed-panel__note--upload">{uploadNote}</p>}
      {hintText && (
        <p
          className={[
            'ed-drag-note',
            drag && hint && !hint.allowed ? 'ed-drag-note--no' : '',
          ].filter(Boolean).join(' ')}
          role="status"
          aria-live="polite"
        >
          {drag && <span className="ed-drag-note__label">{drag.label} → </span>}
          {hintText}
        </p>
      )}

      <div className="ed-panel__grid">
        <nav
          className={drag ? 'ed-nav ed-nav--dragging' : 'ed-nav'}
          aria-label="Список событий"
          ref={navRef}
        >
          {visibleRows.map((row) => {
            const rowHint = drag?.hint && drag.hint.targetId === row.id ? drag.hint : null
            // Кто из соседей правит это событие. Список маленький (людей в
            // проекте единицы), поэтому считаем на каждой строке, а не кэшируем.
            const editors = presence ? editingPeers(presence, row.id) : []
            const rowTyping = presence ? typingLabel(presence, row.id) : null
            return (
              <button
                key={row.id}
                type="button"
                className={[
                  'ed-row',
                  row.isChapter ? 'ed-row--chapter' : 'ed-row--sub',
                  row.id === selectedId ? 'ed-row--active' : '',
                  row.id === drag?.id ? 'ed-row--dragging' : '',
                  rowHint ? dropClassFor(rowHint) : '',
                ].filter(Boolean).join(' ')}
                // Отступ — padding, а не margin: строка остаётся внутри списка и
                // на 320px ничего не выезжает вбок.
                style={{ paddingLeft: 8 + Math.min(row.depth, 4) * 14 }}
                data-event-id={row.id}
                data-depth={row.depth}
                onClick={() => {
                  // Клик после перетаскивания выбор не меняет: он уже выставлен.
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    return
                  }
                  setSelectedId(row.id)
                }}
                onPointerDown={(e) => onRowPointerDown(e, row)}
                onKeyDown={(e) => onRowKeyDown(e, row)}
                title={`${row.number} ${row.title} — тяните мышью или пальцем; Alt+↑/↓ порядок среди соседей, Alt+→ вложить, Alt+← на уровень выше`}
                aria-label={`${row.number} ${row.title}. Перетаскивание мышью или пальцем. Alt со стрелками: вверх/вниз — порядок среди соседей, вправо — вложить в предыдущего соседа, влево — поднять на уровень.`}
              >
                <span className="ed-row__grip" aria-hidden="true">⠿</span>
                <span className="ed-row__mark">{row.isChapter ? '#' : '└'}</span>
                <span className="ed-row__name">{row.title}</span>
                {/* Отметки соседей — до бейджа под-событий: имя строки обрезается
                    многоточием, и «кто здесь» не должно уезжать за край первым. */}
                {editors.length > 0 && (
                  <span className="ed-row__peers">
                    {editors.map((peer) => (
                      <span
                        key={peer.clientId}
                        className="ed-row__peer"
                        data-peer-editing={peer.name}
                        title={`${peer.name} правит это событие`}
                        aria-label={`${peer.name} правит это событие`}
                        style={{ backgroundColor: peer.color }}
                      >
                        {peer.initials}
                      </span>
                    ))}
                  </span>
                )}
                {rowTyping && (
                  <span className="ed-row__typing">
                    <span className="ed-row__typing-full">{rowTyping}</span>
                    {/* Короткая подпись для узкого экрана: полная формулировка
                        живёт только в collab/awareness.ts, какой вариант виден —
                        решает CSS (см. styles/editors.css). */}
                    <span className="ed-row__typing-short" aria-hidden="true">печатает…</span>
                  </span>
                )}
                {row.childCount > 0 && <span className="ed-row__badge">{row.childCount}</span>}
              </button>
            )
          })}
          {visibleRows.length === 0 && <p className="muted">Ничего не найдено.</p>}
        </nav>

        <div className="ed-editor">
          {selectedMap ? (
            <>
              <div className="ed-editor__head">
                <strong className="ed-editor__path">
                  {selectedRow?.isChapter ? 'Глава' : 'Подсобытие'} · {selectedRow?.title ?? ''}
                </strong>
              </div>
              <EventEditor
                ymap={selectedMap}
                assets={assets}
                images={images}
                assetUrls={assetUrls}
                background={background}
                onUpload={uploadAndAttach}
                onAttach={attach}
                onDetach={detach}
                onBackgroundChange={changeBackground}
                onChange={() => scheduleSync()}
                onTyping={markTyping}
              />
              <p className="muted ed-editor__hint">
                Изменения сохраняются автоматически; дерево синхронизируется с сервером.
              </p>
            </>
          ) : (
            <p className="muted">Выберите событие слева или создайте новую главу.</p>
          )}
        </div>
      </div>

      {/* Подпись переноса — в body: список прокручивается (`overflow`), и внутри
          навигатора подсказку обрезало бы. */}
      {drag && createPortal(
        <div className="ed-drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          {drag.label}
        </div>,
        document.body,
      )}
    </section>
  )
}

function countDescendants(all: YMap[], id: string): number {
  const childrenOf = new Map<string, string[]>()
  for (const m of all) {
    const parent = yEventParentId(m)
    const child = m.get('id') as string | undefined
    if (parent && child) {
      const list = childrenOf.get(parent) ?? []
      list.push(child)
      childrenOf.set(parent, list)
    }
  }
  const seen = new Set<string>()
  const walk = (parent: string) => {
    for (const child of childrenOf.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      walk(child)
    }
  }
  walk(id)
  return seen.size
}
