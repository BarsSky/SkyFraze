import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { yEnsureEventIds, yEventParentId, type YArray, type YMap } from '../../collab/yprovider'
import { textString, titleString } from '../../collab/text'
import { getScrollRoot, prefersReducedMotion, visibleBox } from './scrollRoot'
import { stageIsActive } from './stageVisibility'
import {
  CHAPTER_ACCENTS_DARK,
  CHAPTER_ACCENTS_LIGHT,
  TRACK_VH_PER_UNIT,
  buildTimelineModel,
  eventFrames,
  frameLabel,
  framePosition,
  resolveScrollState,
  scrollDeltaForFrame,
  unitsBeforeChapter,
  unitsBeforeFrame,
  type StageAsset,
  type StageEvent,
  type StageState,
  type TimelineFrame,
} from './timelineModel'
import { useTheme } from '../../store/theme'
import { useT } from '../../i18n'
import { useLang } from '../../store/lang'
import { SkyLayer } from './stage/SkyLayer'
import { SceneFrame } from './stage/SceneFrame'
import { CopyPanel } from './stage/CopyPanel'
import { quoteScrollOffset } from '../../lib/quoteHighlight'

import { RouteTree } from './stage/RouteTree'
import { ChapterChips } from './stage/ChapterChips'
import { StageTopBar } from './stage/StageTopBar'

/**
 * Сколько держится «показ фразы» (0.135.0).
 *
 * Дольше подсветки (8 с в панели кадра): человеку нужно время прочитать строку в окружении, а
 * «прыжок назад» посреди чтения хуже, чем показанное место. Раньше срока показ снимают прокрутка
 * человека, смена кадра и новый запрос.
 */
const REVEAL_HOLD_MS = 12_000

export interface AssetLookup {
  url: string
  mime: string
}

interface Props {
  events: YArray
  /** id ассета → url/mime (для фонов кадров и картинок событий) */
  assetsById: Record<string, AssetLookup>
  projectTitle?: string
  /** Кнопки страницы в верхней панели стадии. */
  actions?: ReactNode
  /** Блок под навигацией кадра (например, оценка и просмотры публичной истории). */
  copyFooter?: ReactNode
  /**
   * Кадр, к которому надо перейти (0.87.0): из «Связей» человек нажимает «К проекту» во
   * всплывающей карточке упоминания, и показ проекта должен встать на этот кадр.
   *
   * `nonce` нужен, чтобы повторный выбор того же кадра снова двигал прокрутку: по одному `id`
   * эффект не сработал бы второй раз.
   */
  focusFrame?: { id: string; nonce: number } | null
  /**
   * Фразу в кадре подсветить (0.133.0): «показать в проекте» из чата и из редакторов.
   *
   * Передаётся пропсом, а не событием: покадровая панель монтируется только для активного кадра, и
   * событие, отправленное до перехода, слышать было бы некому — ровно та же причина, по которой
   * переход к кадру из «Связей» идёт пропсом (см. `focusFrame`).
   */
  highlight?: { frameId: string; quote: string; nonce: number } | null
  /**
   * Кто смотрит (0.136.0): участник видит меню выделения с чатом, помощником и правкой, читатель
   * публичной истории — одно действие, «ссылка на фразу».
   */
  audience?: 'members' | 'readers'
}

interface EventMeta {
  id: string
  parentId: string | null
  title: string
  body: string
  assetIds: string[]
  bgKind: 'inherit' | 'tone' | 'asset'
  bgTone?: string
  bgAssetId?: string
  eventDate: string | null
}

function normalizeBgKind(value: unknown): 'inherit' | 'tone' | 'asset' {
  return value === 'tone' || value === 'asset' ? value : 'inherit'
}

/**
 * Первый содержательный блок ПОСЛЕ стадии (панель редакторов).
 *
 * Нужен, чтобы понять, когда стадия перестала быть нужной: в потоке под ней живут
 * редакторы, и её fixed-слой не должен их перекрывать. Пустые обёртки (например, бар
 * присутствия без соседей) пропускаем: у них нулевая высота, и «входом в экран» они
 * ничего не значат.
 */
function nextBlockAfter(track: HTMLElement): HTMLElement | null {
  let node = track.parentElement?.nextElementSibling as HTMLElement | null
  while (node) {
    if (node.getBoundingClientRect().height > 1) return node
    node = node.nextElementSibling as HTMLElement | null
  }
  return null
}

function resolveAssets(assetIds: string[], lookup: Record<string, AssetLookup>): StageAsset[] {
  const out: StageAsset[] = []
  for (const id of assetIds) {
    const found = lookup[id]
    if (found) out.push({ id, url: found.url, mime: found.mime })
  }
  return out
}

/**
 * Сценический таймлайн: fixed-стадия + невидимый трек скролла.
 *
 * Каждое событие — отдельный кадр: глава, затем по одному все её под-события
 * (и их под-шаги), поэтому глава полностью «разворачивает» вложенность, прежде
 * чем трек перейдёт к следующей главе. Фон кадра настраивается на событии.
 *
 * Раскладка одна и та же — fixed-сцена плюс трек прокрутки, — а ширина решает,
 * что видно в кадре. На широком экране места хватает и на картинку, и на текст:
 * фон кадра (в том числе фотография) остаётся позади копирайта. На телефоне на
 * двоих места нет, поэтому элементы идут ДРУГ ЗА ДРУГОМ отдельными кадрами:
 * текст главы → её картинки → текст под-события → его картинки → следующая глава.
 * Кадр события занимает экран текстом (фотография под ним скрыта стилями — у неё
 * есть собственный кадр), кадр-картинка показывает снимок с одной строкой подписи.
 * Прокрутка всюду листает кадры, а не тянет «простыню» документа.
 *
 * Стадия занимается только показом и навигацией: редактор — отдельный модуль.
 */
export function TimelineStage({
  events, assetsById, projectTitle, actions, copyFooter, focusFrame, highlight,
  audience = 'members',
}: Props) {
  // Карта файлов проекта (id → адрес) для текста кадра: в тексте могут быть ссылки
  // на вложения (`/api/assets/<id>`), и без подмены они не откроются в приложении.
  const assetUrls = useMemo(() => {
    const map: Record<string, string> = {}
    for (const [id, asset] of Object.entries(assetsById)) map[id] = asset.url
    return map
  }, [assetsById])
  const [theme] = useTheme()
  const t = useT()
  const [lang] = useLang()
  const trackRef = useRef<HTMLDivElement>(null)
  const stageActiveRef = useRef(true)
  const [meta, setMeta] = useState<EventMeta[]>([])
  const [state, setState] = useState<StageState>(() =>
    resolveScrollState({ chapters: [], totalWeight: 0, frameCount: 0 }, 0),
  )
  const [stageActive, setStageActive] = useState(true)

  // Пока сцена на экране, шапка приложения должна быть плотной: она полупрозрачная
  // («стекло» с блюром), и текст кадра, уходя под неё, просвечивал — название главы
  // визуально смешивалось с шапкой. Класс на <html> ловит CSS; вне сцены стекло
  // возвращается (список проектов, лента).
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('sf-stage-on', stageActive)
    return () => root.classList.remove('sf-stage-on')
  }, [stageActive])

  /**
   * Пересчёт «сцена на экране» по факту положения, а не только по кадровому циклу (0.72.1).
   *
   * Зачем отдельно от rAF-цикла: цикл крутится постоянно, но у него есть состояния, в которых
   * он не успевает — фоновая вкладка (браузер душит requestAnimationFrame), тяжёлая отрисовка,
   * программный скролл. Если в такой момент сцена уже ушла с экрана, её полоска гасла и
   * возвращалась только после перезагрузки: состояние менялось лишь внутри цикла, а
   * CSS-переход оставался в «погашенном» виде. Теперь то же вычисление вызывается ещё и на
   * scroll/resize/visibilitychange, поэтому возврат наверх возвращает полоску всегда.
   */
  const applyStageVisibility = useCallback(() => {
    const track = trackRef.current
    if (!track) return
    const box = visibleBox(null)
    const rect = track.getBoundingClientRect()
    const nextBlock = nextBlockAfter(track)
    const inView = stageIsActive({
      trackTop: rect.top,
      trackBottom: rect.bottom,
      boxTop: box.top,
      boxBottom: box.bottom,
      nextTop: nextBlock ? nextBlock.getBoundingClientRect().top : null,
    })
    if (inView !== stageActiveRef.current) {
      stageActiveRef.current = inView
      setStageActive(inView)
    }
  }, [])

  useEffect(() => {
    applyStageVisibility()
    const root = trackRef.current ? getScrollRoot(trackRef.current) : null
    const onScroll = () => applyStageVisibility()
    // scroll не всплывает — ловим на фазе перехвата, иначе прокрутка вложенного `main`
    // не была бы слышна на document.
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    if (root && root !== document.documentElement) {
      root.addEventListener('scroll', onScroll, { passive: true })
    }
    window.addEventListener('resize', onScroll)
    document.addEventListener('visibilitychange', onScroll)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (root && root !== document.documentElement) root.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('visibilitychange', onScroll)
    }
  }, [applyStageVisibility])

  // Высоту шапки приложения измеряет САМА шапка (0.86.0, Header.tsx) и отдаёт в --sf-header-h.
  //
  // Почему мера переехала: с 0.83.0 стадия живёт только на вкладке «Проект»; её размонтирование
  // снимало переменную, и на «Редакторах»/«Связях»/«Версиях» полоса вкладок вставала на запасные
  // 46 px под реальной шапкой 62 px — верх вкладок был скрыт (отчёт: «меню накрывает кнопки
  // переключения»). Здесь меры больше нет, иначе два наблюдателя спорили бы за одну переменную.

  // ── Данные из CRDT: тексты, вложения и настройки фона кадра
  useEffect(() => {
    if (!events) return
    yEnsureEventIds(events)
    const update = () => {
      const arr = events.toArray() as YMap[]
      setMeta(
        arr
          .map((m) => ({
            id: (m.get('id') as string | undefined) ?? '',
            parentId: yEventParentId(m),
            title: titleString(m),
            body: textString(m, 'body').trim(),
            assetIds: ((m.get('assets') as string[] | undefined) ?? []).filter(Boolean),
            bgKind: normalizeBgKind(m.get('bg_kind')),
            bgTone: (m.get('bg_tone') as string | undefined) || undefined,
            bgAssetId: (m.get('bg_asset') as string | undefined) || undefined,
            eventDate: (m.get('event_date') as string | undefined) ?? null,
          }))
          .filter((e) => e.id.length > 0),
      )
    }
    update()
    events.observeDeep(update)
    return () => events.unobserveDeep(update)
  }, [events])

  const items = useMemo<StageEvent[]>(
    () =>
      meta.map((m, i) => ({
        id: m.id,
        parentId: m.parentId,
        title: m.title,
        body: m.body,
        flatIndex: i,
        assets: resolveAssets(m.assetIds, assetsById),
        bgKind: m.bgKind,
        bgTone: m.bgTone,
        bgAssetId: m.bgAssetId,
        eventDate: m.eventDate,
      })),
    [meta, assetsById],
  )

  const accents = theme === 'light' ? CHAPTER_ACCENTS_LIGHT : CHAPTER_ACCENTS_DARK
  const model = useMemo(() => buildTimelineModel(items, accents, lang), [items, accents, lang])

  // Высота полосы чипов (переключение по событиям): сцена и лист кадра начинаются
  // ПОД ней, поэтому чипы никогда не налезают на картинку. Зависимость от наличия
  // глав: пока события не приехали, чипов в дереве нет, и замер без неё остался бы
  // нулевым навсегда.
  const hasChapters = model.chapters.length > 0
  useEffect(() => {
    const chips = document.querySelector<HTMLElement>('.sf-chips')
    if (!chips) {
      document.documentElement.style.setProperty('--sf-chips-h', '0px')
      return undefined
    }
    const apply = () => {
      const visible = getComputedStyle(chips).display !== 'none'
      const h = visible ? Math.round(chips.getBoundingClientRect().height) : 0
      document.documentElement.style.setProperty('--sf-chips-h', `${h}px`)
    }
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    ro?.observe(chips)
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      document.documentElement.style.removeProperty('--sf-chips-h')
    }
  }, [hasChapters])

  // Плоский список кадров по всему таймлайну — для переходов «назад/дальше»
  // сквозь главы (а не только внутри текущей). Кадры-картинки тоже участвуют:
  // листать фотографии события нужно и кнопками, не только прокруткой.
  const flatFrames = useMemo(
    () =>
      model.chapters.flatMap((chapter) =>
        chapter.frames.map((frame, frameIndex) => ({
          id: frame.id,
          number: frame.number,
          label: frameLabel(frame, lang),
          chapterIndex: chapter.chapterIndex,
          frameIndex,
        })),
      ),
    [model.chapters],
  )

  // ── Текст кадра раскрывается прокруткой, а не собственной полосой листа.
  //
  // У листа была своя прокрутка — последняя в цепочке (лист в fixed-слое), из-за
  // чего палец над текстом упирался в её конец. Теперь положение текста задаёт
  // прогресс кадра: вес кадра вырос на длину текста (textUnits в модели), и за
  // время кадра текст проезжает целиком. Ведём его прямо из кадрового цикла, а не
  // через состояние: состояние квантовано (1/50 кадра), и на длинной главе шаг
  // кванта — это сотни пикселей, текст дёргался бы.
  const frameLocalRef = useRef(0)
  /**
   * Пока идёт «показ фразы» — цель прокрутки текста задаёт фраза, а не прогресс кадра (0.135.0).
   *
   * Зачем. Текст длинного кадра проезжает по мере прокрутки страницы (`scrollTop` считается из
   * прогресса), поэтому подсветка фразы ближе к концу листа оказывалась за кромкой: кадр открыт,
   * фраза подсвечена, а «строчки» не видно. Пока override жив, `driveText` ставит лист на фразу.
   *
   * Снимается он раньше срока, если человек сам начал листать (иначе текст «дерётся» с прокруткой),
   * и при смене кадра: показ относится к одному кадру.
   */
  const revealRef = useRef<{
    quote: string
    frameId: string
    until: number
    nextCheck: number
    target: number | null
  } | null>(null)
  const driveText = useCallback(() => {    const scroll = document.querySelector<HTMLElement>('.sf-copy__scroll')
    if (!scroll) return
    const max = scroll.scrollHeight - scroll.clientHeight
    if (max <= 0) return
    // Переполнение помечаем классом: по нему CSS добавляет листу мягкие края,
    // чтобы уходящие за срез строки не обрывались резкой линией. Короткому тексту
    // класс не ставим — там маска затенила бы сам заголовок.
    const long = max > 24
    if (scroll.classList.contains('sf-copy__scroll--long') !== long) {
      scroll.classList.toggle('sf-copy__scroll--long', long)
    }
    // Показ фразы перебивает прогресс: лист стоит на ней, пока человек сам не тронул прокрутку.
    // Цель пересчитываем на ходу: пока кадр входит, высота листа и длина текста меняются (шрифты,
    // появление навигации), и посчитанное один раз смещение устаревает — фраза оставалась за
    // кромкой (0.135.0). Раз в 150 мс достаточно: чаще содержимое не меняется.
    const reveal = revealRef.current
    let revealTarget: number | null = null
    if (reveal !== null && reveal.until > Date.now()) {
      const now = Date.now()
      if (reveal.target === null || now >= reveal.nextCheck) {
        reveal.nextCheck = now + 150
        const found = quoteScrollOffset(scroll, reveal.quote)
        if (found !== null) {
          reveal.target = Math.min(Math.max(found.top - scroll.clientHeight / 3, 0), max)
        }
      }
      revealTarget = reveal.target
    }
    const target = Math.round(
      revealTarget !== null ? revealTarget : max * Math.min(1, Math.max(0, frameLocalRef.current)),
    )
    if (Math.abs(scroll.scrollTop - target) > 1) scroll.scrollTop = target
  }, [])

  /**
   * Подкрутить лист к найденной фразе (0.135.0).
   *
   * Кадр мог ещё не переключиться (страница просит переход и подсветку одновременно), поэтому
   * пробуем несколько раз: как только в листе появился текст нужного кадра и фраза нашлась —
   * ставим override и больше не ищем. Человек тронул прокрутку — показ снимается, дальше текст
   * ведёт прогресс, как обычно.
   */
  useEffect(() => {
    if (!highlight?.quote) return undefined
    const quote = highlight.quote
    const frameId = highlight.frameId
    let cancelled = false
    let tries = 0
    let timer = 0
    let hold = 0
    const stop = () => {
      revealRef.current = null
      window.clearTimeout(hold)
    }
    const attempt = () => {
      if (cancelled) return
      tries += 1
      const scroll = document.querySelector<HTMLElement>('.sf-copy__scroll')
      const body = scroll?.querySelector<HTMLElement>('[data-frame-body]')
      if (scroll && body && body.getAttribute('data-frame-body') === frameId) {
        if (quoteScrollOffset(scroll, quote) !== null) {
          // Запоминаем ФРАЗУ, а не её смещение: цель прокрутки `driveText` пересчитывает сам, пока
          // показ жив — высота листа меняется вместе с входом кадра.
          revealRef.current = {
            quote,
            frameId,
            until: Date.now() + REVEAL_HOLD_MS,
            nextCheck: 0,
            target: null,
          }
          driveText()
          window.clearTimeout(hold)
          hold = window.setTimeout(() => {
            revealRef.current = null
            driveText()
          }, REVEAL_HOLD_MS)
          return
        }
      }
      if (tries < 120) timer = window.setTimeout(attempt, 100)
    }
    attempt()
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('touchmove', stop, { passive: true })
    window.addEventListener('keydown', stop)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(hold)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchmove', stop)
      window.removeEventListener('keydown', stop)
    }
  }, [driveText, highlight?.frameId, highlight?.nonce, highlight?.quote])

  /**
   * Смена кадра снимает показ фразы (0.135.0): просьба относилась к одному кадру, и держать
   * текст следующего кадра на чужой позиции нельзя.
   */
  useEffect(() => {
    const reveal = revealRef.current
    if (reveal !== null && reveal.frameId !== state.frame?.id) {
      revealRef.current = null
      driveText()
    }
  }, [driveText, state.frame?.id])

  // ── Скролл → состояние кадра. Значения квантуются: плавность даёт CSS.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    let raf = 0
    let last = { chapter: -1, frame: -2, transition: -1, local: -1 }

    const tick = () => {
      const box = visibleBox(null)
      const rect = track.getBoundingClientRect()
      const viewport = Math.max(1, box.bottom - box.top)
      const scrollable = Math.max(1, rect.height - viewport)
      const passed = box.top - rect.top
      const progress = Math.max(0, Math.min(1, passed / scrollable))
      const next = resolveScrollState(model, progress * model.totalWeight)
      frameLocalRef.current = next.frameLocal
      driveText()

      // Стадия живёт, пока трек занимает экран И под ним ещё не показался следующий
      // блок (панель редакторов). Иначе её fixed-слои перекрывают редактор и крадут
      // по нему клики: человек видел «пустую область» вместо панели, пока не долистает
      // до конца. Решение — в stageIsActive (там же тесты).
      const nextBlock = nextBlockAfter(track)
      const inView = stageIsActive({
        trackTop: rect.top,
        trackBottom: rect.bottom,
        boxTop: box.top,
        boxBottom: box.bottom,
        nextTop: nextBlock ? nextBlock.getBoundingClientRect().top : null,
      })
      if (inView !== stageActiveRef.current) {
        stageActiveRef.current = inView
        setStageActive(inView)
      }

      const qTransition = Math.round(next.transition * 20) / 20
      const qLocal = Math.round(next.frameLocal * 50) / 50
      if (
        next.chapterIndex !== last.chapter ||
        next.frameIndex !== last.frame ||
        qTransition !== last.transition ||
        qLocal !== last.local
      ) {
        last = { chapter: next.chapterIndex, frame: next.frameIndex, transition: qTransition, local: qLocal }
        setState({ ...next, transition: qTransition, frameLocal: qLocal })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [model, driveText])

  // ── Переход к кадру из другого места приложения (0.87.0).
  //
  // «Связи» → всплывающая карточка упоминания → «К проекту»: человек уже видел цитату и ждёт
  // ровно этот кадр, а не начало истории. Прокрутка стадии — это вес кадров, поэтому позицию
  // берём из модели (`framePosition` + `unitsBeforeFrame`), а не «примерно туда»: трек
  // выравниваем по видимой области и добавляем долю, которую занимают кадры до нужного.
  //
  // rAF, а не сразу: при переключении вкладки стадия монтируется в этом же кадре, и до первой
  // раскладки `getBoundingClientRect` вернул бы нули.
  useEffect(() => {
    if (!focusFrame?.id) return undefined
    const raf = requestAnimationFrame(() => {
      const track = trackRef.current
      if (!track) return
      const position = framePosition(model, focusFrame.id)
      if (!position) return
      const box = visibleBox(null)
      const rect = track.getBoundingClientRect()
      const delta = scrollDeltaForFrame({
        trackTop: rect.top,
        boxTop: box.top,
        trackHeight: rect.height,
        viewport: box.bottom - box.top,
        model,
        position,
      })
      const root = getScrollRoot(track)
      // Корня прокрутки может не быть (стадия ещё не в документе) — тогда двигать нечего.
      if (!root) return
      if (root === document.scrollingElement) window.scrollBy(0, delta)
      else root.scrollTop += delta
      applyStageVisibility()
    })
    return () => cancelAnimationFrame(raf)
    // nonce — часть зависимости: повторный выбор того же кадра тоже должен двигать прокрутку.
  }, [focusFrame?.id, focusFrame?.nonce, model])

  // ── Жест над листом кадра ведёт трек, а не упирается в лист.
  //
  // Лист лежит в fixed-слое (.sf-copylayer), поэтому его прокрутка — последняя в
  // цепочке: за ней нет прокручиваемого предка (страница едет во вложенном `main`,
  // а не в body). Отсюда две беды: палец над текстом не листал историю вообще, а
  // дойдя до конца длинного текста — не переходил к картинкам. Здесь мы доводим
  // жест до трека. Право на жест блок получает только если пользователь реально
  // может его прокрутить: текст кадра ведёт прогресс кадра (см. эффект ниже), а не
  // палец, поэтому обычно жест сразу идёт по треку.
  const userScrollable = (el: HTMLElement): boolean => {
    const overflowY = getComputedStyle(el).overflowY
    return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1
  }
  useEffect(() => {
    const track = trackRef.current
    if (!track) return undefined
    const root = getScrollRoot(track)
    const pageBy = (dy: number) => {
      if (!Number.isFinite(dy) || Math.abs(dy) < 0.5) return
      if (root && root !== document.scrollingElement) root.scrollTop += dy
      else window.scrollBy(0, dy)
    }
    /** Лист кадра под пальцем (null — жест не над листом, это не наша забота). */
    const sheetUnder = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null
      return target.closest<HTMLElement>('.sf-copy')
    }
    /**
     * Блок внутри листа, который пользователь может прокрутить сам.
     * Своей прокрутки у листа нет ни на одной ширине (текст ведёт прогресс кадра),
     * поэтому обычно это null — и тогда жест целиком ведёт трек.
     */
    const userScrollerIn = (copy: HTMLElement): HTMLElement | null => {
      const inner = copy.querySelector<HTMLElement>('.sf-copy__scroll')
      if (inner && userScrollable(inner)) return inner
      return userScrollable(copy) ? copy : null
    }
    const atEdge = (el: HTMLElement, dy: number): boolean => {
      if (dy > 0) return el.scrollTop + el.clientHeight >= el.scrollHeight - 2
      return el.scrollTop <= 2
    }
    const onWheel = (e: WheelEvent) => {
      const copy = sheetUnder(e.target)
      if (!copy) return
      const scroller = userScrollerIn(copy)
      if (!scroller || atEdge(scroller, e.deltaY)) pageBy(e.deltaY)
    }
    let touchSheet: HTMLElement | null = null
    let touchScroller: HTMLElement | null = null
    let lastY = 0
    const onTouchStart = (e: TouchEvent) => {
      touchSheet = sheetUnder(e.target)
      touchScroller = touchSheet ? userScrollerIn(touchSheet) : null
      lastY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!touchSheet) return
      const y = e.touches[0]?.clientY
      if (y === undefined) return
      const dy = lastY - y
      lastY = y
      if (!touchScroller || atEdge(touchScroller, dy)) pageBy(dy)
    }
    const onTouchEnd = () => {
      touchSheet = null
      touchScroller = null
    }
    document.addEventListener('wheel', onWheel, { passive: true })
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('wheel', onWheel)
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [hasChapters])

  // ── Текст кадра раскрывается прокруткой, а не собственной полосой листа.
  //
  // У листа была своя прокрутка — последняя в цепочке (лист в fixed-слое), из-за
  // чего палец над текстом упирался в её конец. Теперь положение текста задаёт
  // прогресс кадра: вес кадра вырос на длину текста (textUnits в модели), и за
  // время кадра текст проезжает целиком. Плавное движение ведёт кадровый цикл
  // (см. driveText), а здесь выставляем позицию сразу при смене кадра и при
  // дорисовке содержимого (формулы, диаграммы, картинки меняют высоту текста).
  useLayoutEffect(() => {
    driveText()
    const scroll = document.querySelector<HTMLElement>('.sf-copy__scroll')
    if (!scroll || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => driveText())
    ro.observe(scroll)
    return () => ro.disconnect()
  }, [state.frame?.id, driveText])

  const jumpToUnits = useCallback(
    (units: number) => {
      const track = trackRef.current
      if (!track) return
      const root = getScrollRoot(track)
      const rect = track.getBoundingClientRect()
      // Прогресс стадия считает от ВЕРХА ОКНА (см. tick выше), а скролл идёт во
      // вложенном контейнере (`main` под шапкой). Раньше цель считалась в
      // координатах контейнера с pxPerUnit = высота трека / вес: переход целился
      // на главную высоту выше и на столько же «не доезжал». На большом экране
      // промах тонул в окне кадра, а на маленьком телефоне (шапка выше, трек
      // делён на меньшее число пикселей) кнопка «дальше» вообще не двигала кадр.
      const viewport = Math.max(1, window.innerHeight)
      const scrollable = Math.max(1, rect.height - viewport)
      const totalWeight = Math.max(0.0001, model.totalWeight)
      // +2px: `unitsBeforeFrame` даёт НАЧАЛО кадра, а браузер округляет scrollTop
      // до целых пикселей — без запаса прыжок вставал ровно на границу и читался
      // как предыдущий кадр (на 320px кнопка «дальше» вообще не двигала кадр).
      const target = Math.max(0, Math.min(scrollable, (units / totalWeight) * scrollable + 2))
      const delta = rect.top + target
      const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
      if (root && root !== document.scrollingElement) {
        root.scrollTo({ top: root.scrollTop + delta, behavior })
      } else {
        window.scrollTo({ top: window.scrollY + delta, behavior })
      }
    },
    [model.totalWeight],
  )

  const jumpToChapter = useCallback(
    (chapterIndex: number) => jumpToUnits(unitsBeforeChapter(model, chapterIndex)),
    [model, jumpToUnits],
  )

  const jumpToFrame = useCallback(
    (chapterIndex: number, frameIndex: number) => jumpToUnits(unitsBeforeFrame(model, chapterIndex, frameIndex)),
    [model, jumpToUnits],
  )

  // Автопереходов нет: создание события в редакторе не должно уводить стадию —
  // пользователь остаётся в редакторе и правит текст.

  // Высота подписи кадра-картинки (--sf-photo-h): на телефоне снимок занимает сцену
  // целиком, а подпись лежит поверх её нижнего края. Отступ снизу у снимка должен
  // равняться высоте подписи — иначе либо подпись накрывает фотографию, либо между
  // ними остаётся пустая полоса. Высоту мерим, а не считаем в vh: она зависит от
  // длины названия, шрифта и safe-area. useLayoutEffect — чтобы до отрисовки кадра
  // отступ уже был верным и снимок не «прыгал».
  const frameId = state.frame?.id ?? ''
  const frameKind = state.frame?.kind ?? ''
  useLayoutEffect(() => {
    const panel = document.querySelector<HTMLElement>('.sf-copy--photo')
    const apply = () => {
      const h = panel ? Math.round(panel.getBoundingClientRect().height) : 0
      document.documentElement.style.setProperty('--sf-photo-h', `${h}px`)
    }
    apply()
    const ro = panel && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    if (ro && panel) ro.observe(panel)
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      document.documentElement.style.removeProperty('--sf-photo-h')
    }
  }, [frameId, frameKind])

  if (!events || model.chapters.length === 0) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center' }}>
        <p className="muted">{t('stage.empty')}</p>
      </div>
    )
  }

  const chapter = state.chapter
  const frame = state.frame ?? chapter?.frames[0] ?? null
  const accent = frame?.accent ?? accents[0]
  const flatIndex = frame ? flatFrames.findIndex((entry) => entry.id === frame.id) : -1
  const prevEntry = flatIndex > 0 ? flatFrames[flatIndex - 1] : undefined
  const nextEntry = flatIndex >= 0 && flatIndex < flatFrames.length - 1 ? flatFrames[flatIndex + 1] : undefined

  // Видимые слои: активный кадр + предыдущий (кроссфейд внутри главы и на стыке глав).
  const layers: Array<{ frame: TimelineFrame; role: 'active' | 'previous' }> = []
  if (frame && chapter) {
    layers.push({ frame, role: 'active' })
    if (state.frameIndex > 0) {
      const previous = chapter.frames[state.frameIndex - 1]
      if (previous) layers.push({ frame: previous, role: 'previous' })
    } else if (state.chapterIndex > 0) {
      const previousChapter = model.chapters[state.chapterIndex - 1]
      const previous = previousChapter?.frames[previousChapter.frames.length - 1]
      if (previous) layers.push({ frame: previous, role: 'previous' })
    }
  }

  return (
    <div
      className="sf-root"
      data-stage={stageActive ? 'active' : 'idle'}
      data-chapter={chapter?.number ?? ''}
      data-frame-number={frame?.number ?? ''}
      data-frame-kind={frame?.kind ?? ''}
      data-frame-index={state.frameIndex}
      data-frames-in-chapter={chapter ? eventFrames(chapter.frames).length : 0}
      /* Вход кадра нужен и CSS: на телефоне лист копирайта выезжает снизу, пока
         кадр входит (--sf-frame-enter 0→1 за первые 22% окна кадра), поэтому текст
         раскрывается постепенно, а не вываливается целиком сразу. */
      style={{ ['--sf-accent' as string]: accent, ['--sf-frame-enter' as string]: state.transition }}
    >
      <div className="sf-progress" aria-hidden>
        <span style={{ transform: `scaleX(${state.progress})` }} />
      </div>

      <StageTopBar
        projectTitle={projectTitle}
        chapters={model.chapters}
        activeChapter={state.chapterIndex}
        onChapter={jumpToChapter}
        actions={actions}
      />

      <div className="sf-stage" aria-hidden>
        <SkyLayer accent={accent} tone={frame?.background.tone} />
        {layers.map(({ frame: layerFrame, role }) => {
          const opacity = role === 'active' ? state.transition : 1 - state.transition
          return (
            <div
              key={layerFrame.id}
              className="sf-scene"
              data-frame-id={layerFrame.id}
              data-active={role === 'active' ? 'true' : 'false'}
              style={{ opacity, zIndex: role === 'active' ? 2 : 1 }}
            >
              <SceneFrame frame={layerFrame} local={role === 'active' ? state.frameLocal : 1} />
            </div>
          )
        })}
      </div>

      <div className="sf-copylayer">
        {chapter && frame && (
          <CopyPanel
            chapter={chapter}
            frame={frame}
            onJumpFrame={jumpToFrame}
            onPrev={prevEntry ? () => jumpToFrame(prevEntry.chapterIndex, prevEntry.frameIndex) : undefined}
            onNext={nextEntry ? () => jumpToFrame(nextEntry.chapterIndex, nextEntry.frameIndex) : undefined}
            prevLabel={prevEntry?.label}
            nextLabel={nextEntry?.label}
            footer={copyFooter}
            assetUrls={assetUrls}
            highlight={highlight}
            audience={audience}
          />
        )}
      </div>

      <RouteTree
        chapters={model.chapters}
        activeChapter={state.chapterIndex}
        activeFrame={state.frameIndex}
        onChapter={jumpToChapter}
        onFrame={jumpToFrame}
      />
      <ChapterChips
        chapters={model.chapters}
        activeChapter={state.chapterIndex}
        activeFrame={state.frameIndex}
        onChapter={jumpToChapter}
        onFrame={jumpToFrame}
      />

      <div className="sf-hint" style={{ opacity: state.progress > 0.01 ? 0 : 1 }}>
        <span>{t('stage.scrollHint')}</span>
        <i />
      </div>

      <div
        className="sf-track"
        ref={trackRef}
        style={{ height: `${Math.max(1, model.totalWeight) * TRACK_VH_PER_UNIT}vh` }}
      />
    </div>
  )
}
