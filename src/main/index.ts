import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join, resolve } from 'path'
import { Bridge, type RawScan } from './bridge'
import { BackgroundModel } from './pipeline/background'
import { cluster } from './pipeline/cluster'
import { Tracker } from './pipeline/track'
import { ZoneEvaluator } from './pipeline/zones'
import { computeHomography, applyHomography, type Mat3 } from '../shared/homography'
import { OscSender } from './osc'
import { savePreset, loadPreset } from './presets'
import { loadSettings, saveSettings } from './settings'
import { diagnose, probeDevice, configure } from './network'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_PIPELINE_CONFIG,
  DEFAULT_OSC_CONFIG,
  type BridgeConfig,
  type VizFrame,
  type PipelineConfig,
  type OscConfig,
  type CalibrationPoints,
  type Zone,
  type Preset,
  type NetworkConfigureRequest
} from '../shared/types'

// Path to the compiled C++ bridge. In dev, cwd is the project root and
// `npm run bridge` writes bridge/bin/s2e_bridge(.exe). Packaged apps bundle the
// current platform binary under resources/bridge/. An env override wins.
const BRIDGE_EXE = process.platform === 'win32' ? 's2e_bridge.exe' : 's2e_bridge'
const BRIDGE_PATH =
  process.env.S2E_BRIDGE_PATH ||
  (app.isPackaged
    ? join(process.resourcesPath, 'bridge', BRIDGE_EXE)
    : resolve(process.cwd(), 'bridge', 'bin', BRIDGE_EXE))

let win: BrowserWindow | null = null
let bridge: Bridge | null = null
let autoStarted = false

// Effective connection resolved on the last startBridge, reused by the exit hook
// (re-diagnosis) and the on-connect settings persistence.
let lastConfig: { ip: string; port: number } = { ip: '192.168.11.2', port: 8089 }
// Guard so the last-used connection is persisted once per config, not per frame.
let savedFor = ''

const DEG2RAD = Math.PI / 180

// --- Pipeline singletons (constructed once, reused for the app lifetime) ----
const background = new BackgroundModel(720) // ~0.5deg angular resolution
const tracker = new Tracker()
const zoneEval = new ZoneEvaluator()
const oscSender = new OscSender()

// --- Live, user-editable configuration state -------------------------------
let pipelineConfig: PipelineConfig = { ...DEFAULT_PIPELINE_CONFIG }
let oscConfig: OscConfig = { ...DEFAULT_OSC_CONFIG }
let calibration: CalibrationPoints | null = null
let zones: Zone[] = []
let homography: Mat3 | null = null // recomputed only when calibration changes

/** Snapshot the current live state as a persistable Preset. */
function currentPreset(): Preset {
  return {
    calibration,
    zones,
    pipeline: pipelineConfig,
    osc: oscConfig
  }
}

/** Recompute the cached homography from the current calibration (null = none). */
function refreshHomography(): void {
  homography = calibration ? computeHomography(calibration.src) : null
}

/** Apply a loaded Preset to all live state and dependent resources. */
function applyPreset(preset: Preset): void {
  pipelineConfig = { ...preset.pipeline }
  oscConfig = { ...preset.osc }
  calibration = preset.calibration
  zones = preset.zones ?? []
  refreshHomography()
  oscSender.configure(oscConfig)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    backgroundColor: '#0b0e14',
    title: 'Slamtec S2E Tracker',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    if (!autoStarted) {
      autoStarted = true
      startBridge(loadSettings().connection)
    }
  })

  // window.open from the renderer never creates a child window; external
  // targets (e.g. the System Settings network-pane deep link in the network
  // fix panel) are handed to the OS instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|x-apple\.systempreferences):/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Drop the reference once the window is gone so the optional chaining in
  // send() actually short-circuits. Without this, win stays truthy after the
  // window is closed and per-frame IPC keeps targeting a destroyed webContents.
  win.on('closed', () => {
    win = null
  })
}

// Guarded IPC push to the renderer. The bridge can emit an in-flight scan frame
// while the window is mid-teardown (close -> destroyed -> 'closed'), and sending
// to a destroyed webContents throws "Object has been destroyed", surfacing as a
// main-process error dialog on quit. Skip the send when the target is gone.
function send(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

async function startBridge(cfg?: BridgeConfig): Promise<void> {
  if (!bridge) bridge = new Bridge(BRIDGE_PATH)
  bridge.removeAllListeners()

  // Resolve the effective connection: explicit request > last-saved > factory
  // default. The S2E ships on a fixed 192.168.11.2:8089, so the beginner path
  // needs no input at all.
  const saved = loadSettings().connection
  const ip = cfg?.ip ?? saved?.ip ?? '192.168.11.2'
  const port = cfg?.port ?? saved?.port ?? 8089
  lastConfig = { ip, port }
  savedFor = ''

  // Fresh session: drop stale tracks / zone occupancy so ids and enter/exit
  // events do not leak across restarts.
  tracker.reset()
  zoneEval.reset()

  // Preflight: with no host adapter on the target /24 the bridge would only
  // spin in a reconnect loop, so surface a no-network state and never spawn.
  if (!cfg?.skipPreflight) {
    try {
      const diag = await diagnose(ip)
      if (!diag.ok) {
        send(IPC.status, { state: 'no-network', message: `no adapter on ${ip.split('.').slice(0, 3).join('.')}.x` })
        return
      }
    } catch {
      // Diagnosis failure must not block a connect attempt; fall through.
    }
  }

  bridge.on('status', (s) => {
    console.log('[main] bridge:', s.state, s.message ?? '')
    // Persist the last-used connection once we reach a live state for it.
    if ((s.state === 'connected' || s.state === 'scanning') && savedFor !== `${ip}:${port}`) {
      savedFor = `${ip}:${port}`
      saveSettings({ connection: lastConfig })
    }
    send(IPC.status, s)
  })

  // Exit hook: re-diagnose so the UI recovers from an adapter loss (macOS
  // re-plug drops the static IP) vs. an unresponsive device. Codes 3/4 are the
  // "connect failed" / "no response" cases where this distinction matters.
  bridge.on('exit', async (code: number | null) => {
    if (code !== 3 && code !== 4) return
    try {
      const diag = await diagnose(lastConfig.ip)
      if (!diag.ok) {
        send(IPC.status, {
          state: 'no-network',
          message: `adapter lost its ${lastConfig.ip.split('.').slice(0, 3).join('.')}.x address`
        })
        return
      }
      const probe = await probeDevice(lastConfig.ip)
      send(IPC.status, {
        state: 'error',
        message: probe.found
          ? 'device detected on ARP but not answering — power-cycle the sensor'
          : 'adapter OK — device not responding (check cable/power/hub; S2E ignores ping)'
      })
    } catch {
      // Never let re-diagnosis crash main.
    }
  })
  bridge.on('log', (l) => {
    console.log('[main] bridge-log:', l)
    send(IPC.log, l)
  })
  bridge.on('scan', (scan: RawScan) => {
    const n = scan.count

    // Raw point cloud (LiDAR mm), always streamed so the user sees the sweep
    // even while the background is still learning.
    const xy = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      const a = scan.angle[i] * DEG2RAD
      const d = scan.dist[i]
      xy[i * 2] = Math.cos(a) * d
      xy[i * 2 + 1] = Math.sin(a) * d
    }

    // 1. Background learning (no-op unless a learn window is active).
    background.addFrame(scan.angle, scan.dist, n)

    // 2. Foreground extraction (every frame; reads cfg.bgDeltaMm live).
    const fg = background.subtract(scan.angle, scan.dist, n, pipelineConfig)

    // Interleave foreground xy for the renderer overlay.
    const fgXY = new Float32Array(fg.count * 2)
    for (let i = 0; i < fg.count; i++) {
      fgXY[i * 2] = fg.x[i]
      fgXY[i * 2 + 1] = fg.y[i]
    }

    // 3. Cluster -> 4. Track.
    const clusters = cluster(fg, pipelineConfig)
    const tracks = tracker.update(clusters, pipelineConfig)

    // 5. Homography: map each track's LiDAR mm (x,y) -> normalized (u,v).
    // With no calibration, fall back to a simple linear normalization so zones
    // and OSC still receive sane [0,1]-ish values instead of raw millimeters.
    if (homography) {
      for (const t of tracks) {
        const [u, v] = applyHomography(homography, t.x, t.y)
        t.u = Math.max(0, Math.min(1, u))
        t.v = Math.max(0, Math.min(1, v))
      }
    } else {
      // Fallback: center sensor in a nominal 8 m x 8 m field, origin at middle.
      for (const t of tracks) {
        t.u = Math.max(0, Math.min(1, t.x / 8000 + 0.5))
        t.v = Math.max(0, Math.min(1, 0.5 - t.y / 8000))
      }
    }

    // 6. Zone occupancy + enter/exit events.
    const { runtime, events } = zoneEval.evaluate(tracks, zones)

    // 7. OSC out (no-op when disabled / socket not ready).
    oscSender.send(tracks, runtime, events, oscConfig)

    // Forward zone events to the renderer (one message each).
    for (const e of events) send(IPC.zoneEvent, e)

    const frame: VizFrame = {
      seq: scan.seq,
      tMs: scan.tMs,
      count: n,
      xy,
      quality: scan.quality,
      fg: fgXY,
      tracks,
      zones: runtime,
      bg: {
        learning: background.learning,
        progress: background.progress,
        bins: background.coveredBins,
        totalBins: background.totalBins
      }
    }
    if (scan.seq % 30 === 0) {
      console.log(
        `[main] frame #${scan.seq}: ${n} pts, ${fg.count} fg, ${tracks.length} tracks` +
          (background.learning ? ' (learning bg)' : '')
      )
    }
    send(IPC.frame, frame)
  })

  bridge.start(ip, port)
}

app.whenReady().then(() => {
  createWindow()
  oscSender.configure(oscConfig)

  // --- Bridge lifecycle ----------------------------------------------------
  ipcMain.handle(IPC.bridgeStart, (_e, cfg: BridgeConfig | undefined) => {
    startBridge(cfg)
    return true
  })
  ipcMain.handle(IPC.bridgeStop, () => {
    bridge?.stop()
    return true
  })

  // --- Pipeline configuration ----------------------------------------------
  ipcMain.handle(IPC.setPipelineConfig, (_e, cfg: PipelineConfig) => {
    pipelineConfig = cfg
    return true
  })
  ipcMain.handle(IPC.learnBackground, () => {
    background.startLearn(pipelineConfig.bgLearnFrames)
    // Re-learning invalidates current tracks/occupancy.
    tracker.reset()
    zoneEval.reset()
    return true
  })
  ipcMain.handle(IPC.resetBackground, () => {
    background.reset()
    // Dropping the baseline turns the whole scene back into foreground, so the
    // tracks/occupancy built against the old baseline no longer apply.
    tracker.reset()
    zoneEval.reset()
    return true
  })

  // --- Calibration ---------------------------------------------------------
  ipcMain.handle(IPC.setCalibration, (_e, p: CalibrationPoints | null) => {
    calibration = p
    refreshHomography()
    return true
  })

  // --- Zones ---------------------------------------------------------------
  ipcMain.handle(IPC.setZones, (_e, z: Zone[]) => {
    zones = z ?? []
    return true
  })

  // --- OSC -----------------------------------------------------------------
  ipcMain.handle(IPC.setOscConfig, (_e, cfg: OscConfig) => {
    oscConfig = cfg
    oscSender.configure(cfg)
    return true
  })

  // --- Presets -------------------------------------------------------------
  ipcMain.handle(IPC.savePreset, async () => {
    return savePreset(win, currentPreset())
  })
  ipcMain.handle(IPC.loadPreset, async () => {
    const preset = await loadPreset(win)
    if (preset) applyPreset(preset)
    return preset
  })
  ipcMain.handle(IPC.getState, () => {
    return currentPreset()
  })

  // --- Network diagnosis / device probe / adapter configuration ------------
  ipcMain.handle(IPC.networkDiagnose, (_e, targetIp: string) => diagnose(targetIp))
  ipcMain.handle(IPC.networkProbe, (_e, targetIp: string) => probeDevice(targetIp))
  ipcMain.handle(IPC.networkConfigure, (_e, req: NetworkConfigureRequest) => configure(req))
  ipcMain.handle(IPC.getConnection, () => loadSettings().connection ?? null)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  bridge?.stop()
  oscSender.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  bridge?.stop()
  oscSender.close()
})
