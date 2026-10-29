import type { Lang } from '../store/lang'

/**
 * Множественное число (0.115.0).
 *
 * Зачем отдельный хелпер, а не `n === 1 ? 'кадр' : 'кадра'`: в русском три формы, и правило не
 * сводится к последней цифре — 11 кадров, но 21 кадр; 12 кадров, но 22 кадра. Ошибка здесь не
 * ломает страницу, но видна сразу («5 кадра»), и именно так она попадает в отчёты.
 *
 * В словарях формы лежат отдельными ключами (`projects.frames.one/few/many`), а хелпер говорит,
 * какую взять. Английскому хватает двух форм: `one` и `many`.
 */
export type PluralForm = 'one' | 'few' | 'many'

export function pluralForm(lang: Lang, n: number): PluralForm {
  const value = Math.abs(n)
  if (lang === 'en') return value === 1 ? 'one' : 'many'
  const mod10 = value % 10
  const mod100 = value % 100
  if (mod10 === 1 && mod100 !== 11) return 'one'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few'
  return 'many'
}
