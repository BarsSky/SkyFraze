import type { Asset } from '../api/assets'
import { formatBytes } from './format'

/**
 * Загрузка НЕСКОЛЬКИХ файлов: очередь, прогресс и честная сводка.
 *
 * Почему последовательно, а не «всеми сразу». Каждый файл сервер пережимает
 * (PNG → WebP без потерь, JPEG с потерями) — это работа процессора, и десяток
 * одновременных загрузок положил бы стенд на слабой машине, а пользы не дал бы:
 * канал всё равно один. Заодно последовательность даёт понятный прогресс
 * «загружаю 3 из 7» и понятный отказ: видно, на каком файле кончилось место.
 *
 * Почему останавливаемся на «место кончилось». Квоту проекта сервер проверяет на
 * каждом файле, и после отказа все следующие тоже откажутся — но каждый отказ это ещё
 * один пережаренный файл и секунды ожидания. Поэтому при отказе по квоте остаток
 * помечаем как «не загружался», а не долбим сервер.
 */

/** Что вышло по одному файлу. */
export interface UploadOutcome {
  file: File
  /** Загруженный файл или null, если не вышло. */
  asset: Asset | null
  /** Текст отказа (словами сервера, если он их прислал). */
  error: string | null
}

export interface UploadQueueOptions {
  /** Предел одного файла (совпадает с лимитом nginx и бэкенда). */
  maxBytes: number
  /** Сообщение на каждой загрузке: «загружаю 3 из 7». */
  onProgress?: (done: number, total: number) => void
  /**
   * Текст отказа для человека. Ошибки ky несут код, а не объяснение, поэтому
   * вызывающий сам достаёт серверное сообщение (`serverErrorMessage`) — оно
   * приходит асинхронно, и очередь это учитывает.
   */
  describeError?: (error: unknown) => string | Promise<string>
}

/**
 * Прогоняет файлы через `upload` по очереди.
 *
 * Возвращает результат по КАЖДОМУ файлу — в том числе по тем, что не отправлялись:
 * человек должен видеть судьбу всех выбранных файлов, а не только удачных.
 */
export async function runUploads(
  files: File[],
  upload: (file: File) => Promise<Asset | null>,
  options: UploadQueueOptions,
): Promise<UploadOutcome[]> {
  const out: UploadOutcome[] = []
  let quotaHit: string | null = null

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    options.onProgress?.(i, files.length)

    if (file.size > options.maxBytes) {
      out.push({
        file,
        asset: null,
        error: `файл больше ${Math.round(options.maxBytes / 1024 / 1024)} МБ — сервер его не примет`,
      })
      continue
    }
    // Место кончилось на предыдущем файле: не мучаем сервер и человека.
    if (quotaHit !== null) {
      out.push({ file, asset: null, error: `не загружался: ${quotaHit}` })
      continue
    }

    try {
      const asset = await upload(file)
      if (!asset) {
        out.push({ file, asset: null, error: 'сервер отклонил запрос' })
        continue
      }
      out.push({ file, asset, error: null })
    } catch (e) {
      const message = (await options.describeError?.(e)) ?? 'не удалось загрузить'
      out.push({ file, asset: null, error: message })
      if (isQuotaMessage(message)) quotaHit = message
    }
  }

  options.onProgress?.(files.length, files.length)
  return out
}

/**
 * Признак «место кончилось» по тексту отказа.
 *
 * Сервер отвечает человеческой фразой («в проекте занято 9.4 МБ из 10 МБ — файл на
 * 1.2 МБ не помещается»), кода состояния у вызывающего нет: `serverErrorMessage`
 * отдаёт только текст. Поэтому ищем слова, которыми такой отказ и формулируется.
 */
export function isQuotaMessage(message: string): boolean {
  return /не помещается|занято .* из |место закончилось|превышает предел/i.test(message)
}

/** Сводка после очереди: «загружено 3 из 5» и причины по неудачным. */
export function uploadSummary(outcomes: UploadOutcome[]): string {
  const ok = outcomes.filter((o) => o.asset !== null)
  const failed = outcomes.filter((o) => o.asset === null)
  if (failed.length === 0) {
    if (ok.length === 1) return `Загружено: ${ok[0].asset?.filename ?? ok[0].file.name}`
    const total = ok.reduce((sum, o) => sum + (o.asset?.size ?? 0), 0)
    return `Загружено файлов: ${ok.length} (${formatBytes(total)})`
  }
  const parts = [`загружено ${ok.length} из ${outcomes.length}`]
  for (const bad of failed.slice(0, 3)) {
    parts.push(`${bad.file.name}: ${bad.error ?? 'не удалось'}`)
  }
  if (failed.length > 3) parts.push(`и ещё ${failed.length - 3} без подробностей`)
  return parts.join('; ')
}
