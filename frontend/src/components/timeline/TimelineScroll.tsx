import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { EventIllustration } from './EventIllustration'
import type { YArray, YMap } from '../../collab/yprovider'

interface EventLite {
  id: string
  title: string
  body: string
  phase: number // 0..1 — scroll progress для каждого события
  isActive: boolean
  isSelected: boolean
}

interface Props {
  events: YArray
  /** индекс выбранного (selected для редактирования) события */
  selectedIndex: number
  onSelect: (idx: number) => void
  /** eventId → URL ассета (если есть) для замены illustration на реальный image */
  assetUrlByEventId?: Record<string, string>
}

/**
 * Scrollytelling timeline.
 *
 * Каждое событие — full-viewport секция, sticky-positioned.
 * При скролле активная секция меняется (через IntersectionObserver),
 * текст и иллюстрация плавно переходят между событиями.
 *
 * Visual:
 *   ┌────────────────────┐
 *   │  [Illustration]    │  ← full bleed background (SVG или asset image)
 *   │                    │
 *   │   ┌────────────┐   │
 *   │   │  Title     │   │  ← overlay card
 *   │   │  body text │   │
 *   │   │  [edit]    │   │
 *   │   └────────────┘   │
 *   └────────────────────┘
 *         next event ↓
 *
 * Параллельно слева — вертикальная timeline-rail с progress-индикатором.
 */
export function TimelineScroll({ events, selectedIndex, onSelect, assetUrlByEventId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const [eventMeta, setEventMeta] = useState<Array<{ id: string; title: string; body: string }>>([])
  const [scrollProgress, setScrollProgress] = useState(0)
  const [phases, setPhases] = useState<number[]>([])

  // Считываем title/body из Y.Map → state, чтобы React мог рендерить и без перерендера каждого Y.update.
  useEffect(() => {
    if (!events) return
    const update = () => {
      const arr = events.toArray()
      setEventMeta(
        arr.map((m: YMap) => ({
          id: (m.get('id') as string) ?? crypto.randomUUID(),
          title: ((m.get('title') as string) ?? '').trim(),
          body: ((m.get('body') as string) ?? '').trim(),
        }))
      )
    }
    update()
    // Следим за добавлением/удалением событий в array, чтобы пере-обсервить новые maps
    const onArrChange = () => {
      events.toArray().forEach((m: YMap) => m.observeDeep(update))
      update()
    }
    events.observe(onArrChange)
    return () => {
      events.unobserve(onArrChange)
      events.toArray().forEach((m: YMap) => m.unobserveDeep(update))
    }
  }, [events])

  // Scroll-driven phase: для каждой секции считаем 0..1 в зависимости от её позиции в viewport.
  // 0 = выше центра экрана, 1 = ниже. Простой scrollspy через requestAnimationFrame.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    let raf = 0
    const tick = () => {
      const winH = window.innerHeight
      const winCenter = window.scrollY + winH / 2
      const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-event-section]'))
      const next: number[] = []
      for (const s of sections) {
        const top = s.offsetTop
        const h = s.offsetHeight
        const center = top + h / 2
        const dist = Math.abs(winCenter - center) / Math.max(1, h)
        next.push(Math.max(0, 1 - dist))
      }
      setPhases(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [eventMeta.length])

  // Immersive: когда пользователь скроллит в timeline (events.length > 0),
  // скрываем заголовок/header чтобы максимум viewport был под timeline.
  // Простая логика: если scrollY > 200 — header уменьшается до 48px, иначе полный.
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 200)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    // CSS variable for header height — applied on :root via documentElement
    if (compact) {
      document.documentElement.style.setProperty('--header-height', '48px')
    } else {
      document.documentElement.style.removeProperty('--header-height')
    }
  }, [compact])

  // IntersectionObserver: обновляет activeIdx когда секция входит в viewport
  useEffect(() => {
    const root = containerRef.current
    if (!root || !events || events.length === 0) return
    const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-event-section]'))
    if (sections.length === 0) return

    const obs = new IntersectionObserver(
      (entries) => {
        // выбираем секцию с наибольшим ratio
        let best = activeIdx
        let bestRatio = -1
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio
            const idx = Number(e.target.getAttribute('data-idx'))
            if (!Number.isNaN(idx)) best = idx
          }
        }
        if (bestRatio >= 0.1) setActiveIdx(best)
      },
      { threshold: [0.1, 0.3, 0.5, 0.7, 0.9], rootMargin: '-20% 0px -20% 0px' }
    )
    sections.forEach((s) => obs.observe(s))
    return () => obs.disconnect()
  }, [events.length, activeIdx])

  // Общий scrollProgress для rail/progressbar
  useEffect(() => {
    function onScroll() {
      const root = containerRef.current
      if (!root) return
      const rect = root.getBoundingClientRect()
      const total = root.offsetHeight - window.innerHeight
      const scrolled = -rect.top
      setScrollProgress(Math.max(0, Math.min(1, scrolled / Math.max(1, total))))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!events || events.length === 0) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center' }}>
        <p className="muted">Нет событий. Нажмите «+ Событие», чтобы начать.</p>
      </div>
    )
  }

  const lit: EventLite[] = eventMeta.map((m, i) => ({
    id: m.id,
    title: m.title,
    body: m.body,
    phase: phases[i] ?? 0,
    isActive: i === activeIdx,
    isSelected: i === selectedIndex,
  }))

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        scrollSnapType: 'y proximity',     // мягкий scroll-snap — не ломает обычный скролл
      }}
    >
      {/* Side rail (sticky) */}
      <SideRail total={events?.length ?? 0} active={activeIdx} progress={scrollProgress} />

      {/* Sections */}
      {lit.map((ev, i) => (
        <EventSection
          key={ev.id}
          idx={i}
          total={events.length}
          ev={ev}
          onSelect={() => onSelect(i)}
          assetUrl={assetUrlByEventId?.[ev.id]}
          phase={ev.phase}
        />
      ))}

      {/* Cross-section gradient — between events for smooth scroll-flow */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'linear-gradient(to bottom, rgba(10,13,24,0.5) 0%, transparent 8%, transparent 92%, rgba(10,13,24,0.5) 100%)',
          zIndex: 0,
        }}
      />

      {/* Finale — scroll-world style CTA at the end */}
      <section style={{
        position: 'relative',
        minHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '60px 24px',
        background: 'radial-gradient(ellipse at center, rgba(88,166,255,0.06) 0%, transparent 70%)',
      }}>
        <div style={{
          fontSize: 12,
          color: '#79c0ff',
          letterSpacing: 4,
          textTransform: 'uppercase',
          marginBottom: 16,
          fontWeight: 600,
        }}>
          Конец хронологии
        </div>
        <h2 style={{
          margin: 0,
          marginBottom: 12,
          fontSize: 'clamp(28px, 4vw, 48px)',
          fontWeight: 800,
          color: '#fff',
          fontFamily: 'var(--sw-font-display)',
          letterSpacing: '-0.02em',
        }}>
          2214 — Новая эра
        </h2>
        <p className="muted" style={{ maxWidth: 520, fontSize: 16 }}>
          События из романа «Абсолютное оружие» Андрея Ливадного. Используйте эту временную линию как шаблон для собственного сценария.
        </p>
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EventSection — одна секция одного события
// ─────────────────────────────────────────────────────────────────────────────

function EventSection({
  idx, total, ev, onSelect, assetUrl, phase: phaseProp,
}: {
  idx: number
  total: number
  ev: EventLite
  onSelect: () => void
  assetUrl?: string
  phase?: number
}) {
  const ref = useRef<HTMLElement>(null)
  // Progressive reveal: phase рассчитывается родителем через scrollspy.
  // Используем phase для transform + opacity + blur — каждая секция реагирует
  // на расстояние от центра viewport. phase ≈ 0 → контент вне viewport,
  // phase ≈ 0.5 → раскрывается, phase ≈ 1 → полностью видно.
  const phase = Math.min(1, Math.max(0, phaseProp ?? ev.phase ?? 0))
  // Чуть более плавная кривая: phase ** 0.7 даёт чуть менее агрессивный fade-out
  const easedPhase = Math.pow(phase, 0.7)
  const transform = `translateY(${(1 - easedPhase) * 80}px) scale(${0.94 + easedPhase * 0.06})`
  const opacity = Math.pow(easedPhase, 0.85)
  const blur = (1 - easedPhase) * 4

  return (
    <section
      ref={ref}
      data-event-section
      data-idx={idx}
      style={{
        position: 'relative',
        minHeight: '55vh',
        scrollSnapAlign: 'center',
        scrollSnapStop: 'normal',             // snap только при естественной остановке скролла — не блокирует быструю прокрутку
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        padding: '0 16px',
        // Mark this section as scroll-driven — child elements react to phase
        ['--phase' as any]: phase,
      }}
    >
      {/* Full-bleed background (illustration OR asset image) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
        {assetUrl ? (
          <img
            src={assetUrl}
            alt={ev.title}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transition: 'transform 0.6s ease, filter 0.4s ease',
              filter: ev.isActive ? 'brightness(0.55)' : 'brightness(0.35)',
              transform: ev.isActive ? 'scale(1.02)' : 'scale(1.05)',
            }}
          />
        ) : (
          <div style={{
            width: '100%',
            height: '100%',
            transition: 'transform 0.6s ease, filter 0.4s ease',
            filter: ev.isActive ? 'brightness(1)' : 'brightness(0.6)',
            transform: ev.isActive ? 'scale(1.02)' : 'scale(1.05)',
          }}>
            <EventIllustration
              eventId={ev.id}
              title={ev.title || `Событие ${idx + 1}`}
              phase={ev.isActive ? 0.5 : 0}
            />
          </div>
        )}
        {/* Vignette gradient overlay for text readability */}
        <div style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse at center, transparent 30%, rgba(13,17,23,0.85) 90%),' +
            ' linear-gradient(to top, rgba(13,17,23,0.95) 0%, rgba(13,17,23,0.3) 30%, transparent 50%)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* Chapter counter (top-left) */}
      <div style={{
        position: 'absolute',
        top: '24px',
        left: '24px',
        zIndex: 2,
        color: '#7d8590',
        fontSize: 13,
        letterSpacing: 2,
        fontVariantNumeric: 'tabular-nums',
        textTransform: 'uppercase',
        fontWeight: 500,
      }}>
        <span style={{ color: '#e6edf3', fontSize: 18, fontWeight: 600 }}>{String(idx + 1).padStart(2, '0')}</span>
        <span style={{ margin: '0 8px' }}>/</span>
        <span>{String(total).padStart(2, '0')}</span>
      </div>

      {/* Active dot */}
      <div style={{
        position: 'absolute',
        top: '24px',
        right: '24px',
        zIndex: 2,
        width: 8, height: 8, borderRadius: '50%',
        background: ev.isActive ? '#3fb950' : '#30363d',
        boxShadow: ev.isActive ? '0 0 12px #3fb950' : 'none',
        transition: 'all 0.3s',
      }} />

      {/* Content card (overlay) */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        maxWidth: 720,
        width: 'calc(100% - 32px)',
        padding: 'clamp(24px, 4vw, 40px) clamp(24px, 5vw, 48px)',
        background: 'rgba(10, 13, 24, 0.72)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 16,
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        boxShadow: '0 30px 80px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
        transform: `translateY(${(1 - phase) * 60}px) scale(${0.94 + phase * 0.06})`,
        opacity: Math.max(0.25, Math.pow(phase, 0.9)),
        filter: phase < 0.95 ? `blur(${(1 - phase) * 6}px)` : 'none',
        transition: 'opacity 0.6s var(--sw-easing, ease-out), transform 0.7s var(--sw-easing, cubic-bezier(0.16, 1, 0.3, 1)), filter 0.4s ease-out',
        willChange: 'transform, opacity, filter',
      }}>
        <div style={{
          fontSize: 11,
          color: '#79c0ff',
          letterSpacing: 4,
          textTransform: 'uppercase',
          marginBottom: 12,
          fontWeight: 600,
          fontFamily: 'var(--sw-font-display)',
        }}>
          Событие {String(idx + 1).padStart(2, '0')} из {String(total).padStart(2, '0')}
        </div>
        <h2 style={{
          margin: 0,
          marginBottom: 20,
          fontSize: 'clamp(26px, 5vw, 56px)',
          lineHeight: 1.05,
          fontWeight: 800,
          color: '#fff',
          fontFamily: 'var(--sw-font-display)',
          letterSpacing: '-0.02em',
          textShadow: '0 2px 30px rgba(0,0,0,0.5)',
        }}>
          {ev.title || `Событие ${idx + 1}`}
        </h2>
        <div style={{
          color: '#d0d7de',
          fontSize: 'clamp(15px, 1.3vw, 18px)',
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap',
          maxHeight: '40vh',
          overflow: 'hidden',
          position: 'relative',
          fontFamily: 'var(--sw-font-body)',
        }}>
          {ev.body || <em style={{ opacity: 0.5 }}>Пусто — нажмите редактировать</em>}
          {/* Fade-out gradient at bottom of long text */}
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 60,
            background: 'linear-gradient(to bottom, transparent, rgba(13,17,23,0.78))',
            pointerEvents: 'none',
          }} />
        </div>
        <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            className={ev.isSelected ? 'secondary' : ''}
            onClick={onSelect}
          >
            {ev.isSelected ? '✓ редактируется' : 'редактировать'}
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            клик → прокрутить к редактору
          </span>
        </div>
      </div>

      {/* Bottom-scroll hint */}
      <div style={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2,
        color: '#7d8590',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        animation: 'fadeInUp 0.6s ease 0.3s both',
      }}>
        <span>↓</span>
        <span>прокрутить вниз</span>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SideRail — вертикальная timeline-rail слева с точками для каждого события
// ─────────────────────────────────────────────────────────────────────────────

function SideRail({ total, active, progress }: { total: number; active: number; progress: number }) {
  return (
    <>
      {/* Progress fill (vertical line that grows as user scrolls) */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          top: '20vh',
          bottom: '20vh',
          left: 36,
          width: 2,
          background: '#21262d',
          zIndex: 5,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${progress * 100}%`,
            background: 'linear-gradient(180deg, #58a6ff 0%, #3fb950 100%)',
            transition: 'height 0.2s',
          }}
        />
      </div>

      {/* Dots — one per event, clickable to jump to that event */}
      <nav
        aria-label="Timeline events"
        style={{
          position: 'fixed',
          top: '50%',
          left: 22,
          transform: 'translateY(-50%)',
          zIndex: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {Array.from({ length: total }).map((_, i) => {
          const isActive = i === active
          const distance = Math.abs(i - active)
          return (
            <button
              key={i}
              type="button"
              title={`К событию ${i + 1}`}
              onClick={() => {
                const target = document.querySelector<HTMLElement>(`[data-event-section][data-idx="${i}"]`)
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              style={{
                width: isActive ? 16 : 10,
                height: isActive ? 16 : 10,
                borderRadius: '50%',
                background: isActive ? '#58a6ff' : distance <= 1 ? '#3fb950' : '#30363d',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                boxShadow: isActive ? '0 0 12px #58a6ff' : 'none',
                transition: 'all 0.2s',
              }}
            />
          )
        })}
      </nav>
    </>
  )
}
