import type { Cluster, PipelineConfig, Track } from '../../shared/types'

/**
 * Internal track record. Extends the public Track shape with the bookkeeping
 * fields needed for birth/death hysteresis. Only confirmed tracks are emitted.
 */
interface TrackState extends Track {
  matchCount: number // consecutive frames matched (drives birth)
  confirmed: boolean // promoted to a real track (post-birth)
}

/**
 * A candidate match between an existing track and a cluster, with the squared
 * distance between them. Squared distance avoids a sqrt during sorting.
 */
interface Candidate {
  track: TrackState
  cluster: Cluster
  d2: number
}

/**
 * Multi-target tracker. Associates clusters to persistent tracks frame to frame
 * with greedy nearest-neighbour matching inside a distance gate, smooths
 * position, and applies birth/death hysteresis so flicker does not spawn or
 * kill ids. State is retained across `update` calls.
 *
 * Homography (u, v) is applied later by the integrator; this class always
 * leaves u = v = 0.
 */
export class Tracker {
  private tracks: TrackState[] = []
  private nextId = 1

  /**
   * Advance one frame. Returns only confirmed (post-birth) tracks.
   * @param clusters cluster centroids for this frame (LiDAR mm)
   * @param cfg pipeline config (gate, smoothing, birth/death frames)
   */
  update(clusters: Cluster[], cfg: PipelineConfig): Track[] {
    const gate2 = cfg.trackMaxJumpMm * cfg.trackMaxJumpMm
    const alpha = clamp01(cfg.smoothing)

    // 1. Build every track<->cluster pair inside the gate.
    const candidates: Candidate[] = []
    for (const track of this.tracks) {
      for (const cluster of clusters) {
        const dx = cluster.cx - track.x
        const dy = cluster.cy - track.y
        const d2 = dx * dx + dy * dy
        if (d2 <= gate2) candidates.push({ track, cluster, d2 })
      }
    }

    // 2. Greedy match: shortest distance first, each track/cluster used once.
    candidates.sort((a, b) => a.d2 - b.d2)
    const usedTracks = new Set<TrackState>()
    const usedClusters = new Set<Cluster>()
    for (const c of candidates) {
      if (usedTracks.has(c.track) || usedClusters.has(c.cluster)) continue
      usedTracks.add(c.track)
      usedClusters.add(c.cluster)
      this.applyMatch(c.track, c.cluster, alpha, cfg)
    }

    // 3. Unmatched tracks: age the miss, drop on death.
    const survivors: TrackState[] = []
    for (const track of this.tracks) {
      if (usedTracks.has(track)) {
        survivors.push(track)
        continue
      }
      track.lostFrames += 1
      track.age += 1
      track.matchCount = 0 // break the birth streak
      if (track.lostFrames < cfg.deathFrames) survivors.push(track)
    }

    // 4. Unmatched clusters become provisional (or instantly confirmed) tracks.
    for (const cluster of clusters) {
      if (usedClusters.has(cluster)) continue
      survivors.push(this.spawn(cluster, cfg))
    }

    this.tracks = survivors

    // 5. Emit a clean copy of confirmed tracks only.
    const out: Track[] = []
    for (const t of this.tracks) {
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

  /** Smooth a matched track toward its cluster and refresh velocity. */
  private applyMatch(track: TrackState, cluster: Cluster, alpha: number, cfg: PipelineConfig): void {
    const px = track.x
    const py = track.y
    const nx = alpha * cluster.cx + (1 - alpha) * px
    const ny = alpha * cluster.cy + (1 - alpha) * py
    track.vx = nx - px
    track.vy = ny - py
    track.x = nx
    track.y = ny
    track.lostFrames = 0
    track.matchCount += 1
    track.age += 1
    if (!track.confirmed && track.matchCount >= cfg.birthFrames) track.confirmed = true
  }

  /** Create a provisional track from a fresh cluster. */
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
