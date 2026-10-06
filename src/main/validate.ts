import {
  DEFAULT_OSC_CONFIG,
  DEFAULT_PIPELINE_CONFIG,
  MAX_OSC_SLOTS,
  type CalibrationPoints,
  type OscConfig,
  type OscMode,
  type PipelineConfig,
  type Preset,
  type Zone
} from '../shared/types'
import { validateQuad } from '../shared/homography'

/**
 * Runtime validation for everything that crosses a trust boundary into main
 * (IPC payloads, preset files, persisted state). TypeScript types do not exist
 * at runtime: a hand-edited preset or a renderer bug must degrade to defaults
 * per field, never crash the scan loop or stall it (e.g. maxSlots = 1e9).
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function num(v: unknown, def: number, min: number, max: number, int = false): number {
  let n = finiteNumber(v)
  if (n === null) return def
  if (int) n = Math.round(n)
  return Math.min(max, Math.max(min, n))
}

const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)

// [min, max, integer?] per pipeline field.
const PIPELINE_RANGES: Record<keyof PipelineConfig, [number, number, boolean?]> = {
  bgDeltaMm: [0, 2000],
  bgNoiseK: [0, 20],
  bgMinReturnRatio: [0, 1],
  bgLearnFrames: [1, 1000, true],
  clusterGapMm: [1, 2000],
  minClusterPts: [1, 200, true],
  minSizeMm: [0, 5000],
  maxSizeMm: [1, 20000],
  trackMaxJumpMm: [1, 5000],
  smoothing: [0.01, 1],
  birthFrames: [1, 30, true],
  deathFrames: [1, 100, true],
  angleMinDeg: [-360, 720],
  angleMaxDeg: [-360, 720],
  rangeMinMm: [0, 40000],
  rangeMaxMm: [1, 40000],
  minQuality: [0, 255, true],
  roiMargin: [0, 1]
}

export function sanitizePipeline(raw: unknown, base: PipelineConfig = DEFAULT_PIPELINE_CONFIG): PipelineConfig {
  const src = isObj(raw) ? raw : {}
  const out = { ...base }
  for (const key of Object.keys(PIPELINE_RANGES) as Array<keyof PipelineConfig>) {
    const [min, max, int] = PIPELINE_RANGES[key]
    out[key] = num(src[key], base[key], min, max, int)
  }
  if (out.maxSizeMm < out.minSizeMm) out.maxSizeMm = out.minSizeMm
  if (out.rangeMaxMm < out.rangeMinMm) out.rangeMaxMm = out.rangeMinMm
  return out
}

const OSC_MODES: OscMode[] = ['touch', 'slots', 'both']

export function sanitizeOsc(raw: unknown, base: OscConfig = DEFAULT_OSC_CONFIG): OscConfig {
  const src = isObj(raw) ? raw : {}
  const host = typeof src.host === 'string' && /^[A-Za-z0-9.\-:_]{1,253}$/.test(src.host.trim()) ? src.host.trim() : base.host
  const rawPrefix = typeof src.addrPrefix === 'string' ? src.addrPrefix.trim() : ''
  const prefix =
    rawPrefix !== '' && /^\/?[A-Za-z0-9_\-./]{0,63}$/.test(rawPrefix)
      ? rawPrefix
      : base.addrPrefix
  return {
    host,
    port: num(src.port, base.port, 1, 65535, true),
    addrPrefix: prefix,
    maxSlots: num(src.maxSlots, base.maxSlots, 1, MAX_OSC_SLOTS, true),
    enabled: bool(src.enabled, base.enabled),
    mode: OSC_MODES.includes(src.mode as OscMode) ? (src.mode as OscMode) : base.mode,
    yUp: bool(src.yUp, base.yUp),
    requireReady: bool(src.requireReady, base.requireReady)
  }
}

const MAX_ZONES = 64
const MAX_VERTICES = 64
const GEOMETRY_EPSILON = 1e-9

type Point = [number, number]

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) <= GEOMETRY_EPSILON && Math.abs(a[1] - b[1]) <= GEOMETRY_EPSILON
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.abs(cross(a, b, p)) <= GEOMETRY_EPSILON &&
    p[0] >= Math.min(a[0], b[0]) - GEOMETRY_EPSILON &&
    p[0] <= Math.max(a[0], b[0]) + GEOMETRY_EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - GEOMETRY_EPSILON &&
    p[1] <= Math.max(a[1], b[1]) + GEOMETRY_EPSILON
  )
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)
  if (
    ((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) ||
      (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON)) &&
    ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) ||
      (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))
  ) {
    return true
  }
  return (
    (Math.abs(abC) <= GEOMETRY_EPSILON && onSegment(a, b, c)) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && onSegment(a, b, d)) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && onSegment(c, d, a)) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && onSegment(c, d, b))
  )
}

/** Zones may be concave, but their ring must be simple and non-degenerate. */
function validPolygon(polygon: Point[]): boolean {
  const n = polygon.length
  if (n < 3) return false

  for (let i = 0; i < n; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % n]
    const c = polygon[(i + 2) % n]
    if (samePoint(a, b)) return false
    // A redundant point along an edge is a valid polygon vertex; reversing
    // direction along that edge would make overlapping segments.
    if (Math.abs(cross(a, b, c)) <= GEOMETRY_EPSILON &&
      (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) <= 0) return false
    for (let j = i + 1; j < n; j++) {
      if (samePoint(a, polygon[j])) return false
    }
  }

  let area2 = 0
  for (let i = 0; i < n; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % n]
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  if (Math.abs(area2) <= GEOMETRY_EPSILON) return false

  for (let i = 0; i < n; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges meet at their shared vertex by definition.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      if (segmentsIntersect(a, b, polygon[j], polygon[(j + 1) % n])) return false
    }
  }
  return true
}

export function sanitizeZones(raw: unknown): Zone[] {
  if (!Array.isArray(raw)) return []
  const out: Zone[] = []
  const ids = new Set<string>()
  for (const z of raw.slice(0, MAX_ZONES)) {
    if (!isObj(z) || !Array.isArray(z.polygon) || z.polygon.length > MAX_VERTICES) continue
    const polygon: Array<[number, number]> = []
    let malformed = false
    for (const p of z.polygon) {
      if (!Array.isArray(p) || p.length !== 2) {
        malformed = true
        break
      }
      const x = finiteNumber(p[0])
      const y = finiteNumber(p[1])
      if (x === null || y === null) {
        malformed = true
        break
      }
      polygon.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))])
    }
    if (malformed || !validPolygon(polygon)) continue
    const rawId = typeof z.id === 'string' ? z.id.trim().slice(0, 64) : ''
    const baseId = rawId || `zone-${out.length + 1}`
    let id = baseId
    for (let suffix = 2; ids.has(id); suffix++) {
      const tail = `_${suffix}`
      id = `${baseId.slice(0, 64 - tail.length)}${tail}`
    }
    ids.add(id)
    // Spaces preserve word boundaries and sanitize exactly like control chars
    // in the OSC segment helpers (main and renderer).
    const rawName = typeof z.name === 'string' ? z.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 64) : ''
    out.push({
      id,
      name: rawName || `zone ${out.length + 1}`,
      color:
        typeof z.color === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(z.color)
          ? z.color
          : '#4fc3f7',
      enabled: bool(z.enabled, true),
      polygon,
      touch: bool(z.touch, true)
    })
  }
  return out
}

export function sanitizeCalibration(raw: unknown): CalibrationPoints | null {
  if (!isObj(raw) || !Array.isArray(raw.src) || raw.src.length !== 4) return null
  const src: Array<[number, number]> = []
  for (const p of raw.src) {
    if (!Array.isArray(p) || p.length !== 2) return null
    const x = finiteNumber(p[0])
    const y = finiteNumber(p[1])
    if (x === null || y === null) return null
    src.push([x, y])
  }
  const points = src as CalibrationPoints['src']
  return validateQuad(points) === null ? { src: points } : null
}

/** Full preset; returns null only when `raw` is not an object at all. */
export function sanitizePreset(raw: unknown): Preset | null {
  if (!isObj(raw)) return null
  return {
    calibration: sanitizeCalibration(raw.calibration),
    zones: sanitizeZones(raw.zones),
    pipeline: sanitizePipeline(raw.pipeline),
    osc: sanitizeOsc(raw.osc)
  }
}

/** Strict-ish dotted IPv4 + port check for bridge targets. */
export function sanitizeTarget(ip: unknown, port: unknown): { ip: string; port: number } | null {
  if (typeof ip !== 'string') return null
  const parts = ip.trim().split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
  const pn = finiteNumber(port)
  if (pn === null || !Number.isInteger(pn) || pn < 1 || pn > 65535) return null
  return { ip: ip.trim(), port: pn }
}
