import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Страж локализации (0.130.0).
 *
 * Зачем тест, а не договорённость. После 0.129.0 интерфейс переведён целиком, но это состояние
 * легко потерять: новая подпись, написанная в разметке строкой, снова оставит в английском
 * интерфейсе русский текст. Поэтому проверяются два правила:
 *
 *   1. **Каждый ключ, который код просит у словаря, существует в RU и EN.** Опечатка в имени
 *      ключа иначе всплывала бы только на экране — и показывала бы сам ключ вместо подписи.
 *   2. **Русские строки в коде остаются только там, где они осознанно русские** —
 *      данные, протокол разметки и нормализация поиска. Список с причиной на каждый файл
 *      зафиксирован ниже: если русских строк стало больше, тест падает и требует либо ключа
 *      словаря, либо записи в этот список.
 *
 * Считаются строковые литералы и текстовые узлы JSX; комментарии вырезаются (они по-русски
 * намеренно и читаются разработчиком, а не человеком на экране).
 */

const SRC = join(process.cwd(), 'src')

/** Что осталось русским НАМЕРЕННО: файл → сколько литералов и почему. */
const ALLOWED_RUSSIAN: Record<string, { count: number; why: string }> = {
  'api/docxTemplates.ts': {
    count: 10,
    why: 'русский эталон подписей карты стилей — запасной вариант для неизвестных ключей сервера',
  },
  'api/entities.ts': {
    count: 3,
    why: 'названия стартовых видов карточек — данные проекта, их создаёт сервер',
  },
  'collab/yprovider.ts': {
    count: 1,
    why: '«Новое событие» — заголовок, который попадает В ДОКУМЕНТ при создании кадра',
  },
  'components/Header.tsx': { count: 1, why: 'название языка («Русский») — его читают на самом языке' },
  'components/docx/DocxHelp.tsx': {
    count: 2,
    why: 'текст маркеров DOCX — синтаксис, который человек набирает в документе',
  },
  'lib/crafts.ts': {
    count: 17,
    why: 'каталог специализаций хранится в профиле как введён и виден другим людям',
  },
  'lib/docxMarkers.ts': {
    count: 2,
    why: 'маркеры DOCX (sf:style=Имя, sf:begin=Имя) — протокол разметки',
  },
  'lib/entitySearch.ts': { count: 1, why: 'замена «ё»→«е» нужна для поиска по-русски' },
  'lib/uploadQueue.ts': {
    count: 1,
    why: 'признак «место кончилось» ищется по словам ОТВЕТА СЕРВЕРА, а не по подписи',
  },
  'pages/AboutPage.tsx': { count: 1, why: 'название языка — его читают на самом языке' },
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** Текст без комментариев: блоки, строки и JSX-комментарии вырезаются. */
function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1')
}

const CYRILLIC = /[А-Яа-яЁё]/

/** Строковые литералы (все три вида кавычек) с кириллицей. */
function russianLiterals(source: string): string[] {
  const out: string[] = []
  const patterns = [/'((?:\\.|[^'\\\n])*)'/g, /"((?:\\.|[^"\\\n])*)"/g, /`((?:\\.|[^`\\])*)`/g]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (CYRILLIC.test(match[1])) out.push(match[1].trim())
    }
  }
  return out
}

/** Текстовые узлы JSX: между `>` и `<`, если внутри кириллица и нет выражений. */
function russianJsxText(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1].trim()
    if (text !== '' && CYRILLIC.test(text)) out.push(text)
  }
  return out
}

const sources = walk(SRC)
  .filter((path) => !/\.test\.(ts|tsx)$/.test(path))
  .filter((path) => !relative(SRC, path).startsWith('i18n' + require('node:path').sep))
  .map((path) => ({ path, name: relative(SRC, path).split('\\').join('/') }))

describe('локализация: ключи и остатки русского', () => {
  const ruSource = readFileSync(join(SRC, 'i18n', 'ru.ts'), 'utf8')
  const keys = new Set(
    [...ruSource.matchAll(/^\s*'([a-z][A-Za-z0-9._]*)':/gm)].map((match) => match[1]),
  )

  it('словарь читается: ключей больше тысячи', () => {
    expect(keys.size).toBeGreaterThan(1000)
  })

  it('каждый литеральный ключ, который просит код, есть в словаре', () => {
    const missing: string[] = []
    for (const { path, name } of sources) {
      const source = stripComments(readFileSync(path, 'utf8'))
      const requests: string[] = []
      // t('key'), tStatic('key'), translate(lang, 'key'), pluralWord(lang, 'prefix', n)
      for (const match of source.matchAll(/\bt(?:Static)?\(\s*'([^']+)'/g)) requests.push(match[1])
      for (const match of source.matchAll(/\btranslate\(\s*[\w.]+\s*,\s*'([^']+)'/g)) {
        requests.push(match[1])
      }
      for (const match of source.matchAll(/\bpluralWord\(\s*[\w.]+,\s*'([^']+)'/g)) {
        for (const form of ['one', 'few', 'many']) requests.push(`${match[1]}.${form}`)
      }
      for (const request of requests) {
        if (!keys.has(request)) missing.push(`${name}: ${request}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('русские строки в коде остались только там, где это осознанно', () => {
    const found: Record<string, string[]> = {}
    for (const { path, name } of sources) {
      const source = stripComments(readFileSync(path, 'utf8'))
      const literals = [...russianLiterals(source), ...russianJsxText(source)]
      if (literals.length > 0) found[name] = literals
    }

    const unexpected = Object.entries(found).filter(([name]) => !(name in ALLOWED_RUSSIAN))
    const grew = Object.entries(found).filter(([name, list]) => {
      const allowed = ALLOWED_RUSSIAN[name]
      return allowed !== undefined && list.length > allowed.count
    })

    // Если тест упал здесь: либо добавь ключ словаря (обычный случай), либо, если строка —
    // данные проекта или протокол, допиши файл в ALLOWED_RUSSIAN вместе с причиной.
    expect({ unexpected, grew }).toEqual({ unexpected: [], grew: [] })
  })
})
