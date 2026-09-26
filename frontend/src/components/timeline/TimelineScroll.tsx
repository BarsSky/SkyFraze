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

  // Считываем title/body из Y.Map → state, чтобы React мог рендерить и без перерендера каждого Y.update.
  useEffect(() => {
    if (!events) return
    const arr = events.toArray()
    const update = () => {
      setEventMeta(
        arr.map((m: YMap) => ({
          id: (m.get('id') as string) ?? crypto.randomUUID(),
          title: ((m.get('title') as string) ?? '').trim(),
          body: ((m.get('body') as string) ?? '').trim(),
        }))
      )
    }
    update()
    arr.forEach((m: YMap) => m.observeDeep(update))
    return () => {
      arr.forEach((m: YMap) => m.unobserveDeep(update))
    }
  }, [events])

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
    phase: 0,
    isActive: i === activeIdx,
    isSelected: i === selectedIndex,
  }))

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
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
        />
      ))}

      {/* Bottom fade-out */}
      <div style={{
        height: '40vh',
        background: 'linear-gradient(to bottom, transparent, var(--bg))',
        pointerEvents: 'none',
      }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EventSection — одна секция одного события
// ─────────────────────────────────────────────────────────────────────────────

function EventSection({
  idx, total, ev, onSelect, assetUrl,
}: {
  idx: number
  total: number
  ev: EventLite
  onSelect: () => void
  assetUrl?: string
}) {
  const ref = useRef<HTMLElement>(null)
  return (
    <section
      ref={ref}
      data-event-section
      data-idx={idx}
      style={{
        position: 'relative',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
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
        width: 'calc(100% - 80px)',
        padding: '32px 36px',
        background: 'rgba(13, 17, 23, 0.78)',
        border: '1px solid #30363d',
        borderRadius: 12,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        transform: ev.isActive ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.98)',
        opacity: ev.isActive ? 1 : 0.6,
        transition: 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
        marginTop: '12vh',
        marginBottom: '8vh',
      }}>
        <div style={{
          fontSize: 11,
          color: '#58a6ff',
          letterSpacing: 3,
          textTransform: 'uppercase',
          marginBottom: 8,
          fontWeight: 600,
        }}>
          Событие {String(idx + 1).padStart(2, '0')}
        </div>
        <h2 style={{
          margin: 0,
          marginBottom: 16,
          fontSize: 'clamp(22px, 4vw, 38px)',
          lineHeight: 1.15,
          fontWeight: 700,
          color: '#fff',
        }}>
          {ev.title || `Событие ${idx + 1}`}
        </h2>
        <div style={{
          color: '#c9d1d9',
          fontSize: 16,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          maxHeight: '40vh',
          overflow: 'hidden',
          position: 'relative',
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
