// Shared contract types for the Slamtec S2E tracker.
// Coordinate conventions:
//   x, y  -> LiDAR space in millimeters, sensor at the origin.
//   u, v  -> normalized [0, 1] space (homography output), invariant to sensor placement.

// Background-learning status, surfaced per frame so the UI can show whether a
// baseline exists, learning progress, and how much of the sweep is covered.
export interface BgStatus {
  learning: boolean
  progress: number // 0..1
  bins: number // angular bins with a learned baseline
  totalBins: number
  ready: boolean // a finished baseline exists (learned this session or restored from disk)
}

// Why touch output is (not) live. 'ok' = calibrated, baseline ready, scans fresh.
export type ReadyReason =
  | 'ok'
  | 'no-calibration'
  | 'bad-calibration'
  | 'learning'
  | 'no-background'
  | 'calibrating'
  | 'stalled'

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
  bg: BgStatus
  // Touch output gate. When `ready` is false and OscConfig.requireReady is on,
  // no touch begin/move is sent (frames still go out with ready=0).
  ready: boolean
  readyReason: ReadyReason
  // Main-process pipeline time for this frame, ms.
  procMs: number
}

export type BridgeState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'scanning'
  | 'error'
  | 'stopped'
  // Preflight found no host adapter on the target /24 subnet; the bridge was
  // never spawned. The renderer shows the network fix panel for this state.
  | 'no-network'

export interface BridgeStatus {
  state: BridgeState
  message?: string
}

export interface BridgeConfig {
  ip?: string
  port?: number
  // Bypass the subnet preflight ("Start anyway" for routed/unusual setups).
  skipPreflight?: boolean
}

// Last-used connection, persisted in userData/settings.json on successful connect.
export interface ConnectionSettings {
  ip: string
  port: number
}

// One host network interface, as seen by the connection diagnosis.
export interface NetworkInterfaceInfo {
  name: string // os.networkInterfaces() key (darwin: 'en5'; win32: friendly alias)
  serviceName?: string // macOS networksetup service name; undefined if no service exists
  ipv4: string[] // may be empty: unconfigured adapters often carry only fe80:: entries
  isWifi: boolean
  isVirtual: boolean
  isLinkLocal: boolean // has a 169.254.x.x address (DHCP fallback — strong candidate signal)
  onTargetSubnet: boolean
  candidate: boolean
  suggested: boolean // exactly one true among candidates (best ranked)
}

export interface NetworkDiagnosis {
  targetIp: string
  ok: boolean // >=1 interface on the target /24
  matches: NetworkInterfaceInfo[] // already on the subnet (>1 entry = warn in UI)
  candidates: NetworkInterfaceInfo[] // configurable choices, ranked best-first
  all: NetworkInterfaceInfo[]
  platform: string
}

// ARP-based device presence probe (the S2E does not answer ICMP ping).
export interface DeviceProbeResult {
  found: boolean // targetIp resolved to a valid MAC in the ARP table
  probedIp: string
  otherIps: string[] // other live /24 entries — suggestions when the device IP changed
}

export interface NetworkConfigureRequest {
  interfaceName: string // NetworkInterfaceInfo.name
  ip: string // host address to assign, default '192.168.11.100'
  prefixLength: number // 24
}

export interface NetworkConfigureResult {
  ok: boolean // decided solely by post-configure re-diagnosis polling
  cancelled: boolean // admin/UAC prompt dismissed
  error?: string
  diagnosis: NetworkDiagnosis
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

// A tracked object (hand / person). x, y are LiDAR millimeters; u, v are
// normalized (homography output; [0, 1] inside the calibrated area).
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
  // Touch area: when at least one enabled zone has touch=true, only touches
  // inside such zones are sent (tagged with the zone + zone-local coords).
  // With no touch areas the whole calibrated area accepts touches.
  // Optional for old presets; the main-process validator defaults it to true.
  touch?: boolean
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
  bgDeltaMm: number // minimum radial distance in front of the baseline to count as foreground
  bgNoiseK: number // per-bin threshold = max(bgDeltaMm, bgNoiseK * robust sigma of that bin)
  bgMinReturnRatio: number // bins returning in fewer learn frames than this are "empty" (any return = foreground)
  bgLearnFrames: number
  clusterGapMm: number
  minClusterPts: number
  minSizeMm: number // cluster extent = bounding-box diagonal (orientation independent)
  maxSizeMm: number
  trackMaxJumpMm: number // association gate around the predicted position
  smoothing: number // 1 = raw position, lower = more smoothing
  birthFrames: number
  deathFrames: number
  // Scan mask, applied before clustering. Sector [angleMinDeg, angleMaxDeg] in
  // sensor degrees; when min > max the sector wraps through 0 deg.
  angleMinDeg: number
  angleMaxDeg: number
  rangeMinMm: number
  rangeMaxMm: number
  minQuality: number // 0..255, points below are dropped
  // With a calibration, points mapping outside [-roiMargin, 1 + roiMargin] in
  // (u, v) are dropped before clustering (no edge clamping of outside objects).
  roiMargin: number
}

// OSC output mode. 'touch' = Unity-friendly touch lifecycle (see README
// "OSC 출력"), 'slots' = legacy fixed-slot TouchDesigner stream, 'both'.
export type OscMode = 'touch' | 'slots' | 'both'

export interface OscConfig {
  host: string
  port: number
  addrPrefix: string
  maxSlots: number // slots mode only, clamped to [1, MAX_OSC_SLOTS]
  enabled: boolean
  mode: OscMode
  yUp: boolean // touch mode: send y = 1 - v (Unity convention, origin bottom-left)
  requireReady: boolean // touch mode: hold touches until calibrated + background ready
}

export const MAX_OSC_SLOTS = 32

// Touch phases sent in `<prefix>/touch` messages.
export const TouchPhase = { begin: 0, move: 1, end: 2, cancel: 3 } as const
export type TouchPhase = (typeof TouchPhase)[keyof typeof TouchPhase]

export interface Preset {
  calibration: CalibrationPoints | null
  zones: Zone[]
  pipeline: PipelineConfig
  osc: OscConfig
}

// Wall-touch defaults: the scan plane runs a few cm in front of the wall and
// hands (30-100 mm) break it briefly. Starting points for on-site tuning.
export const WALL_TOUCH_PIPELINE_CONFIG: PipelineConfig = {
  bgDeltaMm: 40,
  bgNoiseK: 4,
  bgMinReturnRatio: 0.5,
  bgLearnFrames: 50,
  clusterGapMm: 40,
  minClusterPts: 2,
  minSizeMm: 10,
  maxSizeMm: 250,
  trackMaxJumpMm: 200,
  smoothing: 0.85,
  birthFrames: 1,
  deathFrames: 2,
  angleMinDeg: 0,
  angleMaxDeg: 360,
  rangeMinMm: 100,
  rangeMaxMm: 10000,
  minQuality: 0,
  roiMargin: 0.02
}

// Floor people-tracking profile (the original use case).
export const PERSON_TRACKING_PIPELINE_CONFIG: PipelineConfig = {
  ...WALL_TOUCH_PIPELINE_CONFIG,
  bgDeltaMm: 150,
  bgLearnFrames: 30,
  clusterGapMm: 120,
  minClusterPts: 3,
  minSizeMm: 80,
  maxSizeMm: 1200,
  trackMaxJumpMm: 600,
  smoothing: 0.5,
  birthFrames: 3,
  deathFrames: 8,
  rangeMaxMm: 15000,
  roiMargin: 0.1
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = WALL_TOUCH_PIPELINE_CONFIG

export const DEFAULT_OSC_CONFIG: OscConfig = {
  host: '127.0.0.1',
  port: 7000,
  addrPrefix: '/wall',
  maxSlots: 16,
  enabled: true,
  mode: 'touch',
  yUp: true,
  requireReady: true
}

export const DEFAULT_PRESET: Preset = {
  calibration: null,
  zones: [],
  pipeline: DEFAULT_PIPELINE_CONFIG,
  osc: DEFAULT_OSC_CONFIG
}
