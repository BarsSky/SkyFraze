import { useMemo } from 'react'

/**
 * Процедурный генератор SVG-иллюстраций для событий таймлайна.
 * Используется как fallback когда у события нет загруженного ассета.
 *
 * Каждая иллюстрация детерминирована по event.id (через простой hash)
 * → один и тот же event всегда получает ту же картинку.
 *
 * Theme palette — cinematic dark sci-fi (тёплые/холодные акценты).
 */

interface Props {
  eventId: string
  title: string
  width?: number
  height?: number
  /** 0..1 — фаза анимации */
  phase?: number
}

// cinematic palettes: [bg1, bg2, accent1, accent2, glow]
const PALETTES: Array<[string, string, string, string, string]> = [
  ['#0a0d18', '#1a0d2e', '#58a6ff', '#a371f7', '#3fb950'], // запуск в космос (cool)
  ['#0d1820', '#1a2030', '#39c5cf', '#58a6ff', '#7d8590'], // сигналы (cold)
  ['#1a0d0d', '#2e1010', '#d29922', '#f85149', '#ffa657'], // теория/открытие (warm)
  ['#0a0a0a', '#1a1a1a', '#7d8590', '#58a6ff', '#f85149'], // протесты (mono)
  ['#1f0d0d', '#3d1818', '#f85149', '#ff7b72', '#d29922'], // битва/инцидент (red)
  ['#0d1a1f', '#1a2030', '#a371f7', '#58a6ff', '#39c5cf'], // восстание ИИ (purple)
  ['#1a1a0d', '#2e2e10', '#d29922', '#58a6ff', '#7d8590'], // подготовка (industrial)
]

function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
  }
  return Math.abs(h)
}

export function EventIllustration({ eventId, title, width = 1200, height = 700, phase = 0 }: Props) {
  const palette = useMemo(() => {
    const idx = hashStr(eventId || title) % PALETTES.length
    return PALETTES[idx]
  }, [eventId, title])

  const variant = useMemo(() => {
    // Выбираем «сцену» по hash — разные композиции для разных событий
    const v = hashStr(eventId + 'scene') % 4
    return v
  }, [eventId])

  const [bg1, bg2, accent1, accent2, glow] = palette

  // Параметры, зависящие от фазы (для тонкой анимации при прокрутке)
  const t = phase
  const starDrift = t * 12 // пикселей сдвига

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
      }}
      role="img"
      aria-label={title}
    >
      <defs>
        <radialGradient id={`bg-${eventId}`} cx="50%" cy="60%" r="80%">
          <stop offset="0%" stopColor={bg2} />
          <stop offset="100%" stopColor={bg1} />
        </radialGradient>
        <radialGradient id={`glow-${eventId}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={glow} stopOpacity="0.6" />
          <stop offset="60%" stopColor={accent1} stopOpacity="0.2" />
          <stop offset="100%" stopColor={accent1} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`planet-${eventId}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={accent1} />
          <stop offset="100%" stopColor={accent2} />
        </linearGradient>
        <filter id={`blur-${eventId}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* Background */}
      <rect width={width} height={height} fill={`url(#bg-${eventId})`} />

      {/* Звёзды — детерминированные по hash */}
      {Array.from({ length: 80 }).map((_, i) => {
        const h = hashStr(eventId + 'star' + i)
        const x = (h * 37) % width
        const y = (h * 71) % height
        const r = ((h >> 3) % 5) / 10 + 0.3
        const opacity = ((h >> 5) % 100) / 200 + 0.3
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={r}
            fill="#fff"
            opacity={opacity}
          />
        )
      })}

      {/* Параллакс слой звёзд (медленнее) */}
      <g transform={`translate(${-starDrift * 0.3} 0)`}>
        {Array.from({ length: 30 }).map((_, i) => {
          const h = hashStr(eventId + 'far' + i)
          const x = ((h * 53) % width) + starDrift
          const y = ((h * 89) % height)
          return <circle key={i} cx={x} cy={y} r={1.2} fill="#fff" opacity={0.4} />
        })}
      </g>

      {/* Glow halo */}
      <circle
        cx={width / 2}
        cy={height * 0.5}
        r={Math.min(width, height) * 0.4}
        fill={`url(#glow-${eventId})`}
      />

      {/* Scene-specific composition */}
      {variant === 0 && (
        // Большая планета + кольца (как Сатурн)
        <ScenePlanetRinged width={width} height={height} accent1={accent1} accent2={accent2} />
      )}
      {variant === 1 && (
        // Корабль с траекторией
        <SceneShipTrajectory width={width} height={height} accent1={accent1} accent2={accent2} phase={phase} />
      )}
      {variant === 2 && (
        // Звёздное скопление + лучи
        <SceneStarCluster width={width} height={height} accent1={accent1} accent2={accent2} glow={glow} />
      )}
      {variant === 3 && (
        // Горизонт планеты
        <SceneHorizon width={width} height={height} accent1={accent1} accent2={accent2} glow={glow} phase={phase} />
      )}

      {/* Vignette */}
      <rect width={width} height={height} fill={`url(#bg-${eventId})`} opacity={0.15} style={{ mixBlendMode: 'multiply' as React.CSSProperties['mixBlendMode'] }} />

      {/* Title overlay (subtle, в правом нижнем углу) */}
      <g opacity={0.6}>
        <text
          x={width - 40}
          y={height - 32}
          textAnchor="end"
          fill="#fff"
          fontFamily="system-ui"
          fontSize="22"
          fontWeight={500}
          style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.8))' }}
        >
          {title.slice(0, 60)}
        </text>
      </g>
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene compositions
// ─────────────────────────────────────────────────────────────────────────────

function ScenePlanetRinged({ width, height, accent1, accent2 }: { width: number; height: number; accent1: string; accent2: string }) {
  const cx = width * 0.7
  const cy = height * 0.5
  const r = Math.min(width, height) * 0.18
  return (
    <g>
      {/* Back-side of ring */}
      <ellipse cx={cx} cy={cy} rx={r * 1.9} ry={r * 0.4} fill="none" stroke={accent2} strokeWidth={3} opacity={0.5} />
      {/* Planet */}
      <circle cx={cx} cy={cy} r={r} fill={`url(#planet-${'x'})`}>
        <animate attributeName="opacity" values="0.95;1;0.95" dur="6s" repeatCount="indefinite" />
      </circle>
      {/* Surface details */}
      <ellipse cx={cx - r * 0.3} cy={cy - r * 0.2} rx={r * 0.4} ry={r * 0.15} fill={accent2} opacity={0.3} />
      <ellipse cx={cx + r * 0.4} cy={cy + r * 0.3} rx={r * 0.3} ry={r * 0.1} fill={accent2} opacity={0.4} />
      {/* Front-side of ring */}
      <ellipse cx={cx} cy={cy} rx={r * 1.9} ry={r * 0.4} fill="none" stroke={accent1} strokeWidth={4} opacity={0.85} mask={`url(#ringMask)`} />
      {/* Moon */}
      <circle cx={width * 0.25} cy={height * 0.3} r={r * 0.18} fill={accent1} opacity={0.6} />
    </g>
  )
}

function SceneShipTrajectory({ width, height, accent1, accent2, phase }: { width: number; height: number; accent1: string; accent2: string; phase: number }) {
  // Корабль движется по параболе слева направо
  const progress = (phase % 1 + 1) % 1 // 0..1
  const x = width * 0.1 + width * 0.8 * progress
  const y = height * 0.7 - Math.sin(progress * Math.PI) * height * 0.4
  return (
    <g>
      {/* Trajectory path */}
      <path
        d={`M ${width * 0.05} ${height * 0.7} Q ${width * 0.5} ${height * 0.2} ${width * 0.95} ${height * 0.7}`}
        fill="none"
        stroke={accent1}
        strokeWidth={2}
        strokeDasharray="8 12"
        opacity={0.5}
      />
      {/* Engine glow */}
      <circle cx={x} cy={y} r={40} fill={accent2} opacity={0.4} filter="url(#blur-x)" />
      {/* Ship body */}
      <g transform={`translate(${x}, ${y}) rotate(${progress * 30 - 15})`}>
        <ellipse cx={0} cy={0} rx={32} ry={8} fill={accent1} />
        <ellipse cx={0} cy={0} rx={20} ry={5} fill={accent2} />
        <polygon points="-32,0 -42,-4 -42,4" fill={accent1} />
        <polygon points="-32,0 -38,-8 -36,-3 -38,3 -36,8" fill={accent2} />
      </g>
    </g>
  )
}

function SceneStarCluster({ width, height, accent1, accent2, glow }: { width: number; height: number; accent1: string; accent2: string; glow: string }) {
  // Большое светило в центре + лучи
  const cx = width / 2
  const cy = height * 0.55
  return (
    <g>
      {/* Core glow */}
      <circle cx={cx} cy={cy} r={180} fill={glow} opacity={0.3} />
      <circle cx={cx} cy={cy} r={80} fill={glow} opacity={0.6} />
      <circle cx={cx} cy={cy} r={28} fill="#fff" />
      {/* Light rays */}
      {Array.from({ length: 16 }).map((_, i) => {
        const angle = (i / 16) * Math.PI * 2
        const x2 = cx + Math.cos(angle) * 280
        const y2 = cy + Math.sin(angle) * 280
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x2}
            y2={y2}
            stroke={accent1}
            strokeWidth={1.5}
            opacity={0.4}
          />
        )
      })}
      {/* Orbit ring */}
      <ellipse cx={cx} cy={cy} rx={220} ry={60} fill="none" stroke={accent2} strokeWidth={1.5} opacity={0.5} />
      <circle cx={cx + 220} cy={cy} r={6} fill={accent2} />
    </g>
  )
}

function SceneHorizon({ width, height, accent1, accent2, glow, phase }: { width: number; height: number; accent1: string; accent2: string; glow: string; phase: number }) {
  // Горизонт планеты снизу, силуэты кораблей/деревьев/башен
  const groundY = height * 0.7
  return (
    <g>
      {/* Sky gradient (above) */}
      <rect x={0} y={0} width={width} height={groundY} fill={accent1} opacity={0.15} />
      {/* Ground curve */}
      <path
        d={`M 0 ${groundY} Q ${width / 2} ${groundY - 60} ${width} ${groundY} L ${width} ${height} L 0 ${height} Z`}
        fill={accent1}
        opacity={0.5}
      />
      {/* Distant glow (sunrise) */}
      <circle cx={width * 0.5} cy={groundY - 30} r={120} fill={glow} opacity={0.4} />
      <circle cx={width * 0.5} cy={groundY - 30} r={60} fill={accent2} opacity={0.6} />
      {/* Silhouettes */}
      {[0.1, 0.25, 0.55, 0.78, 0.92].map((x, i) => {
        const h = 30 + ((i * 47) % 60)
        return (
          <rect
            key={i}
            x={width * x - 8}
            y={groundY - h}
            width={16}
            height={h}
            fill="#000"
            opacity={0.7}
          />
        )
      })}
    </g>
  )
}
