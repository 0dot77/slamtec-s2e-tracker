import { useEffect, useRef, useState } from 'react'
import type { Zone, ZoneRuntime } from '@shared/types'
import { hexToRgba, makeZone } from '../lib/zones'

// On-canvas zone editor. Sits absolutely on top of the LiDAR view (same pattern
// as CalibrationLayer) so zones are drawn and edited directly on the real
// tracking area, warped through the active calibration.
//
// Coordinate flow (owned by the parent, which also owns pan/zoom + calibration):
//   normToScreen(u, v) -> [px, py] | null   normalized [0,1] -> CSS px
//   screenToNorm(px,py) -> [u, v]  | null   CSS px           -> normalized [0,1]
// Both return null when no calibration exists (the unit square has no place on
// the floor yet); in that case drawing is disabled and a hint is shown.

interface Props {
  width: number
  height: number
  zones: Zone[]
  runtime?: ZoneRuntime[]
  calibrated: boolean
  normToScreen: (u: number, v: number) => [number, number] | null
  screenToNorm: (px: number, py: number) => [number, number] | null
  onChange: (zones: Zone[]) => void
}

// Pixel radius for "click the first vertex to close" and grabbing handles.
const CLOSE_PX = 12

export default function ZoneOverlay({
  width,
  height,
  zones,
  runtime,
  calibrated,
  normToScreen,
  screenToNorm,
  onChange
}: Props): JSX.Element {
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<Array<[number, number]>>([])
  const [hover, setHover] = useState<[number, number] | null>(null)

  // Latest values for the window-level key handler without re-binding it.
  const draftRef = useRef(draft)
  const drawingRef = useRef(drawing)
  draftRef.current = draft
  drawingRef.current = drawing

  // Vertex drag (existing zones): which zone + vertex is being moved.
  const dragRef = useRef<{ zoneId: string; idx: number } | null>(null)

  const rtById = new Map<string, ZoneRuntime>()
  if (runtime) for (const r of runtime) rtById.set(r.id, r)

  const startDrawing = (): void => {
    setDraft([])
    setHover(null)
    setDrawing(true)
  }
  const cancelDraft = (): void => {
    setDraft([])
    setHover(null)
    setDrawing(false)
  }
  const commitDraft = (): void => {
    if (draftRef.current.length >= 3) {
      onChange([...zones, makeZone(draftRef.current, zones)])
    }
    cancelDraft()
  }

  // Esc cancels an in-progress draft; Enter commits it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!drawingRef.current) return
      if (e.key === 'Escape') cancelDraft()
      else if (e.key === 'Enter') commitDraft()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // commitDraft/cancelDraft close over zones; re-bind when it changes. Live
    // values (draft, drawing) are read from refs inside the handler.
  }, [zones])

  // ---- Drawing surface (capture rect) interactions ----
  const onSurfaceClick = (e: React.MouseEvent): void => {
    if (e.detail > 1) return // ignore the click that belongs to a double-click
    const p = screenToNorm(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    if (!p) return
    const d = draftRef.current
    // Close by clicking near the first vertex (measured in screen px).
    if (d.length >= 3) {
      const first = normToScreen(d[0][0], d[0][1])
      if (first) {
        const dx = e.nativeEvent.offsetX - first[0]
        const dy = e.nativeEvent.offsetY - first[1]
        if (Math.hypot(dx, dy) <= CLOSE_PX) {
          commitDraft()
          return
        }
      }
    }
    setDraft([...d, p])
  }
  const onSurfaceMove = (e: React.MouseEvent): void => {
    const p = screenToNorm(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    if (p) setHover(p)
  }

  // ---- Existing-zone vertex drag ----
  const onVertexDown =
    (zoneId: string, idx: number) => (e: React.PointerEvent<SVGCircleElement>): void => {
      if (drawing) return
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = { zoneId, idx }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  const onVertexMove = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const p = screenToNorm(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    if (!p) return
    onChange(
      zones.map((z) =>
        z.id === drag.zoneId
          ? { ...z, polygon: z.polygon.map((pt, i) => (i === drag.idx ? p : pt)) }
          : z
      )
    )
  }
  const onVertexUp = (e: React.PointerEvent<SVGCircleElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Project a normalized polygon to screen px; null if any point is unmapped.
  const project = (poly: Array<[number, number]>): Array<[number, number]> | null => {
    const out: Array<[number, number]> = []
    for (const [u, v] of poly) {
      const s = normToScreen(u, v)
      if (!s) return null
      out.push(s)
    }
    return out
  }

  const draftScreen = drawing ? project(draft) : null
  const hoverScreen = hover ? normToScreen(hover[0], hover[1]) : null

  return (
    <svg
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        pointerEvents: 'none',
        overflow: 'visible'
      }}
    >
      {/* Capture rect: only active while drawing, so pan/zoom and vertex drag
          stay usable otherwise. */}
      {drawing && (
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          style={{ pointerEvents: 'all', cursor: 'crosshair' }}
          onClick={onSurfaceClick}
          onMouseMove={onSurfaceMove}
          onDoubleClick={(e) => {
            e.preventDefault()
            commitDraft()
          }}
        />
      )}

      {/* Existing zones: outline + draggable vertices. Fill/active highlight is
          drawn by LidarCanvas underneath; here we add the editing affordances. */}
      {zones.map((z) => {
        const scr = project(z.polygon)
        if (!scr || scr.length < 2) return null
        const active = rtById.get(z.id)?.active ?? false
        const stroke = z.enabled ? z.color : hexToRgba(z.color, 0.4)
        return (
          <g key={z.id}>
            <polygon
              points={scr.map((p) => `${p[0]},${p[1]}`).join(' ')}
              fill="none"
              stroke={stroke}
              strokeWidth={active ? 2 : 1.25}
              style={{ pointerEvents: 'none' }}
            />
            {!drawing &&
              scr.map((p, i) => (
                <circle
                  key={i}
                  cx={p[0]}
                  cy={p[1]}
                  r={5}
                  fill="#11151f"
                  stroke={stroke}
                  strokeWidth={2}
                  style={{ pointerEvents: 'all', cursor: 'grab' }}
                  onPointerDown={onVertexDown(z.id, i)}
                  onPointerMove={onVertexMove}
                  onPointerUp={onVertexUp}
                  onPointerCancel={onVertexUp}
                />
              ))}
          </g>
        )
      })}

      {/* In-progress draft: chain + rubber-band to cursor + close hint. */}
      {draftScreen && draftScreen.length > 0 && (
        <>
          <polyline
            points={[...draftScreen, ...(hoverScreen ? [hoverScreen] : [])]
              .map((p) => `${p[0]},${p[1]}`)
              .join(' ')}
            fill="none"
            stroke="#37a0d4"
            strokeWidth={1.5}
            style={{ pointerEvents: 'none' }}
          />
          {draftScreen.map((p, i) => (
            <circle
              key={i}
              cx={p[0]}
              cy={p[1]}
              r={i === 0 ? 5 : 3}
              fill={i === 0 ? '#3ad48c' : '#37a0d4'}
              style={{ pointerEvents: 'none' }}
            />
          ))}
          {draftScreen.length >= 3 && (
            <circle
              cx={draftScreen[0][0]}
              cy={draftScreen[0][1]}
              r={CLOSE_PX}
              fill="none"
              stroke="rgba(58,212,140,0.6)"
              strokeWidth={1}
              style={{ pointerEvents: 'none' }}
            />
          )}
        </>
      )}

      {/* Toolbar pinned to the bottom (foreignObject so we can use plain DOM
          buttons); top-left is occupied by the LiDAR HUD. */}
      <foreignObject x={8} y={Math.max(0, height - 44)} width={Math.max(0, width - 16)} height={40}>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
            pointerEvents: 'none'
          }}
        >
          {!calibrated ? (
            <span
              style={{
                background: 'rgba(11,14,20,0.85)',
                color: '#e0b341',
                padding: '4px 8px',
                borderRadius: 6
              }}
            >
              Calibrate the floor first to draw zones.
            </span>
          ) : !drawing ? (
            <button
              onClick={startDrawing}
              style={{
                pointerEvents: 'all',
                background: '#2563a8',
                border: '1px solid #2f74c0',
                color: '#fff',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer'
              }}
            >
              + Draw zone
            </button>
          ) : (
            <>
              <span
                style={{
                  background: 'rgba(11,14,20,0.85)',
                  color: '#37a0d4',
                  padding: '4px 8px',
                  borderRadius: 6
                }}
              >
                drawing · {draft.length} pt{draft.length === 1 ? '' : 's'} · click to add,
                dbl-click / Enter to finish, Esc to cancel
              </span>
              <button
                onClick={commitDraft}
                disabled={draft.length < 3}
                style={{
                  pointerEvents: 'all',
                  background: '#2563a8',
                  border: '1px solid #2f74c0',
                  color: '#fff',
                  borderRadius: 6,
                  padding: '4px 10px',
                  fontSize: 11,
                  cursor: draft.length < 3 ? 'not-allowed' : 'pointer',
                  opacity: draft.length < 3 ? 0.5 : 1
                }}
              >
                Finish
              </button>
              <button
                onClick={cancelDraft}
                style={{
                  pointerEvents: 'all',
                  background: '#1c2436',
                  border: '1px solid #2a3344',
                  color: '#d7dce5',
                  borderRadius: 6,
                  padding: '4px 10px',
                  fontSize: 11,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </foreignObject>
    </svg>
  )
}
