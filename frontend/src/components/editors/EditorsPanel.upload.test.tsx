import { describe, expect, it } from 'vitest'

import type { Asset } from '../../api/assets'

import { uploadErrorNote, uploadNoteFor } from './EditorsPanel'

/**
 * Подсказка после загрузки. Сервер пережимает картинки в WebP и меняет имя файла,
 * поэтому проверяем ровно то, ради чего подсказка и существует: человек должен
 * увидеть, что файл не подменили, а сжали.
 */
function asset(partial: Partial<Asset>): Asset {
  return {
    id: 'a1',
    project_id: 'p1',
    owner_id: 'u1',
    filename: 'файл',
    mime: 'application/octet-stream',
    size: 100,
    s3_key: 'k',
    kind: 'file',
    created_at: '2026-10-02T00:00:00Z',
    ...partial,
  }
}

function file(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('uploadNoteFor', () => {
  it('обычный файл — просто имя', () => {
    const note = uploadNoteFor(
      file('смета.pdf', 2048, 'application/pdf'),
      asset({ filename: 'смета.pdf', mime: 'application/pdf', size: 2048 }),
    )
    expect(note).toBe('Загружено: смета.pdf')
  })

  it('пережатая картинка — с исходным и итоговым весом', () => {
    const note = uploadNoteFor(
      file('photo.jpg', 2_000_531, 'image/jpeg'),
      asset({ filename: 'photo.webp', mime: 'image/webp', size: 161_396 }),
    )
    expect(note).toBe('Загружено: photo.webp — пережато из 1.9 МБ в 158 КБ')
  })

  it('webp остаётся webp: пережатия не было, лишнего не пишем', () => {
    const note = uploadNoteFor(
      file('схема.webp', 4096, 'image/webp'),
      asset({ filename: 'схема.webp', mime: 'image/webp', size: 4096 }),
    )
    expect(note).toBe('Загружено: схема.webp')
  })
})

describe('uploadErrorNote', () => {
  it('показывает текст сервера: «не помещается» вместо «сервер отклонил запрос»', async () => {
    const error = {
      response: new Response(JSON.stringify({ error: 'в проекте занято 9.4 МБ из 10.0 МБ — файл на 1.2 МБ не помещается' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    }
    expect(await uploadErrorNote(error)).toContain('не помещается')
  })

  it('без ответа сервера — своё сообщение, но понятное', async () => {
    expect(await uploadErrorNote(new TypeError('Failed to fetch'))).toBe(
      'Не удалось загрузить файл: сервер отклонил запрос.',
    )
  })
})
