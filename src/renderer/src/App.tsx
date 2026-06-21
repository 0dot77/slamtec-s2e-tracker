import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BridgeStatus,
  CalibrationPoints,
  OscConfig,
  PipelineConfig,
  Track,
  VizFrame,
  Zone,
  ZoneEvent,
  ZoneRuntime
} from '@shared/types'
import { DEFAULT_OSC_CONFIG, DEFAULT_PIPELINE_CONFIG } from '@shared/types'
import LidarCanvas, { type View } from './components/LidarCanvas'
import CalibrationLayer from './components/CalibrationLayer'
import ZoneEditor from './components/ZoneEditor'
import ControlPanel from './components/ControlPanel'

const STATE_COLOR: Record<string, string> = {
  idle: '#8a93a6',
  connecting: '#e0b341',
  connected: '#37a0d4',
  scanning: '#3ad48c',
  error: '#ff5d5d',
  stopped: '#8a93a6'
}

type Mode = 'view' | 'calibrate' | 'zones'

export default function App(): JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>({ state: 'idle' })
  const [ip, setIp] = useState('192.168.11.2')
  const [port, setPort] = useState(8089)

  const [mode, setMode] = useState<Mode>('view')

  // Per-frame data (latest VizFrame, split for the consumers that need it).
  const [frame, setFrame] = useState<VizFrame | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [runtime, setRuntime] = useState<ZoneRuntime[]>([])

  // Authoring / config state (source of truth in the renderer, mirrored to main).
  const [pipe, setPipe] = useState<PipelineConfig>(DEFAULT_PIPELINE_CONFIG)
  const [osc, setOsc] = useState<OscConfig>(DEFAULT_OSC_CONFIG)
  const [calibration, setCalibration] = useState<CalibrationPoints | null>(null)
  const [zones, setZones] = useState<Zone[]>([])

  // Latest canvas view transform (device px), lifted so overlays stay aligned.
  const [view, setView] = useState<View | null>(null)

  const [lastEvent, setLastEvent] = useState<string>('')

  // Subscribe to bridge channels once.
  useEffect(() => {
    const offStatus = window.api?.onStatus(setStatus)
    const offFrame = window.api?.onFrame((f) => {
      setFrame(f)
      setTracks(f.tracks)
      setRuntime(f.zones)
    })
    const offZone = window.api?.onZoneEvent((e: ZoneEvent) => {
      setLastEvent(`${e.type === 'enter' ? '→' : '←'} ${e.zone} #${e.id}`)
      console.log('[zone]', e.type, e.zone, 'id', e.id)
    })
    return () => {
      offStatus?.()
      offFrame?.()
      offZone?.()
    }
  }, [])

  // Hydrate config from the main process once.
  useEffect(() => {
    window.api?.getState().then((p) => {
      setPipe(p.pipeline)
      setOsc(p.osc)
      setCalibration(p.calibration)
      setZones(p.zones)
    })
  }, [])

  // --- Handlers: update local state AND push to main ----------------------
  const handlePipe = useCallback((c: PipelineConfig) => {
    setPipe(c)
    window.api?.setPipelineConfig(c)
  }, [])

  const handleOsc = useCallback((c: OscConfig) => {
    setOsc(c)
    window.api?.setOscConfig(c)
  }, [])

  const handleZones = useCallback((next: Zone[]) => {
    setZones(next)
    window.api?.setZones(next)
  }, [])

  const handleCalibration = useCallback((p: CalibrationPoints) => {
    setCalibration(p)
    window.api?.setCalibration(p)
  }, [])

  const handleLearnBackground = useCallback(() => {
    window.api?.learnBackground()
  }, [])

  const handleResetBackground = useCallback(() => {
    window.api?.resetBackground()
  }, [])

  const handleSavePreset = useCallback(() => {
    window.api?.savePreset()
  }, [])

  const handleLoadPreset = useCallback(() => {
    window.api?.loadPreset().then((p) => {
      if (!p) return
      setPipe(p.pipeline)
      setOsc(p.osc)
      setCalibration(p.calibration)
      setZones(p.zones)
    })
  }, [])

  // Keep the latest view in a ref so the toScreen/toWorld closures the overlay
  // gets are always derived from current pan/zoom (rebuilt each render below).
  const viewRef = useRef<View | null>(view)
  viewRef.current = view

  const color = STATE_COLOR[status.state] ?? '#8a93a6'

  // Build CSS-px transforms for the calibration overlay from the device-px view.
  // These fold in the y-flip LidarCanvas applies (screen y = oy - yMm*scale).
  const toScreen = useCallback(
    (xMm: number, yMm: number): [number, number] => {
      const v = viewRef.current
      if (!v) return [0, 0]
      return [(v.ox + xMm * v.scale) / v.dpr, (v.oy - yMm * v.scale) / v.dpr]
    },
    // Rebuild when the view changes so handles track pan/zoom.
    [view]
  )
  const toWorld = useCallback(
    (px: number, py: number): [number, number] => {
      const v = viewRef.current
      if (!v) return [0, 0]
      return [(px * v.dpr - v.ox) / v.scale, (v.oy - py * v.dpr) / v.scale]
    },
    [view]
  )

  return (
    <div className="app">
      <header className="topbar">
        <strong>Slamtec&nbsp;S2E&nbsp;Tracker</strong>
        <span className="pill" style={{ color, borderColor: color }}>
          ● {status.state}
          {status.message ? ` — ${status.message}` : ''}
        </span>

        <div className="seg">
          {(['view', 'calibrate', 'zones'] as Mode[]).map((m) => (
            <button
              key={m}
              className={mode === m ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setMode(m)}
            >
              {m === 'view' ? 'View' : m === 'calibrate' ? 'Calibrate' : 'Zones'}
            </button>
          ))}
        </div>

        <div className="spacer" />
        {lastEvent ? (
          <span className="evt" title="last zone event">
            {lastEvent}
          </span>
        ) : null}
        <label className="field">
          IP
          <input value={ip} onChange={(e) => setIp(e.target.value)} style={{ width: 130 }} />
        </label>
        <label className="field">
          Port
          <input
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 0)}
            style={{ width: 70 }}
          />
        </label>
        <button onClick={() => window.api?.start({ ip, port })}>Start</button>
        <button className="ghost" onClick={() => window.api?.stop()}>
          Stop
        </button>
      </header>

      <div className="body">
        <div className="canvas-wrap">
          <LidarCanvas
            frame={frame}
            calibration={calibration}
            onView={setView}
          />
          {mode === 'calibrate' && view && (
            <CalibrationLayer
              points={calibration}
              onChange={handleCalibration}
              toScreen={toScreen}
              toWorld={toWorld}
              width={view.cssW}
              height={view.cssH}
            />
          )}
        </div>

        {mode === 'zones' && (
          <div className="side-panel">
            <div className="side-title">Event Zones</div>
            <ZoneEditor
              zones={zones}
              tracks={tracks}
              runtime={runtime}
              onChange={handleZones}
            />
          </div>
        )}

        <ControlPanel
          config={pipe}
          onConfig={handlePipe}
          osc={osc}
          onOsc={handleOsc}
          onLearnBackground={handleLearnBackground}
          onResetBackground={handleResetBackground}
          onSavePreset={handleSavePreset}
          onLoadPreset={handleLoadPreset}
          bg={frame?.bg}
          status={
            mode === 'calibrate'
              ? 'Drag the 4 amber handles to map the floor.'
              : status.message
                ? `${status.state}: ${status.message}`
                : status.state
          }
        />
      </div>
    </div>
  )
}
