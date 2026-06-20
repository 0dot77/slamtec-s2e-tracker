import { useCallback, useEffect, useRef, useState } from 'react'
import type { Track, Zone, ZoneRuntime } from '@shared/types'

interface ZoneEditorProps {
  zones: Zone[]
  tracks: Track[]
  runtime?: ZoneRuntime[]
  onChange: (zones: Zone[]) => void
}

// Small dark-theme-friendly palette new zones cycle through.
const PALETTE = ['#37a0d4', '#3ad48c', '#e0b341', '#ff5d5d', '#a079e0', '#37d4c8', '#e07ab4']

// Closing threshold (in normalized units) for clicking back onto the first vertex.
const CLOSE_DIST = 0.03

function nextColor(zones: Zone[]): string {
  return PALETTE[zones.length % PALETTE.length]
}

// Map a hex color to an rgba() string at the given alpha (handles #rgb and #rrggbb).
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

export default function ZoneEditor({
  zones,
  tracks,
  runtime,
  onChange
}: ZoneEditorProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Hot data read inside the rAF draw loop — kept in refs so the loop never restarts.
  const zonesRef = useRef<Zone[]>(zones)
  const tracksRef = useRef<Track[]>(tracks)
  const runtimeRef = useRef<ZoneRuntime[] | undefined>(runtime)
  const draftRef = useRef<Array<[number, number]>>([]) // in-progress polygon, normalized
  const hoverRef = useRef<[number, number] | null>(null) // cursor in normalized space

  // Draft length mirrored into state so the toolbar can react (finish/cancel buttons).
  const [draftLen, setDraftLen] = useState(0)

  zonesRef.current = zones
  tracksRef.current = tracks
  runtimeRef.current = runtime

  // Convert a pointer event to normalized [0,1] coords (clamped to the unit square).
  const toNorm = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const canvas = canvasRef.current
    if (!canvas) return [0, 0]
    const r = canvas.getBoundingClientRect()
    const u = r.width > 0 ? (e.clientX - r.left) / r.width : 0
    const v = r.height > 0 ? (e.clientY - r.top) / r.height : 0
    return [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))]
  }, [])

  // Commit the in-progress draft polygon as a new Zone.
  const commitDraft = useCallback(() => {
    const pts = draftRef.current
    if (pts.length >= 3) {
      const z = zonesRef.current
      const zone: Zone = {
        id: `z${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        name: `zone ${z.length + 1}`,
        color: nextColor(z),
        enabled: true,
        polygon: pts.map(([x, y]) => [x, y] as [number, number])
      }
      onChange([...z, zone])
    }
    draftRef.current = []
    setDraftLen(0)
  }, [onChange])

  const cancelDraft = useCallback(() => {
    draftRef.current = []
    setDraftLen(0)
  }, [])

  // Render loop + pointer interactions.
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const dpr = (): number => window.devicePixelRatio || 1

    const resize = (): void => {
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(r.width * dpr()))
      canvas.height = Math.max(1, Math.floor(r.height * dpr()))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const w = canvas.width
      const h = canvas.height
      const d = dpr()
      const nx = (u: number): number => u * w
      const ny = (v: number): number => v * h

      // Backdrop.
      ctx.fillStyle = '#0b0e14'
      ctx.fillRect(0, 0, w, h)

      // Grid (quarters) + border framing the unit square.
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(120,140,170,0.12)'
      ctx.beginPath()
      for (let i = 1; i < 4; i++) {
        ctx.moveTo(nx(i / 4), 0)
        ctx.lineTo(nx(i / 4), h)
        ctx.moveTo(0, ny(i / 4))
        ctx.lineTo(w, ny(i / 4))
      }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(120,140,170,0.3)'
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1)

      // Corner labels for orientation in normalized space.
      ctx.fillStyle = 'rgba(150,170,200,0.4)'
      ctx.font = `${10 * d}px ui-monospace, monospace`
      ctx.fillText('0,0', 4 * d, 12 * d)
      ctx.fillText('1,1', w - 22 * d, h - 5 * d)

      const rt = runtimeRef.current
      const rtById = new Map<string, ZoneRuntime>()
      if (rt) for (const r of rt) rtById.set(r.id, r)

      // Existing zones.
      for (const zone of zonesRef.current) {
        const poly = zone.polygon
        if (poly.length < 2) continue
        const r = rtById.get(zone.id)
        const active = r?.active ?? false
        const dim = !zone.enabled

        ctx.beginPath()
        ctx.moveTo(nx(poly[0][0]), ny(poly[0][1]))
        for (let i = 1; i < poly.length; i++) ctx.lineTo(nx(poly[i][0]), ny(poly[i][1]))
        ctx.closePath()

        // Fill: brighter when a runtime says the zone is active.
        ctx.fillStyle = hexToRgba(zone.color, active ? 0.32 : dim ? 0.05 : 0.12)
        ctx.fill()
        ctx.lineWidth = active ? 2 * d : 1.25 * d
        ctx.strokeStyle = dim ? hexToRgba(zone.color, 0.4) : zone.color
        ctx.stroke()

        // Vertex handles.
        ctx.fillStyle = dim ? hexToRgba(zone.color, 0.4) : zone.color
        for (const [px, py] of poly) {
          ctx.beginPath()
          ctx.arc(nx(px), ny(py), 2.5 * d, 0, Math.PI * 2)
          ctx.fill()
        }

        // Centroid label: name + live occupant count when runtime present.
        let cx = 0
        let cy = 0
        for (const [px, py] of poly) {
          cx += px
          cy += py
        }
        cx /= poly.length
        cy /= poly.length
        const occ = r?.occupants.length ?? 0
        const label = rt ? `${zone.name} · ${occ}` : zone.name
        ctx.font = `${11 * d}px ui-monospace, monospace`
        const tw = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(11,14,20,0.7)'
        ctx.fillRect(nx(cx) - tw / 2 - 4 * d, ny(cy) - 8 * d, tw + 8 * d, 16 * d)
        ctx.fillStyle = dim ? '#8a93a6' : '#d7dce5'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, nx(cx), ny(cy))
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }

      // In-progress draft polygon (open chain + rubber-band to cursor).
      const draft = draftRef.current
      if (draft.length > 0) {
        ctx.strokeStyle = '#37a0d4'
        ctx.lineWidth = 1.25 * d
        ctx.beginPath()
        ctx.moveTo(nx(draft[0][0]), ny(draft[0][1]))
        for (let i = 1; i < draft.length; i++) ctx.lineTo(nx(draft[i][0]), ny(draft[i][1]))
        const hov = hoverRef.current
        if (hov) ctx.lineTo(nx(hov[0]), ny(hov[1]))
        ctx.stroke()

        // Vertices, with the first one emphasized as the close target.
        for (let i = 0; i < draft.length; i++) {
          ctx.beginPath()
          ctx.arc(nx(draft[i][0]), ny(draft[i][1]), (i === 0 ? 5 : 3) * d, 0, Math.PI * 2)
          ctx.fillStyle = i === 0 ? '#3ad48c' : '#37a0d4'
          ctx.fill()
        }
        // Close hint ring around the first vertex once the polygon is closeable.
        if (draft.length >= 3) {
          ctx.strokeStyle = 'rgba(58,212,140,0.6)'
          ctx.lineWidth = 1 * d
          ctx.beginPath()
          ctx.arc(nx(draft[0][0]), ny(draft[0][1]), CLOSE_DIST * Math.min(w, h), 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // Tracks as dots at (u, v).
      const sz = Math.max(3, 3 * d)
      for (const t of tracksRef.current) {
        const x = nx(t.u)
        const y = ny(t.v)
        ctx.beginPath()
        ctx.arc(x, y, sz, 0, Math.PI * 2)
        ctx.fillStyle = '#3ad48c'
        ctx.fill()
        ctx.lineWidth = 1 * d
        ctx.strokeStyle = '#0b0e14'
        ctx.stroke()
        ctx.fillStyle = 'rgba(215,220,229,0.85)'
        ctx.font = `${10 * d}px ui-monospace, monospace`
        ctx.fillText(`${t.id}`, x + sz + 2 * d, y + 3 * d)
      }
    }
    draw()

    const onMove = (e: MouseEvent): void => {
      hoverRef.current = toNorm(e)
    }
    const onLeave = (): void => {
      hoverRef.current = null
    }
    const onClick = (e: MouseEvent): void => {
      if (e.detail > 1) return // ignore the click that belongs to a double-click
      const p = toNorm(e)
      const draft = draftRef.current
      // Close by clicking near the first vertex.
      if (draft.length >= 3) {
        const dx = p[0] - draft[0][0]
        const dy = p[1] - draft[0][1]
        if (Math.hypot(dx, dy) <= CLOSE_DIST) {
          commitDraft()
          return
        }
      }
      draft.push(p)
      setDraftLen(draft.length)
    }
    const onDouble = (e: MouseEvent): void => {
      e.preventDefault()
      commitDraft()
    }

    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('dblclick', onDouble)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('dblclick', onDouble)
    }
  }, [toNorm, commitDraft])

  // ---- Zone list mutations (each produces a fresh Zone[] for onChange) ----

  const updateZone = (id: string, patch: Partial<Zone>): void => {
    onChange(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)))
  }
  const deleteZone = (id: string): void => {
    onChange(zones.filter((z) => z.id !== id))
  }
  const cycleColor = (z: Zone): void => {
    const i = PALETTE.indexOf(z.color)
    updateZone(z.id, { color: PALETTE[(i + 1) % PALETTE.length] })
  }

  const rtById = new Map<string, ZoneRuntime>()
  if (runtime) for (const r of runtime) rtById.set(r.id, r)

  return (
    <div className="zone-editor" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          aspectRatio: '1 / 1',
          width: '100%',
          maxWidth: 360,
          position: 'relative',
          border: '1px solid #1e2533',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#0b0e14'
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', cursor: 'crosshair' }}
        />
        <div
          className="hud"
          style={{
            position: 'absolute',
            top: 6,
            left: 8,
            display: 'flex',
            gap: 10,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
            color: '#8a93a6',
            pointerEvents: 'none'
          }}
        >
          {draftLen > 0 ? (
            <span style={{ color: '#37a0d4' }}>
              drawing · {draftLen} pt{draftLen === 1 ? '' : 's'}
            </span>
          ) : (
            <span>click to add points · dbl-click / click start to close</span>
          )}
        </div>
        {draftLen > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: 6,
              right: 8,
              display: 'flex',
              gap: 6
            }}
          >
            <button
              onClick={commitDraft}
              disabled={draftLen < 3}
              style={{
                background: '#2563a8',
                border: '1px solid #2f74c0',
                color: '#fff',
                borderRadius: 6,
                padding: '3px 9px',
                fontSize: 11,
                cursor: draftLen < 3 ? 'not-allowed' : 'pointer',
                opacity: draftLen < 3 ? 0.5 : 1
              }}
            >
              Finish
            </button>
            <button
              onClick={cancelDraft}
              style={{
                background: '#1c2436',
                border: '1px solid #2a3344',
                color: '#d7dce5',
                borderRadius: 6,
                padding: '3px 9px',
                fontSize: 11,
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {zones.length === 0 ? (
          <div style={{ fontSize: 12, color: '#8a93a6' }}>
            No zones yet — draw a polygon above.
          </div>
        ) : (
          zones.map((z) => {
            const occ = rtById.get(z.id)?.occupants.length ?? 0
            const active = rtById.get(z.id)?.active ?? false
            return (
              <div
                key={z.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  background: '#11151f',
                  border: `1px solid ${active ? z.color : '#1e2533'}`,
                  borderRadius: 6
                }}
              >
                <button
                  onClick={() => cycleColor(z)}
                  title="Click to change color"
                  style={{
                    width: 16,
                    height: 16,
                    flex: '0 0 auto',
                    borderRadius: 4,
                    background: z.color,
                    border: '1px solid #2a3344',
                    padding: 0,
                    cursor: 'pointer'
                  }}
                />
                <input
                  value={z.name}
                  onChange={(e) => updateZone(z.id, { name: e.target.value })}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: '#0b0e14',
                    border: '1px solid #2a3344',
                    color: '#d7dce5',
                    borderRadius: 6,
                    padding: '4px 7px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12
                  }}
                />
                {runtime && (
                  <span
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 11,
                      color: active ? '#3ad48c' : '#8a93a6',
                      minWidth: 16,
                      textAlign: 'right'
                    }}
                    title="occupants"
                  >
                    {occ}
                  </span>
                )}
                <label
                  className="field"
                  style={{ gap: 4, fontSize: 11, color: '#8a93a6', cursor: 'pointer' }}
                  title="Enable / disable"
                >
                  <input
                    type="checkbox"
                    checked={z.enabled}
                    onChange={(e) => updateZone(z.id, { enabled: e.target.checked })}
                  />
                  on
                </label>
                <button
                  onClick={() => deleteZone(z.id)}
                  title="Delete zone"
                  style={{
                    background: '#1c2436',
                    border: '1px solid #2a3344',
                    color: '#ff5d5d',
                    borderRadius: 6,
                    padding: '3px 8px',
                    fontSize: 12,
                    cursor: 'pointer'
                  }}
                >
                  ✕
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
