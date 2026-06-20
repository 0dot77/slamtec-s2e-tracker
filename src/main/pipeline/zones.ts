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
  // Previous-frame occupant ids per zone id (Set for O(1) membership).
  private prev = new Map<string, Set<number>>()

  /**
   * Ray-casting point-in-polygon test. Returns true when (x, y) lies inside
   * the polygon. Vertices are [x, y] pairs; the ring is treated as closed.
   */
  private static contains(polygon: Array<[number, number]>, x: number, y: number): boolean {
    let inside = false
    const n = polygon.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = polygon[i]
      const [xj, yj] = polygon[j]
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
   * yield `{ active: false, occupants: [] }` and emit no events; their prior
   * occupancy is dropped so re-enabling starts fresh (no stale enter/exit).
   */
  evaluate(tracks: Track[], zones: Zone[]): { runtime: ZoneRuntime[]; events: ZoneEvent[] } {
    const runtime: ZoneRuntime[] = []
    const events: ZoneEvent[] = []
    const seen = new Set<string>()

    for (const zone of zones) {
      seen.add(zone.id)

      if (!zone.enabled || zone.polygon.length < 3) {
        // Disabled (or degenerate) zone: inert, and forget its history so a
        // re-enable does not spuriously fire enter/exit for stale occupants.
        this.prev.delete(zone.id)
        runtime.push({ ...zone, active: false, occupants: [] })
        continue
      }

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
      runtime.push({ ...zone, active: occupants.length > 0, occupants })
    }

    // Drop history for zones that no longer exist so deleting then recreating a
    // zone id does not leak stale occupancy.
    for (const id of this.prev.keys()) {
      if (!seen.has(id)) this.prev.delete(id)
    }

    return { runtime, events }
  }

  /** Clear all retained occupancy state (e.g. on bridge stop / re-learn). */
  reset(): void {
    this.prev.clear()
  }
}
