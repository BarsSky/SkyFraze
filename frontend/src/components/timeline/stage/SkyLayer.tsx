import { useMemo } from 'react'

const PARTICLE_COUNT = 16

/**
 * Небо кадра: градиент от акцента кадра, мягкое свечение и дрейф-частицы.
 * Чистый слой оформления — без данных проекта.
 */
export function SkyLayer({ accent, tone }: { accent: string; tone?: string }) {
  const particles = useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }).map((_, i) => ({
        id: i,
        left: `${Math.round(Math.random() * 100)}%`,
        top: `${Math.round(Math.random() * 100)}%`,
        size: 6 + Math.round(Math.random() * 14),
        delay: `${(Math.random() * 9).toFixed(2)}s`,
        duration: `${(11 + Math.random() * 12).toFixed(2)}s`,
        ring: i % 4 === 0,
      })),
    [],
  )

  return (
    <div className="sf-sky" style={{ ['--sf-accent' as string]: accent }}>
      <div className="sf-sky__grad" style={tone ? { ['--sf-tone' as string]: tone } : undefined} />
      <div className="sf-sky__glow" />
      <div className="sf-particles" aria-hidden>
        {particles.map((p) => (
          <span
            key={p.id}
            className={p.ring ? 'sf-pt sf-pt--ring' : 'sf-pt sf-pt--dot'}
            style={{
              left: p.left,
              top: p.top,
              width: p.size,
              height: p.size,
              animationDelay: p.delay,
              animationDuration: p.duration,
            }}
          />
        ))}
      </div>
    </div>
  )
}
