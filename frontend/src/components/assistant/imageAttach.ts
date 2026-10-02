/**
 * Прикрепление картинок к вопросу.
 *
 * Что здесь решено и почему:
 *
 *   - **Проверяем на стороне браузера, но полагаемся на сервер.** Отсеять файл на 40 МБ
 *     до отправки — вежливость (человек сразу видит причину), но настоящая проверка
 *     обязана быть на сервере: браузерное ограничение обходится одним curl-ом.
 *   - **data URL, а не файл на диск.** Картинка нужна для одного вопроса: хранить её
 *     отдельным вложением проекта значит обещать больше, чем мы делаем (история её не
 *     помнит). Формат data URL одинаков для нас и для сервера, а тот уже переводит его
 *     в то, что ждёт конкретный провайдер.
 *   - **Пределы совпадают с серверными** (три картинки, 4 МБ data URL): расхождение
 *     выглядело бы как «интерфейс разрешил, а сервер отказал».
 */

/** Сколько картинок можно приложить к одному вопросу (совпадает с серверным). */
export const MAX_IMAGES = 3

/**
 * Предел на файл. Сервер принимает data URL до 4 МБ, то есть примерно 3 МБ файла:
 * base64 добавляет около трети. Берём чуть меньше, чтобы не отказывать «на самом краю».
 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/** Что принимаем: те же форматы, что и сервер. */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Почему файл нельзя приложить (или `null`, если можно).
 *
 * `currentCount` — сколько картинок уже приложено: предел общий на вопрос, а не на файл.
 */
export function imageFileError(file: File, currentCount: number): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return `«${file.name}»: формат ${file.type || 'неизвестен'} не поддерживается (можно png, jpeg, webp, gif)`
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return `«${file.name}»: ${mb} МБ — больше предела (${MAX_IMAGE_BYTES / (1024 * 1024)} МБ)`
  }
  if (currentCount >= MAX_IMAGES) {
    return `К одному вопросу можно приложить не больше ${MAX_IMAGES} картинок`
  }
  return null
}

/** Читает файл в data URL — в том виде, в котором картинка уходит на сервер. */
export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('не удалось прочитать файл'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      if (!result.startsWith('data:')) {
        reject(new Error('файл прочитался не как картинка'))
        return
      }
      resolve(result)
    }
    reader.readAsDataURL(file)
  })
}
