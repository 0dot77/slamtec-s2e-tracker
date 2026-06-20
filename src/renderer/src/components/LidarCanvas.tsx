import { useEffect, useRef, useState } from 'react'
import type { VizFrame } from '@shared/types'

interface View {
  scale: number // pixels per millimeter (device px)
  ox: number // screen x of LiDAR origin (device px)
  oy: number // screen y of LiDAR origin (device px)
}

export default function LidarCanvas(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<VizFrame | null>(null)
  const viewRef = useRef<View>({ scale: 0.08, ox: 0, oy: 0 })
  const initedRef = useRef(false)
  const stampsRef = useRef<number[]>([])
  const [hz, setHz] = useState(0)
  const [pts, setPts] = useState(0)
  const [seq, setSeq] = useState(0)

  // Subscribe to frames.
  useEffect(() => {
    return window.api?.onFrame((f) => {
      frameRef.current = f
      setPts(f.count)
      setSeq(f.seq)
      const now = performance.now()
      const s = stampsRef.current
      s.push(now)
      while (s.length > 30) s.shift()
      if (s.length > 1) {
        const dt = (s[s.length - 1] - s[0]) / (s.length - 1)
        setHz(dt > 0 ? 1000 / dt : 0)
      }
    })
  }, [])

  // Render loop + interactions.
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const dpr = (): number => window.devicePixelRatio || 1

    const resize = (): void => {
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(r.width * dpr()))
      canvas.height = Math.max(1, Math.floor(r.height * dpr()))
      if (!initedRef.current) {
        viewRef.current.ox = canvas.width / 2
        viewRef.current.oy = canvas.height / 2
        viewRef.current.scale = Math.min(canvas.width, canvas.height) / 8000 // ~8 m across
        initedRef.current = true
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const v = viewRef.current
      const w = canvas.width
      const h = canvas.height
      const d = dpr()

      ctx.fillStyle = '#0b0e14'
      ctx.fillRect(0, 0, w, h)

      // Range rings every 1 m.
      ctx.lineWidth = 1
      ctx.font = `${11 * d}px ui-monospace, monospace`
      const diag = Math.hypot(w, h)
      for (let m = 1; m <= 30; m++) {
        const rr = m * 1000 * v.scale
        if (rr > diag) break
        ctx.strokeStyle = m % 5 === 0 ? 'rgba(120,140,170,0.32)' : 'rgba(120,140,170,0.14)'
        ctx.beginPath()
        ctx.arc(v.ox, v.oy, rr, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = 'rgba(150,170,200,0.45)'
        ctx.fillText(`${m}m`, v.ox + rr + 3 * d, v.oy - 3 * d)
      }

      // Axes.
      ctx.strokeStyle = 'rgba(120,140,170,0.22)'
      ctx.beginPath()
      ctx.moveTo(0, v.oy)
      ctx.lineTo(w, v.oy)
      ctx.moveTo(v.ox, 0)
      ctx.lineTo(v.ox, h)
      ctx.stroke()

      // Point cloud.
      const f = frameRef.current
      if (f) {
        const xy = f.xy
        const s = v.scale
        const sz = Math.max(1.5, 1.6 * d)
        ctx.fillStyle = '#37d4c8'
        for (let i = 0; i < f.count; i++) {
          const x = v.ox + xy[i * 2] * s
          const y = v.oy - xy[i * 2 + 1] * s
          ctx.fillRect(x, y, sz, sz)
        }
      }

      // LiDAR origin.
      ctx.fillStyle = '#ff5d5d'
      ctx.beginPath()
      ctx.arc(v.ox, v.oy, 4 * d, 0, Math.PI * 2)
      ctx.fill()
    }
    draw()

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const v = viewRef.current
      const d = dpr()
      const mx = e.offsetX * d
      const my = e.offsetY * d
      const k = Math.exp(-e.deltaY * 0.0015)
      v.ox = mx - (mx - v.ox) * k
      v.oy = my - (my - v.oy) * k
      v.scale *= k
    }
    let dragging = false
    let lx = 0
    let ly = 0
    const onDown = (e: MouseEvent): void => {
      dragging = true
      lx = e.clientX
      ly = e.clientY
      canvas.style.cursor = 'grabbing'
    }
    const onMove = (e: MouseEvent): void => {
      if (!dragging) return
      const v = viewRef.current
      const d = dpr()
      v.ox += (e.clientX - lx) * d
      v.oy += (e.clientY - ly) * d
      lx = e.clientX
      ly = e.clientY
    }
    const onUp = (): void => {
      dragging = false
      canvas.style.cursor = 'grab'
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />
      <div className="hud">
        <div>
          <span className="accent">{hz.toFixed(1)}</span> Hz
        </div>
        <div>{pts} pts</div>
        <div>#{seq}</div>
        <div style={{ color: '#5b6678' }}>scroll = zoom · drag = pan</div>
      </div>
    </>
  )
}
