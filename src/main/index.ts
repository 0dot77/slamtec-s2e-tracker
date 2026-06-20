import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
import { Bridge, type RawScan } from './bridge'
import type { BridgeConfig, VizFrame } from '../shared/types'

// Path to the compiled C++ bridge. In dev, cwd is the project root.
const BRIDGE_PATH = process.env.S2E_BRIDGE_PATH || resolve(process.cwd(), 'bridge/s2e_bridge')

let win: BrowserWindow | null = null
let bridge: Bridge | null = null
let autoStarted = false

const DEG2RAD = Math.PI / 180

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
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload)
}

function startBridge(cfg?: BridgeConfig): void {
  if (!bridge) bridge = new Bridge(BRIDGE_PATH)
  bridge.removeAllListeners()

  bridge.on('status', (s) => {
    console.log('[main] bridge:', s.state, s.message ?? '')
    send('bridge-status', s)
  })
  bridge.on('log', (l) => {
    console.log('[main] bridge-log:', l)
    send('bridge-log', l)
  })
  bridge.on('scan', (scan: RawScan) => {
    const n = scan.count
    const xy = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      const a = scan.angle[i] * DEG2RAD
      const d = scan.dist[i]
      xy[i * 2] = Math.cos(a) * d
      xy[i * 2 + 1] = Math.sin(a) * d
    }
    const frame: VizFrame = { seq: scan.seq, tMs: scan.tMs, count: n, xy, quality: scan.quality }
    if (scan.seq % 30 === 0) console.log(`[main] frame #${scan.seq}: ${n} pts @ ${scan.tMs}ms`)
    send('frame', frame)
  })

  bridge.start(cfg?.ip, cfg?.port)
}

app.whenReady().then(() => {
  createWindow()

  ipcMain.handle('bridge:start', (_e, cfg: BridgeConfig | undefined) => {
    startBridge(cfg)
    return true
  })
  ipcMain.handle('bridge:stop', () => {
    bridge?.stop()
    return true
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  bridge?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => bridge?.stop())
