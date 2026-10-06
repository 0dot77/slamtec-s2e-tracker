import { TouchPhase, type Track, type Zone } from '../shared/types'
import { ZoneEvaluator } from './pipeline/zones'

/** One touch lifecycle event, ready for OSC encoding. */
export interface TouchEvent {
  id: number // touch id (not the track id)
  phase: TouchPhase
  u: number // normalized wall coords, v top-down
  v: number
  zone: string // OSC-sanitized touch-area name, '' when no touch areas exist
  lu: number // coords local to the touch area's bounding box (v top-down)
  lv: number
}

interface ActiveTouch {
  id: number
  zoneId: string // '' = whole calibrated area
  zone: string
  u: number
  v: number
  lu: number
  lv: number
}

interface TouchArea {
  id: string
  name: string // OSC-sanitized, deduped
  polygon: Array<[number, number]>
  minU: number
  minV: number
  spanU: number
  spanV: number
}

// OSC forbids these in an address segment.
const ILLEGAL = /[\x00-\x1f\x7f #*,/?[\]{}]+/g

/** Sanitize one zone name into an OSC address segment (see README contract). */
export function sanitizeSegment(name: string): string {
  return name.replace(ILLEGAL, '_').replace(/^_+|_+$/g, '') || 'zone'
}

/** Zone id -> unique OSC segment, deduped in list order with _2, _3, ... */
export function oscZoneNames(zones: Zone[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const z of zones) {
    const base = sanitizeSegment(z.name)
    let name = base
    for (let k = 2; used.has(name); k++) name = `${base}_${k}`
    used.add(name)
    out.set(z.id, name)
  }
  return out
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)
// With a validated prefix (at most 65 ASCII bytes), 200 ids plus /frame fit
// together in the final 1200-byte bundle. Extra tracks remain visualized.
const MAX_TOUCHES = 200

/**
 * Turns per-frame tracks into touch begin/move/end/cancel events.
 *
 * - Touch areas = enabled zones with `touch !== false`. When any exist, a
 *   track only touches while inside one; it is tagged with that area and
 *   area-local coordinates. Crossing into another area ends the touch and
 *   begins a new one (new id) in the new area.
 * - With no touch areas, every track inside the calibrated square touches.
 * - Touch ids are independent of track ids and never reused in a session.
 */
export class TouchManager {
  private active = new Map<number, ActiveTouch>() // track id -> touch
  private nextId = 1
  private areas: TouchArea[] = []
  private areasKey = ''

  /** Recompute touch areas when the zone list changes (cheap identity check). */
  setZones(zones: Zone[]): void {
    const key = JSON.stringify(zones.map((z) => [z.id, z.name, z.enabled, z.touch, z.polygon]))
    if (key === this.areasKey) return
    this.areasKey = key
    const names = oscZoneNames(zones)
    this.areas = []
    for (const z of zones) {
      if (!z.enabled || z.touch === false || z.polygon.length < 3) continue
      let minU = Infinity
      let minV = Infinity
      let maxU = -Infinity
      let maxV = -Infinity
      for (const [x, y] of z.polygon) {
        if (x < minU) minU = x
        if (x > maxU) maxU = x
        if (y < minV) minV = y
        if (y > maxV) maxV = y
      }
      this.areas.push({
        id: z.id,
        name: names.get(z.id) ?? sanitizeSegment(z.name),
        polygon: z.polygon,
        minU,
        minV,
        spanU: Math.max(1e-9, maxU - minU),
        spanV: Math.max(1e-9, maxV - minV)
      })
    }
  }

  get count(): number {
    return this.active.size
  }

  /** Active touch ids (for the `/alive` snapshot). */
  aliveIds(): number[] {
    const ids: number[] = []
    for (const t of this.active.values()) ids.push(t.id)
    return ids.sort((a, b) => a - b)
  }

  /**
   * Advance one frame. `allowed` = touch output gate (calibrated + background
   * ready + not calibrating); when false every active touch is cancelled.
   */
  update(tracks: Track[], allowed: boolean): TouchEvent[] {
    if (!allowed) return this.cancelAll()

    const events: TouchEvent[] = []
    const seen = new Set<number>()

    for (const t of tracks) {
      if (!Number.isFinite(t.u) || !Number.isFinite(t.v) || t.u < 0 || t.u > 1 || t.v < 0 || t.v > 1) continue
      const u = clamp01(t.u)
      const v = clamp01(t.v)
      const hit = this.locate(u, v)
      if (!hit) continue // outside every touch area
      seen.add(t.id)

      const prev = this.active.get(t.id)
      if (prev && prev.zoneId === hit.zoneId) {
        prev.u = u
        prev.v = v
        prev.lu = hit.lu
        prev.lv = hit.lv
        events.push(this.event(prev, TouchPhase.move))
        continue
      }
      if (prev) events.push(this.event(prev, TouchPhase.end))
      if ((!prev && this.active.size >= MAX_TOUCHES) || this.nextId > 0x7fffffff) {
        if (prev) this.active.delete(t.id)
        continue
      }
      const touch: ActiveTouch = { id: this.nextId++, zoneId: hit.zoneId, zone: hit.zone, u, v, lu: hit.lu, lv: hit.lv }
      this.active.set(t.id, touch)
      events.push(this.event(touch, TouchPhase.begin))
    }

    for (const [trackId, touch] of this.active) {
      if (seen.has(trackId)) continue
      events.push(this.event(touch, TouchPhase.end))
      this.active.delete(trackId)
    }
    return events
  }

  /** Cancel every active touch (stall, stop, calibration, readiness lost). */
  cancelAll(): TouchEvent[] {
    const events: TouchEvent[] = []
    for (const touch of this.active.values()) events.push(this.event(touch, TouchPhase.cancel))
    this.active.clear()
    return events
  }

  private locate(u: number, v: number): { zoneId: string; zone: string; lu: number; lv: number } | null {
    if (this.areas.length === 0) return { zoneId: '', zone: '', lu: u, lv: v }
    for (const a of this.areas) {
      if (!ZoneEvaluator.contains(a.polygon, u, v)) continue
      return {
        zoneId: a.id,
        zone: a.name,
        lu: clamp01((u - a.minU) / a.spanU),
        lv: clamp01((v - a.minV) / a.spanV)
      }
    }
    return null
  }

  private event(t: ActiveTouch, phase: TouchPhase): TouchEvent {
    return { id: t.id, phase, u: t.u, v: t.v, zone: t.zone, lu: t.lu, lv: t.lv }
  }
}
