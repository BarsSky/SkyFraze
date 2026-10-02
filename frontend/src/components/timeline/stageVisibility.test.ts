import { describe, expect, it } from 'vitest'
import { stageIsActive } from './stageVisibility'

/**
 * Когда стадия таймлайна жива, а когда гаснет.
 *
 * Проверяем ровно тот дефект, из-за которого «пустая область перекрывала редактор»:
 * хвост трека занимает верхнюю половину экрана, внизу уже показался редактор — стадия
 * обязана погаснуть, иначе её fixed-слой накрывает редактор и крадёт по нему клики.
 */
const VIEWPORT = { boxTop: 0, boxBottom: 720 }

/** Трек на весь экран: от 0 до 720. */
const FULL_TRACK = { trackTop: 0, trackBottom: 720 }

describe('stageIsActive', () => {
  it('трек на весь экран, редактор далеко внизу — стадия жива', () => {
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: 1400 })).toBe(true)
  })

  it('редактор показался внизу — стадия гаснет, даже если трек ещё занимает пол-экрана', () => {
    // Ровно случай из отчёта: верх занят хвостом трека, внизу виден редактор.
    expect(
      stageIsActive({ ...VIEWPORT, trackTop: -660, trackBottom: 60, nextTop: 480 }),
    ).toBe(false)
  })

  it('редактор подходит к нижней кромке — стадия ещё жива', () => {
    // nextTop ниже «линии входа» (0.9 экрана = 648) — не гасим раньше времени.
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: 700 })).toBe(true)
  })

  it('трека на экране почти нет — стадия гаснет и без следующего блока', () => {
    expect(stageIsActive({ ...VIEWPORT, trackTop: -700, trackBottom: 20, nextTop: null })).toBe(false)
  })

  it('после стадии ничего нет (пустой проект) — работает прежнее правило про половину', () => {
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: null })).toBe(true)
    expect(stageIsActive({ ...VIEWPORT, trackTop: -400, trackBottom: 320, nextTop: null })).toBe(false)
  })

  it('вьюпорт смещён (прокрутка вложенного контейнера) — считаем от его границ', () => {
    // Верх видимой области не 0: у проекта это `main` под шапкой (62px), высота 658.
    const box = { boxTop: 62, boxBottom: 720 }
    // Трек занимает весь видимый бокс, редактор далеко внизу — стадия жива.
    expect(stageIsActive({ ...box, trackTop: 62, trackBottom: 782, nextTop: 1500 })).toBe(true)
    // Редактор ещё ниже линии входа (62 + 0.9·658 = 654) — стадия тоже жива.
    expect(stageIsActive({ ...box, trackTop: 62, trackBottom: 782, nextTop: 700 })).toBe(true)
    // Редактор поднялся выше линии входа — стадия гаснет.
    expect(stageIsActive({ ...box, trackTop: 62, trackBottom: 782, nextTop: 600 })).toBe(false)
  })
})
