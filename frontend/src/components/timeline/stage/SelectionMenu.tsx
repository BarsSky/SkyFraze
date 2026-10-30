import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../../i18n'
import {
  locateQuote,
  requestQuoteToAssistant,
  requestQuoteToChat,
  requestQuoteEdit,
  type FrameQuote,
} from '../../../lib/storySelection'

/**
 * Меню выделенного фрагмента в показе проекта (0.132.0).
 *
 * Как это выглядит для человека: он выделяет фразу в кадре — рядом с выделением появляется
 * небольшое меню с тремя действиями. Не панель, не окно: меню должно быть там, где рука, и
 * исчезать, как только выделение снято.
 *
 * Почему меню в стадии, а не в шапке. Выделение живёт в тексте кадра, и уводить взгляд в шапку за
 * действием — значит терять и выделение, и место. Меню следует за выделением.
 *
 * Что считает компонент, а что — страница. Здесь только «что выделено» (цитата и смещения в
 * исходнике кадра) и три события наружу; что делать с цитатой, решает страница: открыть док на
 * вкладке чата, открыть док на помощнике или показать окно быстрой правки.
 */
interface Props {
  /** Кадр, к которому относится текст: id и заголовок нужны в ссылке и в окне правки. */
  frameId: string
  frameTitle: string
  /** Исходный Markdown кадра: по нему восстанавливаются смещения выделения. */
  source: string
}

export function SelectionMenu({ frameId, frameTitle, source }: Props) {
  const t = useT()
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [quote, setQuote] = useState<FrameQuote | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    setVisible(false)
    setQuote(null)
  }, [])

  useEffect(() => {
    const read = () => {
      const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
      const text = selection?.toString().trim() ?? ''
      if (!selection || selection.rangeCount === 0 || text === '') {
        close()
        return
      }
      // Выделение должно быть ВНУТРИ текста ИМЕННО ЭТОГО кадра: меню над выделенной подписью
      // кнопки или именем автора выглядело бы предложением, которого человек не просил. Кадр
      // ищем от самого выделения вверх, а не по документу: в стадии на экране бывает несколько
      // кадров разом (переход, соседние слайды), и первым в документе может быть не тот.
      const range = selection.getRangeAt(0)
      const anchor = range.commonAncestorContainer
      const element = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement
      const host = element?.closest('[data-frame-body]') ?? null
      if (host === null || host.getAttribute('data-frame-body') !== frameId) {
        close()
        return
      }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        close()
        return
      }
      // Выделение уехало из окна (прокрутили кадр) — держать меню над пустым местом незачем.
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        close()
        return
      }
      // Над выделением, по центру; выше экрана не уходим (тогда меню окажется под текстом).
      const top = rect.top > 56 ? rect.top - 8 : rect.bottom + 8
      /**
       * Держим меню в пределах экрана — точной подгонкой после отрисовки (`fitOnScreen`).
       *
       * Текст кадра в стадии бывает выше окна (лист кадра прокручивается), и выделение у нижней
       * кромки дало бы меню ЗА экраном: `position: fixed` не прокручивается вместе со страницей, и
       * «достать» его человек не может. Это поймал e2e-сценарий, а не глаза.
       */
      setPosition({ left: rect.left + rect.width / 2, top })
      setVisible(true)
      // Смещения ищем здесь, а не в обработчике кнопки: выделение к моменту клика уже может
      // быть снято, а `source` — исходный Markdown кадра, пришедший в пропсе.
      setQuote({ frameId, frameTitle, quote: text, range: locateQuote(source, text) })
    }

    // selectionchange приходит и на каждое движение каретки — читаем в следующем кадре, чтобы
    // не мерить геометрию до перерисовки.
    let frame = 0
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(read)
    }
    /**
     * Закрываем по нажатию ВНЕ меню — но решаем это на отпускании, а не на нажатии.
     *
     * На телефоне выделение ставят длинным нажатием, а потом тянут за ручки. Каждое такое
     * касание — `pointerdown` вне меню, и прежняя проверка закрывала меню от первого же движения:
     * человек не успевал до него добраться. Теперь: если выделение на месте — меню остаётся (оно
     * следует за выделением), а если палец снял выделение — `selectionchange` его закроет сам.
     */
    let pressedOutside = false
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = menuRef.current?.contains(event.target as Node) !== true
    }
    const onPointerUp = () => {
      const outside = pressedOutside
      pressedOutside = false
      if (!outside) return
      const text = window.getSelection()?.toString().trim() ?? ''
      if (text !== '') {
        // Выделение живо (например, тянули ручку) — просто пересчитываем место меню.
        schedule()
        return
      }
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('selectionchange', schedule)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('keydown', onKeyDown)
    // Прокрутка не закрывает меню, а пересчитывает его место: на мобильном прокрутка и выделение
    // ходят вместе, и «меню исчезло, пока тянули ручку» — не поведение, а поломка.
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [close, frameId, frameTitle, source])

  /**
   * Подогнать меню в пределы экрана после отрисовки (0.132.0).
   *
   * Почему после, а не до. Ширина меню зависит от подписей и языка, и заранее её знать нечем;
   * измеряем настоящий прямоугольник и сдвигаем ровно на столько, чтобы он влез.
   *
   * Почему с проверкой «а влезает ли вообще». Раньше сдвиг применялся без неё, и на телефоне
   * (390 px) меню шире экрана (три длинные подписи) уезжало вправо, потом влево, потом снова
   * вправо — бесконечный `setState` и «Maximum update depth exceeded». React после этого
   * размонтирует дерево: человек видит только фон без кнопок (это и было в отчёте). Поэтому:
   * не влезает — не двигаем вовсе, помещаться оно обязано по CSS (`.sf-select-menu` на узких
   * экранах складывается в столбец), а не подгонкой координат.
   */
  useLayoutEffect(() => {
    const node = menuRef.current
    if (!node || !visible) return
    const box = node.getBoundingClientRect()
    const margin = 8
    // Нулевой прямоугольник — среда без геометрии (jsdom в тестах): двигать нечего.
    if (box.width === 0 && box.height === 0) return
    const maxWidth = window.innerWidth - margin * 2
    const maxHeight = window.innerHeight - margin * 2
    if (box.width > maxWidth || box.height > maxHeight) return
    const left = Math.min(Math.max(box.left, margin), window.innerWidth - margin - box.width)
    const top = Math.min(Math.max(box.top, margin), window.innerHeight - margin - box.height)
    const dx = left - box.left
    const dy = top - box.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    setPosition((current) => ({ left: current.left + dx, top: current.top + dy }))
  }, [visible, position.left, position.top])

  if (!visible || quote === null) return null

  const act = (run: (value: FrameQuote) => void) => {
    run(quote)
    // Выделение снимаем сами: после действия меню не должно висеть над пустым местом.
    window.getSelection()?.removeAllRanges()
    close()
  }

  /**
   * Меню уходит в `document.body` порталом (0.132.0).
   *
   * Почему не на месте, внутри листа кадра. Слой текста стадии (`.sf-copylayer`) — `pointer-events:
   * none`, чтобы прокрутка шла по треку под ним; кнопка внутри такого слоя физически не получает
   * нажатий — их забирает трек (это и поймал e2e-сценарий: «sf-track intercepts pointer events»).
   * Портал снимает и это, и зависимость `position: fixed` от `transform` предков стадии.
   */
  return createPortal(
    <div
      ref={menuRef}
      className="sf-select-menu"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      role="toolbar"
      aria-label={t('sel.aria')}
      data-selection-menu
    >
      <button type="button" onClick={() => act(requestQuoteToChat)} data-selection-chat>
        {t('sel.toChat')}
      </button>
      <button type="button" onClick={() => act(requestQuoteToAssistant)} data-selection-assistant>
        {t('sel.toAssistant')}
      </button>
      <button type="button" onClick={() => act(requestQuoteEdit)} data-selection-edit>
        {t('sel.edit')}
      </button>
    </div>,
    document.body,
  )
}
