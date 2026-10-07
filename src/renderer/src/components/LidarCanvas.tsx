import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CalibrationPoints, PipelineConfig, Zone } from '@shared/types'
import { applyHomography, type Mat3 } from '@shared/homography'
import type { FrameSource } from '../lib/frameStore'
import { hexToRgba, PALETTE } from '../lib/zones'
import { angleInSector, keptSectorSpan } from '../lib/scanMask'
import { alignedRotation, deviceX, deviceY, fitView, screenAngle, setViewOrientation, type View, type ViewOrientation } from '../lib/viewTransform'

interface Props {
  frameSource: FrameSource
  calibration: CalibrationPoints | null
  fitCalibration: CalibrationPoints | null
  config: PipelineConfig
  zones: Zone[]
  homographyInv: Mat3 | null
  onView: (view: View) => void
  orientation: ViewOrientation
  onOrientation: (orientation: ViewOrientation) => void
  children: ReactNode
}
type Point = [number, number]

function LidarCanvas({ frameSource, calibration, fitCalibration, config, zones, homographyInv, onView, orientation, onOrientation, children }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<View>({ scale: 0.08, ox: 0, oy: 0, dpr: 1, cssW: 0, cssH: 0,
    ...orientation, xx: 1, xy: 0, yx: 0, yy: -1 })
  const scheduleRef = useRef<() => void>(() => {})
  const fitRef = useRef<() => void>(() => {})
  const orientRef = useRef<(next: ViewOrientation) => void>(() => {})
  const [rotationInput, setRotationInput] = useState(String(orientation.rotationDeg))
  // Project normalized polygons into mm once per geometry/calibration change.
  const projected = useMemo(() => homographyInv ? zones.map((zone) => ({
    zone, points: zone.polygon.map(([u, v]) => applyHomography(homographyInv, u, v))
  })).filter((item) => item.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) : [], [zones, homographyInv])
  const propsRef = useRef({ calibration, fitCalibration, config, projected, homographyInv, onView, orientation, onOrientation })
  propsRef.current = { calibration, fitCalibration, config, projected, homographyInv, onView, orientation, onOrientation }

  useEffect(() => {
    const canvas = canvasRef.current!
    const surface = surfaceRef.current!
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
      const { config: cfg, fitCalibration: quad } = propsRef.current
      fitView(v, cfg.angleMinDeg, cfg.angleMaxDeg, cfg.rangeMaxMm, quad?.src)
      publish()
    }
    fitRef.current = fit
    orientRef.current = (next): void => { setViewOrientation(viewRef.current, next); publish() }
    setViewOrientation(viewRef.current, propsRef.current.orientation)
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
      const sx = (x: number, y: number): number => deviceX(v, x, y)
      const sy = (x: number, y: number): number => deviceY(v, x, y)
      ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, w, h)
      const outer = Math.max(Math.hypot(v.ox, v.oy), Math.hypot(w - v.ox, v.oy),
        Math.hypot(w - v.ox, h - v.oy), Math.hypot(v.ox, h - v.oy)) + 2
      ctx.lineWidth = d; ctx.font = `${11 * d}px ui-monospace, monospace`
      const ringMm = [250, 500, 1000, 2000, 5000, 10000].find((step) => step * v.scale >= 55 * d) ?? 20000
      for (let radius = ringMm; radius * v.scale <= outer; radius += ringMm) {
        ctx.strokeStyle = 'rgba(120,140,170,0.12)'; ctx.beginPath()
        ctx.arc(v.ox, v.oy, radius * v.scale, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = '#5b6678'; ctx.fillText(`${radius / 1000} m`, sx(radius, 0) + 4 * d, sy(radius, 0) - 4 * d)
      }
      ctx.strokeStyle = 'rgba(120,140,170,0.22)'; ctx.beginPath()
      const axisMm = outer / v.scale
      ctx.moveTo(sx(-axisMm, 0), sy(-axisMm, 0)); ctx.lineTo(sx(axisMm, 0), sy(axisMm, 0))
      ctx.moveTo(sx(0, -axisMm), sy(0, -axisMm)); ctx.lineTo(sx(0, axisMm), sy(0, axisMm)); ctx.stroke()
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
          ctx.fillRect(sx(x, y), sy(x, y), 1.6 * d, 1.6 * d)
        }
        if (frame.fg) {
          ctx.fillStyle = '#37d4c8'
          for (let i = 0; i < frame.fg.length; i += 2) {
            ctx.fillRect(sx(frame.fg[i], frame.fg[i + 1]) - d, sy(frame.fg[i], frame.fg[i + 1]) - d, 2.2 * d, 2.2 * d)
          }
        }
      }
      // The shared projection supplies the arc direction; a mirror reverses it.
      const span = keptSectorSpan(cfg.angleMinDeg, cfg.angleMaxDeg)
      ctx.fillStyle = 'rgba(155,53,65,0.13)'
      if (span < 360) {
        const start = screenAngle(v, cfg.angleMaxDeg)
        const excluded = (360 - span) * Math.PI / 180
        ctx.beginPath(); ctx.moveTo(v.ox, v.oy)
        ctx.arc(v.ox, v.oy, outer, start, start + (v.mirror ? excluded : -excluded), !v.mirror)
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
        const x = Math.cos(a) * axisMm; const y = Math.sin(a) * axisMm
        ctx.beginPath(); ctx.moveTo(v.ox, v.oy)
        ctx.lineTo(sx(x, y), sy(x, y)); ctx.stroke()
      }
      ctx.setLineDash([])
      const labelRadius = Math.min(w, h) * 0.34
      ctx.fillStyle = '#9f8291'; ctx.textAlign = 'center'
      for (let angle = 0; angle < 360; angle += 45) {
        const a = angle * Math.PI / 180
        const x = Math.cos(a) * labelRadius / v.scale; const y = Math.sin(a) * labelRadius / v.scale
        ctx.fillText(`${angle}°${angle === 0 ? ' +x' : angle === 90 ? ' +y' : ''}`,
          sx(x, y), sy(x, y))
      }
      ctx.textAlign = 'left'
      if (quad) {
        ctx.strokeStyle = 'rgba(224,179,65,0.6)'; ctx.lineWidth = 1.5 * d
        ctx.beginPath(); quad.src.forEach(([x, y], i) => i ? ctx.lineTo(sx(x, y), sy(x, y)) : ctx.moveTo(sx(x, y), sy(x, y)))
        ctx.closePath(); ctx.stroke()
        if (inverse) {
          ctx.strokeStyle = 'rgba(224,179,65,0.16)'; ctx.lineWidth = d
          for (const t of [0.25, 0.5, 0.75]) {
            for (const [a, b] of [[[t, 0], [t, 1]], [[0, t], [1, t]]]) {
              const p = applyHomography(inverse, a[0], a[1]); const q = applyHomography(inverse, b[0], b[1])
              ctx.beginPath(); ctx.moveTo(sx(p[0], p[1]), sy(p[0], p[1])); ctx.lineTo(sx(q[0], q[1]), sy(q[0], q[1])); ctx.stroke()
            }
          }
        }
      }
      const key = `${v.ox},${v.oy},${v.scale},${v.rotationDeg},${v.mirror}`
      if (!screenCache || screenCache.geometry !== geometry || screenCache.key !== key) {
        screenCache = { geometry, key, points: geometry.map((item) => item.points.map(([x, y]) => [sx(x, y), sy(x, y)])) }
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
        ctx.beginPath(); trail.forEach(([x, y], i) => i ? ctx.lineTo(sx(x, y), sy(x, y)) : ctx.moveTo(sx(x, y), sy(x, y))); ctx.stroke()
        ctx.globalAlpha = track.lostFrames ? 0.4 : 1
        ctx.beginPath(); ctx.arc(sx(track.x, track.y), sy(track.x, track.y), 5 * d, 0, Math.PI * 2)
        ctx.fillStyle = color; ctx.fill(); ctx.fillStyle = '#d7dce5'
        ctx.fillText(`#${track.id}`, sx(track.x, track.y) + 8 * d, sy(track.x, track.y) - 6 * d); ctx.globalAlpha = 1
      }
      ctx.fillStyle = '#ff5d5d'; ctx.beginPath(); ctx.arc(v.ox, v.oy, 4 * d, 0, Math.PI * 2); ctx.fill()
    }
    const isControl = (target: EventTarget | null): boolean => target instanceof Element &&
      !!target.closest('button,input,select,textarea,summary,label,foreignObject,.zone-toolbar')
    const onWheel = (event: WheelEvent): void => {
      if (isControl(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      const v = viewRef.current; const rect = canvas.getBoundingClientRect()
      const mx = (event.clientX - rect.left) * v.dpr; const my = (event.clientY - rect.top) * v.dpr
      const nextScale = Math.min(3 * v.dpr, Math.max(0.002 * v.dpr, v.scale * Math.exp(-event.deltaY * 0.0015)))
      const factor = nextScale / v.scale
      v.ox = mx - (mx - v.ox) * factor; v.oy = my - (my - v.oy) * factor; v.scale = nextScale
      publish()
    }
    let drag: { pointerId: number; x: number; y: number; rotate: boolean; angle: number | null } | null = null
    const pointerAngle = (event: PointerEvent): number | null => {
      const v = viewRef.current; const rect = canvas.getBoundingClientRect()
      const x = (event.clientX - rect.left) * v.dpr - v.ox
      const y = (event.clientY - rect.top) * v.dpr - v.oy
      // Crossing the origin has no defined angle; resume outside this small disk.
      return Math.hypot(x, y) < 12 * v.dpr ? null : Math.atan2(y, x)
    }
    const onDown = (event: PointerEvent): void => {
      if (drag || isControl(event.target)) return
      const rotate = event.button === 2
      if (!rotate && (event.button !== 0 || event.target !== canvas)) return
      event.preventDefault(); event.stopPropagation()
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rotate, angle: rotate ? pointerAngle(event) : null }
      surface.setPointerCapture(event.pointerId)
      surface.style.cursor = canvas.style.cursor = rotate ? 'crosshair' : 'grabbing'
    }
    const onMove = (event: PointerEvent): void => {
      if (!drag || drag.pointerId !== event.pointerId) return
      event.preventDefault(); event.stopPropagation()
      const v = viewRef.current
      if (drag.rotate) {
        const angle = pointerAngle(event)
        if (angle !== null && drag.angle !== null) {
          const delta = Math.atan2(Math.sin(angle - drag.angle), Math.cos(angle - drag.angle))
          const next = { rotationDeg: v.rotationDeg + delta * 180 / Math.PI * (v.mirror ? 1 : -1),
            mirror: v.mirror, alignDirection: v.alignDirection }
          setViewOrientation(v, next)
          propsRef.current.onOrientation({ ...next, rotationDeg: v.rotationDeg })
          publish()
        }
        drag.angle = angle
      } else {
        v.ox += (event.clientX - drag.x) * v.dpr; v.oy += (event.clientY - drag.y) * v.dpr
        publish()
      }
      drag.x = event.clientX; drag.y = event.clientY
    }
    const onUp = (event: PointerEvent): void => {
      if (!drag || drag.pointerId !== event.pointerId) return
      event.stopPropagation()
      drag = null; surface.style.cursor = ''; canvas.style.cursor = 'grab'
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
    }
    const onContext = (event: MouseEvent): void => { if (!isControl(event.target)) event.preventDefault() }
    resize(); consume()
    const ro = new ResizeObserver(resize); ro.observe(canvas)
    const off = frameSource.subscribe(consume)
    window.addEventListener('resize', resize)
    // Capture above SVG overlays so wheel/right-drag work in every editing mode.
    surface.addEventListener('wheel', onWheel, { passive: false, capture: true })
    surface.addEventListener('pointerdown', onDown, true); surface.addEventListener('pointermove', onMove, true)
    surface.addEventListener('pointerup', onUp, true); surface.addEventListener('pointercancel', onUp, true)
    surface.addEventListener('lostpointercapture', onUp, true); surface.addEventListener('contextmenu', onContext)
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); off()
      scheduleRef.current = () => {}; fitRef.current = () => {}; orientRef.current = () => {}
      window.removeEventListener('resize', resize)
      surface.removeEventListener('wheel', onWheel, true); surface.removeEventListener('pointerdown', onDown, true)
      surface.removeEventListener('pointermove', onMove, true); surface.removeEventListener('pointerup', onUp, true)
      surface.removeEventListener('pointercancel', onUp, true); surface.removeEventListener('lostpointercapture', onUp, true)
      surface.removeEventListener('contextmenu', onContext)
    }
  }, [frameSource])
  useEffect(() => scheduleRef.current(), [config, calibration, projected, homographyInv])
  useEffect(() => {
    const current = viewRef.current
    if (current.rotationDeg !== orientation.rotationDeg || current.mirror !== orientation.mirror || current.alignDirection !== orientation.alignDirection) {
      orientRef.current(orientation)
    }
    setRotationInput(String(Number(orientation.rotationDeg.toFixed(2))))
  }, [orientation])
  const changeOrientation = (next: ViewOrientation): void => {
    orientRef.current(next)
    onOrientation({ ...next, rotationDeg: viewRef.current.rotationDeg })
  }
  const rotate = (degrees: number): void => changeOrientation({ ...orientation, rotationDeg: degrees })
  const commitRotation = (): void => {
    const number = Number(rotationInput)
    if (rotationInput.trim() && Number.isFinite(number)) rotate(number)
    else setRotationInput(String(Number(orientation.rotationDeg.toFixed(2))))
  }
  const align = (direction = orientation.alignDirection): void => {
    changeOrientation({ ...orientation, alignDirection: direction,
      rotationDeg: alignedRotation(config.angleMinDeg, config.angleMaxDeg, direction, orientation.rotationDeg) })
    fitRef.current()
  }
  const compass = screenAngle(viewRef.current, 0) * 180 / Math.PI
  return <div className="lidar-stage">
    <div className="lidar-view-tools" role="toolbar" aria-label="LiDAR view controls">
      <button onClick={() => fitRef.current()}>Fit view</button>
      <div className="view-rotation-buttons" role="group" aria-label="Rotate view">
        <button title="Rotate view -90 degrees" onClick={() => rotate(orientation.rotationDeg - 90)}>−90°</button>
        <button title="Rotate view -15 degrees" onClick={() => rotate(orientation.rotationDeg - 15)}>−15°</button>
        <button title="Rotate view +15 degrees" onClick={() => rotate(orientation.rotationDeg + 15)}>+15°</button>
        <button title="Rotate view +90 degrees" onClick={() => rotate(orientation.rotationDeg + 90)}>+90°</button>
      </div>
      <label className="view-rotation-input">rot <input aria-label="View rotation (degrees)" type="number" step="1"
        value={rotationInput} onChange={(event) => setRotationInput(event.target.value)} onBlur={commitRotation}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />°</label>
      <button title="Reset view rotation to 0 degrees" onClick={() => rotate(0)}>Reset</button>
      <button aria-pressed={orientation.mirror} title="Flip the view horizontally"
        onClick={() => changeOrientation({ ...orientation, mirror: !orientation.mirror })}>Mirror</button>
      <div className="view-align-controls">
        <button title="Point the kept scan sector down or up, then fit its extent" onClick={() => align()}>Align to scan mask</button>
        <select aria-label="Scan mask direction" title="Direction of the kept sector; changing this also aligns and fits"
          value={orientation.alignDirection} onChange={(event) => align(event.target.value as 'down' | 'up')}>
          <option value="down">Down</option><option value="up">Up</option>
        </select>
      </div>
      <span className="view-compass" title={`Sensor 0° direction · rot ${Number(orientation.rotationDeg.toFixed(2))}°${orientation.mirror ? ' · mirrored' : ''}`}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" stroke="#2a3344" />
          <path d="M5 12H20M15 8L20 12L15 16" fill="none" stroke="#e0b341" strokeWidth="1.5" transform={`rotate(${compass} 12 12)`} />
        </svg>0°
      </span>
    </div>
    <div ref={surfaceRef} className="lidar-surface">
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none' }} />
      {children}
    </div>
  </div>
}
export default memo(LidarCanvas)
