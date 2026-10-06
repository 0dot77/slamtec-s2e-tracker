import { memo, useEffect, useMemo, useRef } from 'react'
import type { CalibrationPoints, PipelineConfig, Zone } from '@shared/types'
import { applyHomography, type Mat3 } from '@shared/homography'
import type { FrameSource } from '../lib/frameStore'
import { hexToRgba, PALETTE } from '../lib/zones'
import { angleInSector, keptSectorSpan, sensorDegrees } from '../lib/scanMask'

export interface View {
  scale: number
  ox: number
  oy: number
  dpr: number
  cssW: number
  cssH: number
}
interface Props {
  frameSource: FrameSource
  calibration: CalibrationPoints | null
  config: PipelineConfig
  zones: Zone[]
  homographyInv: Mat3 | null
  onView: (view: View) => void
}
type Point = [number, number]

function LidarCanvas({ frameSource, calibration, config, zones, homographyInv, onView }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<View>({ scale: 0.08, ox: 0, oy: 0, dpr: 1, cssW: 0, cssH: 0 })
  const scheduleRef = useRef<() => void>(() => {})
  const fitRef = useRef<() => void>(() => {})
  // Project normalized polygons into mm once per geometry/calibration change.
  const projected = useMemo(() => homographyInv ? zones.map((zone) => ({
    zone, points: zone.polygon.map(([u, v]) => applyHomography(homographyInv, u, v))
  })).filter((item) => item.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) : [], [zones, homographyInv])
  const propsRef = useRef({ calibration, config, projected, homographyInv, onView })
  propsRef.current = { calibration, config, projected, homographyInv, onView }

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let lastSeq: number | null = null
    const trails = new Map<number, Point[]>()
    let screenCache: { geometry: typeof projected; key: string; points: Point[][] } | null = null
    const schedule = (): void => { if (!raf) raf = requestAnimationFrame(draw) }
    scheduleRef.current = schedule
    const publish = (): void => {
      propsRef.current.onView({ ...viewRef.current })
      schedule()
    }
    const fit = (): void => {
      const v = viewRef.current
      const quad = propsRef.current.calibration?.src
      if (quad) {
        const xs = quad.map((p) => p[0]); const ys = quad.map((p) => p[1])
        const minX = Math.min(0, ...xs); const maxX = Math.max(0, ...xs)
        const minY = Math.min(0, ...ys); const maxY = Math.max(0, ...ys)
        v.scale = Math.min(canvas.width / Math.max(1000, maxX - minX), canvas.height / Math.max(1000, maxY - minY)) * 0.75
        v.ox = canvas.width / 2 - (minX + maxX) / 2 * v.scale
        v.oy = canvas.height / 2 + (minY + maxY) / 2 * v.scale
      } else {
        v.scale = Math.min(canvas.width, canvas.height) / 8000
        v.ox = canvas.width / 2; v.oy = canvas.height / 2
      }
      publish()
    }
    fitRef.current = fit
    let initialized = false
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const v = viewRef.current
      const oldW = canvas.width; const oldH = canvas.height; const oldDpr = v.dpr
      const nextW = Math.max(1, Math.round(rect.width * ratio))
      const nextH = Math.max(1, Math.round(rect.height * ratio))
      if (initialized && nextW === oldW && nextH === oldH && v.dpr === ratio) return
      canvas.width = nextW; canvas.height = nextH
      v.dpr = ratio; v.cssW = rect.width; v.cssH = rect.height
      if (!initialized) { initialized = true; fit() }
      else {
        v.scale *= ratio / oldDpr
        v.ox = nextW / 2 + (v.ox - oldW / 2) * ratio / oldDpr
        v.oy = nextH / 2 + (v.oy - oldH / 2) * ratio / oldDpr
        publish()
      }
    }
    const consume = (): void => {
      const frame = frameSource.getFrame()
      if (!frame) { trails.clear(); lastSeq = null; schedule(); return }
      if (lastSeq === frame.seq) return
      if (lastSeq !== null && frame.seq < lastSeq) trails.clear()
      lastSeq = frame.seq
      const live = new Set<number>()
      for (const track of frame.tracks) {
        live.add(track.id)
        const trail = trails.get(track.id) ?? []
        trail.push([track.x, track.y])
        if (trail.length > 24) trail.shift()
        trails.set(track.id, trail)
      }
      for (const id of trails.keys()) if (!live.has(id)) trails.delete(id)
      schedule()
    }
    function draw(): void {
      raf = 0
      if (!ctx) return
      const v = viewRef.current
      const { config: cfg, calibration: quad, projected: geometry, homographyInv: inverse } = propsRef.current
      const w = canvas.width; const h = canvas.height; const d = v.dpr
      const sx = (x: number): number => v.ox + x * v.scale
      const sy = (y: number): number => v.oy - y * v.scale
      ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, w, h)
      const outer = Math.max(...[[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => Math.hypot(x - v.ox, y - v.oy))) + 2
      ctx.lineWidth = d; ctx.font = `${11 * d}px ui-monospace, monospace`
      const ringMm = [250, 500, 1000, 2000, 5000, 10000].find((step) => step * v.scale >= 55 * d) ?? 20000
      for (let radius = ringMm; radius * v.scale <= outer; radius += ringMm) {
        ctx.strokeStyle = 'rgba(120,140,170,0.12)'; ctx.beginPath()
        ctx.arc(v.ox, v.oy, radius * v.scale, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = '#5b6678'; ctx.fillText(`${radius / 1000} m`, sx(radius) + 4 * d, v.oy - 4 * d)
      }
      ctx.strokeStyle = 'rgba(120,140,170,0.22)'; ctx.beginPath()
      ctx.moveTo(0, v.oy); ctx.lineTo(w, v.oy); ctx.moveTo(v.ox, 0); ctx.lineTo(v.ox, h); ctx.stroke()
      const frame = frameSource.getFrame()
      if (frame) {
        const length = Math.min(frame.count, frame.xy.length >> 1)
        for (let i = 0; i < length; i++) {
          const x = frame.xy[i * 2]; const y = frame.xy[i * 2 + 1]
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue
          const range = Math.hypot(x, y)
          const kept = range >= cfg.rangeMinMm && range <= cfg.rangeMaxMm &&
            angleInSector(Math.atan2(y, x) * 180 / Math.PI, cfg.angleMinDeg, cfg.angleMaxDeg) &&
            (frame.quality?.[i] ?? 255) >= cfg.minQuality
          ctx.fillStyle = kept ? '#2a4a5a' : '#38252d'
          ctx.fillRect(sx(x), sy(y), 1.6 * d, 1.6 * d)
        }
        if (frame.fg) {
          ctx.fillStyle = '#37d4c8'
          for (let i = 0; i < frame.fg.length; i += 2) {
            ctx.fillRect(sx(frame.fg[i]) - d, sy(frame.fg[i + 1]) - d, 2.2 * d, 2.2 * d)
          }
        }
      }
      // Sensor angles increase toward +y, hence the negative screen arc angle.
      const span = keptSectorSpan(cfg.angleMinDeg, cfg.angleMaxDeg)
      ctx.fillStyle = 'rgba(155,53,65,0.13)'
      if (span < 360) {
        const start = sensorDegrees(cfg.angleMaxDeg) * Math.PI / 180
        const excluded = (360 - span) * Math.PI / 180
        ctx.beginPath(); ctx.moveTo(v.ox, v.oy)
        ctx.arc(v.ox, v.oy, outer, -start, -start - excluded, true)
        ctx.closePath(); ctx.fill()
      }
      ctx.beginPath(); ctx.arc(v.ox, v.oy, cfg.rangeMinMm * v.scale, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.rect(0, 0, w, h)
      ctx.arc(v.ox, v.oy, cfg.rangeMaxMm * v.scale, 0, Math.PI * 2); ctx.fill('evenodd')
      ctx.strokeStyle = '#86434e'; ctx.setLineDash([5 * d, 4 * d])
      for (const limit of [cfg.rangeMinMm, cfg.rangeMaxMm]) {
        ctx.beginPath(); ctx.arc(v.ox, v.oy, limit * v.scale, 0, Math.PI * 2); ctx.stroke()
      }
      for (const angle of span < 360 ? [cfg.angleMinDeg, cfg.angleMaxDeg] : []) {
        const a = angle * Math.PI / 180
        ctx.beginPath(); ctx.moveTo(v.ox, v.oy)
        ctx.lineTo(v.ox + Math.cos(a) * outer, v.oy - Math.sin(a) * outer); ctx.stroke()
      }
      ctx.setLineDash([])
      const labelRadius = Math.min(w, h) * 0.34
      ctx.fillStyle = '#9f8291'; ctx.textAlign = 'center'
      for (let angle = 0; angle < 360; angle += 45) {
        const a = angle * Math.PI / 180
        ctx.fillText(`${angle}°${angle === 0 ? ' +x' : angle === 90 ? ' +y' : ''}`,
          v.ox + Math.cos(a) * labelRadius, v.oy - Math.sin(a) * labelRadius)
      }
      ctx.textAlign = 'left'
      if (quad) {
        ctx.strokeStyle = 'rgba(224,179,65,0.6)'; ctx.lineWidth = 1.5 * d
        ctx.beginPath(); quad.src.forEach(([x, y], i) => i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))
        ctx.closePath(); ctx.stroke()
        if (inverse) {
          ctx.strokeStyle = 'rgba(224,179,65,0.16)'; ctx.lineWidth = d
          for (const t of [0.25, 0.5, 0.75]) {
            for (const [a, b] of [[[t, 0], [t, 1]], [[0, t], [1, t]]]) {
              const p = applyHomography(inverse, a[0], a[1]); const q = applyHomography(inverse, b[0], b[1])
              ctx.beginPath(); ctx.moveTo(sx(p[0]), sy(p[1])); ctx.lineTo(sx(q[0]), sy(q[1])); ctx.stroke()
            }
          }
        }
      }
      const key = `${v.ox},${v.oy},${v.scale}`
      if (!screenCache || screenCache.geometry !== geometry || screenCache.key !== key) {
        screenCache = { geometry, key, points: geometry.map((item) => item.points.map(([x, y]) => [sx(x), sy(y)])) }
      }
      const runtime = new Map(frame?.zones.map((zone) => [zone.id, zone]))
      geometry.forEach(({ zone }, index) => {
        const points = screenCache!.points[index]
        if (points.length < 3) return
        const active = runtime.get(zone.id)?.active ?? false
        ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath()
        ctx.fillStyle = hexToRgba(zone.color, !zone.enabled ? 0.04 : active ? 0.3 : 0.12); ctx.fill()
        ctx.strokeStyle = hexToRgba(zone.color, zone.enabled ? 0.9 : 0.4); ctx.lineWidth = (active ? 2 : 1.25) * d; ctx.stroke()
        const center = points.reduce<Point>((sum, p) => [sum[0] + p[0] / points.length, sum[1] + p[1] / points.length], [0, 0])
        ctx.textAlign = 'center'; ctx.fillStyle = '#d7dce5'
        ctx.fillText(`${zone.name} · ${runtime.get(zone.id)?.occupants.length ?? 0}`, center[0], center[1]); ctx.textAlign = 'left'
      })
      for (const track of frame?.tracks ?? []) {
        const color = PALETTE[track.id % PALETTE.length]
        const trail = trails.get(track.id) ?? []
        ctx.strokeStyle = color; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5 * d
        ctx.beginPath(); trail.forEach(([x, y], i) => i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))); ctx.stroke()
        ctx.globalAlpha = track.lostFrames ? 0.4 : 1
        ctx.beginPath(); ctx.arc(sx(track.x), sy(track.y), 5 * d, 0, Math.PI * 2)
        ctx.fillStyle = color; ctx.fill(); ctx.fillStyle = '#d7dce5'
        ctx.fillText(`#${track.id}`, sx(track.x) + 8 * d, sy(track.y) - 6 * d); ctx.globalAlpha = 1
      }
      ctx.fillStyle = '#ff5d5d'; ctx.beginPath(); ctx.arc(v.ox, v.oy, 4 * d, 0, Math.PI * 2); ctx.fill()
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const v = viewRef.current; const rect = canvas.getBoundingClientRect()
      const mx = (event.clientX - rect.left) * v.dpr; const my = (event.clientY - rect.top) * v.dpr
      const nextScale = Math.min(3 * v.dpr, Math.max(0.002 * v.dpr, v.scale * Math.exp(-event.deltaY * 0.0015)))
      const factor = nextScale / v.scale
      v.ox = mx - (mx - v.ox) * factor; v.oy = my - (my - v.oy) * factor; v.scale = nextScale
      publish()
    }
    let drag: Point | null = null
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      drag = [event.clientX, event.clientY]; canvas.setPointerCapture(event.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const onMove = (event: PointerEvent): void => {
      if (!drag) return
      const v = viewRef.current
      v.ox += (event.clientX - drag[0]) * v.dpr; v.oy += (event.clientY - drag[1]) * v.dpr
      drag = [event.clientX, event.clientY]; publish()
    }
    const onUp = (event: PointerEvent): void => {
      drag = null; canvas.style.cursor = 'grab'
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    resize(); consume()
    const ro = new ResizeObserver(resize); ro.observe(canvas)
    const off = frameSource.subscribe(consume)
    window.addEventListener('resize', resize)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp)
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); off()
      scheduleRef.current = () => {}; fitRef.current = () => {}
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [frameSource])
  useEffect(() => scheduleRef.current(), [config, calibration, projected, homographyInv])
  return <>
    <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none' }} />
    <button className="view-fit" onClick={() => fitRef.current()}>Fit view</button>
  </>
}
export default memo(LidarCanvas)
