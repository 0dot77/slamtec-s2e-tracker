// Visualization frame pushed from main -> renderer over IPC.
// `xy` is interleaved [x0, y0, x1, y1, ...] in millimeters with the LiDAR at the origin.
export interface VizFrame {
  seq: number
  tMs: number
  count: number
  xy: Float32Array
  quality: Uint8Array
}

export type BridgeState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'scanning'
  | 'error'
  | 'stopped'

export interface BridgeStatus {
  state: BridgeState
  message?: string
}

export interface BridgeConfig {
  ip?: string
  port?: number
}
