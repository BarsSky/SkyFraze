import { describe, expect, it } from 'vitest'
import { MAX_IMAGES, MAX_IMAGE_BYTES, imageFileError, readImageFile } from './imageAttach'

/**
 * Прикрепление картинок: что проверяем в браузере.
 *
 * Проверки здесь — вежливость (человек видит причину до отправки), а не защита: сервер
 * обязан проверять то же самое сам. Поэтому проверяем, что причины объясняются СЛОВАМИ и
 * что пределы совпадают с серверными.
 */
function fakeFile(name: string, type: string, size: number): File {
  return { name, type, size } as File
}

describe('imageFileError', () => {
  it('пропускает нормальный файл', () => {
    expect(imageFileError(fakeFile('маяк.png', 'image/png', 200_000), 0)).toBeNull()
  })

  it('объясняет неподходящий формат', () => {
    const message = imageFileError(fakeFile('схема.svg', 'image/svg+xml', 1000), 0)
    expect(message).toContain('схема.svg')
    expect(message).toMatch(/png/)
  })

  it('объясняет слишком большой файл с его размером', () => {
    const message = imageFileError(fakeFile('фото.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1), 0)
    expect(message).toContain('фото.jpg')
    expect(message).toMatch(/МБ/)
  })

  it('не даёт приложить больше предела картинок', () => {
    const message = imageFileError(fakeFile('ещё.png', 'image/png', 1000), MAX_IMAGES)
    expect(message).toContain(String(MAX_IMAGES))
  })
})

describe('readImageFile', () => {
  it('читает файл в data URL — в том виде, в котором картинка уходит на сервер', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const file = new File([bytes], 'точка.png', { type: 'image/png' })
    const result = await readImageFile(file)
    expect(result.startsWith('data:image/png;base64,')).toBe(true)
    // Те же байты, что положили: чтение не должно ничего терять.
    expect(atob(result.split(',')[1])).toBe(String.fromCharCode(...bytes))
  })
})
