// Shared contract types for the Slamtec S2E tracker.
// Coordinate conventions:
//   x, y  -> LiDAR space in millimeters, sensor at the origin.
//   u, v  -> normalized [0, 1] space (homography output), invariant to sensor placement.

// Visualization frame pushed from main -> renderer over IPC.
// `xy` is interleaved [x0, y0, x1, y1, ...] in millimeters with the LiDAR at the origin.
// `fg` is interleaved foreground xy [x0, y0, x1, y1, ...] in millimeters.
export interface VizFrame {
  seq: number
  tMs: number
  count: number
  xy: Float32Array
  quality?: Uint8Array
  fg?: Float32Array
  tracks: Track[]
  zones: ZoneRuntime[]
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

// Foreground points, angle-ordered. Parallel arrays of length `count`.
// x, y are LiDAR millimeters with the sensor at the origin.
export interface FgPoints {
  count: number
  angle: Float32Array
  dist: Float32Array
  x: Float32Array
  y: Float32Array
}

// Cluster centroid in LiDAR millimeters.
export interface Cluster {
  cx: number
  cy: number
  sizeMm: number
  count: number
}

// A tracked person. x, y are LiDAR millimeters; u, v are normalized [0, 1].
export interface Track {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  u: number
  v: number
  age: number
  lostFrames: number
}

// Event zone. polygon vertices are in normalized [0, 1] space (placement-invariant).
export interface Zone {
  id: string
  name: string
  color: string
  enabled: boolean
  polygon: Array<[number, number]>
}

// Zone enriched with per-frame runtime occupancy state.
export interface ZoneRuntime extends Zone {
  active: boolean
  occupants: number[]
}

// Zone enter/exit event for a given track.
export interface ZoneEvent {
  zone: string
  id: number
  type: 'enter' | 'exit'
}

// 4 LiDAR-mm correspondence points mapped to the unit square
// in order: (0,0), (1,0), (1,1), (0,1).
export interface CalibrationPoints {
  src: [[number, number], [number, number], [number, number], [number, number]]
}

export interface PipelineConfig {
  bgDeltaMm: number
  bgLearnFrames: number
  clusterGapMm: number
  minClusterPts: number
  minSizeMm: number
  maxSizeMm: number
  trackMaxJumpMm: number
  smoothing: number
  birthFrames: number
  deathFrames: number
}

export interface OscConfig {
  host: string
  port: number
  addrPrefix: string
  maxSlots: number
  enabled: boolean
}

export interface Preset {
  calibration: CalibrationPoints | null
  zones: Zone[]
  pipeline: PipelineConfig
  osc: OscConfig
}

// Sensible person-tracking defaults.
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  bgDeltaMm: 150,
  bgLearnFrames: 30,
  clusterGapMm: 120,
  minClusterPts: 3,
  minSizeMm: 80,
  maxSizeMm: 1200,
  trackMaxJumpMm: 600,
  smoothing: 0.5,
  birthFrames: 3,
  deathFrames: 8
}

export const DEFAULT_OSC_CONFIG: OscConfig = {
  host: '127.0.0.1',
  port: 7000,
  addrPrefix: '/lidar',
  maxSlots: 16,
  enabled: true
}

export const DEFAULT_PRESET: Preset = {
  calibration: null,
  zones: [],
  pipeline: DEFAULT_PIPELINE_CONFIG,
  osc: DEFAULT_OSC_CONFIG
}
