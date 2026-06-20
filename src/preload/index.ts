import { contextBridge, ipcRenderer } from 'electron'
import type {
  VizFrame,
  BridgeStatus,
  BridgeConfig,
  PipelineConfig,
  CalibrationPoints,
  Zone,
  OscConfig,
  Preset,
  ZoneEvent
} from '../shared/types'
import { IPC } from '../shared/ipc'

const api = {
  onFrame: (cb: (f: VizFrame) => void): (() => void) => {
    const listener = (_e: unknown, f: VizFrame): void => cb(f)
    ipcRenderer.on(IPC.frame, listener)
    return () => ipcRenderer.removeListener(IPC.frame, listener)
  },
  onStatus: (cb: (s: BridgeStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: BridgeStatus): void => cb(s)
    ipcRenderer.on(IPC.status, listener)
    return () => ipcRenderer.removeListener(IPC.status, listener)
  },
  onLog: (cb: (s: string) => void): (() => void) => {
    const listener = (_e: unknown, s: string): void => cb(s)
    ipcRenderer.on(IPC.log, listener)
    return () => ipcRenderer.removeListener(IPC.log, listener)
  },
  onZoneEvent: (cb: (e: ZoneEvent) => void): (() => void) => {
    const listener = (_e: unknown, e: ZoneEvent): void => cb(e)
    ipcRenderer.on(IPC.zoneEvent, listener)
    return () => ipcRenderer.removeListener(IPC.zoneEvent, listener)
  },
  start: (cfg?: BridgeConfig): Promise<boolean> => ipcRenderer.invoke(IPC.bridgeStart, cfg),
  stop: (): Promise<boolean> => ipcRenderer.invoke(IPC.bridgeStop),
  setPipelineConfig: (cfg: PipelineConfig): Promise<boolean> =>
    ipcRenderer.invoke(IPC.setPipelineConfig, cfg),
  learnBackground: (): Promise<boolean> => ipcRenderer.invoke(IPC.learnBackground),
  setCalibration: (p: CalibrationPoints | null): Promise<boolean> =>
    ipcRenderer.invoke(IPC.setCalibration, p),
  setZones: (z: Zone[]): Promise<boolean> => ipcRenderer.invoke(IPC.setZones, z),
  setOscConfig: (cfg: OscConfig): Promise<boolean> => ipcRenderer.invoke(IPC.setOscConfig, cfg),
  savePreset: (): Promise<boolean> => ipcRenderer.invoke(IPC.savePreset),
  loadPreset: (): Promise<Preset | null> => ipcRenderer.invoke(IPC.loadPreset),
  getState: (): Promise<Preset> => ipcRenderer.invoke(IPC.getState)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
