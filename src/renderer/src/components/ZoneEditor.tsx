import { useEffect, useMemo, useRef, useState } from 'react'
import type { Zone, ZoneRuntime } from '@shared/types'
import {
  oscZoneNames,
  reserveZoneName,
  seedZoneNames,
  uniqueZoneName,
  zoneTouchAddress
} from '../lib/zones'

interface ZoneEditorProps {
  zones: Zone[]
  runtime?: ZoneRuntime[]
  oscPrefix: string
  onChange: (zones: Zone[]) => void
}

interface NameInputProps {
  zone: Zone
  zones: Zone[]
  onCommit: (name: string) => void
}

function ZoneNameInput({ zone, zones, onCommit }: NameInputProps): JSX.Element {
  const [draft, setDraft] = useState(zone.name)
  const cancelBlur = useRef(false)

  useEffect(() => setDraft(zone.name), [zone.name])

  const commit = (): void => {
    if (cancelBlur.current) { cancelBlur.current = false; return }
    const name = uniqueZoneName(draft, zones, zone.id, zone.name)
    setDraft(name)
    if (name !== zone.name) onCommit(name)
  }

  return (
    <input
      className="zone-name-input"
      aria-label={`Name for ${zone.name}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          // Blur fires before React updates state; restore without committing.
          setDraft(zone.name)
          cancelBlur.current = true
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export default function ZoneEditor({
  zones,
  runtime,
  oscPrefix,
  onChange
}: ZoneEditorProps): JSX.Element {
  useEffect(() => seedZoneNames(zones), [zones])

  const runtimeById = useMemo(() => {
    const result = new Map<string, ZoneRuntime>()
    for (const item of runtime ?? []) result.set(item.id, item)
    return result
  }, [runtime])

  const oscNames = useMemo(() => oscZoneNames(zones), [zones])

  const updateZone = (id: string, patch: Partial<Zone>): void => {
    if (typeof patch.name === 'string') reserveZoneName(patch.name)
    onChange(zones.map((zone) => (zone.id === id ? { ...zone, ...patch } : zone)))
  }

  return (
    <div className="zone-editor">
      <div className="zone-editor-help">
        Draw on the LiDAR or Wall view. Select a shape to drag its vertices or delete it.
      </div>

      <div className="zone-list">
        {zones.length === 0 ? (
          <div className="zone-empty">No touch areas yet.</div>
        ) : (
          zones.map((zone) => {
            const live = runtimeById.get(zone.id)
            const occupants = live?.occupants.length ?? 0
            const active = live?.active ?? false
            const segment = oscNames.get(zone.id) ?? 'zone'
            const address = zoneTouchAddress(oscPrefix, segment)
            return (
              <div
                className={`zone-card${active ? ' active' : ''}${zone.enabled ? '' : ' disabled'}`}
                style={{ '--zone-color': zone.color } as React.CSSProperties}
                key={zone.id}
              >
                <div className="zone-card-main">
                  <input
                    className="zone-color-input"
                    type="color"
                    value={zone.color}
                    aria-label={`Color for ${zone.name}`}
                    title="Area color"
                    onChange={(event) => updateZone(zone.id, { color: event.target.value })}
                  />
                  <ZoneNameInput
                    zone={zone}
                    zones={zones}
                    onCommit={(name) => updateZone(zone.id, { name })}
                  />
                  {runtime && (
                    <span className={`zone-occupancy${active ? ' active' : ''}`} title="Occupants">
                      {occupants}
                    </span>
                  )}
                  <button
                    type="button"
                    className="zone-delete"
                    onClick={() => onChange(zones.filter((item) => item.id !== zone.id))}
                    title={`Delete ${zone.name}`}
                    aria-label={`Delete ${zone.name}`}
                  >
                    ×
                  </button>
                </div>

                <div className="zone-card-options">
                  <label title="Include this area in processing and OSC output">
                    <input
                      type="checkbox"
                      checked={zone.enabled}
                      onChange={(event) => updateZone(zone.id, { enabled: event.target.checked })}
                    />
                    enabled
                  </label>
                  <label title="Accept wall touches inside this area">
                    <input
                      type="checkbox"
                      checked={zone.touch !== false}
                      onChange={(event) => updateZone(zone.id, { touch: event.target.checked })}
                    />
                    touch area
                  </label>
                </div>

                <code className="zone-address" title={address}>
                  {address}
                </code>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
