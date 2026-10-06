// Angle-bin background subtraction.
//
// The LiDAR sweeps 360 degrees per revolution. We carve that sweep into
// `binCount` angular bins and learn, per bin, the distance to the static
// surface as the *median* of all samples collected over the learning window,
// plus a robust noise estimate (MAD). The median (rather than a rolling
// minimum) is robust to transient objects that drift into the scan plane while
// learning.
//
// Wall mounting makes "no return" directions common (the plane runs along the
// wall into open space). A bin only gets a distance baseline when it returned
// in at least `bgMinReturnRatio` of the learning frames; otherwise it is
// learned as EMPTY and any later return there is foreground. This prevents a
// hand seen in a single learning frame from becoming a permanent baseline.
//
// At runtime a point counts as foreground when it sits at least
// max(bgDeltaMm, bgNoiseK * sigma_bin) *closer* than its bin baseline.
//
// Conventions (matching RawScan): angle is DEGREES, dist is MILLIMETERS, with
// the sensor at the origin.
import type { FgPoints, PipelineConfig } from '../../shared/types'
import { applyHomographyStrict, type Mat3 } from '../../shared/homography'

const DEG2RAD = Math.PI / 180
// MAD -> standard deviation for normally distributed range noise.
const MAD_TO_SIGMA = 1.4826

/** Serializable learned baseline (persisted across app restarts). */
export interface BackgroundSnapshot {
  binCount: number
  // Per-bin baseline distance in mm; null = learned empty (no stable return).
  baseline: Array<number | null>
  sigma: number[]
}

/** Optional per-call mask applied while extracting foreground. */
export interface SubtractMask {
  // Calibration homography; points mapping outside the margin are dropped.
  roi: Mat3 | null
  roiMargin: number
}

function median(values: number[]): number {
  if (values.length === 0) return NaN
  const a = values.slice().sort((x, y) => x - y)
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

/** True when angle `a` (deg) lies in the sector [min, max], wrapping through 0 when min > max. */
export function inSector(a: number, min: number, max: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(min) || !Number.isFinite(max)) return false
  if (max - min >= 360) return true
  let x = a % 360
  if (x < 0) x += 360
  let lo = min % 360
  if (lo < 0) lo += 360
  let hi = max % 360
  if (hi < 0) hi += 360
  if (lo === hi) return true
  return lo < hi ? x >= lo && x <= hi : x >= lo || x <= hi
}

export class BackgroundModel {
  private readonly binCount: number
  private readonly binWidth: number // degrees per bin

  // Per-bin learned surface distance (mm). NaN = learned empty / unlearned.
  private readonly baseline: Float32Array
  // Per-bin robust noise sigma (mm).
  private readonly sigma: Float32Array

  private hasBaseline = false

  private learnTarget = 0
  private learnSeen = 0
  private isLearning = false
  private minReturnRatio = 0.5

  // Per-bin samples during learning, plus the number of frames in which the
  // bin returned at least once (for the return-ratio test).
  private samples: number[][] = []
  private framesWithReturn = new Uint16Array(0)
  private lastFrameMark = new Uint32Array(0)

  private learnedBins = 0

  // Reusable output buffers for subtract(). Returned as subarray views, so the
  // result is only valid until the next subtract() call (consumed synchronously).
  private scAngle = new Float32Array(0)
  private scDist = new Float32Array(0)
  private scX = new Float32Array(0)
  private scY = new Float32Array(0)

  constructor(binCount = 2880) {
    this.binCount = Math.max(1, binCount | 0)
    this.binWidth = 360 / this.binCount
    this.baseline = new Float32Array(this.binCount).fill(NaN)
    this.sigma = new Float32Array(this.binCount)
  }

  startLearn(frames: number, minReturnRatio = 0.5): void {
    this.learnTarget = Math.max(1, frames | 0)
    this.learnSeen = 0
    this.isLearning = true
    this.hasBaseline = false
    this.learnedBins = 0
    this.minReturnRatio = Math.max(0, Math.min(1, minReturnRatio))
    this.baseline.fill(NaN)
    this.sigma.fill(0)
    this.samples = Array.from({ length: this.binCount }, () => [])
    this.framesWithReturn = new Uint16Array(this.binCount)
    this.lastFrameMark = new Uint32Array(this.binCount)
  }

  reset(): void {
    this.learnTarget = 0
    this.learnSeen = 0
    this.isLearning = false
    this.hasBaseline = false
    this.learnedBins = 0
    this.baseline.fill(NaN)
    this.sigma.fill(0)
    this.samples = []
    this.framesWithReturn = new Uint16Array(0)
    this.lastFrameMark = new Uint32Array(0)
  }

  get learning(): boolean {
    return this.isLearning
  }

  /** A finished baseline exists (learned or restored). */
  get ready(): boolean {
    return this.hasBaseline && !this.isLearning
  }

  get progress(): number {
    if (this.isLearning) return this.learnTarget ? this.learnSeen / this.learnTarget : 0
    return this.hasBaseline ? 1 : 0
  }

  /** Bins holding a distance baseline (learned-empty bins excluded). */
  get coveredBins(): number {
    return this.learnedBins
  }

  get totalBins(): number {
    return this.binCount
  }

  private binOf(angleDeg: number): number {
    let a = angleDeg % 360
    if (a < 0) a += 360
    let bin = (a / this.binWidth) | 0
    if (bin >= this.binCount) bin = this.binCount - 1
    return bin
  }

  addFrame(angle: Float32Array, dist: Float32Array, count: number): void {
    if (!this.isLearning) return

    const n = Math.min(count, angle.length, dist.length)
    const mark = this.learnSeen + 1
    for (let i = 0; i < n; i++) {
      const d = dist[i]
      const a = angle[i]
      if (!(d > 0) || !Number.isFinite(d) || !Number.isFinite(a)) continue
      const bin = this.binOf(a)
      this.samples[bin].push(d)
      if (this.lastFrameMark[bin] !== mark) {
        this.lastFrameMark[bin] = mark
        this.framesWithReturn[bin]++
      }
    }

    this.learnSeen++
    if (this.learnSeen >= this.learnTarget) this.finishLearn()
  }

  private finishLearn(): void {
    const minFrames = Math.max(1, Math.ceil(this.learnSeen * this.minReturnRatio))
    let learned = 0
    for (let bin = 0; bin < this.binCount; bin++) {
      const s = this.samples[bin]
      if (s.length > 0 && this.framesWithReturn[bin] >= minFrames) {
        const med = median(s)
        const dev = s.map((d) => Math.abs(d - med))
        this.baseline[bin] = med
        this.sigma[bin] = median(dev) * MAD_TO_SIGMA
        learned++
      } else {
        this.baseline[bin] = NaN // learned empty
        this.sigma[bin] = 0
      }
    }
    this.learnedBins = learned
    // A completed window is a valid baseline even if every bin is empty (a
    // wall plane into open space can legitimately return nothing).
    this.hasBaseline = true
    this.isLearning = false
    this.samples = []
    this.framesWithReturn = new Uint16Array(0)
    this.lastFrameMark = new Uint32Array(0)
  }

  snapshot(): BackgroundSnapshot | null {
    if (!this.ready) return null
    const baseline: Array<number | null> = new Array(this.binCount)
    const sigma: number[] = new Array(this.binCount)
    for (let i = 0; i < this.binCount; i++) {
      baseline[i] = Number.isNaN(this.baseline[i]) ? null : Math.round(this.baseline[i] * 10) / 10
      sigma[i] = Math.round(this.sigma[i] * 10) / 10
    }
    return { binCount: this.binCount, baseline, sigma }
  }

  /** Restore a persisted baseline. Returns false (and changes nothing) on mismatch. */
  restore(snap: BackgroundSnapshot): boolean {
    if (!snap || snap.binCount !== this.binCount) return false
    if (!Array.isArray(snap.baseline) || snap.baseline.length !== this.binCount) return false
    if (!Array.isArray(snap.sigma) || snap.sigma.length !== this.binCount) return false
    // Validate the complete snapshot before mutating live state. Treating a
    // corrupt number as an empty bin would make every return there foreground,
    // while this method promises to leave the current model unchanged on a
    // mismatch.
    for (let i = 0; i < this.binCount; i++) {
      const b = snap.baseline[i]
      const s = snap.sigma[i]
      if (!(b === null || (typeof b === 'number' && Number.isFinite(b) && b > 0))) return false
      if (!(typeof s === 'number' && Number.isFinite(s) && s >= 0)) return false
    }

    let learned = 0
    for (let i = 0; i < this.binCount; i++) {
      const b = snap.baseline[i]
      this.baseline[i] = b === null ? NaN : b
      this.sigma[i] = snap.sigma[i]
      if (b !== null) learned++
    }
    this.learnedBins = learned
    this.learnTarget = 0
    this.learnSeen = 0
    this.hasBaseline = true
    this.isLearning = false
    this.samples = []
    this.framesWithReturn = new Uint16Array(0)
    this.lastFrameMark = new Uint32Array(0)
    return true
  }

  /**
   * Extract foreground points in angle order. Applies the scan mask (sector,
   * range, quality), the background test, and the optional calibration ROI.
   * Without a baseline every masked-in point is foreground.
   *
   * The returned arrays are views into reusable buffers: valid until the next
   * call. Every consumer in the pipeline reads them synchronously.
   */
  subtract(
    angle: Float32Array,
    dist: Float32Array,
    quality: Uint8Array | undefined,
    count: number,
    cfg: PipelineConfig,
    mask?: SubtractMask
  ): FgPoints {
    const n = Math.min(count, angle.length, dist.length)
    this.ensureScratch(n)

    const baseline = this.baseline
    const sigma = this.sigma
    const delta = cfg.bgDeltaMm
    const noiseK = cfg.bgNoiseK
    const useBaseline = this.hasBaseline
    const aMin = cfg.angleMinDeg
    const aMax = cfg.angleMaxDeg
    const fullCircle = aMax - aMin >= 360
    const rMin = cfg.rangeMinMm
    const rMax = cfg.rangeMaxMm
    const qMin = cfg.minQuality
    const roi = mask?.roi ?? null
    const lo = -(mask?.roiMargin ?? 0)
    const hi = 1 + (mask?.roiMargin ?? 0)

    const outAngle = this.scAngle
    const outDist = this.scDist
    const outX = this.scX
    const outY = this.scY

    let m = 0
    for (let i = 0; i < n; i++) {
      const d = dist[i]
      if (!(d > 0) || d < rMin || d > rMax) continue
      const a = angle[i]
      if (!Number.isFinite(a)) continue
      if (!fullCircle && !inSector(a, aMin, aMax)) continue
      if (qMin > 0 && (!quality || i >= quality.length || quality[i] < qMin)) continue

      if (useBaseline) {
        const bin = this.binOf(a)
        const base = baseline[bin]
        if (!Number.isNaN(base)) {
          const thr = Math.max(delta, noiseK * sigma[bin])
          if (base - d < thr) continue
        }
      }

      const rad = a * DEG2RAD
      const x = Math.cos(rad) * d
      const y = Math.sin(rad) * d
      if (roi) {
        const [u, v] = applyHomographyStrict(roi, x, y)
        if (!(u >= lo && u <= hi && v >= lo && v <= hi)) continue
      }
      outAngle[m] = a
      outDist[m] = d
      outX[m] = x
      outY[m] = y
      m++
    }

    return {
      count: m,
      angle: outAngle.subarray(0, m),
      dist: outDist.subarray(0, m),
      x: outX.subarray(0, m),
      y: outY.subarray(0, m)
    }
  }

  private ensureScratch(n: number): void {
    if (this.scAngle.length >= n) return
    this.scAngle = new Float32Array(n)
    this.scDist = new Float32Array(n)
    this.scX = new Float32Array(n)
    this.scY = new Float32Array(n)
  }
}
