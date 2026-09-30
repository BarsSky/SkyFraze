import { useMemo } from 'react'
import { useTheme } from '../../store/theme'
import {
  hashString,
  hsl,
  sceneKind,
  scenePalette,
  type SceneKind,
  type ScenePalette,
} from '../../lib/scenePalette'

/**
 * Процедурный фон кадра: используется, когда у события не выбрана картинка.
 *
 * Палитра выводится из акцента главы и темы (см. lib/scenePalette.ts), поэтому
 * глава и её под-события выглядят как одна история, а светлая тема получает
 * светлую сцену, а не тёмный космос. Композиция выбирается по id события и
 * детерминирована: одно событие — одна и та же картинка.
 *
 * Сцены намеренно абстрактные и низкоконтрастные: они фон для текста, а не
 * вторая сюжетная линия. Ни гора, ни корабль, ни орбита не «привязаны» к жанру —
 * подходит и космосу, и фэнтези, и документу.
 */
interface Props {
  eventId: string
  title: string
  /** Акцент главы (`frame.accent`) — из него строится палитра сцены. */
  accent?: string
  width?: number
  height?: number
  /** 0..1 — фаза анимации (параллакс при прокрутке) */
  phase?: number
}

export function EventIllustration({ eventId, title, accent, width = 1200, height = 700, phase = 0 }: Props) {
  const [theme] = useTheme()
  const palette = useMemo(() => scenePalette(accent ?? '#6FB3C9', theme), [accent, theme])
  const kind = useMemo(() => sceneKind(eventId || title), [eventId, title])
  const seed = useMemo(() => hashString(`${eventId}:detail`), [eventId])
  // Уникальный суффикс градиентов: до этого в компоненте были жёсткие id вида
  // `planet-x`/`blur-x`, которые нигде не определены, и часть сцены не рисовалась.
  const uid = useMemo(() => `scene${hashString(eventId || title).toString(36)}`, [eventId, title])

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}
      role="img"
      aria-label={title}
    >
      <defs>
        <radialGradient id={`${uid}-sky`} cx="50%" cy="42%" r="85%">
          <stop offset="0%" stopColor={palette.bg2} />
          <stop offset="100%" stopColor={palette.bg1} />
        </radialGradient>
        <radialGradient id={`${uid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={palette.glow} stopOpacity="0.55" />
          <stop offset="55%" stopColor={palette.glow} stopOpacity="0.18" />
          <stop offset="100%" stopColor={palette.glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-ridge`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={palette.ridge} stopOpacity="0.55" />
          <stop offset="100%" stopColor={palette.ridge} stopOpacity="0.95" />
        </linearGradient>
      </defs>

      <rect width={width} height={height} fill={`url(#${uid}-sky)`} />
      <Scene kind={kind} palette={palette} width={width} height={height} seed={seed} phase={phase} uid={uid} />
      {/* Плотная вуаль по краям: текст кадра всегда читается поверх сцены. */}
      <rect width={width} height={height} fill={`url(#${uid}-glow)`} opacity="0.5" />
    </svg>
  )
}

function Scene({
  kind, palette, width, height, seed, phase, uid,
}: {
  kind: SceneKind
  palette: ScenePalette
  width: number
  height: number
  seed: number
  phase: number
  uid: string
}) {
  const drift = phase * 14
  switch (kind) {
    case 'ridges':
      return <SceneRidges palette={palette} width={width} height={height} seed={seed} drift={drift} uid={uid} />
    case 'aurora':
      return <SceneAurora palette={palette} width={width} height={height} seed={seed} drift={drift} />
    case 'horizon':
      return <SceneHorizon palette={palette} width={width} height={height} seed={seed} drift={drift} uid={uid} />
    case 'contours':
      return <SceneContours palette={palette} width={width} height={height} seed={seed} drift={0} />
    case 'dust':
      return <SceneDust palette={palette} width={width} height={height} seed={seed} drift={drift} />
    case 'orbits':
      return <SceneOrbits palette={palette} width={width} height={height} seed={seed} drift={drift} />
  }
}

/** Хребты: три слоя мягких горных силуэтов, свет из-за дальней гряды. */
function SceneRidges({ palette, width, height, seed, drift, uid }: SceneProps & { uid: string }) {
  const layers = [0.52, 0.64, 0.78]
  return (
    <g>
      <circle cx={width * 0.68} cy={height * 0.34} r={Math.min(width, height) * 0.22} fill={`url(#${uid}-glow)`} />
      {layers.map((base, layer) => {
        const y = height * base
        const amp = 26 + layer * 22
        const points: string[] = []
        for (let i = 0; i <= 12; i++) {
          const x = (width / 12) * i
          const wobble = Math.sin((i + (seed % 7)) * (1.1 + layer * 0.4)) * amp
          points.push(`${x.toFixed(0)} ${(y + wobble - drift * (0.2 + layer * 0.1)).toFixed(0)}`)
        }
        return (
          <path
            key={layer}
            d={`M 0 ${height} L ${points.join(' L ')} L ${width} ${height} Z`}
            fill={`url(#${uid}-ridge)`}
            opacity={0.35 + layer * 0.22}
          />
        )
      })}
      <g opacity="0.5">
        {Array.from({ length: 24 }).map((_, i) => {
          const h = hashString(`${seed}:dust${i}`)
          return (
            <circle
              key={i}
              cx={((h * 37) % width)}
              cy={((h * 71) % (height * 0.5))}
              r={((h >> 3) % 4) / 6 + 0.4}
              fill={palette.dust}
              opacity={0.35}
            />
          )
        })}
      </g>
    </g>
  )
}

/** Аврора: полосы света с синусоидальным краем. */
function SceneAurora({ palette, width, height, seed, drift }: SceneProps) {
  const bands = [0.3, 0.42, 0.56]
  return (
    <g>
      {bands.map((base, band) => {
        const y = height * base
        const points: string[] = []
        for (let i = 0; i <= 16; i++) {
          const x = (width / 16) * i
          const wave = Math.sin((i / 16) * Math.PI * 2 + band + (seed % 5)) * (34 + band * 18)
          points.push(`${x.toFixed(0)} ${(y + wave - drift * 0.4).toFixed(0)}`)
        }
        const color = band % 2 === 0 ? palette.accent1 : palette.accent2
        return (
          <path
            key={band}
            d={`M 0 ${y + 130} L ${points.join(' L ')} L ${width} ${y + 130} Z`}
            fill={color}
            opacity={0.12 + band * 0.05}
          />
        )
      })}
      <ellipse cx={width * 0.5} cy={height * 1.02} rx={width * 0.7} ry={height * 0.22} fill={palette.ridge} opacity={0.5} />
    </g>
  )
}

/** Горизонт: кривая планеты, тонкая атмосфера и мягкое светило. */
function SceneHorizon({ palette, width, height, seed, drift }: SceneProps) {
  const groundY = height * (0.66 + ((seed % 5) - 2) * 0.01)
  return (
    <g>
      <circle cx={width * 0.42} cy={groundY - height * 0.1} r={Math.min(width, height) * 0.16} fill={palette.glow} opacity="0.5" />
      <path
        d={`M 0 ${groundY} Q ${width / 2} ${groundY - 70} ${width} ${groundY} L ${width} ${height} L 0 ${height} Z`}
        fill={palette.ridge}
        opacity="0.85"
      />
      {/* Атмосферная полоса над горизонтом */}
      <path
        d={`M 0 ${groundY} Q ${width / 2} ${groundY - 70} ${width} ${groundY}`}
        fill="none"
        stroke={palette.accent1}
        strokeWidth="2"
        opacity="0.35"
      />
      {/* Редкие силуэты на горизонте — намёк на «что-то есть», без конкретики */}
      {[0.18, 0.36, 0.62, 0.84].map((x, i) => {
        const h = 16 + ((seed + i * 37) % 34)
        return (
          <rect
            key={i}
            x={width * x - drift * 0.1}
            y={groundY - h - 4}
            width={7}
            height={h}
            fill={palette.ridge}
            opacity="0.75"
          />
        )
      })}
    </g>
  )
}

/** Контуры: топографическая карта — ровные кольца и мелкая сетка. */
function SceneContours({ palette, width, height, seed }: SceneProps) {
  const cx = width * (0.3 + ((seed % 5) * 0.1))
  const cy = height * (0.45 + ((seed % 3) * 0.06))
  return (
    <g>
      {Array.from({ length: 9 }).map((_, i) => {
        const k = 1 + i * 0.55
        return (
          <ellipse
            key={i}
            cx={cx}
            cy={cy}
            rx={Math.min(width, height) * 0.12 * k}
            ry={Math.min(width, height) * 0.08 * k}
            fill="none"
            stroke={i % 3 === 0 ? palette.accent2 : palette.accent1}
            strokeWidth={i % 3 === 0 ? 1.6 : 1}
            opacity={0.22}
          />
        )
      })}
      <g opacity="0.14">
        {Array.from({ length: 10 }).map((_, i) => (
          <line key={i} x1={0} y1={(height / 10) * i} x2={width} y2={(height / 10) * i} stroke={palette.ridge} strokeWidth="1" />
        ))}
      </g>
    </g>
  )
}

/** Пыль: мягкие облака света и мелкая взвесь — «космос» без конкретных тел. */
function SceneDust({ palette, width, height, seed, drift }: SceneProps) {
  return (
    <g>
      {Array.from({ length: 5 }).map((_, i) => {
        const h = hashString(`${seed}:cloud${i}`)
        const cx = (h * 43) % width
        const cy = (h * 97) % height
        const r = Math.min(width, height) * (0.16 + ((h >> 4) % 20) / 100)
        return (
          <circle
            key={i}
            cx={cx - drift * (0.1 + i * 0.03)}
            cy={cy}
            r={r}
            fill={i % 2 === 0 ? palette.accent1 : palette.accent2}
            opacity={0.1}
          />
        )
      })}
      {Array.from({ length: 70 }).map((_, i) => {
        const h = hashString(`${seed}:star${i}`)
        return (
          <circle
            key={i}
            cx={((h * 37) % width) - drift * 0.2}
            cy={(h * 71) % height}
            r={((h >> 3) % 5) / 8 + 0.4}
            fill={palette.dust}
            opacity={(((h >> 5) % 60) + 25) / 100}
          />
        )
      })}
    </g>
  )
}

/** Орбиты: эллипсы и точки — спокойный «технический» фон. */
function SceneOrbits({ palette, width, height, seed, drift }: SceneProps) {
  const cx = width * 0.55
  const cy = height * 0.5
  return (
    <g>
      <circle cx={cx} cy={cy} r={Math.min(width, height) * 0.1} fill={palette.accent1} opacity="0.35" />
      {Array.from({ length: 5 }).map((_, i) => {
        const rx = Math.min(width, height) * (0.2 + i * 0.12)
        const ry = rx * (0.32 + ((seed + i) % 4) * 0.05)
        const angle = ((seed % 360) + i * 47) * (Math.PI / 180)
        const px = cx + Math.cos(angle) * rx
        const py = cy + Math.sin(angle) * ry
        return (
          <g key={i}>
            <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={palette.accent2} strokeWidth="1.2" opacity="0.28" />
            <circle cx={px - drift * 0.2} cy={py} r={3 + (i % 3)} fill={palette.accent1} opacity="0.6" />
          </g>
        )
      })}
    </g>
  )
}

interface SceneProps {
  palette: ScenePalette
  width: number
  height: number
  seed: number
  drift: number
  uid?: string
}
