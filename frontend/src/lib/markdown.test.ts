import { describe, expect, it } from 'vitest'
import { DIAGRAM_CLASS, MATH_CLASS, looksLikeMarkdown, renderMarkdown } from './markdown'

/** Разбор готового HTML: проверяем структуру, а не подстроки в разметке. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
}

const mathTexts = (html: string): string[] =>
  Array.from(parse(html).querySelectorAll(`.${MATH_CLASS}`)).map((el) => el.textContent ?? '')

const diagramTexts = (html: string): string[] =>
  Array.from(parse(html).querySelectorAll(`.${DIAGRAM_CLASS}`)).map((el) => el.textContent ?? '')

describe('renderMarkdown: базовое форматирование', () => {
  it('заголовки, списки, выделение и цитаты', () => {
    const { html } = renderMarkdown('# Глава\n\n- раз\n- два\n\n**жирный** и *курсив*\n\n> цитата')
    expect(html).toContain('<h1>Глава</h1>')
    expect(html).toContain('<li>раз</li>')
    expect(html).toContain('<strong>жирный</strong>')
    expect(html).toContain('<em>курсив</em>')
    expect(html).toContain('<blockquote>')
  })

  it('таблицы (GFM) собираются в настоящую таблицу', () => {
    const { html } = renderMarkdown('| Герой | Роль |\n|---|---|\n| Аня | инженер |\n| Борис | пилот |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Герой</th>')
    expect(html).toContain('<td>пилот</td>')
  })

  it('код в тройных кавычках не превращается в разметку', () => {
    const { html } = renderMarkdown('```js\nconst x = `# не заголовок`\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('language-js')
    expect(html).not.toContain('<h1>')
  })

  it('ссылки открываются в новой вкладке и без opener', () => {
    const { html } = renderMarkdown('[сайт](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('пустой текст даёт пустой результат', () => {
    expect(renderMarkdown('   ').html).toBe('')
    expect(renderMarkdown('').hasMath).toBe(false)
  })
})

describe('renderMarkdown: формулы', () => {
  it('строчная формула становится заготовкой с TeX', () => {
    const result = renderMarkdown('Площадь $S = \\pi r^2$ круга')
    expect(result.hasMath).toBe(true)
    expect(result.html).toContain(`class="${MATH_CLASS}"`)
    expect(mathTexts(result.html)).toEqual(['S = \\pi r^2'])
  })

  it('блочная формула в одну строку и в несколько строк', () => {
    const single = renderMarkdown('$$E = mc^2$$')
    expect(single.hasMath).toBe(true)
    expect(mathTexts(single.html)).toEqual(['E = mc^2'])

    const multi = renderMarkdown('$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$')
    expect(multi.hasMath).toBe(true)
    expect(mathTexts(multi.html)[0]).toContain('\\frac{1}{2}')
  })

  it('цены и одиночные доллары формулами не считаются', () => {
    const result = renderMarkdown('Билет стоит $5, а обед $7 — итого $12.')
    expect(result.hasMath).toBe(false)
    expect(result.html).toContain('$5')
  })

  it('формула внутри блока кода остаётся текстом', () => {
    const result = renderMarkdown('```\n$x^2$\n```')
    expect(result.hasMath).toBe(false)
    expect(result.html).toContain('$x^2$')
  })
})

describe('renderMarkdown: диаграммы', () => {
  it('блок mermaid становится заготовкой с исходником', () => {
    const result = renderMarkdown('```mermaid\ngraph TD\n  A --> B\n```')
    expect(result.hasDiagram).toBe(true)
    expect(result.html).toContain(`class="${DIAGRAM_CLASS}"`)
    // Исходник лежит в тексте узла: в атрибуте «-->» не выживает.
    expect(diagramTexts(result.html)).toEqual(['graph TD\n  A --> B'])
  })

  it('обычный код диаграммой не считается', () => {
    expect(renderMarkdown('```js\nconst a = 1\n```').hasDiagram).toBe(false)
  })
})

describe('renderMarkdown: безопасность', () => {
  it('сырой HTML вырезается, текст остаётся читаемым', () => {
    const { html } = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">')
    const doc = parse(html)
    expect(doc.querySelector('script')).toBeNull()
    expect(doc.querySelector('[onerror]')).toBeNull()
    // Тег остался обычным текстом — его видно, но он ничего не делает.
    expect(doc.body.textContent).toContain('<script>')
  })

  it('javascript: в ссылке не становится ссылкой', () => {
    const { html } = renderMarkdown('[клик](javascript:alert(1))')
    expect(parse(html).querySelector('a')).toBeNull()
  })

  it('html внутри формулы не ломает разметку', () => {
    const { html } = renderMarkdown('$a" onload="alert(1)$')
    const doc = parse(html)
    expect(doc.querySelector('[onload]')).toBeNull()
    expect(mathTexts(html)[0]).toContain('onload')
  })
})

describe('renderMarkdown: ссылки на вложения проекта', () => {
  const id = '11111111-2222-3333-4444-555555555555'

  it('заменяет адрес вложения на доступный странице', () => {
    const { html } = renderMarkdown(`![схема](/api/assets/${id})`, { [id]: 'blob:sf-asset' })
    const img = parse(html).querySelector('img')
    // Эндпоинт требует авторизации, а <img> заголовок не передаёт: без подмены
    // картинка в тексте не открывалась бы (401).
    expect(img?.getAttribute('src')).toBe('blob:sf-asset')
  })

  it('не трогает чужие адреса и ссылки вне карты', () => {
    const other = '99999999-8888-7777-6666-555555555555'
    const { html } = renderMarkdown(
      `![своя](/api/assets/${id})\n\n![чужая](/api/assets/${other})\n\n[сайт](https://example.com)\n\n[документ](/api/assets/${other})`,
      { [id]: 'blob:sf-asset' },
    )
    const doc = parse(html)
    expect(doc.querySelectorAll('img')[0]?.getAttribute('src')).toBe('blob:sf-asset')
    // Файла этой картинки у страницы нет — вместо запроса к защищённому эндпоинту
    // (он дал бы 401 в консоли) показываем пустой пиксель: картинка появится, как
    // только страница получит адрес файла.
    expect(doc.querySelectorAll('img')[1]?.getAttribute('src')).toMatch(/^data:image\/gif/)
    // Ссылку на файл не подменяем: переход по ней — действие человека.
    expect(doc.querySelectorAll('a')[1]?.getAttribute('href')).toBe(`/api/assets/${other}`)
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
  })

  it('без карты файлов разметка не меняется', () => {
    const { html } = renderMarkdown(`![схема](/api/assets/${id})`)
    expect(parse(html).querySelector('img')?.getAttribute('src')).toBe(`/api/assets/${id}`)
  })
})

describe('looksLikeMarkdown', () => {
  it('видит разметку и не путает её с обычным текстом', () => {
    expect(looksLikeMarkdown('# Заголовок')).toBe(true)
    expect(looksLikeMarkdown('- пункт')).toBe(true)
    expect(looksLikeMarkdown('**жирный**')).toBe(true)
    expect(looksLikeMarkdown('| a | b |')).toBe(true)
    expect(looksLikeMarkdown('$x^2$')).toBe(true)
    expect(looksLikeMarkdown('Просто текст про колонию.')).toBe(false)
  })
})
