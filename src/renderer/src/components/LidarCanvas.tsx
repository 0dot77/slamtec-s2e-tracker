import { useEffect, useRef, useState } from 'react'
import type { CalibrationPoints, Track, VizFrame, Zone, ZoneRuntime } from '@shared/types'
import { applyHomography, type Mat3 } from '@shared/homography'
import { hexToRgba } from '../lib/zones'

export interface View {
  scale: number // pixels per millimeter (device px)
  ox: number // screen x of LiDAR origin (device px)
  oy: number // screen y of LiDAR origin (device px)
  dpr: number // device pixel ratio captured with this view
  cssW: number // canvas CSS width (px)
  cssH: number // canvas CSS height (px)
}

interface Props {
  // Latest frame to draw. The parent owns the subscription so it can also feed
  // tracks/zones to the side panels; LidarCanvas just renders what it is given.
  frame: VizFrame | null
  // Active calibration quad (LiDAR mm) to outline, or null. Drawn faintly so the
  // user keeps spatial context even outside Calibrate mode.
  calibration?: CalibrationPoints | null
  // Notified whenever the view transform changes (mount, resize, wheel, drag) so
  // the parent can keep overlays (CalibrationLayer) aligned with pan/zoom.
  onView?: (v: View) => void
  // Event zones (normalized polygons) drawn warped onto the floor, plus the
  // inverse homography (normalized -> LiDAR mm) needed to place them. Runtime
  // adds the live active/occupant state for highlighting.
  zones?: Zone[]
  runtime?: ZoneRuntime[]
  homographyInv?: Mat3 | null
}

const TRACK_COLORS = ['#3ad48c', '#37a0d4', '#e0b341', '#ff5d5d', '#a079e0', '#37d4c8', '#e07ab4']

export default function LidarCanvas({
  frame,
  calibration,
  onView,
  zones,
  runtime,
  homographyInv
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<VizFrame | null>(frame)
  const calibRef = useRef<CalibrationPoints | null>(calibration ?? null)
  const zonesRef = useRef<Zone[]>(zones ?? [])
  const runtimeRef = useRef<ZoneRuntime[]>(runtime ?? [])
  const homInvRef = useRef<Mat3 | null>(homographyInv ?? null)
  const onViewRef = useRef(onView)
  const viewRef = useRef<View>({ scale: 0.08, ox: 0, oy: 0, dpr: 1, cssW: 0, cssH: 0 })
  const initedRef = useRef(false)
  const stampsRef = useRef<number[]>([])
  // Short position trails per track id (device px), capped length.
  const trailsRef = useRef<Map<number, Array<[number, number]>>>(new Map())
  const [hz, setHz] = useState(0)
  const [pts, setPts] = useState(0)
  const [seq, setSeq] = useState(0)

  frameRef.current = frame
  calibRef.current = calibration ?? null
  zonesRef.current = zones ?? []
  runtimeRef.current = runtime ?? []
  homInvRef.current = homographyInv ?? null
  onViewRef.current = onView

  // HUD counters + FPS estimate, recomputed when a new frame arrives.
  useEffect(() => {
    if (!frame) return
    setPts(frame.count)
    setSeq(frame.seq)
    const now = performance.now()
    const s = stampsRef.current
    s.push(now)
    while (s.length > 30) s.shift()
    if (s.length > 1) {
      const dt = (s[s.length - 1] - s[0]) / (s.length - 1)
      setHz(dt > 0 ? 1000 / dt : 0)
    }
  }, [frame])

  // Render loop + interactions.
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const dpr = (): number => window.devicePixelRatio || 1

    const publishView = (): void => {
      const v = viewRef.current
      v.dpr = dpr()
      const r = canvas.getBoundingClientRect()
      v.cssW = r.width
      v.cssH = r.height
      onViewRef.current?.({ ...v })
    }

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
      publishView()
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

      const f = frameRef.current
      const s = v.scale
      const sx = (xMm: number): number => v.ox + xMm * s
      const sy = (yMm: number): number => v.oy - yMm * s // y flipped

      // Calibration quad outline (faint, drawn under the cloud).
      const calib = calibRef.current
      if (calib) {
        const q = calib.src
        ctx.strokeStyle = 'rgba(224,179,65,0.55)'
        ctx.lineWidth = 1.5 * d
        ctx.beginPath()
        ctx.moveTo(sx(q[0][0]), sy(q[0][1]))
        for (let i = 1; i < 4; i++) ctx.lineTo(sx(q[i][0]), sy(q[i][1]))
        ctx.closePath()
        ctx.stroke()
      }

      // Raw point cloud (dim) + foreground points (bright).
      if (f) {
        const xy = f.xy
        const szPt = Math.max(1.5, 1.6 * d)
        ctx.fillStyle = '#2a4a5a'
        for (let i = 0; i < f.count; i++) {
          ctx.fillRect(sx(xy[i * 2]), sy(xy[i * 2 + 1]), szPt, szPt)
        }
        const fgxy = f.fg
        if (fgxy) {
          const szFg = Math.max(2, 2.2 * d)
          ctx.fillStyle = '#37d4c8'
          const fgCount = fgxy.length >> 1
          for (let i = 0; i < fgCount; i++) {
            ctx.fillRect(sx(fgxy[i * 2]) - szFg / 2, sy(fgxy[i * 2 + 1]) - szFg / 2, szFg, szFg)
          }
        }
      }

      // Event zones, warped from normalized space onto the floor via the
      // inverse homography. Drawn over the cloud but under the tracks.
      const hInv = homInvRef.current
      const zoneList = zonesRef.current
      if (hInv && zoneList.length > 0) {
        const rtById = new Map<string, ZoneRuntime>()
        for (const r of runtimeRef.current) rtById.set(r.id, r)
        ctx.font = `${11 * d}px ui-monospace, monospace`
        for (const zone of zoneList) {
          if (zone.polygon.length < 2) continue
          const pts = zone.polygon.map(([u, vv]) => {
            const [mx, my] = applyHomography(hInv, u, vv)
            return [sx(mx), sy(my)] as [number, number]
          })
          const r = rtById.get(zone.id)
          const active = r?.active ?? false
          const dim = !zone.enabled

          ctx.beginPath()
          ctx.moveTo(pts[0][0], pts[0][1])
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
          ctx.closePath()
          ctx.fillStyle = hexToRgba(zone.color, active ? 0.3 : dim ? 0.04 : 0.12)
          ctx.fill()
          ctx.lineWidth = (active ? 2 : 1.25) * d
          ctx.strokeStyle = dim ? hexToRgba(zone.color, 0.4) : zone.color
          ctx.stroke()

          // Centroid label: name + live occupant count.
          let cx = 0
          let cy = 0
          for (const [px, py] of pts) {
            cx += px
            cy += py
          }
          cx /= pts.length
          cy /= pts.length
          const occ = r?.occupants.length ?? 0
          const label = `${zone.name} · ${occ}`
          const tw = ctx.measureText(label).width
          ctx.fillStyle = 'rgba(11,14,20,0.7)'
          ctx.fillRect(cx - tw / 2 - 4 * d, cy - 8 * d, tw + 8 * d, 16 * d)
          ctx.fillStyle = dim ? '#8a93a6' : '#d7dce5'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, cx, cy)
          ctx.textAlign = 'left'
          ctx.textBaseline = 'alphabetic'
        }
      }

      // Tracks: trail + dot + id label.
      const trails = trailsRef.current
      if (f) {
        const live = new Set<number>()
        for (const t of f.tracks) {
          live.add(t.id)
          let trail = trails.get(t.id)
          if (!trail) {
            trail = []
            trails.set(t.id, trail)
          }
          trail.push([t.x, t.y])
          while (trail.length > 24) trail.shift()
        }
        // Drop trails for vanished tracks.
        for (const id of trails.keys()) if (!live.has(id)) trails.delete(id)

        for (const t of f.tracks) {
          const color = TRACK_COLORS[t.id % TRACK_COLORS.length]
          const trail = trails.get(t.id)
          if (trail && trail.length > 1) {
            ctx.strokeStyle = color
            ctx.globalAlpha = 0.35
            ctx.lineWidth = 1.5 * d
            ctx.beginPath()
            ctx.moveTo(sx(trail[0][0]), sy(trail[0][1]))
            for (let i = 1; i < trail.length; i++) ctx.lineTo(sx(trail[i][0]), sy(trail[i][1]))
            ctx.stroke()
            ctx.globalAlpha = 1
          }
          const px = sx(t.x)
          const py = sy(t.y)
          ctx.beginPath()
          ctx.arc(px, py, 5 * d, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
          ctx.lineWidth = 1.5 * d
          ctx.strokeStyle = '#0b0e14'
          ctx.stroke()
          ctx.fillStyle = '#d7dce5'
          ctx.font = `${11 * d}px ui-monospace, monospace`
          ctx.fillText(`#${t.id}`, px + 8 * d, py - 6 * d)
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
      publishView()
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
      publishView()
    }
    const onUp = (): void => {
      if (!dragging) return
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
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
      />
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
