import { useEffect, useMemo, useRef } from 'react'
import 'katex/dist/katex.min.css'
import { DIAGRAM_CLASS, MATH_CLASS, renderMarkdown } from '../lib/markdown'
import { useTheme } from '../store/theme'
import { randomId } from '../lib/uuid'

interface Props {
  /** Исходный markdown-текст события. */
  source: string
  /** Класс обёртки: у кадра таймлайна свои рамки и ограничения высоты. */
  className?: string
}

/**
 * Markdown-текст: разметка, формулы и диаграммы.
 *
 * Сам HTML приходит уже очищенным (см. lib/markdown.ts), здесь только оживление
 * заготовок. KaTeX и Mermaid тянутся динамическим импортом и только когда в
 * тексте они действительно есть: диаграммы весят около мегабайта, и платить за
 * них на каждой странице с обычным текстом незачем. CSS KaTeX подключён статично
 * (это ~25 КБ правил), а шрифты браузер подтянет лишь при первом рендере формулы.
 */
export function MarkdownBlock({ source, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [theme] = useTheme()
  const result = useMemo(() => renderMarkdown(source), [source])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    let cancelled = false

    async function renderMath() {
      const nodes = Array.from(root!.querySelectorAll<HTMLElement>(`.${MATH_CLASS}`))
      if (nodes.length === 0) return
      const katex = await import('katex')
      if (cancelled) return
      for (const node of nodes) {
        if (node.dataset.sfRendered === 'math') continue
        const tex = node.textContent ?? ''
        try {
          katex.default.render(tex, node, {
            throwOnError: false,
            displayMode: node.classList.contains(`${MATH_CLASS}--block`),
            output: 'html',
          })
          node.dataset.sfRendered = 'math'
        } catch {
          // Совсем сломанную формулу показываем как есть — текст важнее.
          node.textContent = tex
        }
      }
    }

    async function renderDiagrams() {
      const nodes = Array.from(root!.querySelectorAll<HTMLElement>(`.${DIAGRAM_CLASS}`))
      if (nodes.length === 0) return
      const mermaid = (await import('mermaid')).default
      if (cancelled) return
      mermaid.initialize({
        startOnLoad: false,
        // Строгий режим: подписи в диаграмме проходят через санитайз, а клики по
        // узлам и произвольный HTML внутри схемы запрещены.
        securityLevel: 'strict',
        theme: theme === 'light' ? 'default' : 'dark',
        fontFamily: 'inherit',
      })
      for (const node of nodes) {
        // Тема поменялась — перерисовываем из сохранённого исходника.
        const sourceText = node.dataset.sfSource ?? node.textContent ?? ''
        if (node.dataset.sfRendered === 'mermaid' && node.dataset.sfTheme === theme) continue
        node.dataset.sfSource = sourceText
        try {
          const { svg } = await mermaid.render(`sf-md-graph-${randomId().slice(0, 8)}`, sourceText)
          if (cancelled) return
          node.innerHTML = svg
          node.dataset.sfRendered = 'mermaid'
          node.dataset.sfTheme = theme
          node.classList.remove('sf-md-mermaid--error')
        } catch {
          // Схему с ошибкой показываем исходником: человек должен увидеть, что
          // именно он написал, и поправить.
          node.textContent = sourceText
          node.classList.add('sf-md-mermaid--error')
        }
      }
    }

    void (async () => {
      await renderMath()
      await renderDiagrams()
    })()

    return () => {
      cancelled = true
    }
  }, [result.html, theme])

  if (!result.html) return null
  return (
    <div
      ref={ref}
      className={className ? `sf-md ${className}` : 'sf-md'}
      data-markdown
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  )
}
