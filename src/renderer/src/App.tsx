import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BridgeStatus,
  CalibrationPoints,
  OscConfig,
  PipelineConfig,
  VizFrame,
  Zone,
  ZoneEvent,
  ZoneRuntime
} from '@shared/types'
import { DEFAULT_OSC_CONFIG, DEFAULT_PIPELINE_CONFIG } from '@shared/types'
import { applyHomography, computeHomography, invertMat3 } from '@shared/homography'
import LidarCanvas, { type View } from './components/LidarCanvas'
import CalibrationLayer from './components/CalibrationLayer'
import ZoneOverlay from './components/ZoneOverlay'
import ZoneEditor from './components/ZoneEditor'
import ControlPanel from './components/ControlPanel'
import NetworkFixPanel from './components/NetworkFixPanel'

const STATE_COLOR: Record<string, string> = {
  idle: '#8a93a6',
  connecting: '#e0b341',
  connected: '#37a0d4',
  scanning: '#3ad48c',
  error: '#ff5d5d',
  stopped: '#8a93a6',
  // Preflight found no adapter on the target subnet — amber, matches the banner.
  'no-network': '#e0b341'
}

// States where a bridge is running (or trying to). Drives the Connect toggle.
const LIVE_STATES = new Set(['connecting', 'connected', 'scanning'])

type Mode = 'view' | 'calibrate' | 'zones'

export default function App(): JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>({ state: 'idle' })
  const [ip, setIp] = useState('192.168.11.2')
  const [port, setPort] = useState(8089)
  // The user edited an Advanced field — only then do we pass an explicit config.
  const [dirty, setDirty] = useState(false)
  // Show the network fix banner while preflight reports no adapter.
  const [showNetFix, setShowNetFix] = useState(false)
  // Unobtrusive ARP-based hint near the status pill: null hides it.
  const [deviceHint, setDeviceHint] = useState<string | null>(null)

  const [mode, setMode] = useState<Mode>('view')

  // Per-frame data (latest VizFrame, split for the consumers that need it).
  const [frame, setFrame] = useState<VizFrame | null>(null)
  const [runtime, setRuntime] = useState<ZoneRuntime[]>([])

  // Authoring / config state (source of truth in the renderer, mirrored to main).
  const [pipe, setPipe] = useState<PipelineConfig>(DEFAULT_PIPELINE_CONFIG)
  const [osc, setOsc] = useState<OscConfig>(DEFAULT_OSC_CONFIG)
  const [calibration, setCalibration] = useState<CalibrationPoints | null>(null)
  const [zones, setZones] = useState<Zone[]>([])

  // Latest canvas view transform (device px), lifted so overlays stay aligned.
  const [view, setView] = useState<View | null>(null)

  const [lastEvent, setLastEvent] = useState<string>('')

  // Guard so the device probe fires at most once per error/connecting episode.
  const probedFor = useRef<string>('')

  // Subscribe to bridge channels once.
  useEffect(() => {
    const offStatus = window.api?.onStatus((s) => {
      setStatus(s)
      if (s.state === 'no-network') setShowNetFix(true)
      if (s.state === 'connected' || s.state === 'scanning') {
        setShowNetFix(false)
        setDeviceHint(null)
        probedFor.current = ''
        window.api?.getConnection().then((c) => {
          if (!c) return
          setIp(c.ip)
          setPort(c.port)
          setDirty(false)
        })
      }
    })
    const offFrame = window.api?.onFrame((f) => {
      setFrame(f)
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
    // Restore the last-used connection into the Advanced fields (defaults if none).
    window.api?.getConnection().then((c) => {
      if (!c) return
      setIp(c.ip)
      setPort(c.port)
    })
  }, [])

  // On a transient error / connecting state, probe ARP once for a presence hint.
  // Guarded per-episode so this never becomes a polling loop.
  useEffect(() => {
    if (status.state !== 'error' && status.state !== 'connecting') return
    if (probedFor.current === status.state) return
    probedFor.current = status.state
    window.api?.probeDevice(ip).then((r) => {
      if (!r) return
      setDeviceHint(r.found ? 'device detected (ARP)' : 'device not detected')
    })
  }, [status.state, ip])

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

  // Connect with no args when untouched (main resolves saved/default config);
  // pass the explicit override only once the user has edited an Advanced field.
  const handleConnect = useCallback(() => {
    if (dirty) window.api?.start({ ip, port })
    else window.api?.start()
  }, [dirty, ip, port])

  const handleDisconnect = useCallback(() => {
    window.api?.stop()
    setShowNetFix(false)
    setDeviceHint(null)
    probedFor.current = ''
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

  // Homography mapping LiDAR mm -> normalized [0,1] (and its inverse). Recomputed
  // only when calibration changes; null until the floor is calibrated.
  const homography = useMemo(
    () => (calibration ? computeHomography(calibration.src) : null),
    [calibration]
  )
  const homographyInv = useMemo(() => (homography ? invertMat3(homography) : null), [homography])

  // Bridge normalized zone space and CSS px through the current pan/zoom + calib.
  // Both return null when there is no calibration to anchor the unit square.
  const normToScreen = useCallback(
    (u: number, v: number): [number, number] | null => {
      if (!homographyInv) return null
      const [x, y] = applyHomography(homographyInv, u, v)
      return toScreen(x, y)
    },
    [homographyInv, toScreen]
  )
  const screenToNorm = useCallback(
    (px: number, py: number): [number, number] | null => {
      if (!homography) return null
      const [x, y] = toWorld(px, py)
      return applyHomography(homography, x, y)
    },
    [homography, toWorld]
  )

  return (
    <div className="app">
      <header className="topbar">
        <strong>Slamtec&nbsp;S2E&nbsp;Tracker</strong>
        <span className="pill" style={{ color, borderColor: color }}>
          ● {status.state}
          {status.message ? ` — ${status.message}` : ''}
        </span>
        {deviceHint ? <span className="dev-hint">{deviceHint}</span> : null}

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
        {LIVE_STATES.has(status.state) ? (
          <button className="ghost" onClick={handleDisconnect}>
            Disconnect
          </button>
        ) : (
          <button onClick={handleConnect}>Connect</button>
        )}

        <details className="advanced">
          <summary title="Override the S2E address (rarely needed)">Advanced</summary>
          <div className="advanced-body">
            <label className="field">
              IP
              <input
                value={ip}
                onChange={(e) => {
                  setIp(e.target.value)
                  setDirty(true)
                }}
                style={{ width: 130 }}
              />
            </label>
            <label className="field">
              Port
              <input
                value={port}
                onChange={(e) => {
                  setPort(Number(e.target.value) || 0)
                  setDirty(true)
                }}
                style={{ width: 70 }}
              />
            </label>
          </div>
        </details>
      </header>

      {showNetFix && (
        <NetworkFixPanel
          targetIp={ip}
          onFixed={handleConnect}
          onStartAnyway={() => window.api?.start({ ip, port, skipPreflight: true })}
          onDismiss={() => setShowNetFix(false)}
        />
      )}

      <div className="body">
        <div className="canvas-wrap">
          <LidarCanvas
            frame={frame}
            calibration={calibration}
            onView={setView}
            zones={zones}
            runtime={runtime}
            homographyInv={homographyInv}
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
          {mode === 'zones' && view && (
            <ZoneOverlay
              width={view.cssW}
              height={view.cssH}
              zones={zones}
              runtime={runtime}
              calibrated={!!calibration}
              normToScreen={normToScreen}
              screenToNorm={screenToNorm}
              onChange={handleZones}
            />
          )}
        </div>

        {mode === 'zones' && (
          <div className="side-panel">
            <div className="side-title">Event Zones</div>
            <ZoneEditor zones={zones} runtime={runtime} onChange={handleZones} />
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
