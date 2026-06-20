import type { CSSProperties } from 'react'
import type { OscConfig, PipelineConfig } from '@shared/types'

interface ControlPanelProps {
  config: PipelineConfig
  onConfig: (c: PipelineConfig) => void
  osc: OscConfig
  onOsc: (c: OscConfig) => void
  onLearnBackground: () => void
  onSavePreset: () => void
  onLoadPreset: () => void
  status?: string
}

// Range slider descriptors. `key` indexes a numeric PipelineConfig field.
interface SliderSpec {
  key: keyof PipelineConfig
  label: string
  min: number
  max: number
  step: number
  unit?: string
}

const SLIDERS: SliderSpec[] = [
  { key: 'bgDeltaMm', label: 'BG delta', min: 20, max: 600, step: 10, unit: 'mm' },
  { key: 'clusterGapMm', label: 'Cluster gap', min: 20, max: 500, step: 10, unit: 'mm' },
  { key: 'minClusterPts', label: 'Min cluster pts', min: 1, max: 30, step: 1 },
  { key: 'minSizeMm', label: 'Min size', min: 0, max: 600, step: 10, unit: 'mm' },
  { key: 'maxSizeMm', label: 'Max size', min: 200, max: 3000, step: 50, unit: 'mm' },
  { key: 'trackMaxJumpMm', label: 'Track max jump', min: 50, max: 2000, step: 50, unit: 'mm' },
  { key: 'smoothing', label: 'Smoothing', min: 0, max: 1, step: 0.05 },
  { key: 'birthFrames', label: 'Birth frames', min: 1, max: 20, step: 1 },
  { key: 'deathFrames', label: 'Death frames', min: 1, max: 60, step: 1 }
]

const panel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  width: 268,
  padding: '14px 16px',
  background: '#11151f',
  borderLeft: '1px solid #1e2533',
  color: '#d7dce5',
  fontSize: 13,
  overflowY: 'auto'
}

const sectionTitle: CSSProperties = {
  fontSize: 11,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: '#8a93a6',
  margin: '2px 0'
}

const rowLabel: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  fontSize: 12,
  color: '#8a93a6',
  marginBottom: 4
}

const valueText: CSSProperties = {
  color: '#d7dce5',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12
}

const rangeInput: CSSProperties = {
  width: '100%',
  accentColor: '#37a0d4',
  cursor: 'pointer'
}

const textInput: CSSProperties = {
  background: '#0b0e14',
  border: '1px solid #2a3344',
  color: '#d7dce5',
  borderRadius: 6,
  padding: '5px 8px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  width: '100%'
}

const primaryButton: CSSProperties = {
  background: '#2563a8',
  border: '1px solid #2f74c0',
  color: '#fff',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
  cursor: 'pointer'
}

const ghostButton: CSSProperties = {
  ...primaryButton,
  background: '#1c2436',
  borderColor: '#2a3344',
  color: '#d7dce5'
}

const oscFieldLabel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: '#8a93a6'
}

const divider: CSSProperties = {
  height: 1,
  background: '#1e2533',
  border: 0,
  margin: '2px 0'
}

// Sliders use whole-number ticks except smoothing, which is fractional.
function fmt(value: number, step: number): string {
  return step < 1 ? value.toFixed(2) : String(value)
}

export default function ControlPanel({
  config,
  onConfig,
  osc,
  onOsc,
  onLearnBackground,
  onSavePreset,
  onLoadPreset,
  status
}: ControlPanelProps): JSX.Element {
  const setField = (key: keyof PipelineConfig, value: number): void => {
    onConfig({ ...config, [key]: value })
  }

  return (
    <aside style={panel}>
      <div style={sectionTitle}>Pipeline</div>

      {SLIDERS.map((s) => {
        const value = config[s.key]
        return (
          <label key={s.key} style={{ display: 'block' }}>
            <span style={rowLabel}>
              <span>{s.label}</span>
              <span style={valueText}>
                {fmt(value, s.step)}
                {s.unit ? <span style={{ color: '#5b6678' }}> {s.unit}</span> : null}
              </span>
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={value}
              onChange={(e) => setField(s.key, Number(e.target.value))}
              style={rangeInput}
            />
          </label>
        )
      })}

      <button type="button" style={ghostButton} onClick={onLearnBackground}>
        Learn background
      </button>

      <hr style={divider} />
      <div style={sectionTitle}>OSC</div>

      <label style={oscFieldLabel}>
        Host
        <input
          type="text"
          value={osc.host}
          onChange={(e) => onOsc({ ...osc, host: e.target.value })}
          style={textInput}
        />
      </label>

      <label style={oscFieldLabel}>
        Port
        <input
          type="number"
          value={osc.port}
          onChange={(e) => onOsc({ ...osc, port: Number(e.target.value) || 0 })}
          style={textInput}
        />
      </label>

      <label style={oscFieldLabel}>
        Address prefix
        <input
          type="text"
          value={osc.addrPrefix}
          onChange={(e) => onOsc({ ...osc, addrPrefix: e.target.value })}
          style={textInput}
        />
      </label>

      <label style={oscFieldLabel}>
        Max slots
        <input
          type="number"
          value={osc.maxSlots}
          onChange={(e) => onOsc({ ...osc, maxSlots: Number(e.target.value) || 0 })}
          style={textInput}
        />
      </label>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: '#d7dce5',
          cursor: 'pointer'
        }}
      >
        <input
          type="checkbox"
          checked={osc.enabled}
          onChange={(e) => onOsc({ ...osc, enabled: e.target.checked })}
          style={{ accentColor: '#3ad48c', cursor: 'pointer' }}
        />
        OSC enabled
      </label>

      <hr style={divider} />
      <div style={sectionTitle}>Preset</div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={{ ...primaryButton, flex: 1 }} onClick={onSavePreset}>
          Save
        </button>
        <button type="button" style={{ ...ghostButton, flex: 1 }} onClick={onLoadPreset}>
          Load
        </button>
      </div>

      {status ? (
        <div
          style={{
            fontSize: 12,
            color: '#8a93a6',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            marginTop: 2
          }}
        >
          {status}
        </div>
      ) : null}
    </aside>
  )
}
