/**
 * Подсказки-промпты для пустого чата.
 *
 * Зачем они и почему зависят от роли. Пустое поле ввода — худшее место, чтобы догадаться,
 * что помощник умеет: он создаёт главы и под-события, а не «отвечает на вопросы вообще».
 * Поэтому в пустом окне показаны готовые формулировки, и они разные для разных ролей:
 * летописцу логично предложить хронологию и даты, соавтору-фантасту — детали мира,
 * проектировщику — разбиение на главы. Общий список «на все случаи» человек читает как
 * рекламу и не пользуется им.
 *
 * Подсказки не отправляются сами: нажатие подставляет текст в поле, чтобы человек мог его
 * поправить. Автоотправка тратила бы токены на формулировку, которую он не выбирал.
 */

import { translate, type Key } from '../../i18n'
import type { Lang } from '../../store/lang'

/** Подсказка в готовом виде: подпись и промпт на языке интерфейса. */
export type PromptHint = { label: string; prompt: string }

/** Пара ключей словаря: подпись и то, что подставится в поле ввода. */
type HintKeys = { label: Key; prompt: Key }

/**
 * Что предложить в пустом чате.
 *
 * `role` — выбранная владельцем роль агента (`''` — роль не выбрана, «внимательный
 * соавтор»); `projectIsEmpty` — в проекте ещё нет ни одного кадра, и тогда первая
 * подсказка предлагает собрать проект с нуля, а не дописывать к существующему.
 *
 * Язык — параметром (0.125.0), по умолчанию русский: подсказка уходит модели как текст
 * запроса, поэтому на английском интерфейсе и запрос английский.
 */
export function promptHints(role = '', projectIsEmpty = true, lang: Lang = 'ru'): PromptHint[] {
  const start: HintKeys = projectIsEmpty
    ? { label: 'ph.fromScratch', prompt: 'ph.fromScratchPrompt' }
    : { label: 'ph.continue', prompt: 'ph.continuePrompt' }

  let keys: HintKeys[]
  switch (role) {
    case 'chronicler':
      keys = [
        start,
        { label: 'ph.timeline', prompt: 'ph.timelinePrompt' },
        { label: 'ph.chapterWithDate', prompt: 'ph.chapterWithDatePrompt' },
      ]
      break
    case 'editor':
      keys = [
        { label: 'ph.repeats', prompt: 'ph.repeatsPrompt' },
        { label: 'ph.wording', prompt: 'ph.wordingPrompt' },
        start,
      ]
      break
    case 'architect':
      keys = [
        start,
        { label: 'ph.splitChapter', prompt: 'ph.splitChapterPrompt' },
        { label: 'ph.balance', prompt: 'ph.balancePrompt' },
      ]
      break
    case 'coauthor':
      keys = [
        start,
        { label: 'ph.worldDetails', prompt: 'ph.worldDetailsPrompt' },
        { label: 'ph.twist', prompt: 'ph.twistPrompt' },
      ]
      break
    default:
      keys = [
        start,
        { label: 'ph.addChapter', prompt: 'ph.addChapterPrompt' },
        { label: 'ph.splitFirst', prompt: 'ph.splitFirstPrompt' },
      ]
  }
  return keys.map((hint) => ({
    label: translate(lang, hint.label),
    prompt: translate(lang, hint.prompt),
  }))
}
