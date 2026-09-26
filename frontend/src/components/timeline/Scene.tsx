import { useEffect, useRef } from 'react'
import * as THREE from 'three'

interface SceneProps {
  /** позиция камеры в нормализованной шкале [0..n-1]; событий может быть несколько */
  scrollIndex: number
  /** точки (positions), через которые должна пролетать камера; минимум 2 */
  points: Array<{ x: number; y: number; z: number }>
  /** опционально — текстура-метка для текущей точки (плоскость с логотипом) */
  label?: string
}

/**
 * Three.js-сцена: простой "диорама" из нескольких светящихся сфер,
 * камера интерполируется по точкам согласно scrollIndex.
 * Минимальный модуль вместо полноценного scroll-world рендера — достаточно для MVP.
 */
export function Scene({ scrollIndex, points, label }: SceneProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const camIndexRef = useRef(scrollIndex)

  useEffect(() => {
    if (!ref.current) return
    const width = ref.current.clientWidth
    const height = ref.current.clientHeight || 480

    const renderer = new THREE.WebGLRenderer({ canvas: ref.current, antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(width, height, false)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0d1117')

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)

    // точки-события — сферы
    const spheres = points.map((p) => {
      const geom = new THREE.SphereGeometry(0.35, 32, 32)
      const mat = new THREE.MeshStandardMaterial({
        color: 0x58a6ff,
        emissive: 0x1f6feb,
        emissiveIntensity: 0.8,
        roughness: 0.4,
        metalness: 0.2,
      })
      const m = new THREE.Mesh(geom, mat)
      m.position.set(p.x, p.y, p.z)
      scene.add(m)
      return m
    })

    // линии между сферами (Catmull-Rom spline визуально)
    if (points.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)))
      const tube = new THREE.TubeGeometry(curve, 64, 0.04, 8, false)
      const lineMat = new THREE.MeshBasicMaterial({ color: 0x30363d })
      scene.add(new THREE.Mesh(tube, lineMat))
    }

    // свет
    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const point = new THREE.PointLight(0xffffff, 1.5, 50)
    point.position.set(0, 5, 10)
    scene.add(point)

    // resize
    const onResize = () => {
      if (!ref.current || !rendererRef.current) return
      const w = ref.current.clientWidth
      const h = ref.current.clientHeight || 480
      rendererRef.current.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    let raf = 0
    const tick = () => {
      // плавная интерполяция scrollIndex
      camIndexRef.current += (scrollIndex - camIndexRef.current) * 0.1
      const idx = Math.max(0, Math.min(points.length - 1, camIndexRef.current))
      const i0 = Math.floor(idx)
      const i1 = Math.min(points.length - 1, i0 + 1)
      const t = idx - i0
      const p0 = points[i0]
      const p1 = points[i1]
      const cx = p0.x + (p1.x - p0.x) * t
      const cy = p0.y + (p1.y - p0.y) * t + 2.5
      const cz = p0.z + (p1.z - p0.z) * t + 6
      camera.position.set(cx, cy, cz)
      // смотрим на следующую точку spline
      const lookT = Math.min(1, t + 0.1)
      const lx = p0.x + (p1.x - p0.x) * lookT
      const ly = p0.y + (p1.y - p0.y) * lookT
      const lz = p0.z + (p1.z - p0.z) * lookT
      camera.lookAt(lx, ly, lz)

      // пульсация сфер
      spheres.forEach((s, i) => {
        const pulse = 1 + 0.08 * Math.sin(performance.now() * 0.001 + i)
        s.scale.setScalar(pulse)
      })

      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
      spheres.forEach((s) => s.geometry.dispose())
      rendererRef.current = null
    }
  }, [points, scrollIndex])

  return (
    <div style={{ position: 'relative', width: '100%', height: '60vh' }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
      {label && (
        <div style={{
          position: 'absolute', top: 16, left: 16, padding: '8px 12px',
          background: 'rgba(13,17,23,0.6)', border: '1px solid #30363d', borderRadius: 6,
        }}>
          {label}
        </div>
      )}
    </div>
  )
}
