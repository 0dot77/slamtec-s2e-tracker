import type { Cluster, PipelineConfig, Track } from '../../shared/types'

/**
 * Internal track record. Extends the public Track shape with the bookkeeping
 * fields needed for birth/death hysteresis. Only confirmed tracks are emitted.
 */
interface TrackState extends Track {
  matchCount: number // consecutive frames matched (drives birth)
  confirmed: boolean // promoted to a real track (post-birth)
}

// Above this many tracks/clusters the O(n^3) assignment falls back to greedy
// matching so a noisy frame can never stall the main process.
const OPTIMAL_MAX = 48

/**
 * Multi-target tracker. Associates clusters to persistent tracks frame to
 * frame by globally optimal (minimum total squared distance) assignment
 * against each track's constant-velocity PREDICTION, inside a distance gate.
 * Smooths position and applies birth/death hysteresis. State is retained
 * across `update` calls.
 *
 * Homography (u, v) is applied later by the integrator; this class always
 * leaves u = v = 0.
 */
export class Tracker {
  private tracks: TrackState[] = []
  private nextId = 1

  update(clusters: Cluster[], cfg: PipelineConfig): Track[] {
    const gate2 = cfg.trackMaxJumpMm * cfg.trackMaxJumpMm
    const alpha = clamp01(cfg.smoothing)
    const tracks = this.tracks

    // 1. Predicted positions (constant velocity across missed frames).
    const px = new Float64Array(tracks.length)
    const py = new Float64Array(tracks.length)
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const steps = t.lostFrames + 1
      px[i] = t.x + t.vx * steps
      py[i] = t.y + t.vy * steps
    }

    // 2. Assignment: track index -> cluster index (or -1).
    const assign =
      tracks.length && clusters.length
        ? tracks.length <= OPTIMAL_MAX && clusters.length <= OPTIMAL_MAX
          ? assignOptimal(px, py, clusters, gate2)
          : assignGreedy(px, py, clusters, gate2)
        : new Int32Array(tracks.length).fill(-1)

    const usedClusters = new Uint8Array(clusters.length)
    const survivors: TrackState[] = []
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      const c = assign[i]
      if (c >= 0) {
        usedClusters[c] = 1
        this.applyMatch(track, clusters[c], alpha, cfg)
        survivors.push(track)
        continue
      }
      // 3. Unmatched: age the miss, drop on death.
      track.lostFrames += 1
      track.age += 1
      track.matchCount = 0
      if (track.confirmed ? track.lostFrames < cfg.deathFrames : false) survivors.push(track)
    }

    // 4. Unmatched clusters become provisional (or instantly confirmed) tracks.
    for (let c = 0; c < clusters.length; c++) {
      if (!usedClusters[c]) survivors.push(this.spawn(clusters[c], cfg))
    }

    this.tracks = survivors

    // 5. Emit a clean copy of confirmed tracks only.
    const out: Track[] = []
    for (const t of survivors) {
      if (!t.confirmed) continue
      out.push({
        id: t.id,
        x: t.x,
        y: t.y,
        vx: t.vx,
        vy: t.vy,
        u: t.u,
        v: t.v,
        age: t.age,
        lostFrames: t.lostFrames
      })
    }
    return out
  }

  /** Reset all internal state (e.g. on stop/restart). Ids continue increasing. */
  reset(): void {
    this.tracks = []
  }

  private applyMatch(track: TrackState, cluster: Cluster, alpha: number, cfg: PipelineConfig): void {
    const px = track.x
    const py = track.y
    const nx = alpha * cluster.cx + (1 - alpha) * px
    const ny = alpha * cluster.cy + (1 - alpha) * py
    // Velocity per frame, lightly smoothed so one noisy centroid does not
    // throw the next prediction off.
    const steps = track.lostFrames + 1
    track.vx = 0.5 * track.vx + 0.5 * ((nx - px) / steps)
    track.vy = 0.5 * track.vy + 0.5 * ((ny - py) / steps)
    track.x = nx
    track.y = ny
    track.lostFrames = 0
    track.matchCount += 1
    track.age += 1
    if (!track.confirmed && track.matchCount >= cfg.birthFrames) track.confirmed = true
  }

  private spawn(cluster: Cluster, cfg: PipelineConfig): TrackState {
    return {
      id: this.nextId++,
      x: cluster.cx,
      y: cluster.cy,
      vx: 0,
      vy: 0,
      u: 0,
      v: 0,
      age: 1,
      lostFrames: 0,
      matchCount: 1,
      confirmed: cfg.birthFrames <= 1
    }
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function assignGreedy(px: Float64Array, py: Float64Array, clusters: Cluster[], gate2: number): Int32Array {
  const pairs: Array<[number, number, number]> = []
  for (let i = 0; i < px.length; i++) {
    for (let j = 0; j < clusters.length; j++) {
      const dx = clusters[j].cx - px[i]
      const dy = clusters[j].cy - py[i]
      const d2 = dx * dx + dy * dy
      if (d2 <= gate2) pairs.push([d2, i, j])
    }
  }
  pairs.sort((a, b) => a[0] - b[0])
  const out = new Int32Array(px.length).fill(-1)
  const usedC = new Uint8Array(clusters.length)
  for (const [, i, j] of pairs) {
    if (out[i] !== -1 || usedC[j]) continue
    out[i] = j
    usedC[j] = 1
  }
  return out
}

/**
 * Minimum-cost assignment (Hungarian / Kuhn-Munkres, O(n^3)) on a square
 * matrix padded with a "no match" cost. Pairs outside the gate cost more than
 * leaving both unmatched, so the optimum never uses them.
 */
function assignOptimal(px: Float64Array, py: Float64Array, clusters: Cluster[], gate2: number): Int32Array {
  const nT = px.length
  const nC = clusters.length
  const n = nT + nC // every track and cluster may also be "unmatched"
  // Prefer the largest feasible matching, then minimize its distance. A
  // gate-sized miss penalty can discard an existing hand even when both
  // detections have a valid assignment (two gated moves versus one zero move).
  const NO = (Math.min(nT, nC) + 1) * (gate2 + 1)
  const BIG = NO * (n + 1) // more expensive than leaving everything unmatched
  // cost[r][c]: rows = tracks + dummy rows, cols = clusters + dummy cols.
  const cost = new Float64Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let v: number
      if (r < nT && c < nC) {
        const dx = clusters[c].cx - px[r]
        const dy = clusters[c].cy - py[r]
        const d2 = dx * dx + dy * dy
        v = d2 <= gate2 ? d2 : BIG
      } else if (r < nT || c < nC) {
        v = NO / 2 // real item paired with a dummy = unmatched
      } else {
        v = 0 // dummy-dummy
      }
      cost[r * n + c] = v
    }
  }

  // Standard e-maxx Hungarian with potentials, 1-indexed.
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const p = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  const minv = new Float64Array(n + 1)
  const used = new Uint8Array(n + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    minv.fill(Infinity)
    used.fill(0)
    do {
      used[j0] = 1
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[(i0 - 1) * n + (j - 1)] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }

  const out = new Int32Array(nT).fill(-1)
  for (let j = 1; j <= nC; j++) {
    const r = p[j] - 1
    if (r >= 0 && r < nT && cost[r * n + (j - 1)] <= gate2) out[r] = j - 1
  }
  return out
}
