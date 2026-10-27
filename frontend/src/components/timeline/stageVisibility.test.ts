import { describe, expect, it } from 'vitest'
import { stageIsActive } from './stageVisibility'

/**
 * Когда стадия таймлайна жива, а когда гаснет.
 *
 * Два правила и их порядок:
 *   1. трек должен занимать существенную часть экрана (иначе показывать нечего);
 *   2. следующий блок («Связи», «Редакторы», бар присутствия) накрыл экран ЦЕЛИКОМ — тогда
 *      стадия гаснет. Он выше fixed-слоя сцены по z-index, поэтому въезжает поверх неё: так
 *      переход выглядит прокруткой, а не пустой полосой между сценой и разделом (0.82.0).
 *
 * Раньше второе правило гасило стадию, как только блок показывался снизу (линия входа — 0.9
 * экрана). Отсюда и жалоба «слишком много пустого места при прокрутке»: сцена уже погашена, а
 * раздел ещё не дошёл.
 */
const VIEWPORT = { boxTop: 0, boxBottom: 720 }

/** Трек на весь экран: от 0 до 720. */
const FULL_TRACK = { trackTop: 0, trackBottom: 720 }

describe('stageIsActive', () => {
  it('трек на весь экран, следующий блок далеко внизу — стадия жива', () => {
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: 1400 })).toBe(true)
  })

  it('следующий блок показался снизу — стадия ЖИВА: он въезжает поверх сцены', () => {
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: 480 })).toBe(true)
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: 700 })).toBe(true)
  })

  it('блок накрыл экран целиком — стадия гаснет', () => {
    expect(stageIsActive({ ...VIEWPORT, trackTop: -660, trackBottom: 60, nextTop: 0 })).toBe(false)
    expect(stageIsActive({ ...VIEWPORT, trackTop: -660, trackBottom: 60, nextTop: -80 })).toBe(false)
  })

  it('трека на экране почти нет — стадия гаснет и без следующего блока', () => {
    expect(stageIsActive({ ...VIEWPORT, trackTop: -700, trackBottom: 20, nextTop: null })).toBe(false)
  })

  it('после стадии ничего нет (пустой проект) — решает, сколько трека ещё на экране', () => {
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: null })).toBe(true)
    // Полоска трека ниже порога (0.1 экрана = 72 px) — сцену больше не показывать.
    expect(stageIsActive({ ...VIEWPORT, trackTop: -700, trackBottom: 20, nextTop: null })).toBe(false)
    // А 320 px трека — ещё видно, и накрывать нечего: стадия жива.
    expect(stageIsActive({ ...VIEWPORT, trackTop: -400, trackBottom: 320, nextTop: null })).toBe(true)
  })

  it('вьюпорт смещён (прокрутка вложенного контейнера) — считаем от его границ', () => {
    // Верх видимой области не 0: у проекта это `main` под шапкой (62px), высота 658.
    const box = { boxTop: 62, boxBottom: 720 }
    expect(stageIsActive({ ...box, trackTop: 62, trackBottom: 782, nextTop: 1500 })).toBe(true)
    // Блок въезжает поверх сцены — стадия жива, пока его верх ниже верхней кромки бокса.
    expect(stageIsActive({ ...box, trackTop: 62, trackBottom: 782, nextTop: 300 })).toBe(true)
    // Верх блока ушёл выше кромки — он накрыл экран, стадия гаснет.
    expect(stageIsActive({ ...box, trackTop: 62, trackBottom: 782, nextTop: 40 })).toBe(false)
  })

  it('порог входа можно сдвинуть явно (запас на слайд-переход)', () => {
    // nextEnterRatio 0.2 — линия входа 144 px: блок с верхом 100 уже «накрыл» экран на 80%.
    expect(
      stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: 100, nextEnterRatio: 0.2 }),
    ).toBe(false)
    // Тот же блок при пороге по умолчанию (0) ещё не накрыл экран целиком — стадия жива.
    expect(stageIsActive({ ...VIEWPORT, ...FULL_TRACK, nextTop: 100 })).toBe(true)
  })
})
