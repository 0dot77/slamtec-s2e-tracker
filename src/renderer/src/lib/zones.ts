// Shared zone helpers used by both LiDAR-space and normalized wall-space editors.
import type { Zone } from '@shared/types'

export const PALETTE = [
  '#37a0d4',
  '#3ad48c',
  '#e0b341',
  '#ff5d5d',
  '#a079e0',
  '#37d4c8',
  '#e07ab4'
]

// Closing threshold (normalized units) for clicking back onto the first vertex.
export const CLOSE_DIST = 0.03

const ZONE_NAME_HISTORY_KEY = 'slamtec-s2e-tracker.zone-name-history.v1'
const AREA_NAME = /^area\s+(\d+)$/i
const MAX_AREA_NUMBER = 1_000_000

interface StoredNameHistory {
  names: string[]
  nextArea: number
}

// Keep a session copy as well as localStorage so name allocation remains monotonic
// when storage is unavailable or disabled.
const reservedNames = new Set<string>()
let nextAreaNumber = 1
let historyLoaded = false

function loadNameHistory(): void {
  if (historyLoaded) return
  historyLoaded = true
  try {
    const raw = globalThis.localStorage?.getItem(ZONE_NAME_HISTORY_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<StoredNameHistory>
    if (Array.isArray(parsed.names)) {
      for (const name of parsed.names) {
        if (typeof name === 'string' && name.trim()) reservedNames.add(name.trim())
      }
    }
    if (typeof parsed.nextArea === 'number' && Number.isSafeInteger(parsed.nextArea) && parsed.nextArea >= 1) {
      // cap + 1 is the persisted marker for switching to fallback names.
      nextAreaNumber = Math.min(MAX_AREA_NUMBER + 1, parsed.nextArea)
    }
  } catch {
    // Persistence is a convenience; the in-memory history still prevents reuse.
  }
}

function saveNameHistory(): void {
  try {
    const value: StoredNameHistory = {
      names: [...reservedNames],
      nextArea: nextAreaNumber
    }
    globalThis.localStorage?.setItem(ZONE_NAME_HISTORY_KEY, JSON.stringify(value))
  } catch {
    // Private/locked-down renderer sessions may reject localStorage writes.
  }
}

function noteAreaNumber(name: string): void {
  const match = AREA_NAME.exec(name)
  if (!match) return
  const number = Number(match[1])
  if (Number.isSafeInteger(number) && number >= 1 && number <= MAX_AREA_NUMBER) {
    nextAreaNumber = Math.max(nextAreaNumber, number + 1)
  }
}

/** N reserved names can block at most N of these distinct candidates. */
function availableName(base: string, unavailable: ReadonlySet<string>): string {
  if (!unavailable.has(base)) return base
  for (let suffix = 2; suffix <= unavailable.size + 2; suffix++) {
    const candidate = `${base} ${suffix}`
    if (!unavailable.has(candidate)) return candidate
  }
  throw new Error('Could not allocate a unique zone name')
}

/** Clamp one normalized point into the wall/calibration unit square. */
export function clampZonePoint(point: readonly [number, number]): [number, number] {
  const finite = (value: number): number => (Number.isFinite(value) ? value : 0)
  return [
    Math.max(0, Math.min(1, finite(point[0]))),
    Math.max(0, Math.min(1, finite(point[1])))
  ]
}

export function clampZonePolygon(
  points: ReadonlyArray<readonly [number, number]>
): Array<[number, number]> {
  return points.map(clampZonePoint)
}

/** Reject shapes main would discard: duplicate/collinear vertices or crossings. */
export function validateZonePolygon(points: Array<[number, number]>): string | null {
  if (points.length < 3) return 'Add at least 3 corners'
  if (points.length > 64) return 'Use at most 64 corners'
  const cross = (a: [number, number], b: [number, number], c: [number, number]): number =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const on = (a: [number, number], b: [number, number], p: [number, number]): boolean =>
    Math.abs(cross(a, b, p)) <= 1e-9 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]; const b = points[(i + 1) % points.length]
    if (Math.abs(cross(a, b, points[(i + 2) % points.length])) <= 1e-9) return 'Corners must not be collinear'
    area += a[0] * b[1] - b[0] * a[1]
    for (let j = i + 1; j < points.length; j++) {
      if (Math.hypot(a[0] - points[j][0], a[1] - points[j][1]) <= 1e-9) return 'Corners must be distinct'
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue
      const c = points[j]; const d = points[(j + 1) % points.length]
      const ac = cross(a, b, c); const ad = cross(a, b, d)
      const ca = cross(c, d, a); const cb = cross(c, d, b)
      if ((ac * ad < 0 && ca * cb < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) {
        return 'Edges must not cross'
      }
    }
  }
  return Math.abs(area) <= 1e-9 ? 'Area is too small' : null
}

export function nextColor(zones: Zone[]): string {
  return PALETTE[zones.length % PALETTE.length]
}

// Map a hex color to an rgba() string at the given alpha (handles #rgb and #rrggbb).
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = Number.parseInt(h, 16)
  if (!Number.isFinite(n)) return `rgba(55,160,212,${alpha})`
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

/** Remember restored/current names and advance the automatic `area N` counter. */
export function seedZoneNames(zones: readonly Zone[]): void {
  loadNameHistory()
  let changed = false
  for (const zone of zones) {
    const name = zone.name.trim()
    if (!name) continue
    if (!reservedNames.has(name)) {
      reservedNames.add(name)
      changed = true
    }
    const before = nextAreaNumber
    noteAreaNumber(name)
    changed ||= before !== nextAreaNumber
  }
  if (changed) saveNameHistory()
}

/** Reserve a user-entered name so deleting/renaming an area never frees it. */
export function reserveZoneName(name: string): void {
  loadNameHistory()
  const clean = name.trim()
  if (!clean) return
  reservedNames.add(clean)
  noteAreaNumber(clean)
  saveNameHistory()
}

/**
 * Make a user-entered zone name unique against both live zones and historical
 * names. Leaving the current name unchanged is always allowed.
 */
export function uniqueZoneName(
  requested: string,
  zones: readonly Zone[],
  zoneId: string,
  currentName: string
): string {
  loadNameHistory()
  seedZoneNames(zones)
  const base = requested.trim() || currentName.trim() || 'area'
  if (base === currentName.trim()) return currentName.trim()

  const unavailable = new Set(reservedNames)
  for (const zone of zones) {
    if (zone.id !== zoneId) unavailable.add(zone.name.trim())
  }

  const candidate = availableName(base, unavailable)
  reserveZoneName(candidate)
  return candidate
}

/** Allocate an `area N` name without reusing deleted names. */
export function allocateZoneName(existing: readonly Zone[]): string {
  loadNameHistory()
  seedZoneNames(existing)
  let candidate = ''
  for (; nextAreaNumber <= MAX_AREA_NUMBER; nextAreaNumber++) {
    const name = `area ${nextAreaNumber}`
    if (reservedNames.has(name)) continue
    candidate = name
    nextAreaNumber++
    break
  }
  if (!candidate) candidate = availableName('area extra', reservedNames)
  reservedNames.add(candidate)
  saveNameHistory()
  return candidate
}

/** Build a fresh touch area from a normalized polygon. */
export function makeZone(polygon: Array<[number, number]>, existing: Zone[]): Zone {
  return {
    id: `z${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: allocateZoneName(existing),
    color: nextColor(existing),
    enabled: true,
    touch: true,
    polygon: clampZonePolygon(polygon)
  }
}

// This expression intentionally matches src/main/touch.ts exactly.
const ILLEGAL_OSC_SEGMENT = /[\x00-\x1f\x7f #*,/?[\]{}]+/g

/** Sanitize one name for use as an OSC address segment. */
export function sanitizeOscSegment(name: string): string {
  return name.replace(ILLEGAL_OSC_SEGMENT, '_').replace(/^_+|_+$/g, '') || 'zone'
}

/** Zone id -> unique OSC segment, deduped in list order exactly like main. */
export function oscZoneNames(zones: readonly Zone[]): Map<string, string> {
  const result = new Map<string, string>()
  const used = new Set<string>()
  for (const zone of zones) {
    const base = sanitizeOscSegment(zone.name)
    let candidate = base
    for (let suffix = 2; used.has(candidate) && suffix <= used.size + 1; suffix++) candidate = `${base}_${suffix}`
    used.add(candidate)
    result.set(zone.id, candidate)
  }
  return result
}

/** Normalize the configured prefix exactly like src/main/osc.ts. */
export function normalizeOscPrefix(raw: string, fallback = '/wall'): string {
  let prefix = (raw || fallback).trim()
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  prefix = prefix.replace(/\/+$/, '').replace(/[ #*,?[\]{}]+/g, '_')
  return prefix || fallback
}

export function zoneTouchAddress(prefix: string, segment: string): string {
  return `${normalizeOscPrefix(prefix)}/zone/${segment}/touch`
}
