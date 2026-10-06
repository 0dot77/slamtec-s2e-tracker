import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BridgeStatus, CalibrationPoints, OscConfig, PipelineConfig, Preset, VizFrame, Zone } from '@shared/types'
import { DEFAULT_OSC_CONFIG, DEFAULT_PIPELINE_CONFIG } from '@shared/types'
import { applyHomography, applyHomographyStrict, computeHomographyChecked, invertMat3, validateQuad } from '@shared/homography'
import LidarCanvas, { type View } from './components/LidarCanvas'
import CalibrationLayer from './components/CalibrationLayer'
import ZoneOverlay from './components/ZoneOverlay'
import ZoneEditor from './components/ZoneEditor'
import WallView from './components/WallView'
import ControlPanel from './components/ControlPanel'
import NetworkFixPanel from './components/NetworkFixPanel'
import { createFrameStore } from './lib/frameStore'
import { useFrameHud } from './lib/useFrameHud'
import { clampZonePolygon, seedZoneNames } from './lib/zones'

const STATE_COLOR: Record<string, string> = {
  idle: '#8a93a6', connecting: '#e0b341', connected: '#37a0d4', scanning: '#3ad48c',
  error: '#ff5d5d', stopped: '#8a93a6', 'no-network': '#e0b341'
}
const LIVE_STATES = new Set(['connecting', 'connected', 'scanning'])
type Mode = 'view' | 'calibrate' | 'zones'
type MainView = 'lidar' | 'wall'

export default function App(): JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>({ state: 'idle' })
  const [ip, setIp] = useState('192.168.11.2')
  const [port, setPort] = useState(8089)
  const [dirty, setDirty] = useState(false)
  const [showNetFix, setShowNetFix] = useState(false)
  const [deviceHint, setDeviceHint] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('view')
  const [mainView, setMainView] = useState<MainView>('lidar')
  const [pipe, setPipe] = useState<PipelineConfig>(DEFAULT_PIPELINE_CONFIG)
  const [osc, setOsc] = useState<OscConfig>(DEFAULT_OSC_CONFIG)
  const [calibration, setCalibration] = useState<CalibrationPoints | null>(null)
  const [draft, setDraft] = useState<CalibrationPoints | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [hydrated, setHydrated] = useState(false)
  const hydratedRef = useRef(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<View | null>(null)
  const lastEventRef = useRef('')
  const [frames] = useState(createFrameStore)
  const latestFrameRef = useRef<VizFrame | null>(null)
  const hud = useFrameHud(frames)
  const mounted = useRef(false)
  const probedFor = useRef('')
  const connectionRef = useRef({ ip, port, dirty })
  connectionRef.current = { ip, port, dirty }

  const adoptState = useCallback((preset: Preset): void => {
    // Incoming installation state is authoritative. Hydration never invokes setters.
    setPipe(preset.pipeline); setOsc(preset.osc); setCalibration(preset.calibration); setZones(preset.zones)
    seedZoneNames(preset.zones)
    hydratedRef.current = true; setHydrated(true)
  }, [])
  const report = useCallback((promise: Promise<unknown>, action: string): void => {
    void promise.then((ok) => {
      if (mounted.current && ok === false) setError(`${action} was rejected.`)
    }).catch((cause: unknown) => {
      if (mounted.current) setError(`${action}: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  }, [])
  useEffect(() => {
    mounted.current = true
    let active = true
    let stateGeneration = 0
    const offState = window.api.onState((preset) => {
      stateGeneration += 1
      adoptState(preset)
    })
    const requestedGeneration = stateGeneration
    void window.api.getState().then((preset) => {
      // A pushed restore/replacement arriving during the request wins the race.
      if (active && stateGeneration === requestedGeneration) adoptState(preset)
    }).catch((cause: unknown) => {
      if (active && !hydratedRef.current) setError(`Could not restore installation: ${String(cause)}`)
    })
    void window.api.getConnection().then((connection) => {
      if (!active || !connection || connectionRef.current.dirty) return
      setIp(connection.ip); setPort(connection.port)
    }).catch(() => {})
    const offFrame = window.api.onFrame((frame) => {
      latestFrameRef.current = frame
      frames.setFrame(frame)
    })
    const offStatus = window.api.onStatus((next) => {
      setStatus(next)
      if (next.state === 'no-network') setShowNetFix(true)
      if (next.state === 'connected' || next.state === 'scanning') {
        setShowNetFix(false); setDeviceHint(null); probedFor.current = ''
        void window.api.getConnection().then((connection) => {
          if (!active || !connection) return
          setIp(connection.ip); setPort(connection.port); setDirty(false)
        }).catch(() => {})
      }
    })
    const offZone = window.api.onZoneEvent((event) => {
      lastEventRef.current = `${event.type === 'enter' ? '→' : '←'} ${event.zone} #${event.id}`
    })
    const offClear = frames.subscribe(() => { latestFrameRef.current = frames.getFrame() })
    return () => {
      active = false; mounted.current = false
      offState(); offFrame(); offStatus(); offZone(); offClear()
      void window.api.setCalibrating(false).catch(() => {})
    }
  }, [adoptState, frames])
  useEffect(() => {
    if (status.state !== 'error' && status.state !== 'connecting') return
    if (probedFor.current === status.state) return
    probedFor.current = status.state
    let active = true
    void window.api.probeDevice(ip).then((probe) => {
      if (active) setDeviceHint(probe.found ? 'device detected (ARP)' : 'device not detected')
    }).catch(() => {})
    return () => { active = false }
  }, [status.state, ip])

  const handlePipe = useCallback((config: PipelineConfig): void => {
    if (!hydratedRef.current) return
    setPipe(config); report(window.api.setPipelineConfig(config), 'Pipeline update')
  }, [report])
  const handleOsc = useCallback((config: OscConfig): void => {
    if (!hydratedRef.current) return
    setOsc(config); report(window.api.setOscConfig(config), 'OSC update')
  }, [report])
  const handleZones = useCallback((next: Zone[]): void => {
    if (!hydratedRef.current) return
    const clamped = next.map((zone) => ({ ...zone, polygon: clampZonePolygon(zone.polygon) }))
    seedZoneNames(clamped); setZones(clamped); report(window.api.setZones(clamped), 'Area update')
  }, [report])
  const handleConnect = useCallback((): void => {
    const connection = connectionRef.current
    report(window.api.start(connection.dirty ? { ip: connection.ip, port: connection.port } : undefined), 'Connect')
  }, [report])
  const handleDisconnect = useCallback((): void => {
    report(window.api.stop(), 'Disconnect')
    setShowNetFix(false); setDeviceHint(null); probedFor.current = ''
    latestFrameRef.current = null; frames.setFrame(null)
  }, [report, frames])
  const handleLoad = useCallback((): void => {
    void window.api.loadPreset().then((preset) => {
      if (mounted.current && preset) { adoptState(preset); setMode('view'); setDraft(null) }
    }).catch((cause: unknown) => { if (mounted.current) setError(`Load preset: ${String(cause)}`) })
  }, [adoptState])
  const viewRef = useRef(view)
  viewRef.current = view
  const toScreen = useCallback((x: number, y: number): [number, number] => {
    const current = viewRef.current
    return current ? [(current.ox + x * current.scale) / current.dpr, (current.oy - y * current.scale) / current.dpr] : [0, 0]
  }, [view])
  const toWorld = useCallback((x: number, y: number): [number, number] => {
    const current = viewRef.current
    return current ? [(x * current.dpr - current.ox) / current.scale, (current.oy - y * current.dpr) / current.scale] : [0, 0]
  }, [view])
  const homography = useMemo(() => computeHomographyChecked(calibration?.src), [calibration])
  const inverse = useMemo(() => homography ? invertMat3(homography) : null, [homography])
  const normToScreen = useCallback((u: number, v: number): [number, number] | null => {
    if (!inverse) return null
    const point = applyHomography(inverse, u, v)
    return point.every(Number.isFinite) ? toScreen(...point) : null
  }, [inverse, toScreen])
  const screenToNorm = useCallback((x: number, y: number): [number, number] | null => {
    if (!homography) return null
    const point = applyHomographyStrict(homography, ...toWorld(x, y))
    return point.every(Number.isFinite) ? point : null
  }, [homography, toWorld])
  const selectMode = (next: Mode): void => {
    if (!hydrated) return
    if (next === 'calibrate') {
      setMainView('lidar')
      if (mode !== 'calibrate') {
        const current = viewRef.current
        const points = calibration ?? (current ? { src: [
          toWorld(current.cssW * 0.2, current.cssH * 0.25), toWorld(current.cssW * 0.8, current.cssH * 0.25),
          toWorld(current.cssW * 0.8, current.cssH * 0.75), toWorld(current.cssW * 0.2, current.cssH * 0.75)
        ] as CalibrationPoints['src'] } : { src: [[-2000, 1000], [2000, 1000], [2000, -1000], [-2000, -1000]] as CalibrationPoints['src'] })
        setDraft({ src: points.src.map((point) => [...point]) as CalibrationPoints['src'] })
      }
    }
    setMode(next)
  }
  const applyCalibration = useCallback(async (points: CalibrationPoints): Promise<void> => {
    const reason = validateQuad(points.src)
    if (reason) throw new Error(reason)
    if (!await window.api.setCalibration(points)) throw new Error('Calibration was rejected.')
    if (!await window.api.setCalibrating(false)) throw new Error('Could not finish calibration capture.')
    if (mounted.current) { setCalibration(points); setDraft(null); setMode('view') }
  }, [])
  const color = STATE_COLOR[status.state] ?? '#8a93a6'
  const lastEvent = lastEventRef.current
  return <div className="app">
    <header className="topbar">
      <strong>Slamtec S2E Tracker</strong>
      <span className="pill" style={{ color, borderColor: color }} title={status.message}>● {status.state}</span>
      {deviceHint && <span className="dev-hint">{deviceHint}</span>}
      <div className="seg">{(['view', 'calibrate', 'zones'] as Mode[]).map((item) =>
        <button key={item} disabled={!hydrated} className={`seg-btn${mode === item ? ' active' : ''}`} onClick={() => selectMode(item)}>
          {item === 'view' ? 'View' : item === 'calibrate' ? 'Calibrate' : 'Touch areas'}
        </button>)}</div>
      <div className="spacer" />
      {lastEvent && <span className="evt" title="Last zone event">{lastEvent}</span>}
      <button className={LIVE_STATES.has(status.state) ? 'ghost' : ''} onClick={LIVE_STATES.has(status.state) ? handleDisconnect : handleConnect}>
        {LIVE_STATES.has(status.state) ? 'Disconnect' : 'Connect'}
      </button>
      <details className="advanced"><summary>Advanced</summary><div className="advanced-body">
        <label className="field">IP<input value={ip} onChange={(e) => { setIp(e.target.value); setDirty(true) }} style={{ width: 130 }} /></label>
        <label className="field">Port<input type="number" min={1} max={65535} value={port} onChange={(e) => {
          const number = Number(e.target.value)
          if (Number.isInteger(number)) setPort(Math.min(65535, Math.max(1, number)))
          setDirty(true)
        }} style={{ width: 75 }} /></label>
      </div></details>
    </header>
    {error && <div className="app-error" role="alert">{error}<button className="net-x" onClick={() => setError('')}>×</button></div>}
    {showNetFix && <NetworkFixPanel targetIp={ip} onFixed={handleConnect}
      onStartAnyway={() => report(window.api.start({ ip, port, skipPreflight: true }), 'Connect')}
      onDismiss={() => setShowNetFix(false)} />}
    <div className="body">
      <div className="main-view">
        <div className="view-tabs">
          {(['lidar', 'wall'] as MainView[]).map((tab) => <button key={tab} className={`seg-btn${mainView === tab ? ' active' : ''}`}
            onClick={() => { if (tab === 'wall' && mode === 'calibrate') { setMode('view'); setDraft(null) } setMainView(tab) }}>
            {tab === 'lidar' ? 'LiDAR' : 'Wall'}
          </button>)}
          {!hydrated && <span className="muted">Restoring installation…</span>}
          <div className="spacer" />
          <span className={`view-status${hud.stale ? ' stale' : ''}`}>{hud.stale ? 'stale · ' : ''}{hud.hz.toFixed(1)} Hz · {hud.procMs.toFixed(1)} ms · {hud.count} pts · #{hud.seq ?? '—'}</span>
        </div>
        <div className="canvas-wrap">
          {mainView === 'lidar' ? <>
            <LidarCanvas frameSource={frames} calibration={calibration} config={pipe} zones={zones} homographyInv={inverse} onView={setView} />
            <div className="hud"><span className="muted">scroll = zoom · drag = pan · shaded = excluded</span></div>
            {mode === 'calibrate' && draft && view && <CalibrationLayer points={draft} onChange={setDraft}
              onApply={applyCalibration} onCancel={() => { setDraft(null); setMode('view') }} frameSource={frames}
              toScreen={toScreen} toWorld={toWorld} width={view.cssW} height={view.cssH} />}
            {mode === 'zones' && view && <ZoneOverlay width={view.cssW} height={view.cssH} zones={zones} runtime={hud.zones}
              calibrated={!!homography} normToScreen={normToScreen} screenToNorm={screenToNorm} onChange={handleZones} />}
          </> : <WallView frameSource={frames} zones={zones} runtime={hud.zones} onChange={handleZones}
            editing={mode === 'zones' && hydrated} calibrated={!!homography} />}
        </div>
      </div>
      {mode === 'zones' && <div className="side-panel"><div className="side-title">Touch areas</div>
        <ZoneEditor zones={zones} runtime={hud.zones} oscPrefix={osc.addrPrefix} onChange={handleZones} />
      </div>}
      <ControlPanel config={pipe} onConfig={handlePipe} osc={osc} onOsc={handleOsc}
        onLearnBackground={() => report(window.api.learnBackground(), 'Learn background')}
        onResetBackground={() => report(window.api.resetBackground(), 'Reset background')}
        onSavePreset={() => report(window.api.savePreset(), 'Save preset')} onLoadPreset={handleLoad}
        hud={hud} disabled={!hydrated} status={status.message} />
    </div>
  </div>
}
