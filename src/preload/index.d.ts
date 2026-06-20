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
} from '@shared/types'

declare global {
  interface Window {
    api: {
      onFrame: (cb: (f: VizFrame) => void) => () => void
      onStatus: (cb: (s: BridgeStatus) => void) => () => void
      onLog: (cb: (s: string) => void) => () => void
      onZoneEvent: (cb: (e: ZoneEvent) => void) => () => void
      start: (cfg?: BridgeConfig) => Promise<boolean>
      stop: () => Promise<boolean>
      setPipelineConfig: (cfg: PipelineConfig) => Promise<boolean>
      learnBackground: () => Promise<boolean>
      setCalibration: (p: CalibrationPoints | null) => Promise<boolean>
      setZones: (z: Zone[]) => Promise<boolean>
      setOscConfig: (cfg: OscConfig) => Promise<boolean>
      savePreset: () => Promise<boolean>
      loadPreset: () => Promise<Preset | null>
      getState: () => Promise<Preset>
    }
  }
}

export {}
