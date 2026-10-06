import { useEffect, useRef, useState } from 'react'
import type { OscConfig, OscMode, PipelineConfig, ReadyReason } from '@shared/types'
import { MAX_OSC_SLOTS, PERSON_TRACKING_PIPELINE_CONFIG, WALL_TOUCH_PIPELINE_CONFIG } from '@shared/types'
import type { FrameHud } from '../lib/useFrameHud'
import { normalizeOscPrefix } from '../lib/zones'

interface Props {
  config: PipelineConfig
  onConfig: (config: PipelineConfig) => void
  osc: OscConfig
  onOsc: (config: OscConfig) => void
  onLearnBackground: () => void
  onResetBackground: () => void
  onSavePreset: () => void
  onLoadPreset: () => void
  hud: FrameHud
  disabled: boolean
  status?: string
}
interface NumericSpec {
  key: keyof PipelineConfig
  label: string
  hint: string
  min: number
  max: number
  step: number
}
const DETECTION: NumericSpec[] = [
  { key: 'bgDeltaMm', label: 'BG delta (mm)', hint: 'Minimum distance in front of the background', min: 0, max: 2000, step: 5 },
  { key: 'bgNoiseK', label: 'BG noise K', hint: 'Multiplier for per-angle background noise', min: 0, max: 20, step: 0.1 },
  { key: 'bgMinReturnRatio', label: 'BG min return ratio', hint: 'Minimum fraction of learning frames with a return', min: 0, max: 1, step: 0.01 },
  { key: 'bgLearnFrames', label: 'BG learn frames', hint: 'Number of scans to learn the empty wall', min: 1, max: 1000, step: 1 },
  { key: 'clusterGapMm', label: 'Cluster gap (mm)', hint: 'Maximum separation between points in one hand', min: 5, max: 2000, step: 5 },
  { key: 'minClusterPts', label: 'Min cluster points', hint: 'Minimum returns needed for a cluster', min: 1, max: 200, step: 1 },
  { key: 'minSizeMm', label: 'Min size (mm)', hint: 'Minimum cluster diagonal', min: 0, max: 5000, step: 5 },
  { key: 'maxSizeMm', label: 'Max size (mm)', hint: 'Maximum cluster diagonal', min: 50, max: 20000, step: 10 },
  { key: 'trackMaxJumpMm', label: 'Track max jump (mm)', hint: 'Association distance around the predicted position', min: 5, max: 5000, step: 5 },
  { key: 'smoothing', label: 'Smoothing', hint: '1 = raw position; smaller values smooth motion', min: 0, max: 1, step: 0.01 },
  { key: 'birthFrames', label: 'Birth frames', hint: 'Consecutive detections needed to create a track', min: 1, max: 30, step: 1 },
  { key: 'deathFrames', label: 'Death frames', hint: 'Missed detections before removing a track', min: 1, max: 100, step: 1 }
]
const MASK: NumericSpec[] = [
  { key: 'angleMinDeg', label: 'Angle min (°)', hint: 'Sensor degrees; min > max keeps the sector through 0°', min: 0, max: 360, step: 1 },
  { key: 'angleMaxDeg', label: 'Angle max (°)', hint: '0° points toward +x; 90° points toward +y', min: 0, max: 360, step: 1 },
  { key: 'rangeMinMm', label: 'Range min (mm)', hint: 'Ignore points closer than this distance', min: 0, max: 40000, step: 10 },
  { key: 'rangeMaxMm', label: 'Range max (mm)', hint: 'Ignore points farther than this distance', min: 10, max: 40000, step: 10 },
  { key: 'minQuality', label: 'Min quality', hint: 'Discard returns below this quality', min: 0, max: 255, step: 1 },
  { key: 'roiMargin', label: 'ROI margin', hint: 'Extra normalized margin outside the calibrated quad', min: 0, max: 1, step: 0.01 }
]
export const READY_HINT: Record<ReadyReason, string> = {
  ok: 'Touch output ready', 'no-calibration': 'Apply a calibration',
  'bad-calibration': 'Fix the calibration quad', learning: 'Learning the empty wall',
  'no-background': 'Learn the background', calibrating: 'Calibration capture in progress',
  stalled: 'Waiting for fresh scans'
}

function OscTextField({ label, value, onCommit, validate, numeric = false }: {
  label: string
  value: string
  onCommit: (value: string) => void
  validate: (value: string) => string | null
  numeric?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const cancelBlur = useRef(false)
  useEffect(() => { setDraft(value); setError(null) }, [value])
  const commit = (): void => {
    if (cancelBlur.current) { cancelBlur.current = false; return }
    const clean = draft.trim()
    const problem = validate(clean)
    setError(problem)
    if (!problem && clean !== value) onCommit(clean)
  }
  return <label className="control-field">
    {label}
    <input aria-label={label} value={draft} inputMode={numeric ? 'numeric' : 'text'}
      aria-invalid={error !== null} onChange={(e) => { setDraft(e.target.value); setError(null) }}
      onBlur={commit} onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelBlur.current = true; setDraft(value); setError(null); e.currentTarget.blur()
        }
      }} />
    {error && <span className="input-error" role="alert">{error}</span>}
  </label>
}

export default function ControlPanel({
  config, onConfig, osc, onOsc, onLearnBackground, onResetBackground,
  onSavePreset, onLoadPreset, hud, disabled, status
}: Props): JSX.Element {
  const [countdown, setCountdown] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const learnRef = useRef(onLearnBackground)
  learnRef.current = onLearnBackground
  useEffect(() => () => clearTimeout(timer.current), [])
  const startLearn = (): void => {
    if (countdown !== null) return
    let seconds = 3
    setCountdown(seconds)
    const tick = (): void => {
      seconds -= 1
      setCountdown(seconds > 0 ? seconds : null)
      if (seconds > 0) timer.current = setTimeout(tick, 1000)
      else learnRef.current()
    }
    timer.current = setTimeout(tick, 1000)
  }
  const setNumeric = (key: keyof PipelineConfig, value: number): void => {
    const next = { ...config, [key]: value }
    if (key === 'minSizeMm') next.maxSizeMm = Math.max(next.maxSizeMm, value)
    if (key === 'maxSizeMm') next.minSizeMm = Math.min(next.minSizeMm, value)
    if (key === 'rangeMinMm') next.rangeMaxMm = Math.max(next.rangeMaxMm, value)
    if (key === 'rangeMaxMm') next.rangeMinMm = Math.min(next.rangeMinMm, value)
    onConfig(next)
  }
  const numericFields = (specs: NumericSpec[]): JSX.Element[] => specs.map((s) =>
    <label className="control-numeric" key={s.key} title={s.hint}>
      <span>{s.label}</span>
      <input type="number" min={s.min} max={s.max} step={s.step} value={config[s.key]}
        onChange={(e) => {
          if (e.target.value === '') return
          const value = Number(e.target.value)
          if (Number.isFinite(value)) setNumeric(s.key, Math.min(s.max, Math.max(s.min, value)))
        }} />
    </label>
  )
  return <aside className="control-panel">
    <div className="control-title">Output status</div>
    <div className={`ready-badge ${hud.ready && !hud.stale ? 'ready' : ''}`}>
      ● {hud.stale ? 'stale' : hud.ready ? 'ready' : 'not ready'}
    </div>
    <div className="muted">{hud.stale ? 'No scan for over 1 s' : READY_HINT[hud.readyReason]}</div>
    <div className="control-metrics">
      <span>{hud.hz.toFixed(1)} Hz</span><span>{hud.procMs.toFixed(1)} ms</span><span>{hud.tracks} tracks</span>
    </div>
    <fieldset disabled={disabled}>
      <div className="control-title">Profile</div>
      <div className="control-actions">
        <button onClick={() => onConfig({ ...WALL_TOUCH_PIPELINE_CONFIG })}>Wall touch</button>
        <button className="ghost" onClick={() => onConfig({ ...PERSON_TRACKING_PIPELINE_CONFIG })}>Person tracking</button>
      </div>
      <div className="control-title">Background</div>
      <div className="control-actions">
        <button onClick={startLearn} disabled={countdown !== null || hud.bg?.learning}>
          {countdown !== null ? `Clear wall · ${countdown}s` : 'Learn background'}
        </button>
        <button className="ghost" onClick={onResetBackground} disabled={countdown !== null}>Reset</button>
      </div>
      <div className="muted">
        {countdown !== null ? 'Remove hands from the scan plane.' : hud.bg?.learning
          ? `Learning · ${Math.round(hud.bg.progress * 100)}%`
          : hud.bg?.ready ? `Learned · ${hud.bg.bins}/${hud.bg.totalBins} bins` : 'No background learned'}
      </div>
      <details open><summary>Detection & tracking</summary>{numericFields(DETECTION)}</details>
      <details open><summary>Scan mask</summary>{numericFields(MASK)}</details>
      <div className="control-title">OSC</div>
      <label className="control-field">Mode
        <select value={osc.mode} onChange={(e) => onOsc({ ...osc, mode: e.target.value as OscMode })}>
          <option value="touch">touch · Unity</option><option value="slots">slots · legacy</option><option value="both">both</option>
        </select>
      </label>
      <OscTextField label="Host" value={osc.host}
        validate={(s) => /^[A-Za-z0-9.\-:_]{1,253}$/.test(s) ? null : 'Enter a host name or IP address'}
        onCommit={(host) => onOsc({ ...osc, host })} />
      <OscTextField label="Port" value={String(osc.port)} numeric
        validate={(s) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 65535 ? null : 'Port must be 1–65535'}
        onCommit={(value) => onOsc({ ...osc, port: Number(value) })} />
      <OscTextField label="Address prefix" value={osc.addrPrefix}
        validate={(s) => s.length > 0 && /^\/?[A-Za-z0-9_\-./]{0,63}$/.test(s) ? null : 'Use letters, numbers, /, _, -, or . (up to 63)'}
        onCommit={(value) => onOsc({ ...osc, addrPrefix: normalizeOscPrefix(value) })} />
      <label className="control-numeric">Max slots
        <input type="number" min={1} max={MAX_OSC_SLOTS} step={1} value={osc.maxSlots}
          onChange={(e) => {
            if (e.target.value === '') return
            const value = Number(e.target.value)
            if (Number.isFinite(value)) onOsc({ ...osc, maxSlots: Math.min(MAX_OSC_SLOTS, Math.max(1, Math.round(value))) })
          }} />
      </label>
      <label className="control-check"><input type="checkbox" checked={osc.yUp}
        onChange={(e) => onOsc({ ...osc, yUp: e.target.checked })} />y up · Unity screen coordinates</label>
      <label className="control-check"><input type="checkbox" checked={osc.requireReady}
        onChange={(e) => onOsc({ ...osc, requireReady: e.target.checked })} />Require ready for touches</label>
      <label className="control-check"><input type="checkbox" checked={osc.enabled}
        onChange={(e) => onOsc({ ...osc, enabled: e.target.checked })} />OSC enabled</label>
      <div className="control-title">Preset</div>
      <div className="control-actions">
        <button onClick={onSavePreset}>Save</button><button className="ghost" onClick={onLoadPreset}>Load</button>
      </div>
    </fieldset>
    {status && <div className="muted">{status}</div>}
  </aside>
}
