/**
 * Палитра и композиция процедурного фона кадра.
 *
 * Раньше фон выбирался из семи «кинематографичных» тёмных палитр по хешу события:
 * у главы и её под-событий оказывались разные, случайные цвета (красная битва рядом
 * с фиолетовым восстанием ИИ), а в светлой теме сцена всё равно оставалась тёмной —
 * только слегка обесцвеченной фильтром. Здесь фон выводится из АКЦЕНТА ГЛАВЫ
 * (он и так уникален на главу и разный в двух темах) и из темы: тон, насыщенность и
 * светлота считаются от акцента, поэтому глава и её под-события выглядят как одна
 * история, а светлая тема получает светлую, «бумажную» сцену.
 *
 * Композиция (что именно нарисовано) по-прежнему детерминирована по id события:
 * одно и то же событие всегда получает одну и ту же картинку.
 */

export type SceneKind = 'ridges' | 'aurora' | 'horizon' | 'contours' | 'dust' | 'orbits'

export const SCENE_KINDS: SceneKind[] = ['ridges', 'aurora', 'horizon', 'contours', 'dust', 'orbits']

export interface ScenePalette {
  /** Дальний фон (заливка всего кадра) */
  bg1: string
  /** Ближний фон — мягкое световое пятно */
  bg2: string
  /** Силуэты: хребты, контуры, горизонт */
  ridge: string
  /** Первый акцент: линии, детали */
  accent1: string
  /** Второй акцент — сдвиг по тону, чтобы сцена не была одноцветной */
  accent2: string
  /** Свечение (источник света) */
  glow: string
  /** Пылинки/звёзды */
  dust: string
}

/** Детерминированный хеш строки (djb2): по нему выбираются композиция и детали. */
export function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return Math.abs(h)
}

/** #rgb / #rrggbb → HSL (h 0..360, s и l 0..100). Непонятный цвет → серый. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { h: 210, s: 20, l: 50 }
  let raw = m[1]
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('')
  const int = parseInt(raw, 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

/** HSL → цвет для SVG (alpha необязательна). */
export function hsl(h: number, s: number, l: number, alpha = 1): string {
  const hue = ((h % 360) + 360) % 360
  const sat = Math.max(0, Math.min(100, s))
  const light = Math.max(0, Math.min(100, l))
  if (alpha >= 1) return `hsl(${hue.toFixed(1)} ${sat.toFixed(1)}% ${light.toFixed(1)}%)`
  return `hsl(${hue.toFixed(1)} ${sat.toFixed(1)}% ${light.toFixed(1)}% / ${alpha})`
}

/**
 * Палитра сцены по акценту главы и теме.
 *
 * Тёмная тема — глубокая, «ночная»: фон почти чёрный с оттенком акцента, силуэты
 * темнее фона, свечение вокруг акцента. Светлая — «бумажная»: фон почти белый с
 * тем же оттенком, силуэты светлее фона, акценты приглушённые и тёмные, чтобы
 * сцена читалась как рисунок, а не как ночной космос.
 */
export function scenePalette(accent: string, theme: 'dark' | 'light'): ScenePalette {
  const { h, s } = hexToHsl(accent)
  // Насыщенность фона держим низкой: сцена не должна спорить с текстом кадра.
  const sat = Math.max(18, Math.min(70, s))
  if (theme === 'light') {
    return {
      bg1: hsl(h, sat * 0.32, 95),
      bg2: hsl(h + 18, sat * 0.28, 88, 0.85),
      ridge: hsl(h + 8, sat * 0.34, 82),
      accent1: hsl(h, sat * 0.5, 45),
      accent2: hsl(h + 42, sat * 0.42, 40),
      glow: hsl(h + 12, sat * 0.6, 72),
      dust: hsl(h + 20, sat * 0.3, 40, 0.35),
    }
  }
  return {
    bg1: hsl(h, sat * 0.35, 7),
    bg2: hsl(h + 18, sat * 0.32, 14, 0.9),
    ridge: hsl(h + 8, sat * 0.4, 4),
    accent1: hsl(h, sat * 0.75, 62),
    accent2: hsl(h + 42, sat * 0.6, 58),
    glow: hsl(h + 12, sat * 0.8, 64),
    dust: hsl(h + 20, sat * 0.2, 96, 0.55),
  }
}

/** Композиция кадра — по id события, чтобы одна и та же сцена была стабильной. */
export function sceneKind(eventId: string): SceneKind {
  return SCENE_KINDS[hashString(`${eventId}:scene`) % SCENE_KINDS.length]
}
