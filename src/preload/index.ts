import { contextBridge, ipcRenderer } from 'electron'
import type { VizFrame, BridgeStatus, BridgeConfig } from '../shared/types'

const api = {
  onFrame: (cb: (f: VizFrame) => void): (() => void) => {
    const listener = (_e: unknown, f: VizFrame): void => cb(f)
    ipcRenderer.on('frame', listener)
    return () => ipcRenderer.removeListener('frame', listener)
  },
  onStatus: (cb: (s: BridgeStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: BridgeStatus): void => cb(s)
    ipcRenderer.on('bridge-status', listener)
    return () => ipcRenderer.removeListener('bridge-status', listener)
  },
  onLog: (cb: (s: string) => void): (() => void) => {
    const listener = (_e: unknown, s: string): void => cb(s)
    ipcRenderer.on('bridge-log', listener)
    return () => ipcRenderer.removeListener('bridge-log', listener)
  },
  start: (cfg?: BridgeConfig): Promise<boolean> => ipcRenderer.invoke('bridge:start', cfg),
  stop: (): Promise<boolean> => ipcRenderer.invoke('bridge:stop')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
