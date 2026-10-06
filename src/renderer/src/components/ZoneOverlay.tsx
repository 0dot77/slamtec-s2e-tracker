import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Zone, ZoneRuntime } from '@shared/types'
import { clampZonePoint, hexToRgba, makeZone, validateZonePolygon } from '../lib/zones'

type Point = [number, number]
type Tool = 'edit' | 'polygon' | 'rectangle'
interface Props {
  width: number
  height: number
  zones: Zone[]
  runtime?: ZoneRuntime[]
  calibrated: boolean
  normToScreen: (u: number, v: number) => Point | null
  screenToNorm: (px: number, py: number) => Point | null
  onChange: (zones: Zone[]) => void
  toolbarBelow?: boolean
}

export default function ZoneOverlay({
  width, height, zones, runtime, calibrated, normToScreen, screenToNorm, onChange, toolbarBelow = false
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const [tool, setTool] = useState<Tool>('edit')
  const [draft, setDraft] = useState<Point[]>([])
  const [hover, setHover] = useState<Point | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<Zone | null>(null)
  const [error, setError] = useState('')
  const dragRef = useRef<{ id: string; index: number; points: Point[] } | null>(null)
  const rectangleRef = useRef<Point | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const zonesRef = useRef(zones)
  zonesRef.current = zones
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const cancel = useCallback((): void => {
    setTool('edit'); setDraft([]); draftRef.current = []; setHover(null)
    setPreview(null); dragRef.current = null; rectangleRef.current = null; setError('')
  }, [])
  const commit = useCallback((points: Point[] = draftRef.current): void => {
    const problem = validateZonePolygon(points)
    if (problem) { setError(problem); return }
    if (zonesRef.current.length >= 64) { setError('Use at most 64 areas'); return }
    const zone = makeZone(points, zonesRef.current)
    changeRef.current([...zonesRef.current, zone]); cancel(); setSelected(zone.id)
  }, [cancel])
  const removeSelected = useCallback((): void => {
    if (!selected) return
    changeRef.current(zonesRef.current.filter((zone) => zone.id !== selected))
    setSelected(null)
  }, [selected])
  useEffect(() => {
    if (selected && !zones.some((zone) => zone.id === selected)) setSelected(null)
  }, [zones, selected])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.target as HTMLElement)?.closest('input,textarea,select,button,[contenteditable]')) return
      if (event.key === 'Escape') { cancel(); setSelected(null) }
      if (event.key === 'Enter' && tool === 'polygon') { event.preventDefault(); commit() }
      if ((event.key === 'Delete' || event.key === 'Backspace') && tool === 'edit' && selected) {
        event.preventDefault(); removeSelected()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [tool, selected, commit, cancel, removeSelected])
  const eventPoint = (event: { clientX: number; clientY: number }): { screen: Point; norm: Point } | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return null
    const screen: Point = [(event.clientX - rect.left) * width / rect.width, (event.clientY - rect.top) * height / rect.height]
    const point = screenToNorm(...screen)
    return point && point.every(Number.isFinite) ? { screen, norm: clampZonePoint(point) } : null
  }
  const project = (points: Point[]): Point[] | null => {
    const output: Point[] = []
    for (const point of points) {
      const screen = normToScreen(...point)
      if (!screen || !screen.every(Number.isFinite)) return null
      output.push(screen)
    }
    return output
  }
  const projected = useMemo(() => zones.map((zone) => ({
    zone, screen: project(preview?.id === zone.id ? preview.polygon : zone.polygon)
  })), [zones, preview, normToScreen])
  const active = useMemo(() => new Set(runtime?.filter((zone) => zone.active).map((zone) => zone.id)), [runtime])
  const draftScreen = project(draft)
  const hoverScreen = hover ? normToScreen(...hover) : null
  const startTool = (next: Tool): void => { cancel(); setSelected(null); setTool(next) }
  const rectPoints = (a: Point, b: Point): Point[] => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]
  const surfaceDown = (event: React.PointerEvent<SVGRectElement>): void => {
    if (event.button !== 0 || (tool !== 'rectangle' && !(tool === 'polygon' && event.shiftKey))) return
    const point = eventPoint(event)
    if (!point) return
    rectangleRef.current = point.norm
    setDraft(rectPoints(point.norm, point.norm)); setError('')
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const surfaceMove = (event: React.PointerEvent<SVGRectElement>): void => {
    const point = eventPoint(event)
    if (!point) return
    if (rectangleRef.current) {
      const next = rectPoints(rectangleRef.current, point.norm)
      setDraft(next); draftRef.current = next
    } else setHover(point.norm)
  }
  const surfaceUp = (event: React.PointerEvent<SVGRectElement>): void => {
    if (!rectangleRef.current) return
    const point = eventPoint(event)
    const next = point ? rectPoints(rectangleRef.current, point.norm) : draftRef.current
    rectangleRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    commit(next)
  }
  const surfaceClick = (event: React.MouseEvent<SVGRectElement>): void => {
    if (tool !== 'polygon' || event.detail > 1 || event.shiftKey) return
    const point = eventPoint(event)
    if (!point) return
    const first = draftRef.current[0] && normToScreen(...draftRef.current[0])
    if (draftRef.current.length >= 3 && first && Math.hypot(point.screen[0] - first[0], point.screen[1] - first[1]) <= 12) {
      commit(); return
    }
    if (draftRef.current.length >= 64) { setError('Use at most 64 corners'); return }
    const last = draftRef.current[draftRef.current.length - 1]
    if (last && Math.hypot(last[0] - point.norm[0], last[1] - point.norm[1]) < 1e-6) return
    const next = [...draftRef.current, point.norm]
    draftRef.current = next; setDraft(next); setError('')
  }
  const vertexUp = (event: React.PointerEvent<SVGCircleElement>, cancelled = false): void => {
    const drag = dragRef.current
    if (!drag) return
    const problem = validateZonePolygon(drag.points)
    if (!cancelled && !problem) {
      changeRef.current(zonesRef.current.map((zone) => zone.id === drag.id ? { ...zone, polygon: drag.points } : zone))
    } else if (!cancelled && problem) setError(problem)
    setPreview(null); dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <>
    <svg ref={svgRef} width={width} height={height} className="zone-overlay" style={{ width, height }}>
      {calibrated && tool !== 'edit' && <rect width={width} height={height} fill="transparent"
        style={{ pointerEvents: 'all', cursor: 'crosshair', touchAction: 'none' }}
        onClick={surfaceClick} onDoubleClick={(e) => { if (tool === 'polygon') { e.preventDefault(); commit() } }}
        onPointerDown={surfaceDown} onPointerMove={surfaceMove} onPointerUp={surfaceUp}
        onPointerCancel={() => { rectangleRef.current = null; setDraft([]); draftRef.current = [] }} />}
      {projected.map(({ zone, screen }) => screen && screen.length >= 3 ? <g key={zone.id}>
        <polygon points={screen.map((p) => p.join(',')).join(' ')}
          fill={hexToRgba(zone.color, preview?.id === zone.id ? 0.2 : 0.02)}
          stroke={hexToRgba(zone.color, zone.enabled ? 0.95 : 0.4)} strokeWidth={selected === zone.id || active.has(zone.id) ? 2 : 1}
          style={{ pointerEvents: tool === 'edit' ? 'all' : 'none', cursor: 'pointer' }}
          onPointerDown={(e) => { e.stopPropagation(); setSelected(zone.id); setError('') }} />
        {tool === 'edit' && selected === zone.id && screen.map((p, index) => <circle key={index}
          cx={p[0]} cy={p[1]} r={6} fill="#11151f" stroke={zone.color} strokeWidth={2}
          style={{ pointerEvents: 'all', cursor: 'grab', touchAction: 'none' }}
          onPointerDown={(e) => {
            e.preventDefault(); e.stopPropagation()
            dragRef.current = { id: zone.id, index, points: zone.polygon.map((p) => [...p] as Point) }
            setError(''); e.currentTarget.setPointerCapture(e.pointerId)
          }} onPointerMove={(e) => {
            const drag = dragRef.current; const point = eventPoint(e)
            if (!drag || !point) return
            drag.points = drag.points.map((p, i) => i === drag.index ? point.norm : p)
            setPreview({ ...zone, polygon: drag.points })
          }} onPointerUp={(e) => vertexUp(e)} onPointerCancel={(e) => vertexUp(e, true)} />)}
      </g> : null)}
      {draftScreen && draftScreen.length > 0 && <>
        <polyline points={[...draftScreen, ...(tool === 'polygon' && !rectangleRef.current && hoverScreen ? [hoverScreen] : [])].map((p) => p.join(',')).join(' ')}
          fill={tool === 'rectangle' || rectangleRef.current ? 'rgba(55,160,212,0.15)' : 'none'} stroke="#37a0d4" strokeWidth={1.5} />
        {draftScreen.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={i === 0 ? 5 : 3} fill={i === 0 ? '#3ad48c' : '#37a0d4'} />)}
        {draft.length >= 3 && tool === 'polygon' && <circle cx={draftScreen[0][0]} cy={draftScreen[0][1]} r={12} fill="none" stroke="#3ad48c" />}
      </>}
    </svg>
    <div className="zone-toolbar" style={toolbarBelow ? { top: height + 12, bottom: 'auto' } : undefined}>
      {!calibrated ? <span className="muted">Apply a calibration to draw in LiDAR space.</span> : <>
        {tool === 'edit' ? <>
          <button onClick={() => startTool('polygon')}>+ Draw polygon</button>
          <button className="ghost" onClick={() => startTool('rectangle')}>Rectangle</button>
          {selected && <button className="ghost" onClick={removeSelected}>Delete selected</button>}
          <span className="muted">Select an area to drag its vertices.</span>
        </> : <>
          <span className="muted">{tool === 'rectangle' ? 'Drag a rectangle.' : `${draft.length} corners · click first / double-click / Enter to close · Shift-drag rectangle`}</span>
          {tool === 'polygon' && <button disabled={draft.length < 3} onClick={() => commit()}>Finish</button>}
          <button className="ghost" onClick={cancel}>Cancel</button>
        </>}
      </>}
      {error && <span className="input-error" role="alert">{error}</span>}
    </div>
  </>
}
