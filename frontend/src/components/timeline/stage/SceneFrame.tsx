import { EventIllustration } from '../EventIllustration'
import type { TimelineFrame } from '../timelineModel'

/**
 * Фон кадра: картинка (ассет события), тон или процедурная иллюстрация.
 * Настраивается на самом событии (в редакторе) и наследуется от родителя.
 */
export function SceneFrame({ frame, local }: { frame: TimelineFrame; local: number }) {
  const parallax = `translate3d(0, ${(-2 + local * 4).toFixed(2)}%, 0) scale(${(1.04 - local * 0.04).toFixed(3)})`
  const { background } = frame

  return (
    <div className="sf-scene__inner" style={{ transform: parallax }}>
      {background.kind === 'asset' && background.assetUrl ? (
        <img className="sf-scene__still" src={background.assetUrl} alt="" loading="lazy" />
      ) : background.kind === 'tone' ? (
        <div className="sf-scene__tone" style={{ background: toneGradient(background.tone) }} />
      ) : (
        <div className="sf-scene__still sf-scene__still--generated">
          <EventIllustration eventId={frame.id} title={frame.title} phase={0.5} />
        </div>
      )}
      <div className="sf-scene__vignette" />
    </div>
  )
}

/** Мягкий градиент из выбранного тона — «настраиваемый фон» без картинки. */
function toneGradient(tone?: string): string {
  const base = tone ?? '#6D7B8C'
  return [
    `radial-gradient(120% 90% at 30% 20%, ${hexAlpha(base, 0.55)} 0%, transparent 60%)`,
    `radial-gradient(100% 80% at 80% 80%, ${hexAlpha(base, 0.35)} 0%, transparent 65%)`,
    `linear-gradient(160deg, ${hexAlpha(base, 0.22)} 0%, var(--sf-bg) 70%)`,
  ].join(', ')
}

/** #RRGGBB + alpha → rgba(...) (без color-mix, чтобы работало и в SVG-фонах). */
export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const int = parseInt(m[1], 16)
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
