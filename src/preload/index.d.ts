import type { VizFrame, BridgeStatus, BridgeConfig } from '@shared/types'

declare global {
  interface Window {
    api: {
      onFrame: (cb: (f: VizFrame) => void) => () => void
      onStatus: (cb: (s: BridgeStatus) => void) => () => void
      onLog: (cb: (s: string) => void) => () => void
      start: (cfg?: BridgeConfig) => Promise<boolean>
      stop: () => Promise<boolean>
    }
  }
}

export {}
