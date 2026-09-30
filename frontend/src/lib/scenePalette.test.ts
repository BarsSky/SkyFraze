import { describe, expect, it } from 'vitest'
import { SCENE_KINDS, hashString, hexToHsl, sceneKind, scenePalette } from './scenePalette'

/** Достаёт светлоту из строки «hsl(H S% L%)». */
function lightness(color: string): number {
  const m = /hsl\([\d.]+ [\d.]+% ([\d.]+)%/.exec(color)
  return m ? Number(m[1]) : NaN
}

function hue(color: string): number {
  const m = /hsl\(([\d.]+)/.exec(color)
  return m ? Number(m[1]) : NaN
}

describe('scenePalette', () => {
  it('хеш детерминирован и различает строки', () => {
    expect(hashString('event-a')).toBe(hashString('event-a'))
    expect(hashString('event-a')).not.toBe(hashString('event-b'))
  })

  it('hexToHsl понимает #rgb и #rrggbb, не падает на мусоре', () => {
    const green = hexToHsl('#4f8a4a')
    expect(green.h).toBeGreaterThan(90)
    expect(green.h).toBeLessThan(150)
    expect(hexToHsl('#fff').l).toBeCloseTo(100, 0)
    expect(() => hexToHsl('не цвет')).not.toThrow()
    expect(hexToHsl('не цвет').h).toBeGreaterThanOrEqual(0)
  })

  it('тёмная тема — тёмный фон, светлая — светлый', () => {
    const dark = scenePalette('#8FB98A', 'dark')
    const light = scenePalette('#8FB98A', 'light')
    expect(lightness(dark.bg1)).toBeLessThan(15)
    expect(lightness(light.bg1)).toBeGreaterThan(85)
    // Силуэты в тёмной теме темнее фона, в светлой — светлее: сцена читается как
    // ночь или как рисунок на бумаге.
    expect(lightness(dark.ridge)).toBeLessThan(lightness(dark.bg2))
    expect(lightness(light.ridge)).toBeGreaterThan(70)
  })

  it('оттенок сцены идёт от акцента главы', () => {
    const accent = '#6FB3C9' // голубой
    const { h } = hexToHsl(accent)
    const dark = scenePalette(accent, 'dark')
    expect(Math.abs(hue(dark.bg1) - h)).toBeLessThan(1)
    expect(Math.abs(hue(dark.accent1) - h)).toBeLessThan(1)
    // Второй акцент сдвинут по тону, чтобы сцена не была одноцветной.
    expect(Math.abs(hue(dark.accent2) - h)).toBeGreaterThan(20)
  })

  it('композиция стабильна для события и покрывает набор видов', () => {
    expect(sceneKind('frame-1')).toBe(sceneKind('frame-1'))
    const kinds = new Set(Array.from({ length: 40 }, (_, i) => sceneKind(`frame-${i}`)))
    expect(kinds.size).toBeGreaterThan(1)
    for (const kind of kinds) expect(SCENE_KINDS).toContain(kind)
  })
})
