import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { EventIllustration } from './EventIllustration'
import type { YArray, YMap } from '../../collab/yprovider'

interface EventLite {
  id: string
  parentId: string | null
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
  const [eventMeta, setEventMeta] = useState<Array<{
    id: string
    parentId: string | null
    title: string
    body: string
  }>>([])
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
          parentId: ((m.get('parent_id') as string | null | undefined) ?? null) as string | null,
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
  // Прощающий расчёт: phase=1 когда секция хоть частично в viewport,
  // phase=0 только когда полностью за пределами. Минимум blur/scale.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    let raf = 0
    const tick = () => {
      const winTop = window.scrollY
      const winH = window.innerHeight
      const winBottom = winTop + winH
      const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-event-section]'))
      const next: number[] = []
      for (const s of sections) {
        const top = s.offsetTop
        const h = s.offsetHeight
        const bottom = top + h
        // Проверяем, в viewport ли секция
        if (bottom < winTop || top > winBottom) {
          next.push(0)  // полностью за пределами viewport
        } else {
          // Считаем долю секции в viewport (0..1)
          const visibleTop = Math.max(top, winTop)
          const visibleBottom = Math.min(bottom, winBottom)
          const visibleFrac = Math.min(1, (visibleBottom - visibleTop) / h)
          next.push(visibleFrac)
        }
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
    parentId: m.parentId,
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
      {/* Side rail (sticky) — hierarchical tree navigation */}
      <SideRail events={lit} active={activeIdx} progress={scrollProgress} onJump={onSelect} />

      {/* Sections — рендерим только TOP-LEVEL events, sub-events внутри как nested контент */}
      {(() => {
        const topLevel: Array<{ ev: EventLite; i: number; children: Array<{ ev: EventLite; i: number }> }> = []
        for (let i = 0; i < lit.length; i++) {
          if (lit[i].parentId === null) {
            const children: Array<{ ev: EventLite; i: number }> = []
            for (let j = 0; j < lit.length; j++) {
              if (lit[j].parentId === lit[i].id) children.push({ ev: lit[j], i: j })
            }
            topLevel.push({ ev: lit[i], i, children })
          }
        }
        return topLevel.map(({ ev, i, children }) => (
          <TopLevelSection
            key={ev.id}
            idx={i}
            total={topLevel.length}
            ev={ev}
            children={children}
            assetUrlByEventId={assetUrlByEventId}
            onSelect={onSelect}
            allEvents={lit}
            allEventIdsByIdx={(idx) => lit[idx]?.id}
          />
        ))
      })()}

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
  // Делаем ОЧЕНЬ ПРОЩАЮЩИМ: phase ≈ 1 когда секция в viewport,
  // phase ≈ 0 только когда полностью out. Минимальный fade для красоты.
  const phase = Math.min(1, Math.max(0, phaseProp ?? ev.phase ?? 0))
  const easedPhase = Math.pow(phase, 0.4)  // резкий подъём к 1 — большая часть вьюпорта = full visible
  const transform = `translateY(${(1 - easedPhase) * 24}px) scale(${0.99 + easedPhase * 0.01})`
  const opacity = Math.max(0.7, Math.pow(easedPhase, 0.5))  // минимум 70% opacity — текст всегда читаем
  const blur = 0  // БЕЗ blur — контент всегда чёткий, как в scroll-world (там тоже нет blur на активной сцене)

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

// MainEventCard — большая карточка top-level события, видна в TopLevelSection.
function MainEventCard({
  ev, idx, total, phase, onSelect, assetUrl,
}: {
  ev: EventLite
  idx: number
  total: number
  phase: number
  onSelect: () => void
  assetUrl?: string
}) {
  const easedPhase = Math.pow(Math.max(0, Math.min(1, phase)), 0.5)
  const opacity = Math.max(0.7, easedPhase)
  const transform = `translateY(${24 * (1 - easedPhase)}px) scale(${0.99 + easedPhase * 0.01})`
  return (
    <div
      onClick={onSelect}
      style={{
        position: 'relative',
        padding: 'clamp(24px, 4vw, 40px) clamp(24px, 5vw, 48px)',
        background: 'rgba(10, 13, 24, 0.72)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 16,
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        boxShadow: '0 30px 80px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
        transform,
        opacity,
        transition: 'opacity 0.5s, transform 0.5s',
        cursor: 'pointer',
      }}
    >
      <div style={{
        fontSize: 11, color: '#79c0ff', letterSpacing: 4, textTransform: 'uppercase',
        marginBottom: 12, fontWeight: 600,
      }}>
        Глава {String(idx + 1).padStart(2, '0')} из {String(total).padStart(2, '0')}
      </div>
      <h2 style={{
        margin: 0, marginBottom: 20,
        fontSize: 'clamp(26px, 5vw, 56px)', lineHeight: 1.05,
        fontWeight: 800, color: '#fff',
        fontFamily: 'var(--sw-font-display)',
        letterSpacing: '-0.02em',
        textShadow: '0 2px 30px rgba(0,0,0,0.5)',
      }}>
        {ev.title || `Событие ${idx + 1}`}
      </h2>
      {ev.body && (
        <p style={{
          margin: 0, color: '#d0d7de',
          fontSize: 'clamp(15px, 1.3vw, 18px)', lineHeight: 1.7,
          whiteSpace: 'pre-wrap', fontFamily: 'var(--sw-font-body)',
        }}>
          {ev.body}
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TopLevelSection — обёртка вокруг top-level event со встроенными sub-events.
// Рендерится как scroll-snap кадр; sub-events идут ВНУТРИ одной большой секции
// (не отдельные snap-кадры), чтобы пользователь плавно скроллил по ним
// внутри одной "главы" прежде чем переключиться на следующую.
// ─────────────────────────────────────────────────────────────────────────────

function TopLevelSection({
  idx, total, ev, children, assetUrlByEventId, onSelect, allEvents, allEventIdsByIdx,
}: {
  idx: number
  total: number
  ev: EventLite
  children: Array<{ ev: EventLite; i: number }>
  assetUrlByEventId?: Record<string, string>
  onSelect: (idx: number) => void
  allEvents: EventLite[]
  allEventIdsByIdx: (i: number) => string | undefined
}) {
  return (
    <section
      data-event-section
      data-idx={idx}
      style={{
        position: 'relative',
        minHeight: `calc(60vh + ${children.length * 22}vh)`,
        scrollSnapAlign: 'center',
        scrollSnapStop: 'normal',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8vh 16px 12vh',
        gap: 24,
      }}
    >
      {/* Главный header события */}
      <div
        data-event-section-main
        style={{
          width: '100%',
          maxWidth: 720,
        }}
      >
        <MainEventCard ev={ev} idx={idx} total={total} phase={ev.phase} onSelect={() => onSelect(idx)} assetUrl={assetUrlByEventId?.[ev.id]} />
      </div>

      {/* Sub-events: nested timeline внутри этой же секции (дерево вниз) */}
      {children.length > 0 && (
        <div
          aria-label={`Sub-events of ${ev.title}`}
          style={{
            width: '100%',
            maxWidth: 720,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            paddingLeft: 18,
            borderLeft: '2px solid rgba(88,166,255,0.18)',
            position: 'relative',
          }}
        >
          {children.map(({ ev: c, i }) => (
            <SubEventCard
              key={c.id}
              ev={c}
              idx={i}
              total={allEvents.length}
              phase={c.phase}
              onSelect={() => onSelect(i)}
              assetUrl={assetUrlByEventId?.[c.id]}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SubEventCard({
  ev, idx, total, phase, onSelect, assetUrl,
}: {
  ev: EventLite
  idx: number
  total: number
  phase: number
  onSelect: () => void
  assetUrl?: string
}) {
  const easedPhase = Math.pow(phase, 0.5)
  const opacity = Math.max(0.7, easedPhase)
  const transform = `translateX(${20 * (1 - easedPhase)}px)`
  return (
    <div
      data-subevent
      data-idx={idx}
      onClick={onSelect}
      style={{
        position: 'relative',
        padding: '14px 18px',
        background: 'rgba(22, 27, 34, 0.7)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        cursor: 'pointer',
        transform,
        opacity,
        transition: 'opacity 0.4s, transform 0.4s',
      }}
    >
      {/* Dot on the line */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: -25,
          top: 20,
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: ev.isActive ? '#79c0ff' : '#484f58',
          boxShadow: ev.isActive ? '0 0 8px #79c0ff' : 'none',
        }}
      />
      <div style={{ fontSize: 11, color: '#79c0ff', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4, fontWeight: 600 }}>
        Подсобытие
      </div>
      <h3 style={{ margin: 0, marginBottom: 6, fontSize: 18, fontWeight: 700, color: '#fff' }}>
        {ev.title}
      </h3>
      {ev.body && (
        <p style={{ margin: 0, fontSize: 13, color: '#c9d1d9', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {ev.body}
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SideRail — hierarchical tree navigation слева
// ─────────────────────────────────────────────────────────────────────────────

function SideRail({
  events, active, progress, onJump,
}: {
  events: EventLite[]
  active: number
  progress: number
  onJump: (idx: number) => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    // По умолчанию все главы раскрыты (sub-events видны), но пользователь может свернуть
    const init: Record<string, boolean> = {}
    for (const e of events) {
      if (e.parentId === null) init[e.id] = true
    }
    return init
  })
  const topLevel = events.filter((e) => e.parentId === null)
  const topCount = topLevel.length
  const scrollTo = (idx: number) => {
    const target = document.querySelector<HTMLElement>(`[data-event-section][data-idx="${idx}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <>
      {/* Progress fill (vertical line that grows as user scrolls) */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          top: '15vh',
          bottom: '15vh',
          left: 24,
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

      {/* Tree navigation — vertical, hierarchical */}
      <nav
        aria-label="Timeline events"
        style={{
          position: 'fixed',
          top: '15vh',
          bottom: '15vh',
          left: 8,
          zIndex: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          overflowY: 'auto',
          padding: '4px 6px',
          maxHeight: '70vh',
          scrollbarWidth: 'none',
        }}
      >
        {topLevel.map((top) => {
          const isActive = top.isActive
          const isExpanded = expanded[top.id] ?? true
          const subs = events.filter((e) => e.parentId === top.id)
          return (
            <div key={top.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {/* Main dot + collapse toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  type="button"
                  title={top.title || `Event ${top.id.slice(0, 6)}`}
                  onClick={() => scrollTo(events.indexOf(top))}
                  style={{
                    width: isActive ? 14 : 10,
                    height: isActive ? 14 : 10,
                    borderRadius: '50%',
                    background: isActive ? '#58a6ff' : '#3fb950',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    boxShadow: isActive ? '0 0 10px #58a6ff' : 'none',
                    transition: 'all 0.2s',
                    flexShrink: 0,
                  }}
                />
                {subs.length > 0 && (
                  <button
                    type="button"
                    title={isExpanded ? 'Свернуть' : 'Развернуть'}
                    onClick={() => setExpanded((p) => ({ ...p, [top.id]: !p[top.id] }))}
                    style={{
                      width: 14,
                      height: 14,
                      background: 'transparent',
                      border: '1px solid #30363d',
                      borderRadius: 3,
                      color: '#7d8590',
                      cursor: 'pointer',
                      fontSize: 10,
                      lineHeight: 1,
                      padding: 0,
                      flexShrink: 0,
                    }}
                  >
                    {isExpanded ? '−' : '+'}
                  </button>
                )}
                {isActive && (
                  <span style={{
                    color: '#fff', fontSize: 11, marginLeft: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    maxWidth: 120,
                  }}>
                    {top.title.slice(0, 14)}
                  </span>
                )}
              </div>
              {/* Sub-event dots (indented) */}
              {isExpanded && subs.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 18 }}>
                  {subs.map((sub) => {
                    const subActive = sub.isActive
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        title={sub.title}
                        onClick={() => scrollTo(events.indexOf(sub))}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          color: subActive ? '#79c0ff' : '#7d8590',
                          fontSize: 11,
                        }}
                      >
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: subActive ? '#79c0ff' : '#484f58',
                          flexShrink: 0,
                        }} />
                        <span style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          maxWidth: 110,
                        }}>
                          {sub.title.slice(0, 18)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        <div style={{ flex: 1 }} />
        {topCount > 0 && (
          <div style={{ color: '#484f58', fontSize: 10, marginTop: 4, textAlign: 'left', paddingLeft: 4 }}>
            {topCount} глав
          </div>
        )}
      </nav>
    </>
  )
}