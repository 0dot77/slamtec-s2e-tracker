import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
import { Bridge, type RawScan } from './bridge'
import { BackgroundModel } from './pipeline/background'
import { cluster } from './pipeline/cluster'
import { Tracker } from './pipeline/track'
import { ZoneEvaluator } from './pipeline/zones'
import { computeHomography, applyHomography, type Mat3 } from './pipeline/homography'
import { OscSender } from './osc'
import { savePreset, loadPreset } from './presets'
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
  type Preset
} from '../shared/types'

// Path to the compiled C++ bridge. In dev, cwd is the project root; in a
// packaged .app the binary is bundled via electron-builder extraResources at
// Contents/Resources/bridge/s2e_bridge. An env override wins for either.
const BRIDGE_PATH =
  process.env.S2E_BRIDGE_PATH ||
  (app.isPackaged
    ? join(process.resourcesPath, 'bridge', 's2e_bridge')
    : resolve(process.cwd(), 'bridge/s2e_bridge'))

let win: BrowserWindow | null = null
let bridge: Bridge | null = null
let autoStarted = false

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
      startBridge()
    }
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

function startBridge(cfg?: BridgeConfig): void {
  if (!bridge) bridge = new Bridge(BRIDGE_PATH)
  bridge.removeAllListeners()

  // Fresh session: drop stale tracks / zone occupancy so ids and enter/exit
  // events do not leak across restarts.
  tracker.reset()
  zoneEval.reset()

  bridge.on('status', (s) => {
    console.log('[main] bridge:', s.state, s.message ?? '')
    send(IPC.status, s)
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
      zones: runtime
    }
    if (scan.seq % 30 === 0) {
      console.log(
        `[main] frame #${scan.seq}: ${n} pts, ${fg.count} fg, ${tracks.length} tracks` +
          (background.learning ? ' (learning bg)' : '')
      )
    }
    send(IPC.frame, frame)
  })

  bridge.start(cfg?.ip, cfg?.port)
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
