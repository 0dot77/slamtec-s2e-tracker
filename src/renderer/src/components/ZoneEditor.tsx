import type { Zone, ZoneRuntime } from '@shared/types'
import { PALETTE } from '../lib/zones'

// Side-panel zone list: rename, recolor, enable/disable, delete, and watch live
// occupancy. Drawing happens directly on the LiDAR view (see ZoneOverlay).
interface ZoneEditorProps {
  zones: Zone[]
  runtime?: ZoneRuntime[]
  onChange: (zones: Zone[]) => void
}

export default function ZoneEditor({ zones, runtime, onChange }: ZoneEditorProps): JSX.Element {
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
    <div className="zone-editor" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#8a93a6', lineHeight: 1.5 }}>
        Use <strong style={{ color: '#37a0d4' }}>+ Draw zone</strong> on the view to draw a polygon
        on the floor. Drag vertices to adjust.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {zones.length === 0 ? (
          <div style={{ fontSize: 12, color: '#8a93a6' }}>No zones yet.</div>
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
