import { formatBytes } from './format'

/**
 * Что сказать про вес набора перед импортом.
 *
 * Зачем это вообще. Импорт подчиняется квоте проекта: набор, который не помещается,
 * отклоняется на первом же файле. Раньше человек узнавал об этом ПОСЛЕ импорта, из
 * отказа, — а теперь видит заранее, в предпросмотре.
 *
 * Считаем по весу ДО пережатия (картинки станут легче): обещать «поместится», а
 * потом отказать хуже, чем сказать «может не поместиться».
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
): ImportWeight | null {
  if (stats.attachments <= 0) return null

  const text = `вложения: ${stats.attachments} · ${formatBytes(stats.attachmentBytes)}`
  if (quotaBytes <= 0) return { text, warning: null }

  const afterImport = usedBytes + stats.attachmentBytes
  if (afterImport > quotaBytes) {
    return {
      text,
      warning:
        usedBytes > 0
          ? `в предел не поместится: занято ${formatBytes(usedBytes)} из ${formatBytes(quotaBytes)}, набор весит ${formatBytes(stats.attachmentBytes)}`
          : `в предел не поместится: предел проекта ${formatBytes(quotaBytes)}, набор весит ${formatBytes(stats.attachmentBytes)}`,
    }
  }
  // Предел будет занят полностью — говорим прямо: после импорта загрузить что-то
  // ещё уже не выйдет.
  if (afterImport >= quotaBytes) {
    return {
      text,
      warning: `после импорта предел будет занят целиком (${formatBytes(afterImport)} из ${formatBytes(quotaBytes)})`,
    }
  }
  // Больше 80% предела — предупреждаем мягко: после импорта место кончится, и это
  // лучше знать заранее.
  if (afterImport / quotaBytes >= 0.8) {
    return {
      text,
      warning: `после импорта будет занято ${formatBytes(afterImport)} из ${formatBytes(quotaBytes)} — место почти закончится`,
    }
  }
  return { text, warning: null }
}
