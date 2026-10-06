import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, shell } from 'electron'
import { randomInt } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Bridge, type RawScan } from './bridge'
import { BackgroundModel } from './pipeline/background'
import { cluster } from './pipeline/cluster'
import { Tracker } from './pipeline/track'
import { ZoneEvaluator } from './pipeline/zones'
import { applyHomographyStrict, computeHomographyChecked, type Mat3 } from '../shared/homography'
import { OscSender } from './osc'
import { TouchManager, type TouchEvent } from './touch'
import { savePreset, loadPreset } from './presets'
import {
  flushInstallation, invalidateBackground, loadBackground, loadInstallation, loadSettings,
  saveBackground, saveInstallation, saveSettings
} from './settings'
import { sanitizeCalibration, sanitizeOsc, sanitizePipeline, sanitizePreset, sanitizeTarget, sanitizeZones } from './validate'
import { diagnose, probeDevice, configure } from './network'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_PRESET,
  type BridgeConfig, type BridgeStatus, type CalibrationPoints, type ConnectionSettings,
  type NetworkConfigureRequest, type OscConfig, type PipelineConfig, type Preset,
  type ReadyReason, type VizFrame, type Zone, type ZoneRuntime
} from '../shared/types'

const BRIDGE_EXE = process.platform === 'win32' ? 's2e_bridge.exe' : 's2e_bridge'
const BRIDGE_PATH = process.env.S2E_BRIDGE_PATH || (app.isPackaged
  ? join(process.resourcesPath, 'bridge', BRIDGE_EXE)
  : resolve(process.cwd(), 'bridge', 'bin', BRIDGE_EXE))
const RENDERER_FILE = join(__dirname, '../renderer/index.html')
const APP_URL = process.env.ELECTRON_RENDERER_URL || pathToFileURL(RENDERER_FILE).href
const DEFAULT_TARGET: ConnectionSettings = { ip: '192.168.11.2', port: 8089 }
const DEG2RAD = Math.PI / 180

let win: BrowserWindow | null = null
let autoStarted = false
let quitting = false
let ownsInstance = false
let sleepBlocker: number | undefined
let watchdog: ReturnType<typeof setInterval> | undefined

const bridge = new Bridge(BRIDGE_PATH)
const background = new BackgroundModel(2880)
const tracker = new Tracker()
const zoneEval = new ZoneEvaluator()
let touchManager = new TouchManager()
const oscSender = new OscSender(log)

let pipelineConfig: PipelineConfig = { ...DEFAULT_PRESET.pipeline }
let oscConfig: OscConfig = { ...DEFAULT_PRESET.osc }
let calibration: CalibrationPoints | null = null
let zones: Zone[] = []
let homography: Mat3 | null = null
let calibrating = false
let lastConfig: ConnectionSettings = { ...DEFAULT_TARGET }
let lastTarget: BridgeConfig = { ...DEFAULT_TARGET }
let backgroundSensor = ''
let savedFor = ''
let startGeneration = 0
let desiredRunning = false
// Ignore the old child's tail during stop or an awaited preflight.
let acceptingScans = false
let scansLive = false
let sawScan = false
let stalled = false
let lastScanAt = 0
let lastOscFrameAt = -Infinity
let lastVizAt = -Infinity
// A renderer-thread round trip bounds pending visualization IPC to one frame.
// It needs no preload/API change and never gates scan processing or OSC.
let vizProbe: object | null = null
let session = newSession()
let frameSeq = 0
let lastStatus: BridgeStatus = { state: 'idle' }

function newSession(): number { return randomInt(1, 0x80000000) }

function send(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function log(line: string): void {
  console.log(line)
  send(IPC.log, line)
}

function status(next: BridgeStatus): void {
  lastStatus = next
  send(IPC.status, next)
}

function currentPreset(): Preset {
  return { calibration, zones, pipeline: pipelineConfig, osc: oscConfig }
}

function persistState(): void {
  const preset = currentPreset()
  saveInstallation(preset)
  send(IPC.state, preset)
}

function emptyZones(): ZoneRuntime[] {
  return zones.map((z) => ({ ...z, active: false, occupants: [] }))
}

function sendTouches(touches: TouchEvent[], ready: boolean): number {
  frameSeq = (frameSeq + 1) & 0x7fffffff
  oscSender.sendTouchFrame({ session, seq: frameSeq, ready, touches, alive: touchManager.aliveIds() }, oscConfig, zones)
  lastOscFrameAt = performance.now()
  return frameSeq
}

/** Deliver cancels and exits before forgetting the previous state. */
function clearOutput(): void {
  sendTouches(touchManager.cancelAll(), false)
  const exits = zoneEval.drain()
  for (const event of exits) send(IPC.zoneEvent, event)
  // The old complete zone list lets deleted/renamed areas receive exits.
  oscSender.sendSlots([], emptyZones(), exits, oscConfig)
  tracker.reset()
}

function applyPreset(raw: unknown, persist = true): Preset | null {
  const preset = sanitizePreset(raw)
  if (!preset) return null
  if (persist) clearOutput()
  pipelineConfig = preset.pipeline
  oscConfig = preset.osc
  calibration = preset.calibration
  zones = preset.zones
  homography = computeHomographyChecked(calibration?.src)
  touchManager.setZones(zones)
  oscSender.configure(oscConfig)
  if (persist) persistState()
  return currentPreset()
}

function restoreBackground(target: ConnectionSettings): void {
  const key = `${target.ip}:${target.port}`
  if (backgroundSensor === key) return
  backgroundSensor = key
  background.reset()
  const snapshot = loadBackground(key)
  if (snapshot && background.restore(snapshot)) log(`[main] restored background for ${key}`)
}

function learnBackground(): boolean {
  if (!invalidateBackground()) return false
  clearOutput()
  background.startLearn(pipelineConfig.bgLearnFrames, pipelineConfig.bgMinReturnRatio)
  log(`[main] learning background: ${pipelineConfig.bgLearnFrames} frames (${backgroundSensor})`)
  return true
}

function readiness(): ReadyReason {
  if (calibrating) return 'calibrating'
  if (background.learning) return 'learning'
  if (!background.ready) return 'no-background'
  if (!calibration) return 'no-calibration'
  if (!homography) return 'bad-calibration'
  return 'ok'
}

function processScan(scan: RawScan): void {
  if (!desiredRunning || !acceptingScans || quitting) return
  const t0 = performance.now()
  lastScanAt = t0
  sawScan = true
  scansLive = true
  if (stalled) {
    stalled = false
    status({ state: 'scanning', message: 'scan resumed' })
  }
  // A reset while scanning should recover without requiring a reconnect.
  if (!background.ready && !background.learning) learnBackground()
  const learning = background.learning
  background.addFrame(scan.angle, scan.dist, scan.count)
  if (learning && !background.learning) {
    const snapshot = background.snapshot()
    if (snapshot) saveBackground(backgroundSensor, snapshot)
    log(`[main] background learned: ${background.coveredBins}/${background.totalBins} bins`)
  }
  const fg = background.subtract(scan.angle, scan.dist, scan.quality, scan.count, pipelineConfig, {
    roi: calibrating ? null : homography,
    roiMargin: pipelineConfig.roiMargin
  })
  const tracks = tracker.update(cluster(fg, pipelineConfig), pipelineConfig).filter((t) => {
    if (homography && !calibrating) {
      const [u, v] = applyHomographyStrict(homography, t.x, t.y)
      if (!Number.isFinite(u) || !Number.isFinite(v)) return false
      // Preserve outside coordinates so leaving the wall ends the touch.
      t.u = u
      t.v = v
    } else {
      // Capture must retain raw x/y tracks even beyond the old map's horizon.
      // Use the 8 m preview mapping until the new calibration is installed.
      t.u = Math.max(0, Math.min(1, t.x / 8000 + 0.5))
      t.v = Math.max(0, Math.min(1, 0.5 - t.y / 8000))
    }
    return true
  })
  const readyReason = readiness()
  const ready = readyReason === 'ok'
  const touchAllowed = ready || (!oscConfig.requireReady && !calibrating && !background.learning)
  const { runtime, events } = zoneEval.evaluate(tracks, zones)
  // Preview coordinates are never advertised as calibrated wall touches.
  const touches = touchManager.update(homography ? tracks : [], touchAllowed)
  const seq = sendTouches(touches, ready)
  oscSender.sendSlots(tracks, runtime, events, oscConfig)
  for (const event of events) send(IPC.zoneEvent, event)

  // OSC and zone events always run; throttle only the large preview payload.
  if (vizProbe || t0 - lastVizAt < 30 || !win || win.isDestroyed() || win.webContents.isDestroyed() ||
    win.webContents.isLoadingMainFrame()) return
  lastVizAt = t0
  const xy = new Float32Array(scan.count * 2)
  for (let i = 0; i < scan.count; i++) {
    const angle = scan.angle[i] * DEG2RAD
    xy[i * 2] = Math.cos(angle) * scan.dist[i]
    xy[i * 2 + 1] = Math.sin(angle) * scan.dist[i]
  }
  // subtract() returns scratch views; copy them before the next scan arrives.
  const fgXY = new Float32Array(fg.count * 2)
  for (let i = 0; i < fg.count; i++) {
    fgXY[i * 2] = fg.x[i]
    fgXY[i * 2 + 1] = fg.y[i]
  }
  const frame: VizFrame = {
    seq, tMs: scan.tMs, count: scan.count, xy, quality: scan.quality, fg: fgXY, tracks, zones: runtime,
    bg: {
      learning: background.learning, progress: background.progress,
      bins: background.coveredBins, totalBins: background.totalBins, ready: background.ready
    },
    ready, readyReason, procMs: performance.now() - t0
  }
  const contents = win.webContents
  const probe = {}
  vizProbe = probe
  try {
    contents.send(IPC.frame, frame)
    void contents.executeJavaScript('void 0').then(() => {
      if (vizProbe === probe) vizProbe = null
    }, () => {
      if (vizProbe === probe) vizProbe = null
    })
  } catch (err) {
    if (vizProbe === probe) vizProbe = null
    log(`[main] preview send failed: ${(err as Error).message}`)
  }
}

function attachBridgeListeners(): void {
  bridge.on('scan', processScan)
  bridge.on('log', (line: string) => log(`[main] bridge: ${line}`))
  bridge.on('status', (next: BridgeStatus) => {
    log(`[main] bridge: ${next.state} ${next.message ?? ''}`)
    if (!desiredRunning || !acceptingScans || quitting) return
    if (next.state === 'scanning') {
      clearOutput()
      session = newSession()
      touchManager = new TouchManager()
      touchManager.setZones(zones)
      stalled = false
      sawScan = false
      scansLive = false
      lastScanAt = 0
      lastVizAt = -Infinity
      sendTouches([], false)
      if (!background.ready && !background.learning) learnBackground()
    } else if (next.state === 'connecting' || next.state === 'stopped' || next.state === 'error') {
      if (scansLive || touchManager.count) clearOutput()
      scansLive = false
      // A reconnect has not seen a scan from its new child yet.
      if (next.state === 'connecting' || next.state === 'stopped') {
        sawScan = false
        stalled = false
      }
    }
    if ((next.state === 'connected' || next.state === 'scanning') && savedFor !== `${lastConfig.ip}:${lastConfig.port}`) {
      savedFor = `${lastConfig.ip}:${lastConfig.port}`
      saveSettings({ connection: { ...lastConfig } })
    }
    status(next)
  })
  bridge.on('exit', (code: number | null) => {
    if (!desiredRunning || !acceptingScans || quitting) return
    clearOutput()
    scansLive = false
    sawScan = false
    stalled = false
    if (code === 3 || code === 4) void diagnoseExit(startGeneration, session, { ...lastConfig })
  })
}

async function diagnoseExit(generation: number, oldSession: number, target: ConnectionSettings): Promise<void> {
  const current = (): boolean => generation === startGeneration && oldSession === session && desiredRunning && !scansLive && !quitting
  try {
    const diagnosis = await diagnose(target.ip)
    if (!current()) return
    if (!diagnosis.ok) {
      status({ state: 'no-network', message: `adapter lost its ${target.ip.split('.').slice(0, 3).join('.')}.x address` })
      return
    }
    const probe = await probeDevice(target.ip)
    if (!current()) return
    status({ state: 'error', message: probe.found
      ? 'device detected on ARP but not answering — power-cycle the sensor'
      : 'adapter OK — device not responding (check cable/power/hub; S2E ignores ping)' })
  } catch (err) {
    if (current()) log(`[main] exit diagnosis failed: ${(err as Error).message}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bridgeRequest(raw: unknown): BridgeConfig | null {
  if (raw !== undefined && !isObject(raw)) return null
  const value = raw ?? {}
  const saved = loadSettings().connection
  const base = (saved && sanitizeTarget(saved.ip, saved.port)) || lastConfig
  const target = sanitizeTarget(value.ip ?? base.ip, value.port ?? base.port)
  if (!target || (value.skipPreflight !== undefined && typeof value.skipPreflight !== 'boolean')) return null
  return { ...target, skipPreflight: value.skipPreflight === true }
}

async function startBridge(raw?: BridgeConfig): Promise<boolean> {
  const cfg = bridgeRequest(raw)
  if (!cfg || quitting) return false
  const target = sanitizeTarget(cfg.ip, cfg.port)!
  const generation = ++startGeneration
  acceptingScans = false
  desiredRunning = false
  clearOutput()
  bridge.stop()
  lastTarget = cfg
  lastConfig = target
  savedFor = ''
  desiredRunning = true
  scansLive = false
  sawScan = false
  stalled = false
  status({ state: 'connecting', message: `${target.ip}:${target.port}` })
  if (!cfg.skipPreflight) {
    try {
      const diagnosis = await diagnose(target.ip)
      if (generation !== startGeneration || quitting) return false
      if (!diagnosis.ok) {
        desiredRunning = false
        status({ state: 'no-network', message: `no adapter on ${target.ip.split('.').slice(0, 3).join('.')}.x` })
        return false
      }
    } catch (err) {
      // Failed diagnosis should not block the actual connection attempt.
      if (generation !== startGeneration || quitting) return false
      log(`[main] preflight failed: ${(err as Error).message}; trying bridge`)
    }
  }
  if (generation !== startGeneration || quitting) return false
  restoreBackground(target)
  acceptingScans = true
  bridge.start(target.ip, target.port)
  return true
}

function stopBridge(): void {
  ++startGeneration
  desiredRunning = false
  acceptingScans = false
  scansLive = false
  sawScan = false
  stalled = false
  clearOutput()
  bridge.stop()
  status({ state: 'stopped', message: 'stopped' })
}

function checkScanFreshness(): void {
  const now = performance.now()
  if (desiredRunning && acceptingScans && sawScan && !stalled && now - lastScanAt > 300) {
    stalled = true
    scansLive = false
    clearOutput()
    status({ state: 'connecting', message: 'scan stalled' })
  }
  if ((stalled || !scansLive) && now - lastOscFrameAt >= 500) sendTouches([], false)
}

function isAppUrl(raw: string): boolean {
  try {
    const candidate = new URL(raw)
    const expected = new URL(APP_URL)
    return expected.protocol === 'file:'
      ? candidate.protocol === 'file:' && candidate.host === expected.host && candidate.pathname === expected.pathname
      : candidate.origin === expected.origin
  } catch { return false }
}

function trustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed() &&
    event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && isAppUrl(event.senderFrame.url)
}

function registerIpc(): void {
  const handle = (channel: string, action: (event: Electron.IpcMainInvokeEvent, value: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, value: unknown) => {
      if (!trustedSender(event)) throw new Error('IPC request from an untrusted frame')
      return action(event, value)
    })
  }
  handle(IPC.bridgeStart, (_event, raw) => {
    const cfg = bridgeRequest(raw)
    return cfg ? startBridge(cfg) : false
  })
  handle(IPC.bridgeStop, () => { stopBridge(); return true })
  handle(IPC.setPipelineConfig, (_event, raw) => {
    if (!isObject(raw)) return false
    const cfg = sanitizePipeline(raw, pipelineConfig)
    clearOutput()
    pipelineConfig = cfg
    persistState()
    return true
  })
  handle(IPC.learnBackground, () => learnBackground())
  handle(IPC.resetBackground, () => {
    if (!invalidateBackground()) return false
    clearOutput()
    background.reset()
    return true
  })
  handle(IPC.setCalibration, (_event, raw) => {
    const next = sanitizeCalibration(raw)
    if (raw !== null && !next) return false
    clearOutput()
    calibration = next
    homography = computeHomographyChecked(calibration?.src)
    persistState()
    return true
  })
  handle(IPC.setZones, (_event, raw) => {
    if (!Array.isArray(raw)) return false
    const next = sanitizeZones(raw)
    clearOutput()
    zones = next
    touchManager.setZones(zones)
    persistState()
    return true
  })
  handle(IPC.setOscConfig, (_event, raw) => {
    if (!isObject(raw)) return false
    const next = sanitizeOsc(raw, oscConfig)
    clearOutput()
    oscConfig = next
    oscSender.configure(oscConfig)
    persistState()
    return true
  })
  handle(IPC.setCalibrating, (_event, on) => {
    if (typeof on !== 'boolean') return false
    if (calibrating !== on) clearOutput()
    calibrating = on
    return true
  })
  handle(IPC.savePreset, async () => {
    try { return await savePreset(win, currentPreset()) }
    catch (err) { log(`[main] preset save failed: ${(err as Error).message}`); return false }
  })
  handle(IPC.loadPreset, async (event) => {
    try {
      const preset = await loadPreset(win)
      return preset && trustedSender(event) && !quitting ? applyPreset(preset) : null
    } catch (err) {
      log(`[main] preset load failed: ${(err as Error).message}`)
      return null
    }
  })
  handle(IPC.getState, () => currentPreset())
  const networkIp = (raw: unknown): string => {
    const target = sanitizeTarget(raw, DEFAULT_TARGET.port)
    if (!target) throw new Error('Invalid network target')
    return target.ip
  }
  handle(IPC.networkDiagnose, (_event, raw) => diagnose(networkIp(raw)))
  handle(IPC.networkProbe, (_event, raw) => probeDevice(networkIp(raw)))
  handle(IPC.networkConfigure, (_event, raw) => {
    if (!isObject(raw) || typeof raw.interfaceName !== 'string' || !raw.interfaceName.trim() ||
      raw.interfaceName.length > 256 || /[\x00-\x1f\x7f]/.test(raw.interfaceName) || raw.prefixLength !== 24) {
      throw new Error('Invalid network configuration')
    }
    const request: NetworkConfigureRequest = { interfaceName: raw.interfaceName, ip: networkIp(raw.ip), prefixLength: 24 }
    return configure(request)
  })
  handle(IPC.getConnection, () => {
    const saved = loadSettings().connection
    return saved ? sanitizeTarget(saved.ip, saved.port) : null
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320, height: 880, backgroundColor: '#0b0e14', title: 'Slamtec S2E Tracker',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win = window
  lastVizAt = -Infinity
  vizProbe = null
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  const resetRendererCapture = (): void => {
    if (win !== window || quitting) return
    calibrating = false
    vizProbe = null
    lastVizAt = -Infinity
    clearOutput()
    send(IPC.state, currentPreset())
  }
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) resetRendererCapture()
  })
  window.webContents.on('did-finish-load', () => {
    if (win !== window || quitting) return
    resetRendererCapture()
    send(IPC.status, lastStatus)
    if (!autoStarted) { autoStarted = true; void startBridge(lastTarget) }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|x-apple\.systempreferences:)/.test(url)) {
      void shell.openExternal(url).catch((err) => log(`[main] open external failed: ${err.message}`))
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault() })
  window.webContents.on('render-process-gone', (_event, details) => {
    resetRendererCapture()
    log(`[main] renderer exited: ${details.reason} (${details.exitCode}); reloading`)
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      if (!quitting && win === window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.reload()
    }, 1000)
  })
  window.on('closed', () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    if (win === window) { win = null; vizProbe = null }
  })
  const loading = process.env.ELECTRON_RENDERER_URL ? window.loadURL(APP_URL) : window.loadFile(RENDERER_FILE)
  void loading.catch((err) => log(`[main] renderer load failed: ${err.message}`))
}

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) {
    if (ownsInstance && app.isReady() && !quitting) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(() => {
  ownsInstance = app.requestSingleInstanceLock()
  if (!ownsInstance) { app.quit(); return }
  const saved = loadSettings().connection
  lastConfig = (saved && sanitizeTarget(saved.ip, saved.port)) || { ...DEFAULT_TARGET }
  lastTarget = { ...lastConfig }
  applyPreset(loadInstallation() ?? DEFAULT_PRESET, false)
  restoreBackground(lastConfig)
  attachBridgeListeners()
  registerIpc()
  sleepBlocker = powerSaveBlocker.start('prevent-display-sleep')
  watchdog = setInterval(checkScanFreshness, 100)
  powerMonitor.on('resume', () => {
    if (desiredRunning && !quitting) { log('[main] system resumed; restarting bridge'); void startBridge(lastTarget) }
  })
  app.on('activate', () => { if (!quitting && BrowserWindow.getAllWindows().length === 0) createWindow() })
  createWindow()
}).catch((err) => { log(`[main] startup failed: ${(err as Error).message}`); app.quit() })

app.on('window-all-closed', () => {
  if (!ownsInstance || quitting) return
  stopBridge()
  autoStarted = false
  calibrating = false
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  ++startGeneration
  desiredRunning = false
  acceptingScans = false
  if (watchdog) clearInterval(watchdog)
  if (ownsInstance) clearOutput()
  bridge.kill()
  oscSender.close()
  if (ownsInstance) flushInstallation()
  if (sleepBlocker !== undefined && powerSaveBlocker.isStarted(sleepBlocker)) powerSaveBlocker.stop(sleepBlocker)
})
