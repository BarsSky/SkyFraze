import { describe, expect, it, vi } from 'vitest'
import type { Asset } from '../api/assets'
import { isQuotaMessage, runUploads, uploadSummary, type UploadOutcome } from './uploadQueue'

/**
 * Очередь загрузки нескольких файлов: порядок, прогресс, отказы и остановка.
 *
 * Проверяем то, что человек видит при выборе десятка файлов: все они получают судьбу
 * (и удачные, и нет), место кончается — остаток не отправляется, слишком большой файл
 * не уходит на сервер вовсе.
 */
function file(name: string, size = 1024): File {
  const f = new File(['x'], name, { type: 'image/png' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

function asset(name: string, size = 512): Asset {
  return {
    id: `id-${name}`,
    project_id: 'p1',
    filename: name,
    mime: 'image/webp',
    size,
    kind: 'image',
    created_at: '',
  } as Asset
}

const MAX = 50 * 1024 * 1024

describe('runUploads', () => {
  it('загружает файлы по очереди и отдаёт результат по каждому', async () => {
    const calls: string[] = []
    const progress: string[] = []
    const files = [file('a.png'), file('b.png'), file('c.png')]
    const outcomes = await runUploads(
      files,
      async (f) => {
        calls.push(f.name)
        return asset(`up-${f.name}`)
      },
      { maxBytes: MAX, onProgress: (done, total) => progress.push(`${done}/${total}`) },
    )

    expect(calls).toEqual(['a.png', 'b.png', 'c.png'])
    expect(outcomes.map((o) => o.asset?.filename)).toEqual(['up-a.png', 'up-b.png', 'up-c.png'])
    // Прогресс: 0/3, 1/3, 2/3 и финальное 3/3 — «сколько сделано из скольких».
    expect(progress).toEqual(['0/3', '1/3', '2/3', '3/3'])
  })

  it('слишком большой файл не уходит на сервер, но виден в сводке', async () => {
    const upload = vi.fn(async () => asset('ok.png'))
    const outcomes = await runUploads([file('big.png', MAX + 1), file('ok.png')], upload, {
      maxBytes: MAX,
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(outcomes[0].error).toMatch(/больше 50 МБ/)
    expect(outcomes[1].asset?.filename).toBe('ok.png')
  })

  it('на отказе по квоте остаток не отправляется', async () => {
    const upload = vi.fn(async (f: File) => {
      if (f.name === 'second.png') throw new Error('409')
      return asset(f.name)
    })
    const outcomes = await runUploads([file('first.png'), file('second.png'), file('third.png')], upload, {
      maxBytes: MAX,
      describeError: () => 'в проекте занято 9.4 МБ из 10 МБ — файл не помещается',
    })

    // Третий файл даже не пробовали: место уже кончилось.
    expect(upload).toHaveBeenCalledTimes(2)
    expect(outcomes[0].asset).not.toBeNull()
    expect(outcomes[1].error).toMatch(/не помещается/)
    expect(outcomes[2].error).toMatch(/не загружался/)
  })

  it('обычный отказ не останавливает очередь', async () => {
    const upload = vi.fn(async (f: File) => {
      if (f.name === 'bad.png') throw new Error('boom')
      return asset(f.name)
    })
    const outcomes = await runUploads([file('bad.png'), file('good.png')], upload, {
      maxBytes: MAX,
      describeError: () => 'сервер ответил 500',
    })
    expect(upload).toHaveBeenCalledTimes(2)
    expect(outcomes[0].error).toBe('сервер ответил 500')
    expect(outcomes[1].asset).not.toBeNull()
  })
})

describe('uploadSummary', () => {
  it('один файл — просто имя, несколько — счёт и вес', () => {
    const one: UploadOutcome[] = [{ file: file('a.png'), asset: asset('a.png', 2048), error: null }]
    expect(uploadSummary(one)).toBe('Загружено: a.png')

    const many: UploadOutcome[] = [
      { file: file('a.png'), asset: asset('a.png', 1024), error: null },
      { file: file('b.png'), asset: asset('b.png', 1024), error: null },
    ]
    expect(uploadSummary(many)).toMatch(/Загружено файлов: 2/)
  })

  it('при отказах говорит, сколько дошло и почему не вышло', () => {
    const outcomes: UploadOutcome[] = [
      { file: file('a.png'), asset: asset('a.png'), error: null },
      { file: file('b.png'), asset: null, error: 'не помещается' },
    ]
    const text = uploadSummary(outcomes)
    expect(text).toMatch(/загружено 1 из 2/)
    expect(text).toMatch(/b\.png: не помещается/)
  })
})

describe('isQuotaMessage', () => {
  it('узнаёт отказы по месту и не путает их с прочими', () => {
    expect(isQuotaMessage('в проекте занято 9.4 МБ из 10 МБ — файл на 1.2 МБ не помещается')).toBe(true)
    expect(isQuotaMessage('место закончилось')).toBe(true)
    expect(isQuotaMessage('файл больше 50 МБ — сервер его не примет')).toBe(false)
    expect(isQuotaMessage('сервер ответил 500')).toBe(false)
  })
})
