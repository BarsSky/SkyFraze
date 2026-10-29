import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { buildEventTree, DEFAULT_MAX_DEPTH, type EventLike, type EventTreeNode } from '../../collab/eventTree'
import { checkMove, type DropPlace, type MoveReject } from '../../collab/reorder'
import { editingPeers, typingLabel, type PeerState } from '../../collab/awareness'
import { textString, titleString } from '../../collab/text'
import { isSearchQuery, searchProject } from '../../lib/projectSearch'
import {
  commentCounts as commentCountsRequest,
  unseenComments as unseenCommentsRequest,
  type FrameAnchor,
} from '../../api/comments'
import { FrameComments } from './FrameComments'
import { FrameMentions } from './FrameMentions'
import { scrollWithinMain } from '../../lib/scrollTo'
import { onOpenFrameRequest } from '../../lib/openFrame'
import { useProjectEntities } from '../entities/useProjectEntities'
import {
  entityUsage,
  frameMentions,
  framesByEntity,
  mentionMatrix,
  type DatedFrame,
  type FrameChapter,
  type MentionFrame,
  type FrameWithMentions,
  type Mention,
} from '../../collab/mentions'
import { dateFromServer } from '../../collab/eventDate'
import {
  previewMarkdownImport,
  readImportErrorMessage,
  type MarkdownImportPreview,
  type MarkdownImportResult,
  type MarkdownImportSource,
  type MarkdownInsertPlace,
} from '../../api/storyFiles'
import { DIRECTORY_PICK } from '../../lib/directoryPick'
import { formatBytes, plural } from '../../lib/format'
import { pluralWord, tStatic, useT, type Key } from '../../i18n'
import { getLang, useLang } from '../../store/lang'
import { importWeight } from '../../lib/importWeight'
import { runUploads, uploadSummary, type UploadOutcome } from '../../lib/uploadQueue'
import {
  attachmentsByAsset,
  planAssetMove,
  type TransferFrame,
} from '../../lib/assetTransfer'
import { serverErrorMessage } from '../../api/client'
import { listDocxTemplates } from '../../api/docxTemplates'
import { docxStyleNames } from '../../lib/docxMarkers'
import {
  yAddEvent,
  yDeleteEvent,
  yEventParentId,
  yMoveSubtree,
  type YArray,
  type YMap,
} from '../../collab/yprovider'
import type { Asset, AssetUsage } from '../../api/assets'
import { ProjectFiles } from './ProjectFiles'
import { EventEditor, type FocusRange, type FrameFragment } from './EventEditor'
import type { BackgroundValue } from './BackgroundPicker'

interface Props {
  events: YArray
  assets: Asset[]
  /** id ассета → blob-URL для превью (ассеты отдаются только с авторизацией). */
  assetUrls: Record<string, string>
  /**
   * Проект и право писать. Нужны обсуждению кадра: без id некуда слать запрос, а без
   * права текст формы был бы обещанием, которое сервер отклонит. Необязательны — панель
   * работает и без них (обсуждение просто не показывается).
   */
  projectId?: string
  canEdit?: boolean
  syncNote?: string | null
  /** Любая правка CRDT: страница проецирует дерево на сервер. */
  onChanged: () => void
  /** Загрузка файла: страница сохраняет ассет и возвращает его. */
  onUpload: (file: File) => Promise<Asset | null>
  /**
   * Занятое место и предел квоты проекта (`GET …/assets/usage`). Необязательно:
   * без него список файлов покажет только суммарный вес.
   */
  assetUsage?: AssetUsage | null
  /**
   * Удаление файла проекта. Необязательно: без него список файлов только
   * показывает, что хранится, а кнопки удаления нет (роль без прав, старые
   * страницы).
   */
  onDeleteAsset?: (asset: Asset) => void
  /** Что ответил сервер на попытку удаления: отказ объясняется словами сервера. */
  assetNote?: string | null
  /** Файл, который удаляется прямо сейчас. */
  assetBusyId?: string | null
  /**
   * Переход к «Связям» из тулбара (0.83.0). У страницы с вкладками это мгновенное
   * переключение режима; без колбэка панель прокручивает страницу к разделу (старый путь).
   */
  onOpenRelations?: () => void
  /**
   * Просьба открыть кадр, пришедшая СТРАНИЦЕЙ (0.87.0): «К редактированию» во всплывающей
   * карточке упоминания в «Связях».
   *
   * Почему проп, а не только событие: с 0.83.0 панель монтируется лишь на своей вкладке, и
   * событие `skyfraze:open-frame`, отправленное из «Связей», слышать было некому — переходы
   * молчали. Страница переключает вкладку и передаёт просьбу уже смонтированной панели; `nonce`
   * позволяет повторить переход к тому же кадру.
   */
  openRequest?: { frameId: string; mention?: Mention; nonce: number } | null
  /** Просьба обработана: страница убирает её, чтобы повторное монтирование не открывало кадр. */
  onOpenRequestHandled?: () => void
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
  /**
   * Текст кадра — только для поиска. В списке он не рисуется целиком: строке хватает
   * названия, а текст виден в редакторе справа.
   */
  body: string
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


/**
 * Что написать после загрузки файла.
 *
 * Сервер пережимает картинки в WebP и меняет имя (`photo.jpg` → `photo.webp`),
 * поэтому короткое «Загружено: photo.webp» выглядело бы как подмена файла. Если
 * имя изменилось, показываем исходный вес и результат — тогда видно, что это
 * экономия, а не ошибка.
 */
export function uploadNoteFor(file: File, asset: Asset): string {
  const renamed = asset.mime === 'image/webp' && !/\.webp$/i.test(file.name)
const lang = getLang()
if (!renamed) return tStatic('ed.uploadDone', { name: asset.filename })
return tStatic('ed.uploadRecompressed', {
name: asset.filename,
from: formatBytes(file.size, lang),
to: formatBytes(asset.size, lang),
})
}

/**
 * Что написать, если загрузка не удалась.
 *
 * Сервер объясняет отказы своими словами — «в проекте занято 9.4 МБ из 10 МБ —
 * файл на 1.2 МБ не помещается». Показать вместо этого «сервер отклонил запрос»
 * значит заставить человека гадать, что именно не так.
 */
export async function uploadErrorNote(e: unknown): Promise<string> {
return (await serverErrorMessage(e)) ?? tStatic('ed.uploadFailed')
}

/**
 * Итог загрузки для человека.
 *
 * Один файл — с подробностью про пережатие («пережато из 2.4 МБ в 300 КБ»), потому что
 * сервер переименовывает картинки и без пояснения это выглядит подменой файла. Несколько
 * — сводкой «загружено 3 из 5» с причинами отказов.
 */
export function outcomeNote(files: File[], outcomes: UploadOutcome[]): string {
  const first = outcomes[0]
  if (files.length === 1 && first?.asset) return uploadNoteFor(files[0], first.asset)
  return uploadSummary(outcomes)
}

/**
 * Кадры в том виде, в каком их видит перенос файлов: подпись, вложения, фон.
 *
 * Читаем прямо из документа (а не из проекции): перенос делает клиент, и решать по
 * устаревшей таблице значило бы терять вложения соавтора. Номера считаем тем же
 * обходом дерева, что и навигатор, — чтобы «01.1» в подписи переноса совпадал с
 * номером кадра в стадии.
 */
export function transferFrames(list: YMap[]): TransferFrame[] {
  const flat: Array<EventLike & { title: string }> = list
    .map((m) => ({
      id: (m.get('id') as string | undefined) ?? '',
      parentId: yEventParentId(m),
      title: titleString(m),
    }))
    .filter((e) => e.id.length > 0)
  const byId = new Map<string, YMap>()
  for (const map of list) byId.set((map.get('id') as string) ?? '', map)

  const out: TransferFrame[] = []
  const walk = (node: EventTreeNode<(typeof flat)[number]>, number: string) => {
    const map = byId.get(node.item.id)
    const assets = ((map?.get('assets') as string[] | undefined) ?? []).filter(Boolean)
    const background =
      map?.get('bg_kind') === 'asset' ? ((map.get('bg_asset') as string | undefined) ?? null) : null
    out.push({
      id: node.item.id,
label: `${number} ${node.item.title || tStatic('ed.untitled')}`.trim(),
      assetIds: assets,
      backgroundAssetId: background,
    })
    node.children.forEach((child, index) => walk(child, `${number}.${index + 1}`))
  }
  buildEventTree(flat, DEFAULT_MAX_DEPTH).forEach((root, index) => {
    walk(root, String(index + 1).padStart(2, '0'))
  })
  return out
}

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
const REJECT_TEXT: Record<MoveReject, Key> = {
'unknown-source': 'ed.reject.unknownSource',
'unknown-target': 'ed.reject.unknownTarget',
self: 'ed.reject.self',
cycle: 'ed.reject.cycle',
depth: 'ed.reject.depth',
}

/** Что означает разрешённая цель — текст для строки-подсказки. */
const DROP_TEXT: Record<DropPlace, Key> = {
before: 'ed.drop.before',
after: 'ed.drop.after',
inside: 'ed.drop.inside',
}

/** Куда положить кусок, если место выбирают не перетаскиванием, а списком. */
type ChunkMode = 'end' | 'before' | 'after' | 'inside'

const CHUNK_MODE_TEXT: Record<ChunkMode, Key> = {
end: 'ed.placeEnd',
before: 'ed.placeBefore',
after: 'ed.placeAfter',
inside: 'ed.placeInside',
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
  /** Сколько файлов станут вложениями: их видно в подписи куска. */
  files: number
  /** Вес вложений до пережатия: по нему видно, поместится ли кусок. */
  bytes: number
  /** Предел вложений проекта на момент разбора (0 — без предела). */
  quotaBytes: number
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
  events, assets, assetUrls, projectId, canEdit, syncNote, onChanged, onUpload, onImportInto,
  presence, onEditing, assetUsage, onDeleteAsset, assetNote, assetBusyId, onOpenRelations,
  openRequest, onOpenRequestHandled,
}: Props) {
  const t = useT()
  const [lang] = useLang()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  /**
   * Фильтр дерева по карточке мира: «только кадры с Анной» (0.69.0).
   *
   * Отдельное состояние, а не часть поисковой строки: это не «найти», а «показать линию
   * персонажа», и сбрасывать его вместе с очисткой поиска было бы неправильно.
   */
  const [entityFilter, setEntityFilter] = useState<string | null>(null)
  const [version, setVersion] = useState(0) // перерисовка после правок CRDT
  const [filesNote, setFilesNote] = useState<string | null>(null)
  /** Сколько комментариев у кадров: бейдж у строки дерева и счётчик обсуждения. */
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  /** Сколько из них новых (написаны после моего последнего просмотра). */
  const [unseenCounts, setUnseenCounts] = useState<Record<string, number>>({})
  const [drag, setDrag] = useState<DragView | null>(null)
  /** Подсказка для клавиатурных переносов: что не получилось и почему. */
  const [notice, setNotice] = useState<string | null>(null)
  /** Разобранный кусок md: пока он есть, его можно перетащить на дерево. */
  const [chunk, setChunk] = useState<ImportChunk | null>(null)
  const [chunkMode, setChunkMode] = useState<ChunkMode>('end')
  const [importBusy, setImportBusy] = useState(false)
  /**
   * Фрагмент, к которому человек сейчас пишет замечание (пришёл из редактора кадра).
   * Живёт в панели, а не в редакторе: замечание уходит в блок обсуждения, который стоит
   * рядом, и выбранный фрагмент должен пережить перерисовку редактора.
   */
  const [pendingAnchor, setPendingAnchor] = useState<FrameAnchor | null>(null)
  /**
   * Фрагмент, который надо показать в тексте (клик по замечанию). 
once — чтобы повторный
   * клик по тому же замечанию срабатывал снова.
   */
  const [focusRange, setFocusRange] = useState<FocusRange | null>(null)
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

  // Счётчики обсуждения — один запрос на проект: N запросов по кадрам ради бейджа были
  // бы дороже, чем весь список. Обновляются после каждого отправленного комментария.
  useEffect(() => {
    if (!projectId) return
    let alive = true
    commentCountsRequest(projectId)
      .then((counts) => {
        if (alive) setCommentCounts(counts)
      })
      .catch(() => undefined)
    // Непрочитанное — вторым запросом, но в том же проходе: оба нужны дереву, и «сколько
    // всего» без «сколько нового» превращает бейдж в декорацию.
    unseenCommentsRequest(projectId)
      .then((unseen) => {
        if (alive) setUnseenCounts(unseen)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [projectId])

  /**
   * Стили абзаца действующего шаблона DOCX (0.92.0) — для панели «Разметка DOCX» в редакторе.
   *
   * Один запрос на проект при открытии панели, а не на каждый кадр: список стилей не зависит
   * от кадра. Ошибка не показывается: без шаблона (или без права менять шаблоны) панель просто
   * не предлагает стилей, и это нормальное состояние, а не сбой, о котором надо кричать в
   * редакторе текста.
   */
  const [docxStyles, setDocxStyles] = useState<string[]>([])
  useEffect(() => {
    if (!projectId) return undefined
    let alive = true
    listDocxTemplates(projectId)
      .then((templates) => {
        if (alive) setDocxStyles(docxStyleNames(templates))
      })
      .catch(() => {
        if (alive) setDocxStyles([])
      })
    return () => {
      alive = false
    }
  }, [projectId])

  const noteCommentCount = useCallback((eventId: string, count: number) => {
    setCommentCounts((current) => {
      if (count <= 0) {
        if (!(eventId in current)) return current
        const next = { ...current }
        delete next[eventId]
        return next
      }
      if (current[eventId] === count) return current
      return { ...current, [eventId]: count }
    })
    // Обсуждение показано — значит, прочитано: отметку на сервере поставил сам блок
    // комментариев, здесь гасим бейдж, чтобы он не висел до перезагрузки страницы.
    setUnseenCounts((current) => {
      if (!(eventId in current)) return current
      const next = { ...current }
      delete next[eventId]
      return next
    })
  }, [])

  const rows = useMemo<NavRow[]>(() => {
    void version
    if (!events) return []
    const flat: Array<EventLike & { title: string }> = (events.toArray() as YMap[]).map((m) => ({
      id: (m.get('id') as string | undefined) ?? '',
      parentId: yEventParentId(m),
      title: titleString(m),
    })).filter((e) => e.id.length > 0)

    // Текст кадров читается отдельным проходом и только для поиска: тянуть `body` в
    // дерево незачем (по нему не строятся связи), а список всё равно обходится целиком.
    const bodies = new Map<string, string>()
    for (const map of events.toArray() as YMap[]) {
      const id = (map.get('id') as string | undefined) ?? ''
      if (id) bodies.set(id, textString(map, 'body'))
    }

    // Номер считаем обходом дерева: «01», «01.2», «01.2.1» — как в кадрах
    // таймлайна, чтобы в подписи переноса число совпадало с видимым номером.
    const out: NavRow[] = []
    const walk = (node: EventTreeNode<(typeof flat)[number]>, number: string, parentId: string | null) => {
      out.push({
        id: node.item.id,
        parentId,
        number,
        depth: node.depth,
title: node.item.title || tStatic('ed.untitled'),
        body: bodies.get(node.item.id) ?? '',
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

  /**
   * Кадры для списка файлов: где лежит каждый файл и куда его можно перенести.
   *
   * Считается здесь, а не в ProjectFiles: документ доступен панели, а списку файлов
   * нужны только готовые подписи и вложения.
   */
  const frames = useMemo<TransferFrame[]>(() => {
    void version
    if (!events) return []
    return transferFrames(events.toArray() as YMap[])
  }, [events, version])
  const attachments = useMemo(() => attachmentsByAsset(frames), [frames])

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

  /**
   * Карточки мира проекта — один список на всю панель (0.68.0).
   *
   * Нужны в двух местах: в блоке «Связи проекта» (список и счётчики) и в поиске упоминаний
   * в тексте кадра. Две независимые загрузки одного списка разъезжались бы.
   */
  const { entities, links: entityLinks, loaded: entitiesLoaded, reload: reloadEntities } =
    useProjectEntities(projectId)

  /**
   * Тексты всех кадров для поиска упоминаний.
   *
   * Читаются тем же проходом, что и поиск по дереву: документ и так целиком в памяти. `version`
   * в зависимостях — чтобы счётчики обновлялись после правок; пересчёт дешёвый (одно регулярное
   * выражение на кадр), но всё равно не на каждое нажатие клавиши — только на изменение CRDT.
   */
  const mentionFrames = useMemo<MentionFrame[]>(() => {
    void version
    if (!events) return []
    const out: DatedFrame[] = []
    for (const map of events.toArray() as YMap[]) {
      const id = (map.get('id') as string | undefined) ?? ''
      if (!id) continue
      out.push({
        id,
        title: titleString(map),
        body: textString(map, 'body'),
        date: dateFromServer(map.get('event_date')),
      })
    }
    return out
  }, [events, version])

  /** Сколько кадров и упоминаний у каждой карточки: по этому «сироту» и видно. */
  const entityUse = useMemo(() => entityUsage(mentionFrames, entities), [mentionFrames, entities])

  /**
   * Хронология по карточкам (фаза 3): где она встречается.
   *
   * `order` берём из дерева (`rows`), а не из массива документа: номер кадра «01.2» считается
   * обходом дерева, и порядок «без даты — как в дереве» должен совпадать с тем, что человек
   * видит в списке слева.
   */
  const entityFrames = useMemo<Record<string, FrameWithMentions[]>>(() => {
    const order = new Map<string, { number: string; order: number }>()
    rows.forEach((row, index) => order.set(row.id, { number: row.number, order: index }))
    const withOrder = mentionFrames.map((frame, index) => {
      const meta = order.get(frame.id)
      return {
        ...frame,
        number: meta?.number ?? '',
        order: meta?.order ?? index,
      }
    })
    return framesByEntity(withOrder, entities)
  }, [entities, mentionFrames, rows])

  const selectedMentions = useMemo(() => {
    if (!selectedId) return []
    const frame = mentionFrames.find((f) => f.id === selectedId)
    return frame ? frameMentions(frame, entities) : []
  }, [entities, mentionFrames, selectedId])

  /**
   * Матрица «персонажи × главы» (0.71.0).
   *
   * Главу кадра ищем подъёмом по родителям до корня: в дереве кадр лежит на любой глубине, а
   * матрица считается по главам. Кадр без главы (потерянный родитель) в матрицу не попадает —
   * столбца для него нет, и придумывать его значило бы показывать структуру, которой нет.
   */
  const entityMatrix = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]))
    const chapters = rows
      .filter((row) => row.isChapter)
      .map((row) => ({ id: row.id, title: row.title, number: row.number }))
    const frameChapters: FrameChapter[] = []
    for (const row of rows) {
      let current:
        | { id: string; parentId: string | null; isChapter: boolean }
        | undefined = row
      // Предохранитель от цикла: битое дерево не должно вешать панель.
      let guard = 0
      while (current && !current.isChapter && guard < 16) {
        current = current.parentId ? byId.get(current.parentId) : undefined
        guard += 1
      }
      if (current?.isChapter) frameChapters.push({ frameId: row.id, chapterId: current.id })
    }
    return mentionMatrix(mentionFrames, frameChapters, chapters, entities)
  }, [entities, mentionFrames, rows])
  /**
   * Переход к «Связям» из тулбара (0.72.1 → 0.79.0 → 0.83.0).
   *
   * С 0.83.0 «Связи» — это ВКЛАДКА, а не блок ниже по странице: страница передаёт
   * `onOpenRelations` и переключает режим мгновенно. Прокрутка осталась запасным путём на
   * случай, когда панель встроена без вкладок (сценарии, которые рендерят её отдельно).
   */
  const openRelations = useCallback(() => {
    if (onOpenRelations) {
      onOpenRelations()
      return
    }
    const section = document.querySelector<HTMLElement>('[data-relations]')
    if (section) scrollWithinMain(section)
  }, [onOpenRelations])
  /** Открыть кадр из хронологии: выбрать его и подсветить упоминание. */
  const openFrameWithMention = useCallback((frameId: string, mention: Mention) => {
    setSelectedId(frameId)
    setFocusRange((current) => ({
      field: mention.field,
      from: mention.from,
      to: mention.to,
      nonce: (current?.nonce ?? 0) + 1,
    }))
  }, [])

  /**
   * Кадр просят открыть из другой области — из хронологии в «Связях» (0.79.0).
   *
   * Событие, а не проп: область «Связи» и панель редакторов — соседние, но независимые
   * компоненты страницы, и тащить колбэк через страницу значило бы регистрировать ссылку
   * внутрь панели. Событие описано в `lib/openFrame.ts`.
   */
  useEffect(() => {
    return onOpenFrameRequest(({ frameId, mention }) => {
      if (mention) openFrameWithMention(frameId, mention)
      else setSelectedId(frameId)
      scrollWithinMain(document.querySelector<HTMLElement>('[data-editor-panel]'))
    })
  }, [openFrameWithMention])

  /**
   * Та же просьба, но пропсом со страницы (0.87.0) — «К редактированию» из «Связей».
   *
   * Событие здесь ненадёжно: панель монтируется только на своей вкладке, и переход из «Связей»
   * отправлял событие в пустоту. Страница переключает вкладку и передаёт просьбу пропсом —
   * панель получает её уже смонтированной. `nonce` в зависимостях нужен, чтобы повторный выбор
   * того же кадра тоже сработал.
   */
  useEffect(() => {
    if (!openRequest?.frameId) return
    if (openRequest.mention) openFrameWithMention(openRequest.frameId, openRequest.mention)
    else setSelectedId(openRequest.frameId)
    scrollWithinMain(document.querySelector<HTMLElement>('[data-editor-panel]'))
    onOpenRequestHandled?.()
  }, [onOpenRequestHandled, openFrameWithMention, openRequest])

  /**
   * Помещается ли разобранный кусок в проект.
   *
   * Предел берём из того же ответа, что и предпросмотр (он неизменен на стенде), а
   * занятое место — из текущего расхода проекта: если с момента разбора файлы
   * добавляли, предупреждение должно это учитывать.
   */
  const chunkWeight = chunk
    ? importWeight(
        { attachments: chunk.files, attachmentBytes: chunk.bytes },
        chunk.quotaBytes,
        assetUsage?.used ?? 0,
      )
    : null

  /**
   * Что показать в списке при введённом запросе.
   *
   * Ищем и по названию, и по тексту (lib/projectSearch): раньше фильтр знал только
   * название, и «найди, где я писал про маяк» не работало — приходилось помнить, в какой
   * это главе. Для попаданий в текст рядом со строкой показывается сниппет: по названию
   * кадра не всегда понятно, почему он в результатах.
   */
  const hits = useMemo(() => searchProject(rows, filter), [rows, filter])
  const visibleRows = useMemo(() => {
    // Фильтр по карточке мира (фаза 3): «только кадры с Анной». Он СИЛЬНЕЕ поиска — два
    // фильтра одновременно показали бы пересечение, которого человек не просил.
    if (entityFilter !== null) {
      const allowed = new Set((entityFrames[entityFilter] ?? []).map((frame) => frame.frameId))
      return rows.filter((row) => allowed.has(row.id))
    }
    if (!isSearchQuery(filter)) return rows
    const byId = new Map(rows.map((row) => [row.id, row]))
    const out: NavRow[] = []
    for (const hit of hits) {
      const row = byId.get(hit.id)
      if (row) out.push(row)
    }
    return out
  }, [rows, hits, filter, entityFilter, entityFrames])
  // Сниппет показываем только у попаданий в текст: у попадания в название он повторяет
  // начало кадра и только удлиняет строку.
  const snippets = useMemo(() => {
    const out = new Map<string, string>()
    for (const hit of hits) {
      if (!hit.inTitle && hit.snippet) out.set(hit.id, hit.snippet)
    }
    return out
  }, [hits])

  const selectedRow = rows.find((r) => r.id === selectedId)
  const attachedIds = ((selectedMap?.get('assets') as string[] | undefined) ?? []).filter(Boolean)
  const images = assets.filter((a) => attachedIds.includes(a.id) && a.mime.startsWith('image/'))

  /**
   * Файлы, прикреплённые хоть к одному кадру проекта.
   *
   * Нужны списку файлов: такой файл удалять нельзя (в CRDT-документе осталась бы
   * ссылка), и кнопка должна быть выключена заранее, с объяснением, а не отвечать
   * отказом сервера. Фон считается ссылкой только когда выбран картинкой.
   */
  const usedAssetIds = useMemo(() => {
    void version
    const used = new Set<string>()
    const list = (events?.toArray() as YMap[] | undefined) ?? []
    for (const map of list) {
      for (const id of ((map.get('assets') as string[] | undefined) ?? []).filter(Boolean)) {
        used.add(id)
      }
      if (map.get('bg_kind') === 'asset') {
        const background = map.get('bg_asset')
        if (typeof background === 'string' && background) used.add(background)
      }
    }
    return used
  }, [events, version])

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
setNotice(t('ed.noticeNoEvents'))
        return
      }
      setChunk({
        source,
        label,
        events: preview.events.length,
        maxDepth: preview.events.reduce((max, event) => Math.max(max, event.depth), 0),
        files: preview.stats.attachments,
        bytes: preview.stats.attachmentBytes,
        quotaBytes: preview.quotaBytes,
      })
      setChunkMode('end')
      setNotice(
t('ed.noticeChunk', {
events: `${preview.events.length} ${pluralWord(lang, 'ed.unit.event', preview.events.length)}`,
}) +
(preview.stats.attachments > 0
? t('ed.noticeChunkAttachments', {
attachments: `${preview.stats.attachments} ${pluralWord(lang, 'ed.unit.attachment', preview.stats.attachments)}`,
})
: '') +
t('ed.noticeChunkDrag'),
      )
    } catch (e) {
      const message = await readImportErrorMessage(e)
setNotice(message ?? t('ed.noticeChunkFailed'))
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
const count = `${files.length} ${pluralWord(lang, 'ed.unit.file', files.length)}`
void loadChunk(files, root && root !== files[0].name ? t('ed.folderLabel', { name: root, count }) : count)
  }

  function onPickChunkZip(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
void loadChunk({ archive: file }, t('ed.archiveLabel', { name: file.name }))
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
reason: t('ed.tooDeepMap', { depth: (chunk?.maxDepth ?? 0) + 1, max: DEFAULT_MAX_DEPTH }),
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
? t('ed.inserted', { count: result.events }) + `. ${warning}`
: t('ed.inserted', { count: result.events }),
      )
    } catch (e) {
      const message = await readImportErrorMessage(e)
setNotice(message ?? t('ed.insertFailed'))
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
setNotice(t('ed.selectFirst'))
      return
    }
    const hint = chunkHint(row, chunkMode)
    if (!hint.allowed) {
setNotice(t('ed.cannotHere', { reason: hint.reason ?? '' }))
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
const map = yAddEvent(events, t('ed.newChapter'), '')
    setSelectedId(map.get('id') as string)
    setFilter('')
    onChanged()
  }

  function createChild() {
    if (!events || !selectedId) return
    // Под-событие создаётся у выбранного события (главы или другого под-события).
const map = yAddEvent(events, t('ed.newChild'), '', { parentId: selectedId })
    setSelectedId(map.get('id') as string)
    onChanged()
  }

  function removeSelected() {
    if (!events || !selectedMap || !selectedId) return
    const arr = events.toArray() as YMap[]
    const descendants = countDescendants(arr, selectedId)
const title = titleString(selectedMap) || t('ed.noTitle')
    const warn = descendants > 0
? t('ed.confirmDeleteMany', { title, count: descendants })
: t('ed.confirmDeleteOne', { title })
    if (!window.confirm(warn)) return
    yDeleteEvent(events, selectedId)
    const nextRow = rows.find((r) => r.id !== selectedId)
    setSelectedId(nextRow?.id ?? null)
    onChanged()
  }

  /**
   * Загрузить НЕСКОЛЬКО файлов и прикрепить их к выбранному кадру.
   *
   * Очередь (lib/uploadQueue.ts) решает три вещи, которые в лоб не решаются:
   * загрузка идёт по одному файлу (сервер пережимает картинки — десяток
   * одновременных загрузок кладёт слабую машину), по каждому файлу виден итог, а
   * когда кончилось место — остаток не отправляется вовсе.
   */
  function uploadAndAttachMany(files: File[]) {
    // Прикрепляем к тому событию, для которого выбирали файлы: за время загрузки
    // человек мог переключиться в навигаторе.
    const targetId = selectedId
    setFilesNote(null)
    void (async () => {
      const outcomes = await runUploads(files, (f) => onUpload(f), {
        maxBytes: MAX_UPLOAD_BYTES,
        onProgress: (done, total) => {
if (total > 1 && done < total) setFilesNote(t('ed.uploading', { done: done + 1, total }))
        },
describeError: (e) => uploadErrorNote(e),
      })

      let first = true
      for (const outcome of outcomes) {
        if (!outcome.asset) continue
        attachTo(targetId, outcome.asset, first && outcomes.length > 1)
        first = false
      }
      setFilesNote(outcomeNote(files, outcomes))
      setVersion((v) => v + 1)
    })()
  }

  /**
   * Загрузить файлы в проект БЕЗ прикрепления к кадру.
   *
   * Нужно для «положить в проект десяток картинок сразу»: привязка к кадрам — отдельное
   * действие (в кадре или переносом из списка файлов), и навязывать её при загрузке
   * нельзя: файл может быть нужен сразу нескольким кадрам или пока ни одному.
   */
  function uploadProjectFiles(files: File[]) {
    setFilesNote(null)
    void (async () => {
      const outcomes = await runUploads(files, (f) => onUpload(f), {
        maxBytes: MAX_UPLOAD_BYTES,
        onProgress: (done, total) => {
if (total > 1 && done < total) setFilesNote(t('ed.uploading', { done: done + 1, total }))
        },
describeError: (e) => uploadErrorNote(e),
      })
      setFilesNote(outcomeNote(files, outcomes))
      setVersion((v) => v + 1)
    })()
  }

  /** Прикрепить загруженный файл к кадру; первая картинка становится фоном кадра. */
  function attachTo(targetId: string | null, asset: Asset, becomeBackground: boolean) {
    const list = (events?.toArray() as YMap[] | undefined) ?? []
    const map = list.find((m) => (m.get('id') as string) === targetId) ?? selectedMap
    if (!map) return
    const current = ((map.get('assets') as string[] | undefined) ?? []).filter(Boolean)
    if (!current.includes(asset.id)) map.set('assets', [...current, asset.id])
    // Первая картинка сразу становится фоном кадра — обычно это и нужно. При
    // загрузке нескольких файлов фон получает только первая, иначе каждая следующая
    // перебивала бы предыдущую и в кадре оказалась случайная картинка.
    if (asset.mime.startsWith('image/') && (becomeBackground || map.get('bg_kind') !== 'asset')) {
      map.set('bg_kind', 'asset')
      map.set('bg_asset', asset.id)
    }
  }

  /**
   * Перенос вложения из кадра в кадр (глава ↔ под-событие).
   *
   * Решение целиком принимает `planAssetMove` (lib/assetTransfer.ts): он знает про фон
   * исходного кадра, про то, что тот же файл может быть прикреплён к нескольким кадрам,
   * и про то, что первая картинка в пустом кадре становится фоном. Здесь — только
   * применение к документу.
   */
  function moveAsset(assetId: string, fromId: string | null, toId: string) {
    const list = (events?.toArray() as YMap[] | undefined) ?? []
    const frames = transferFrames(list)
    const asset = assets.find((a) => a.id === assetId)
    const plan = planAssetMove(frames, assetId, fromId, toId, {
      isImage: (asset?.mime ?? '').startsWith('image/'),
    })
    if ('error' in plan) {
      setFilesNote(plan.error)
      return
    }
    for (const patch of plan.patches) {
      const map = list.find((m) => (m.get('id') as string) === patch.id)
      if (!map) continue
      map.set('assets', patch.assetIds)
      if (patch.backgroundAssetId === null) {
        map.delete('bg_asset')
      } else if (typeof patch.backgroundAssetId === 'string') {
        map.set('bg_kind', 'asset')
        map.set('bg_asset', patch.backgroundAssetId)
      }
    }
    setFilesNote(plan.notice)
    setVersion((v) => v + 1)
    onChanged()
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
      // Причина переводится ЗДЕСЬ (0.119.0): `DropHint.reason` — готовый текст для человека.
      // Пока в нём лежал ключ словаря, подсказка показывала «ed.reject.cycle» — это и поймал тест.
      reason: check.ok ? null : t(REJECT_TEXT[check.reason], { max: DEFAULT_MAX_DEPTH }),
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
setNotice(t('ed.cannotHere', { reason: hint.reason ?? t('ed.unknownDropTarget') }))
        return
      }
      void insertChunk(chunkPlace(hint))
      return
    }

    if (!hint || !hint.allowed) return

    if (yMoveSubtree(events, gesture.id, hint.targetId, hint.place)) {
      setSelectedId(gesture.id) // после переноса событие остаётся выбранным
setNotice(t('ed.moved', { label: gesture.label }))
      onChanged()
    } else {
setNotice(t('ed.moveFailedTreeChanged'))
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
label: t('ed.chunkLabel', { count: `${chunk.events} ${pluralWord(lang, 'ed.unit.event', chunk.events)}` }),
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
if (!prev) return setNotice(t('ed.noPrevSibling'))
      targetId = prev.id
      place = 'before'
    } else if (dir === 'down') {
      const next = siblings[at + 1]
if (!next) return setNotice(t('ed.noNextSibling'))
      targetId = next.id
      place = 'after'
    } else if (dir === 'in') {
      const prev = siblings[at - 1]
if (!prev) return setNotice(t('ed.noPrevToNest'))
      targetId = prev.id
      place = 'inside'
    } else {
if (row.parentId === null) return setNotice(t('ed.alreadyTop'))
      targetId = row.parentId
      place = 'after'
    }

    const items = rowsRef.current.map((item) => ({ id: item.id, parentId: item.parentId }))
    const check = checkMove(items, row.id, targetId, place)
if (!check.ok) return setNotice(t('ed.cannotDo', { reason: t(REJECT_TEXT[check.reason], { max: DEFAULT_MAX_DEPTH }) }))
if (!yMoveSubtree(events, row.id, targetId, place)) return setNotice(t('ed.moveFailed'))

    setSelectedId(row.id)
setNotice(t('ed.moved', { label: row.title }))
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
? t('ed.dropOnRowChunk')
: t('ed.dropOnRowMove')
: hint.allowed
? hint.targetId === null
? drag.kind === 'chunk'
? t('ed.dropEndProject')
: t('ed.dropEndTop')
: t('ed.dropPlace', { place: t(DROP_TEXT[hint.place]) })
: t('ed.dropCannot', { reason: hint.reason ?? '' })
    : notice

  return (
    <section className="ed-panel" data-editor-panel>
      <div className="ed-panel__head">
        <h3 className="ed-panel__title">{t('ed.title')}</h3>
        <div className="ed-toolbar">
          <button type="button" onClick={createChapter}>{t('ed.addChapter')}</button>
<button type="button" className="secondary" onClick={createChild} disabled={!selectedId}>{t('ed.addChild')}</button>
<button type="button" className="secondary ed-danger" onClick={removeSelected} disabled={!selectedId}>{t('ed.delete')}</button>
          {/* Вход в связи: блок карточек выше панели, и без кнопки его не находят */}
          <button
            type="button"
            className="secondary"
            onClick={openRelations}
            data-ed-entities-jump
          >
          {t('ed.relations')}
</button>
        </div>
        <div className="ed-panel__meta">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('ed.search')}
            aria-label={t('ed.searchAria')}
            className="ed-filter"
            data-ed-search
          />
          <span className="muted ed-panel__count">
            {entityFilter !== null
? t('ed.countWithCard', { count: visibleRows.length })
              : isSearchQuery(filter)
? t('ed.countFound', { found: visibleRows.length, total: rows.length })
: t('ed.countAll', { count: rows.length })}
          </span>
        </div>

        {/* Линия карточки: «показать только кадры, где появляется Анна». Список карточек
            берётся из того же хука, что и «Связи проекта», поэтому новая карточка сразу
            доступна фильтру. */}
        {entities.length > 0 && (
          <label className="ed-entity-filter">
            <span className="muted">{t('ed.onlyWithCard')}</span>
            <select
              value={entityFilter ?? ''}
              onChange={(e) => setEntityFilter(e.target.value === '' ? null : e.target.value)}
              aria-label={t('ed.cardFilterAria')}
              data-ed-entity-filter
            >
              <option value="">{t('ed.allFrames')}</option>
              {entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
            {entityFilter !== null && (
              <button
                type="button"
                className="secondary"
                onClick={() => setEntityFilter(null)}
                data-ed-entity-filter-clear
              >
              {t('ed.reset')}
</button>
            )}
          </label>
        )}
      </div>

      {onImportInto && (
        <div className="ed-import" data-ed-import>
          {chunk === null ? (
            <>
              {/* Импорт «в место»: файлы разбирает сервер и ничего не пишет —
                  кусок встанет в проект только после того, как ему выберут место. */}
              <span className="muted ed-import__label">{t('ed.importLabel')}</span>
              <label className={`ed-import__pick${importBusy ? ' is-busy' : ''}`}>
                <input
                  type="file"
                  multiple
                  disabled={importBusy}
                  onChange={onPickChunkFolder}
                  {...DIRECTORY_PICK}
                />
                {t('ed.importFolder')}
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
              {              importBusy && <span className="muted" role="status">{t('ed.importParsing')}</span>}
            </>
          ) : (
            <>
              <button
                type="button"
                className="ed-import__chunk"
                data-ed-chunk
                onPointerDown={onChunkPointerDown}
                title={t('ed.importHint')}
              >
                <span aria-hidden="true">⠿</span> {chunk.label} — {chunk.events}{' '}
                {pluralWord(lang, 'ed.unit.event', chunk.events)}
                {chunk.files > 0 && (
                  <>
                    {' '}
+ {chunk.files} {pluralWord(lang, 'ed.unit.file', chunk.files)}
                  </>
                )}
              </button>
              {/* Вес вложений куска: импорт подчиняется пределу проекта, и об
                  отказе лучше знать до перетаскивания, а не после. */}
              {chunkWeight?.warning && (
                <p className="ed-import__quota" role="status" data-ed-import-quota>
                  {chunkWeight.warning}
                </p>
              )}
              {/* Место можно выбрать и списком: перетаскивание на тач-устройствах
                  конкурирует с прокруткой, а с клавиатуры его не сделать вовсе. */}
              <label className="ed-import__mode">
                <span className="muted">{t('ed.place')}</span>
                <select
                  value={chunkMode}
                  onChange={(e) => setChunkMode(e.target.value as ChunkMode)}
                  aria-label={t('ed.placeAria')}
                >
                  {(Object.keys(CHUNK_MODE_TEXT) as ChunkMode[]).map((mode) => (
                    <option key={mode} value={mode}>{CHUNK_MODE_TEXT[mode]}</option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={insertChunkByMode} disabled={importBusy}>
              {t('ed.insert')}
</button>
              <button
                type="button"
                className="secondary"
                onClick={() => setChunk(null)}
                disabled={importBusy}
              >
              {t('ed.cancel')}
</button>
            </>
          )}
        </div>
      )}

      {syncNote && <p className="muted ed-panel__note">{syncNote}</p>}
      {filesNote && <p className="ed-panel__note ed-panel__note--upload">{filesNote}</p>}
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

      {/* Связи проекта живут в отдельной области «Связи» (0.79.0): граф и карточки мира — это
          не правка текста, и в общей колонке они мешали друг другу (форма создания карточки
          оказывалась между «+ глава» и фильтром дерева). Здесь остаётся только то, что про
          кадры: фильтр дерева по карточке и упоминания под редактором. */}

      <div className="ed-panel__grid">
        <nav
          className={drag ? 'ed-nav ed-nav--dragging' : 'ed-nav'}
          aria-label={t('ed.eventsListAria')}
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
                title={t('ed.rowTooltip', { number: row.number, title: row.title })}
                aria-label={t('ed.rowAria', { number: row.number, title: row.title })}
              >
                <span className="ed-row__grip" aria-hidden="true">⠿</span>
                <span className="ed-row__mark">{row.isChapter ? '#' : '└'}</span>
                <span className="ed-row__name">{row.title}</span>
                {/* Сниппет — только у попаданий в ТЕКСТ: по названию не всегда видно,
                    почему кадр в результатах поиска. Строкой ниже, а не вместо названия:
                    название остаётся ориентиром в дереве. */}
                {snippets.has(row.id) && (
                  <span className="ed-row__snippet" data-ed-snippet>
                    {snippets.get(row.id)}
                  </span>
                )}
                {/* Отметки соседей — до бейджа под-событий: имя строки обрезается
                    многоточием, и «кто здесь» не должно уезжать за край первым. */}
                {editors.length > 0 && (
                  <span className="ed-row__peers">
                    {editors.map((peer) => (
                      <span
                        key={peer.clientId}
                        className="ed-row__peer"
                        data-peer-editing={peer.name}
                        title={t('ed.peerEditing', { name: peer.name })}
                        aria-label={t('ed.peerEditing', { name: peer.name })}
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
<span className="ed-row__typing-short" aria-hidden="true">{t('ed.typing')}</span>
                  </span>
                )}
                {row.childCount > 0 && <span className="ed-row__badge">{row.childCount}</span>}
                {/* Сколько замечаний у кадра: без этого комментарий пишется в пустоту —
                    его никто не заметит, пока сам не откроет кадр. Новые выделены
                    акцентом: «здесь есть что прочитать». */}
                {(commentCounts[row.id] ?? 0) > 0 && (
                  <span
                    className={[
                      'ed-row__comments',
                      (unseenCounts[row.id] ?? 0) > 0 ? 'ed-row__comments--new' : '',
                    ].filter(Boolean).join(' ')}
                    data-comment-count={commentCounts[row.id]}
                    data-comment-unseen={unseenCounts[row.id] ?? 0}
                    title={
                      (unseenCounts[row.id] ?? 0) > 0
? t('ed.commentsTitleNew', { count: commentCounts[row.id], new: unseenCounts[row.id] })
: t('ed.commentsTitle', { count: commentCounts[row.id] })
                    }
                    aria-label={
                      (unseenCounts[row.id] ?? 0) > 0
? t('ed.commentsTitleNew', { count: commentCounts[row.id], new: unseenCounts[row.id] })
: t('ed.commentsTitle', { count: commentCounts[row.id] })
                    }
                  >
                    {commentCounts[row.id]}
                  </span>
                )}
              </button>
            )
          })}
          {visibleRows.length === 0 && <p className="muted">{t('ed.nothingFound')}</p>}
        </nav>

        <div className="ed-editor">
          {selectedMap ? (
            <>
              <div className="ed-editor__head">
                <strong className="ed-editor__path">
{selectedRow?.isChapter ? t('ed.chapter') : t('ed.subEvent')} · {selectedRow?.title ?? ''}
                </strong>
              </div>
              <EventEditor
                ymap={selectedMap}
                assets={assets}
                images={images}
                assetUrls={assetUrls}
                background={background}
                onUpload={(file) => uploadAndAttachMany([file])}
                onUploadMany={uploadAndAttachMany}
                onAttach={attach}
                onDetach={detach}
                onBackgroundChange={changeBackground}
                onChange={() => scheduleSync()}
                onTyping={markTyping}
                onFragmentSelected={(fragment: FrameFragment) =>
                  setPendingAnchor({ field: 'body', ...fragment })
                }
                focusRange={focusRange}
                docxStyles={docxStyles}
              />
              <p className="muted ed-editor__hint">
                {t('ed.autosave')}
              </p>
              {/* Упоминания карточек мира в этом кадре (0.68.0): кто здесь назван. Клик ведёт
                  к самому месту в тексте, поэтому список — не «сводка», а навигация. */}
              <FrameMentions
                hasEntities={entities.length > 0}
                mentions={selectedMentions}
                onShow={(mention: Mention) => {
                  setFocusRange((current) => ({
                    field: mention.field,
                    from: mention.from,
                    to: mention.to,
                    nonce: (current?.nonce ?? 0) + 1,
                  }))
                }}
              />
              {projectId && selectedId && (
                <FrameComments
                  projectId={projectId}
                  eventId={selectedId}
                  canEdit={canEdit === true}
                  onCountChange={noteCommentCount}
                  ymap={selectedMap}
                  pendingAnchor={pendingAnchor}
                  onAnchorConsumed={() => setPendingAnchor(null)}
                  onAnchorClear={() => setPendingAnchor(null)}
                  onShowFragment={(range) =>
                    setFocusRange((current) => ({ ...range, nonce: (current?.nonce ?? 0) + 1 }))
                  }
                />
              )}
            </>
          ) : (
            <p className="muted">{t('ed.selectPrompt')}</p>
          )}
        </div>
      </div>

      <ProjectFiles
        assets={assets}
        usage={assetUsage ?? null}
        attached={usedAssetIds}
        frames={frames}
        busyId={assetBusyId ?? null}
        note={assetNote ?? filesNote ?? null}
        onDelete={(asset) => onDeleteAsset?.(asset)}
        onUploadFiles={uploadProjectFiles}
        onMove={moveAsset}
      />

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
