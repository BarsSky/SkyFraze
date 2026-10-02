import { describe, expect, it } from 'vitest'

import { projectWeight } from './projectWeight'

/**
 * Подпись веса проекта в списке проектов.
 *
 * До этого место в проекте было видно только внутри проекта, в блоке «Файлы
 * проекта», то есть после открытия. Проверяем то, что человек увидит в списке, и
 * границу «место заканчивается».
 */
const mb = (n: number) => n * 1024 * 1024

describe('projectWeight', () => {
  it('с пределом показывает и занятое, и предел', () => {
    expect(projectWeight({ asset_bytes: mb(4), quota_bytes: mb(10) })).toEqual({
      text: 'файлы: 4.0 МБ из 10.0 МБ',
      tight: false,
    })
  })

  it('от 80% предела — предупреждаем', () => {
    expect(projectWeight({ asset_bytes: mb(9), quota_bytes: mb(10) })?.tight).toBe(true)
    expect(projectWeight({ asset_bytes: mb(8), quota_bytes: mb(10) })?.tight).toBe(true)
    expect(projectWeight({ asset_bytes: mb(7.9), quota_bytes: mb(10) })?.tight).toBe(false)
  })

  it('без предела показывает только вес', () => {
    expect(projectWeight({ asset_bytes: mb(2), quota_bytes: 0 })).toEqual({
      text: 'файлы: 2.0 МБ',
      tight: false,
    })
  })

  it('пустой проект не подписываем, чтобы не плодить «файлы: 0 Б»', () => {
    expect(projectWeight({ asset_bytes: 0, quota_bytes: mb(10) })).toBeNull()
    expect(projectWeight({ asset_bytes: 0, quota_bytes: 0 })).toBeNull()
    expect(projectWeight({})).toBeNull()
  })

  it('данные старого сервера (полей нет) не ломают список', () => {
    expect(projectWeight({ asset_bytes: undefined, quota_bytes: undefined })).toBeNull()
  })
})
