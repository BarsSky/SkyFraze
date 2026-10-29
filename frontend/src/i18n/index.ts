import { getLang, useLang, type Lang } from '../store/lang'
import { en } from './en'
import { ru } from './ru'
import { pluralForm } from './plural'

/**
 * Перевод интерфейса (0.115.0).
 *
 * Без библиотеки: словари лежат в коде, ключи плоские, тип ключа выводится из русского словаря
 * (`as const`), так что английский обязан содержать ровно те же ключи — пропуск ловится `tsc`, а
 * не человеком на стенде.
 *
 * Подстановка — `{name}`: значения подставляются как есть, без экранирования, потому что строки
 * собирает не пользователь, а код. Если ключа нет (устаревшая сборка, новый компонент), берём
 * русский вариант, а если нет и его — возвращаем сам ключ: пустая подпись хуже видимого имени
 * ключа, по которому дефект находится за секунду.
 */
export type Key = keyof typeof ru
export type Vars = Record<string, string | number>

const dictionaries: Record<Lang, Record<Key, string>> = { ru, en }

/** Локаль для `Intl`: язык интерфейса, а не язык данных. */
export function localeOf(lang: Lang): string {
  return lang === 'ru' ? 'ru-RU' : 'en-GB'
}

export function translate(lang: Lang, key: Key, vars?: Vars): string {
  const template = dictionaries[lang]?.[key] ?? ru[key]
  if (template === undefined) return key
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars[name] === undefined ? whole : String(vars[name]),
  )
}

export type TFunction = (key: Key, vars?: Vars) => string

/**
 * Хук перевода: `const t = useT()`.
 *
 * Возвращает новую функцию на каждый рендер — намеренно. Мемоизация по `lang` дала бы «застывшие»
 * подписи в компонентах, которые держат `t` в замыкании (таймеры, обработчики): при смене языка
 * они обновились бы только после перерисовки по другой причине.
 */
export function useT(): TFunction {
  const [lang] = useLang()
  return (key: Key, vars?: Vars) => translate(lang, key, vars)
}

/**
 * Слово в нужной форме числа (0.119.0): `pluralWord(lang, 'ed.unit.event', 3)` → «события».
 *
 * Зачем рядом с `translate`: слова с формами лежат в словаре (`ed.unit.event.one/few/many`), и
 * собирать имя ключа в компонентах значило бы повторять `${prefix}.${form}` в десятке мест.
 */
export function pluralWord(lang: Lang, prefix: string, n: number): string {
  return translate(lang, `${prefix}.${pluralForm(lang, n)}` as Key)
}
/** Перевод вне компонента (обработчики, не-React код): по текущему языку. */
export function tStatic(key: Key, vars?: Vars): string {
  return translate(getLang(), key, vars)
}
