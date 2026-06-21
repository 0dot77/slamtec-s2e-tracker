// Angle-bin background subtraction.
//
// The LiDAR sweeps 360 degrees per revolution. We carve that sweep into
// `binCount` angular bins and learn, per bin, the distance to the static
// surface as the *median* of all samples collected over the learning window.
// The median (rather than a rolling minimum) is robust to transient objects
// that drift into the scan plane while learning — a person who is only present
// for a minority of frames does not poison the bin, where a minimum would bake
// their distance in permanently and leave that bin blind. At runtime a point
// counts as foreground when it sits at least `bgDeltaMm` *closer* than its bin
// baseline, i.e. something moved in front of the static scene.
//
// Conventions (matching RawScan): angle is DEGREES, dist is MILLIMETERS, with
// the sensor at the origin. Pure module, allocation-light, no dependencies.
import type { FgPoints, PipelineConfig } from '../../shared/types'

const DEG2RAD = Math.PI / 180

/** Median of a numeric array (ascending). Returns NaN for an empty array. */
function median(values: number[]): number {
  if (values.length === 0) return NaN
  const a = values.slice().sort((x, y) => x - y)
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

export class BackgroundModel {
  private readonly binCount: number
  private readonly binWidth: number // degrees per bin

  // Per-bin learned nearest-surface distance (mm). NaN means "no sample yet".
  private readonly baseline: Float32Array

  // True once at least one bin has a learned baseline (learning was run and
  // saw valid points). Until then, subtract() treats everything as foreground.
  private hasBaseline = false

  // Learning-window state.
  private learnTarget = 0 // frames requested for the current window
  private learnSeen = 0 // frames accumulated so far in the current window
  private isLearning = false

  // Per-bin distance samples collected during the active learning window, then
  // reduced to the median baseline and freed. Empty outside of learning.
  private samples: number[][] = []

  // Bins that received a baseline at the last finalize (surfaced to the UI).
  private learnedBins = 0

  // Reusable scratch buffers for subtract(), grown on demand to the largest
  // point count seen. Kept allocation-light across the per-frame hot path.
  private scAngle = new Float32Array(0)
  private scDist = new Float32Array(0)
  private scX = new Float32Array(0)
  private scY = new Float32Array(0)

  constructor(binCount = 720) {
    this.binCount = Math.max(1, binCount | 0)
    this.binWidth = 360 / this.binCount
    this.baseline = new Float32Array(this.binCount).fill(NaN)
  }

  /** Begin a learning window of `frames` frames (per-bin median baseline). */
  startLearn(frames: number): void {
    this.learnTarget = Math.max(1, frames | 0)
    this.learnSeen = 0
    this.isLearning = true
    this.hasBaseline = false
    this.learnedBins = 0
    this.baseline.fill(NaN)
    // Fresh, empty sample buckets for every bin.
    this.samples = Array.from({ length: this.binCount }, () => [])
  }

  /**
   * Discard the learned baseline and cancel any in-progress learning window,
   * returning to the initial "no baseline" state where subtract() treats every
   * valid point as foreground.
   */
  reset(): void {
    this.learnTarget = 0
    this.learnSeen = 0
    this.isLearning = false
    this.hasBaseline = false
    this.learnedBins = 0
    this.baseline.fill(NaN)
    this.samples = []
  }

  /** True while a learning window is still accumulating frames. */
  get learning(): boolean {
    return this.isLearning
  }

  /** Learning progress in [0, 1]: fraction of the window seen, or 1 once done. */
  get progress(): number {
    if (this.isLearning) return this.learnTarget ? this.learnSeen / this.learnTarget : 0
    return this.hasBaseline ? 1 : 0
  }

  /** Number of angular bins that hold a learned baseline. */
  get coveredBins(): number {
    return this.learnedBins
  }

  /** Total number of angular bins. */
  get totalBins(): number {
    return this.binCount
  }

  /** Map an angle in degrees to a bin index, normalized into [0, binCount). */
  private binOf(angleDeg: number): number {
    // Normalize into [0, 360) so negative or wrapped angles land correctly.
    let a = angleDeg % 360
    if (a < 0) a += 360
    let bin = (a / this.binWidth) | 0
    if (bin >= this.binCount) bin = this.binCount - 1 // guard a==360-epsilon rounding
    return bin
  }

  /**
   * Accumulate one frame's samples into the learning window. No-op when not
   * learning. Auto-finishes (reducing samples to per-bin medians) once the
   * requested frame count is reached. Points with dist <= 0 are ignored.
   */
  addFrame(angle: Float32Array, dist: Float32Array, count: number): void {
    if (!this.isLearning) return

    const n = Math.min(count, angle.length, dist.length)
    const samples = this.samples
    for (let i = 0; i < n; i++) {
      const d = dist[i]
      if (d <= 0) continue
      samples[this.binOf(angle[i])].push(d)
    }

    this.learnSeen++
    if (this.learnSeen >= this.learnTarget) this.finishLearn()
  }

  /** Reduce the collected samples to a per-bin median baseline and free them. */
  private finishLearn(): void {
    const baseline = this.baseline
    let learned = 0
    for (let bin = 0; bin < this.binCount; bin++) {
      const s = this.samples[bin]
      if (s.length > 0) {
        baseline[bin] = median(s)
        learned++
      } else {
        baseline[bin] = NaN
      }
    }
    this.learnedBins = learned
    this.hasBaseline = learned > 0
    this.isLearning = false
    this.samples = [] // free the per-bin buckets
  }

  /**
   * Extract foreground points: those at least `cfg.bgDeltaMm` closer than the
   * learned bin baseline (baseline - dist >= bgDeltaMm). If no baseline has
   * been learned yet, all valid (dist > 0) points are returned as foreground.
   * Output arrays are sized to the foreground count and preserve angle order.
   */
  subtract(
    angle: Float32Array,
    dist: Float32Array,
    count: number,
    cfg: PipelineConfig
  ): FgPoints {
    const n = Math.min(count, angle.length, dist.length)
    this.ensureScratch(n)

    const baseline = this.baseline
    const delta = cfg.bgDeltaMm
    const useBaseline = this.hasBaseline

    const outAngle = this.scAngle
    const outDist = this.scDist
    const outX = this.scX
    const outY = this.scY

    let m = 0
    for (let i = 0; i < n; i++) {
      const d = dist[i]
      if (d <= 0) continue

      if (useBaseline) {
        const base = baseline[this.binOf(angle[i])]
        // No baseline for this bin -> nothing static to subtract against; the
        // point is novel, so keep it as foreground. With a baseline, keep only
        // points that are sufficiently closer than the static surface.
        if (!Number.isNaN(base) && base - d < delta) continue
      }

      const a = angle[i]
      const rad = a * DEG2RAD
      outAngle[m] = a
      outDist[m] = d
      outX[m] = Math.cos(rad) * d
      outY[m] = Math.sin(rad) * d
      m++
    }

    // Return exact-sized copies so downstream stages get tight arrays and the
    // scratch buffers stay private to this model.
    return {
      count: m,
      angle: outAngle.slice(0, m),
      dist: outDist.slice(0, m),
      x: outX.slice(0, m),
      y: outY.slice(0, m)
    }
  }

  /** Grow scratch buffers to hold at least `n` points (never shrinks). */
  private ensureScratch(n: number): void {
    if (this.scAngle.length >= n) return
    this.scAngle = new Float32Array(n)
    this.scDist = new Float32Array(n)
    this.scX = new Float32Array(n)
    this.scY = new Float32Array(n)
  }
}
