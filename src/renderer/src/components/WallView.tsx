import { useCallback, useEffect, useRef, useState } from 'react'
import type { Zone, ZoneRuntime } from '@shared/types'
import type { FrameSource } from '../lib/frameStore'
import { hexToRgba, PALETTE } from '../lib/zones'
import ZoneOverlay from './ZoneOverlay'

interface Props {
  frameSource: FrameSource
  zones: Zone[]
  runtime: ZoneRuntime[]
  onChange: (zones: Zone[]) => void
  editing: boolean
  calibrated: boolean
}
interface Projection { width: number; height: number }
const STORAGE_KEY = 'slamtec-s2e-tracker.wall-output.v1'
const DEFAULT_PROJECTION: Projection = { width: 5760, height: 1200 }
function validDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 32768
}
function readProjection(): Projection {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Projection | null
    if (value && validDimension(value.width) && validDimension(value.height)) return value
  } catch { /* Storage can be unavailable in locked-down installations. */ }
  return DEFAULT_PROJECTION
}
function DimensionInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const cancel = useRef(false)
  useEffect(() => setDraft(String(value)), [value])
  return <label className="field">{label}<input type="number" min={1} max={32768} step={1}
    value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => {
      if (cancel.current) { cancel.current = false; return }
      const number = Number(draft)
      if (validDimension(number)) onChange(number)
      else setDraft(String(value))
    }} onKeyDown={(e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
      if (e.key === 'Escape') { cancel.current = true; setDraft(String(value)); e.currentTarget.blur() }
    }} /></label>
}

export default function WallView({ frameSource, zones, runtime, onChange, editing, calibrated }: Props): JSX.Element {
  const [projection, setProjection] = useState<Projection>(readProjection)
  const [grid, setGrid] = useState(true)
  const [gridStep, setGridStep] = useState(300)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scheduleRef = useRef<() => void>(() => {})
  const ratio = projection.width / projection.height
  const wallW = Math.max(1, Math.min(Math.max(1, size.width - 48), Math.max(1, size.height - 140) * ratio))
  const wallH = wallW / ratio
  const latest = useRef({ projection, grid, gridStep, zones, calibrated })
  latest.current = { projection, grid, gridStep, zones, calibrated }
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projection)) } catch { /* In-memory settings still work. */ }
  }, [projection])
  useEffect(() => {
    const stage = stageRef.current!
    const resize = (): void => {
      const rect = stage.getBoundingClientRect()
      setSize((old) => old.width === rect.width && old.height === rect.height ? old : { width: rect.width, height: rect.height })
    }
    resize()
    const observer = new ResizeObserver(resize); observer.observe(stage)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let lastSeq: number | null = null
    const schedule = (): void => { if (!raf) raf = requestAnimationFrame(draw) }
    scheduleRef.current = schedule
    function draw(): void {
      raf = 0
      if (!ctx) return
      const rect = canvas.getBoundingClientRect(); const d = window.devicePixelRatio || 1
      const w = rect.width; const h = rect.height
      if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
        canvas.width = Math.max(1, Math.round(w * d)); canvas.height = Math.max(1, Math.round(h * d))
      }
      ctx.setTransform(d, 0, 0, d, 0, 0)
      ctx.fillStyle = '#101722'; ctx.fillRect(0, 0, w, h)
      const cfg = latest.current
      if (cfg.grid) {
        ctx.strokeStyle = 'rgba(120,140,170,0.16)'; ctx.lineWidth = 1
        ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = '#6b7488'
        for (let x = cfg.gridStep; x < cfg.projection.width; x += cfg.gridStep) {
          const px = x / cfg.projection.width * w
          ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke()
          if (cfg.gridStep / cfg.projection.width * w > 32) ctx.fillText(String(x), px + 3, 12)
        }
        for (let y = cfg.gridStep; y < cfg.projection.height; y += cfg.gridStep) {
          const py = y / cfg.projection.height * h
          ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke()
          if (cfg.gridStep / cfg.projection.height * h > 18) ctx.fillText(String(y), 3, py - 3)
        }
      }
      const frame = frameSource.getFrame()
      const live = new Map(frame?.zones.map((zone) => [zone.id, zone]))
      for (const zone of cfg.zones) {
        if (zone.polygon.length < 3) continue
        const active = live.get(zone.id)?.active ?? false
        ctx.beginPath(); zone.polygon.forEach(([u, v], i) => i ? ctx.lineTo(u * w, v * h) : ctx.moveTo(u * w, v * h)); ctx.closePath()
        ctx.fillStyle = hexToRgba(zone.color, !zone.enabled ? 0.04 : active ? 0.32 : 0.12); ctx.fill()
        ctx.strokeStyle = hexToRgba(zone.color, zone.enabled ? 0.9 : 0.4); ctx.lineWidth = active ? 2 : 1.25
        ctx.setLineDash(zone.touch === false ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([])
        const center = zone.polygon.reduce<[number, number]>((sum, p) => [sum[0] + p[0] / zone.polygon.length, sum[1] + p[1] / zone.polygon.length], [0, 0])
        ctx.textAlign = 'center'; ctx.font = '11px ui-monospace, monospace'; ctx.fillStyle = '#d7dce5'
        ctx.fillText(`${zone.name} · ${live.get(zone.id)?.occupants.length ?? 0}`, center[0] * w, center[1] * h)
      }
      ctx.textAlign = 'left'
      if (cfg.calibrated) for (const track of frame?.tracks ?? []) {
        if (!Number.isFinite(track.u) || !Number.isFinite(track.v) || track.u < 0 || track.u > 1 || track.v < 0 || track.v > 1) continue
        ctx.globalAlpha = track.lostFrames ? 0.4 : 1
        const x = track.u * w; const y = track.v * h
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = PALETTE[track.id % PALETTE.length]; ctx.fill()
        ctx.fillStyle = '#d7dce5'; ctx.font = '11px ui-monospace, monospace'
        ctx.fillText(`#${track.id}`, Math.min(w - 35, x + 8), Math.max(12, y - 6)); ctx.globalAlpha = 1
      }
    }
    const off = frameSource.subscribe(() => {
      const seq = frameSource.getFrame()?.seq ?? null
      if (seq !== lastSeq || seq === null) { lastSeq = seq; schedule() }
    })
    const observer = new ResizeObserver(schedule); observer.observe(canvas)
    window.addEventListener('resize', schedule); schedule()
    return () => { off(); observer.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', schedule); scheduleRef.current = () => {} }
  }, [frameSource])
  useEffect(() => scheduleRef.current(), [zones, projection, grid, gridStep, calibrated, wallW, wallH])
  const normToScreen = useCallback((u: number, v: number): [number, number] => [u * wallW, v * wallH], [wallW, wallH])
  const screenToNorm = useCallback((x: number, y: number): [number, number] => [x / wallW, y / wallH], [wallW, wallH])
  return <div className="wall-view">
    <div className="wall-settings">
      <DimensionInput label="Output width" value={projection.width} onChange={(width) => setProjection((old) => ({ ...old, width }))} />
      <DimensionInput label="height" value={projection.height} onChange={(height) => setProjection((old) => ({ ...old, height }))} />
      <span className="muted">{ratio.toFixed(2)}:1</span>
      <label className="control-check"><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />Pixel grid</label>
      {grid && <label className="field">Step<input type="number" min={50} max={10000} step={50} value={gridStep}
        onChange={(e) => { const value = Number(e.target.value); if (Number.isFinite(value)) setGridStep(Math.min(10000, Math.max(50, value))) }} />px</label>}
    </div>
    <div className="wall-stage" ref={stageRef}>
      <div className="wall-hint muted">u: left → right · v: top → bottom{!calibrated ? ' · Apply a calibration to show live tracks.' : ''}</div>
      <div className="wall-surface" style={{ width: wallW, height: wallH, left: (size.width - wallW) / 2, top: Math.max(48, (size.height - wallH - 60) / 2) }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        {editing && <ZoneOverlay width={wallW} height={wallH} zones={zones} runtime={runtime} calibrated
          normToScreen={normToScreen} screenToNorm={screenToNorm} onChange={onChange} toolbarBelow />}
        <span className="wall-corner tl">TL · 0,0</span><span className="wall-corner tr">TR · 1,0</span>
        <span className="wall-corner br">BR · 1,1</span><span className="wall-corner bl">BL · 0,1</span>
      </div>
    </div>
  </div>
}
