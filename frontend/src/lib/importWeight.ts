import { formatBytes } from './format'
import { translate } from '../i18n'
import type { Lang } from '../store/lang'

/**
 * Что сказать про вес набора перед импортом.
 *
 * Зачем это вообще. Импорт подчиняется квоте проекта: набор, который не помещается,
 * отклоняется на первом же файле. Раньше человек узнавал об этом ПОСЛЕ импорта, из
 * отказа, — а теперь видит заранее, в предпросмотре.
 *
 * Считаем по весу ДО пережатия (картинки станут легче): обещать «поместится», а
 * потом отказать хуже, чем сказать «может не поместиться».
 *
 * Язык — параметром (0.124.0), по умолчанию русский: подписи собираются здесь, а не в
 * разметке, поэтому английский интерфейс передаёт свой язык явно.
 */
export interface ImportWeight {
  /** Короткая подпись: «вложения: 3 · 4.2 МБ». */
  text: string
  /** Предупреждение о квоте; пусто, если всё помещается или предела нет. */
  warning: string | null
}

/** Что нужно знать о наборе: сколько вложений и сколько они весят. */
export interface ImportWeightStats {
  attachments: number
  attachmentBytes: number
}

export function importWeight(
  stats: ImportWeightStats,
  quotaBytes: number,
  usedBytes = 0,
  lang: Lang = 'ru',
): ImportWeight | null {
  if (stats.attachments <= 0) return null

  const size = formatBytes(stats.attachmentBytes, lang)
  const text = translate(lang, 'iw.attachments', { count: stats.attachments, size })
  if (quotaBytes <= 0) return { text, warning: null }

  const afterImport = usedBytes + stats.attachmentBytes
  if (afterImport > quotaBytes) {
    return {
      text,
      warning:
        usedBytes > 0
          ? translate(lang, 'iw.overUsed', {
              used: formatBytes(usedBytes, lang),
              quota: formatBytes(quotaBytes, lang),
              size,
            })
          : translate(lang, 'iw.overLimit', {
              quota: formatBytes(quotaBytes, lang),
              size,
            }),
    }
  }
  // Предел будет занят полностью — говорим прямо: после импорта загрузить что-то
  // ещё уже не выйдет.
  if (afterImport >= quotaBytes) {
    return {
      text,
      warning: translate(lang, 'iw.fullWarn', {
        after: formatBytes(afterImport, lang),
        quota: formatBytes(quotaBytes, lang),
      }),
    }
  }
  // Больше 80% предела — предупреждаем мягко: после импорта место кончится, и это
  // лучше знать заранее.
  if (afterImport / quotaBytes >= 0.8) {
    return {
      text,
      warning: translate(lang, 'iw.almostWarn', {
        after: formatBytes(afterImport, lang),
        quota: formatBytes(quotaBytes, lang),
      }),
    }
  }
  return { text, warning: null }
}
