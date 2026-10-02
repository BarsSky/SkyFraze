import { describe, expect, it } from 'vitest'
import {
  attachmentLabel,
  attachmentsByAsset,
  planAssetMove,
  type TransferFrame,
} from './assetTransfer'

/**
 * Перенос вложения между кадрами.
 *
 * Проверяем не «кнопка нажалась», а последствия: что происходит с исходным кадром,
 * с его фоном, с другими кадрами, где тот же файл, и с фоном целевого кадра.
 */
const chapter: TransferFrame = {
  id: 'c1',
  label: '01 Пролог',
  assetIds: ['a1', 'a2'],
  backgroundAssetId: 'a1',
}
const sub: TransferFrame = {
  id: 's1',
  label: '01.1 Рассвет',
  assetIds: [],
  backgroundAssetId: null,
}
const frames = [chapter, sub]

describe('planAssetMove', () => {
  it('переносит файл и сбрасывает фон исходного кадра, объясняя это человеку', () => {
    const result = planAssetMove(frames, 'a1', 'c1', 's1', { isImage: true })
    if ('error' in result) throw new Error(result.error)

    const source = result.patches.find((p) => p.id === 'c1')
    const target = result.patches.find((p) => p.id === 's1')
    expect(source?.assetIds).toEqual(['a2'])
    // Фон исходного кадра указывал на перенесённую картинку — его надо снять.
    expect(source?.backgroundAssetId).toBeNull()
    expect(target?.assetIds).toEqual(['a1'])
    // В целевом кадре фон пуст — картинка становится фоном (как при загрузке).
    expect(target?.backgroundAssetId).toBe('a1')
    expect(result.notice).toMatch(/Перенесено/)
    expect(result.notice).toMatch(/фон кадра «01 Пролог» сброшен/)
    expect(result.notice).toMatch(/стала фоном/)
  })

  it('не трогает фон исходного кадра, если переносят не фон', () => {
    const result = planAssetMove(frames, 'a2', 'c1', 's1', { isImage: true })
    if ('error' in result) throw new Error(result.error)
    const source = result.patches.find((p) => p.id === 'c1')
    expect(source?.backgroundAssetId).toBeUndefined()
    expect(source?.assetIds).toEqual(['a1'])
  })

  it('не перебивает фон целевого кадра, если он уже выбран', () => {
    const withBackground: TransferFrame = { ...sub, assetIds: ['a9'], backgroundAssetId: 'a9' }
    const result = planAssetMove([chapter, withBackground], 'a2', 'c1', 's1', { isImage: true })
    if ('error' in result) throw new Error(result.error)
    const target = result.patches.find((p) => p.id === 's1')
    expect(target?.backgroundAssetId).toBeUndefined()
    expect(result.notice).not.toMatch(/фоном/)
  })

  it('не назначает фоном не-картинку', () => {
    const result = planAssetMove(frames, 'a1', 'c1', 's1', { isImage: false })
    if ('error' in result) throw new Error(result.error)
    const target = result.patches.find((p) => p.id === 's1')
    expect(target?.backgroundAssetId).toBeUndefined()
  })

  it('работает как «прикрепить», когда файл ещё ни в одном кадре', () => {
    const result = planAssetMove(frames, 'a7', null, 's1', { isImage: false })
    if ('error' in result) throw new Error(result.error)
    expect(result.patches).toHaveLength(1)
    expect(result.patches[0]).toMatchObject({ id: 's1', assetIds: ['a7'] })
    expect(result.notice).toMatch(/Прикреплено/)
  })

  it('отказывает, когда файл уже в целевом кадре, и когда кадра нет', () => {
    const same = planAssetMove(frames, 'a1', 'c1', 'c1', { isImage: true })
    expect('error' in same && same.error).toMatch(/уже в этом кадре/)

    const exists = planAssetMove(frames, 'a1', 'c1', 's1', { isImage: true })
    expect('error' in exists).toBe(false)
    const alreadyThere = planAssetMove(
      [{ ...sub, assetIds: ['a1'] }, chapter],
      'a1',
      'c1',
      's1',
      { isImage: true },
    )
    expect('error' in alreadyThere && alreadyThere.error).toMatch(/уже прикреплён/)

    const nowhere = planAssetMove(frames, 'a1', 'c1', 'missing', { isImage: true })
    expect('error' in nowhere && nowhere.error).toMatch(/Кадр не найден/)

    const notInSource = planAssetMove(frames, 'a5', 'c1', 's1', { isImage: true })
    expect('error' in notInSource && notInSource.error).toMatch(/нет в кадре/)
  })

  it('один файл в нескольких кадрах: перенос убирает его только у исходного', () => {
    const other: TransferFrame = {
      id: 's2',
      label: '01.2 Буря',
      assetIds: ['a1'],
      backgroundAssetId: 'a1',
    }
    const result = planAssetMove([chapter, sub, other], 'a1', 'c1', 's1', { isImage: true })
    if ('error' in result) throw new Error(result.error)
    // У «Бури» файл остаётся: перенос из «Пролога» не значит «убрать везде».
    expect(result.patches.map((p) => p.id)).toEqual(['c1', 's1'])
  })
})

describe('attachmentsByAsset / attachmentLabel', () => {
  it('собирает, где лежит каждый файл', () => {
    const map = attachmentsByAsset([chapter, sub])
    expect(map.get('a1')?.map((f) => f.label)).toEqual(['01 Пролог'])
    expect(map.get('a2')?.map((f) => f.label)).toEqual(['01 Пролог'])
    expect(map.get('a9')).toBeUndefined()
  })

  it('подпись «где файл» показывает кадры или честно говорит, что нигде', () => {
    expect(attachmentLabel([chapter, sub, chapter])).toBe('01 Пролог, 01.1 Рассвет, 01 Пролог')
    expect(attachmentLabel([])).toBe('ни в одном кадре')
    expect(attachmentLabel(undefined)).toBe('ни в одном кадре')
  })
})
