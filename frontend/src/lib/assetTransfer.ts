/**
 * Перенос вложения из одного кадра в другой (глава ↔ под-событие).
 *
 * Почему это отдельная функция, а не пара строк в панели редакторов. Перенос — не
 * «убрать здесь, добавить там»: у кадра есть ФОН, и если переносимая картинка была
 * фоном исходного кадра, то после переноса исходный кадр остаётся без фона — человек
 * об этом должен узнать, а не обнаружить пустой кадр в ленте. Кроме того один и тот же
 * файл может быть прикреплён к нескольким кадрам (дедупликация по содержимому), и
 * «перенести из A» не значит «убрать у всех».
 *
 * Поэтому решение собирается здесь целиком и проверяется тестами, а панель только
 * применяет результат к CRDT-документу.
 */

/** Кадр в том виде, в каком он нужен для решения о переносе. */
export interface TransferFrame {
  id: string
  /** Подпись для человека: «01 Пролог». */
  label: string
  /** Прикреплённые файлы (уже без пустых значений). */
  assetIds: string[]
  /** Файл-фон кадра, если фон — картинка. */
  backgroundAssetId: string | null
}

/** Изменение одного кадра: что записать в `assets` и что сделать с фоном. */
export interface FramePatch {
  id: string
  assetIds: string[]
  /** Новый фон: `undefined` — не трогать, `null` — очистить, строка — назначить. */
  backgroundAssetId?: string | null
}

export interface MovePlan {
  patches: FramePatch[]
  /** Что сказать человеку под списком файлов. */
  notice: string
}

export type MoveResult = MovePlan | { error: string }

/**
 * Куда можно перенести файл и что при этом изменится.
 *
 * `fromId` может быть `null` — тогда это «прикрепить в кадр» (у файла ещё нет кадра):
 * так та же кнопка работает для файла, который просто лежит в проекте.
 */
export function planAssetMove(
  frames: TransferFrame[],
  assetId: string,
  fromId: string | null,
  toId: string,
  options: { isImage: boolean },
): MoveResult {
  const target = frames.find((f) => f.id === toId)
  if (!target) return { error: 'Кадр не найден — обновите страницу.' }
  if (fromId === toId) return { error: 'Файл уже в этом кадре.' }
  if (target.assetIds.includes(assetId)) {
    return { error: `Файл уже прикреплён к кадру «${target.label}».` }
  }

  const patches: FramePatch[] = []
  const notes: string[] = []

  if (fromId !== null) {
    const source = frames.find((f) => f.id === fromId)
    if (!source) return { error: 'Исходный кадр не найден — обновите страницу.' }
    if (!source.assetIds.includes(assetId)) {
      return { error: `Файла нет в кадре «${source.label}».` }
    }
    const patch: FramePatch = {
      id: source.id,
      assetIds: source.assetIds.filter((id) => id !== assetId),
    }
    if (source.backgroundAssetId === assetId) {
      // Фон исходного кадра уходит вместе с картинкой: оставлять ссылку на файл,
      // которого в кадре больше нет, нельзя — кадр показывал бы чужую картинку.
      patch.backgroundAssetId = null
      notes.push(`фон кадра «${source.label}» сброшен`)
    }
    patches.push(patch)
  }

  const targetPatch: FramePatch = { id: target.id, assetIds: [...target.assetIds, assetId] }
  if (options.isImage && target.backgroundAssetId === null) {
    // Как и при загрузке: первая картинка в кадре становится его фоном. Кадр без фона
    // выглядит пустым, а «просто прикрепить картинку» человек и хочет увидеть фоном.
    targetPatch.backgroundAssetId = assetId
    notes.push(`в кадре «${target.label}» картинка стала фоном`)
  }
  patches.push(targetPatch)

  const what = fromId === null ? 'Прикреплено' : 'Перенесено'
  const where = `в кадр «${target.label}»`
  return {
    patches,
    notice: notes.length > 0 ? `${what} ${where}: ${notes.join(', ')}` : `${what} ${where}`,
  }
}

/**
 * К каким кадрам прикреплён каждый файл: `assetId → [кадр, …]`.
 *
 * Нужно списку файлов: без этого непонятно, что значит «перенести» — файл может быть
 * прикреплён к нескольким кадрам сразу (один и тот же файл по содержимому).
 */
export function attachmentsByAsset(frames: TransferFrame[]): Map<string, TransferFrame[]> {
  const out = new Map<string, TransferFrame[]>()
  for (const frame of frames) {
    for (const assetId of frame.assetIds) {
      const list = out.get(assetId) ?? []
      list.push(frame)
      out.set(assetId, list)
    }
  }
  return out
}

/** Подпись «где файл»: «01 Пролог, 01.1 Рассвет» или «ни в одном кадре». */
export function attachmentLabel(frames: TransferFrame[] | undefined): string {
  if (!frames || frames.length === 0) return 'ни в одном кадре'
  const names = frames.slice(0, 3).map((f) => f.label)
  const tail = frames.length > 3 ? ` и ещё ${frames.length - 3}` : ''
  return names.join(', ') + tail
}
