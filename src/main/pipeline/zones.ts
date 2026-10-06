import type { Track, Zone, ZoneRuntime, ZoneEvent } from '../../shared/types'

/**
 * Evaluates per-frame zone occupancy from tracked people and emits
 * enter/exit events by diffing against the previous frame.
 *
 * Tracks are tested in NORMALIZED (u, v) space against the zone polygon,
 * which is itself normalized [0, 1] (homography output, placement-invariant).
 * State is kept internally across calls, so reuse one instance per pipeline.
 */
export class ZoneEvaluator {
  // Previous-frame occupant ids per zone id (Set for O(1) membership), plus
  // the zone name at that time so exits can be reported after a delete/rename.
  private prev = new Map<string, Set<number>>()
  private prevName = new Map<string, string>()

  /**
   * Ray-casting point-in-polygon test. Returns true when (x, y) lies inside
   * the polygon. Vertices are [x, y] pairs; the ring is treated as closed.
   */
  static contains(polygon: Array<[number, number]>, x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    let inside = false
    const n = polygon.length
    if (n < 3) return false
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = polygon[i]
      const [xj, yj] = polygon[j]
      // Treat the polygon boundary as inside. Without this, the conventional
      // half-open ray test rejects (for example) u=1 on a full-wall rectangle,
      // even though the calibrated wall includes the closed [0, 1] boundary.
      const dx = xj - xi
      const dy = yj - yi
      const cross = (x - xi) * dy - (y - yi) * dx
      if (
        Math.abs(cross) <= 1e-9 &&
        x >= Math.min(xi, xj) - 1e-9 &&
        x <= Math.max(xi, xj) + 1e-9 &&
        y >= Math.min(yi, yj) - 1e-9 &&
        y <= Math.max(yi, yj) + 1e-9
      ) {
        return true
      }
      const intersects =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
      if (intersects) inside = !inside
    }
    return inside
  }

  /**
   * Compute runtime occupancy for each zone and the enter/exit events that
   * occurred since the previous call.
   *
   * Enabled zones run point-in-polygon over every track's (u, v); occupants
   * are sorted track ids and `active` is `occupants.length > 0`. Disabled zones
   * yield `{ active: false, occupants: [] }`; occupants they still held get an
   * `exit` so every `enter` is paired. Deleted zones exit their occupants too.
   */
  evaluate(tracks: Track[], zones: Zone[]): { runtime: ZoneRuntime[]; events: ZoneEvent[] } {
    const runtime: ZoneRuntime[] = []
    const events: ZoneEvent[] = []
    const seen = new Set<string>()

    for (const zone of zones) {
      seen.add(zone.id)

      if (!zone.enabled || zone.polygon.length < 3) {
        // Disabled (or degenerate) zone: close out its occupants, then forget it.
        this.flushExits(zone.id, events)
        runtime.push({ ...zone, active: false, occupants: [] })
        continue
      }

      // A zone name is part of the public event identity. Pair occupants'
      // prior-name enters with exits before emitting new-name enters.
      const previousName = this.prevName.get(zone.id)
      if (previousName !== undefined && previousName !== zone.name) this.flushExits(zone.id, events)

      const occupants: number[] = []
      for (const t of tracks) {
        if (ZoneEvaluator.contains(zone.polygon, t.u, t.v)) occupants.push(t.id)
      }
      occupants.sort((a, b) => a - b)

      const prevSet = this.prev.get(zone.id)
      const curSet = new Set<number>(occupants)

      // Enters: in current, not in previous.
      for (const id of occupants) {
        if (!prevSet || !prevSet.has(id)) events.push({ zone: zone.name, id, type: 'enter' })
      }
      // Exits: in previous, not in current.
      if (prevSet) {
        for (const id of prevSet) {
          if (!curSet.has(id)) events.push({ zone: zone.name, id, type: 'exit' })
        }
      }

      this.prev.set(zone.id, curSet)
      this.prevName.set(zone.id, zone.name)
      runtime.push({ ...zone, active: occupants.length > 0, occupants })
    }

    // Drop history for zones that no longer exist so deleting then recreating a
    // zone id does not leak stale occupancy.
    for (const id of [...this.prev.keys()]) {
      if (!seen.has(id)) this.flushExits(id, events)
    }

    return { runtime, events }
  }

  /**
   * Exit events for everything currently inside any zone, then clear state.
   * Call on stop / re-learn / stall so receivers never keep a stale occupant.
   */
  drain(): ZoneEvent[] {
    const events: ZoneEvent[] = []
    for (const id of [...this.prev.keys()]) this.flushExits(id, events)
    return events
  }

  /** Clear all retained occupancy state without emitting exits. */
  reset(): void {
    this.prev.clear()
    this.prevName.clear()
  }

  private flushExits(zoneId: string, events: ZoneEvent[]): void {
    const set = this.prev.get(zoneId)
    const name = this.prevName.get(zoneId)
    if (set && name !== undefined) {
      for (const id of set) events.push({ zone: name, id, type: 'exit' })
    }
    this.prev.delete(zoneId)
    this.prevName.delete(zoneId)
  }
}
