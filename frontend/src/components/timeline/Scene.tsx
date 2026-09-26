import { useEffect, useRef } from 'react'
import * as THREE from 'three'

interface SceneProps {
  /** позиция камеры в нормализованной шкале [0..n-1] */
  scrollIndex: number
  /** точки вдоль spline; минимум 2 */
  points: Array<{ x: number; y: number; z: number }>
  /** имя текущего события для HUD-метки */
  label?: string
  /** какой индекс сейчас "selected" — точка подсвечивается */
  selected?: number
}

/**
 * Three.js-сцена: «диорама» из N-светящихся маркеров на Catmull-Rom spline,
 * камера плавно интерполируется по точкам по scrollIndex (scroll-scrubbed).
 * Адаптировано под концепцию scroll-world (scroll → camera flight), но без AI-генерации.
 *
 * Если points пустой (0 событий) — возвращает null (родитель должен показать empty-state).
 * Если только 1 точка — рендерит 1 маркер без сплайна.
 */
export function Scene({ scrollIndex, points, label, selected }: SceneProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const camIndexRef = useRef(scrollIndex)

  // Если точек нет — не рендерим ничего (не должно быть "фейковых" дефолтных сфер).
  if (!points || points.length === 0) {
    return null
  }

  useEffect(() => {
    if (!ref.current) return
    const wrap = ref.current.parentElement as HTMLElement
    const width = Math.max(320, wrap.clientWidth)
    const height = Math.max(320, wrap.clientHeight || 480)

    const renderer = new THREE.WebGLRenderer({ canvas: ref.current, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height, false)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0d1117')
    scene.fog = new THREE.Fog('#0d1117', 8, 30)

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100)

    // Для 1 точки spline не строим — рендерим только 1 маркер.
    // Для 2+ точек используем их напрямую (больше НЕТ дефолтных "фейковых" сфер).
    const allPoints = points

    // маркеры событий — сферы разных цветов
    const colors = [0x58a6ff, 0x3fb950, 0xd29922, 0xf85149, 0xa371f7, 0x39c5cf, 0xff7b72]
    const spheres = allPoints.map((p, i) => {
      const isSelected = i === selected
      const r = isSelected ? 0.55 : 0.4
      const geom = new THREE.SphereGeometry(r, 32, 32)
      const mat = new THREE.MeshStandardMaterial({
        color: colors[i % colors.length],
        emissive: colors[i % colors.length],
        emissiveIntensity: isSelected ? 1.4 : 0.7,
        roughness: 0.35,
        metalness: 0.2,
      })
      const m = new THREE.Mesh(geom, mat)
      m.position.set(p.x, p.y + (i % 2) * 0.3, p.z)
      scene.add(m)

      // лёгкое свечение снизу
      const glowGeom = new THREE.SphereGeometry(r * 1.4, 16, 16)
      const glowMat = new THREE.MeshBasicMaterial({
        color: colors[i % colors.length],
        transparent: true,
        opacity: 0.15,
      })
      const glow = new THREE.Mesh(glowGeom, glowMat)
      glow.position.copy(m.position)
      scene.add(glow)
      return { mesh: m, glow, base: i }
    })

    let tube: THREE.Mesh | null = null
    // spline-кривая (Catmull-Rom) — только если >= 2 точек
    if (allPoints.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(
        allPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
        false,
        'catmullrom',
        0.5
      )
      const tubeMesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 96, 0.06, 8, false),
        new THREE.MeshBasicMaterial({ color: 0x30363d })
      )
      tube = tubeMesh
      scene.add(tubeMesh)
    }

    // звёздный фон (мелкие точки на дальнем плане)
    const starGeom = new THREE.BufferGeometry()
    const starCount = 250
    const starPos = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 60
      starPos[i * 3 + 1] = (Math.random() - 0.5) * 30
      starPos[i * 3 + 2] = -10 - Math.random() * 20
    }
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    const stars = new THREE.Points(starGeom, new THREE.PointsMaterial({
      color: 0x7d8590, size: 0.04, transparent: true, opacity: 0.6,
    }))
    scene.add(stars)

    // свет
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const pl = new THREE.PointLight(0xffffff, 1.5, 30)
    pl.position.set(0, 5, 8)
    scene.add(pl)
    const rl = new THREE.PointLight(0x58a6ff, 1, 30)
    rl.position.set(-5, 3, 5)
    scene.add(rl)

    // resize
    const onResize = () => {
      if (!wrap || !rendererRef.current) return
      const w = Math.max(320, wrap.clientWidth)
      const h = Math.max(320, wrap.clientHeight || 480)
      rendererRef.current.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    let raf = 0
    const start = performance.now()

    // spline-кривая (Catmull-Rom) — только если >= 2 точек
    if (allPoints.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(
        allPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
        false,
        'catmullrom',
        0.5
      )
      const tubeMesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 96, 0.06, 8, false),
        new THREE.MeshBasicMaterial({ color: 0x30363d })
      )
      tube = tubeMesh
      scene.add(tubeMesh)
    }

    const tick = () => {
      const t = performance.now()
      // плавная интерполяция scrollIndex
      camIndexRef.current += (scrollIndex - camIndexRef.current) * 0.12
      const idx = Math.max(0, Math.min(allPoints.length - 1, camIndexRef.current))
      const i0 = Math.floor(idx)
      const i1 = Math.min(allPoints.length - 1, i0 + 1)
      const f = idx - i0
      const p0 = allPoints[i0]
      const p1 = allPoints[i1]
      const cx = p0.x + (p1.x - p0.x) * f
      const cy = p0.y + (p1.y - p0.y) * f + 2.5
      const cz = p0.z + (p1.z - p0.z) * f + 5.5
      camera.position.set(cx, cy, cz)
      // lookAt — вперёд по spline
      const lookT = Math.min(1, f + 0.15)
      const lx = p0.x + (p1.x - p0.x) * lookT
      const ly = p0.y + (p1.y - p0.y) * lookT
      const lz = p0.z + (p1.z - p0.z) * lookT
      camera.lookAt(lx, ly, lz)

      // пульсация
      spheres.forEach((s, i) => {
        const phase = (t * 0.001) + i * 0.7
        const sPulse = s.base === selected ? 1 + 0.06 * Math.sin(phase)
                                        : 1 + 0.04 * Math.sin(phase)
        s.mesh.scale.setScalar(sPulse)
      })

      // лёгкое вращение stars
      stars.rotation.y = (t - start) * 0.00005

      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
      spheres.forEach((s) => { s.mesh.geometry.dispose(); s.glow.geometry.dispose() })
      tube?.geometry.dispose()
      starGeom.dispose()
      rendererRef.current = null
    }
  }, [points, scrollIndex, selected])

  return (
    <div style={{
      position: 'relative', width: '100%', height: '60vh',
      minHeight: 360, maxHeight: 720, overflow: 'hidden',
      borderRadius: 8, border: '1px solid #30363d',
    }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
      {label && (
        <div style={{
          position: 'absolute', top: 16, left: 16, padding: '8px 14px',
          background: 'rgba(13,17,23,0.7)', border: '1px solid #30363d',
          borderRadius: 8, fontSize: 14, maxWidth: '60%',
        }}>
          {label}
        </div>
      )}
      <div style={{
        position: 'absolute', bottom: 16, right: 16, padding: '4px 10px',
        background: 'rgba(13,17,23,0.6)', border: '1px solid #30363d',
        borderRadius: 6, fontSize: 12, color: '#7d8590',
      }}>
        scroll ↓ для пролёта между событиями
      </div>
    </div>
  )
}
