import type { Cluster, FgPoints, PipelineConfig } from '../../shared/types'

// Internal accumulator: running sums + bounding box for one in-progress cluster.
// We index into the parallel FgPoints arrays so we never copy point coordinates.
interface Acc {
  start: number // first point index (inclusive)
  end: number // last point index (inclusive)
  count: number
  sumX: number
  sumY: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function newAcc(fg: FgPoints, i: number): Acc {
  const x = fg.x[i]
  const y = fg.y[i]
  return {
    start: i,
    end: i,
    count: 1,
    sumX: x,
    sumY: y,
    minX: x,
    maxX: x,
    minY: y,
    maxY: y
  }
}

function pushPoint(acc: Acc, fg: FgPoints, i: number): void {
  const x = fg.x[i]
  const y = fg.y[i]
  acc.end = i
  acc.count++
  acc.sumX += x
  acc.sumY += y
  if (x < acc.minX) acc.minX = x
  else if (x > acc.maxX) acc.maxX = x
  if (y < acc.minY) acc.minY = y
  else if (y > acc.maxY) acc.maxY = y
}

// Merge `b` into `a` in place (used to close the angular wrap-around seam).
function mergeAcc(a: Acc, b: Acc): void {
  a.count += b.count
  a.sumX += b.sumX
  a.sumY += b.sumY
  if (b.minX < a.minX) a.minX = b.minX
  if (b.maxX > a.maxX) a.maxX = b.maxX
  if (b.minY < a.minY) a.minY = b.minY
  if (b.maxY > a.maxY) a.maxY = b.maxY
}

function gapMm(fg: FgPoints, i: number, j: number): number {
  const dx = fg.x[i] - fg.x[j]
  const dy = fg.y[i] - fg.y[j]
  return Math.hypot(dx, dy)
}

/**
 * Segment angle-ordered foreground points into clusters by gap splitting.
 *
 * The scan arrives angle-ordered, so a single 360° sweep of consecutive points
 * is walked once: whenever the Euclidean gap between point i and point i-1
 * exceeds `cfg.clusterGapMm`, the current cluster is closed and a new one begins.
 * The angular wrap-around seam (last point ↔ first point) is closed too: if the
 * first and last clusters are adjacent across that seam (endpoint gap within
 * `clusterGapMm`) and they are not already the same cluster, they are merged so
 * a person straddling the 0°/360° boundary is not split into two blobs.
 *
 * For each cluster: `cx`,`cy` = centroid (mean x, mean y), `count` = point count,
 * and `sizeMm` = the larger axis of the axis-aligned bounding box,
 * i.e. max(maxX - minX, maxY - minY).
 *
 * Clusters are kept only when count >= `cfg.minClusterPts` and
 * `cfg.minSizeMm` <= sizeMm <= `cfg.maxSizeMm`.
 *
 * Pure: depends only on its arguments, holds no state, allocates no shared data.
 */
export function cluster(fg: FgPoints, cfg: PipelineConfig): Cluster[] {
  const n = fg.count
  if (n <= 0) return []

  // Single point: one trivial cluster (centroid = the point, sizeMm = 0).
  // Walk the sweep once, splitting on gaps larger than clusterGapMm.
  const accs: Acc[] = [newAcc(fg, 0)]
  for (let i = 1; i < n; i++) {
    if (gapMm(fg, i, i - 1) > cfg.clusterGapMm) {
      accs.push(newAcc(fg, i))
    } else {
      pushPoint(accs[accs.length - 1], fg, i)
    }
  }

  // Close the wrap-around seam: if the very last point is within clusterGapMm of
  // the very first point, the trailing cluster continues the leading one.
  if (accs.length > 1) {
    const first = accs[0]
    const last = accs[accs.length - 1]
    if (gapMm(fg, last.end, first.start) <= cfg.clusterGapMm) {
      mergeAcc(first, last)
      accs.pop()
    }
  }

  // Finalize + size/count filter.
  const out: Cluster[] = []
  for (const a of accs) {
    if (a.count < cfg.minClusterPts) continue
    const sizeMm = Math.max(a.maxX - a.minX, a.maxY - a.minY)
    if (sizeMm < cfg.minSizeMm || sizeMm > cfg.maxSizeMm) continue
    out.push({
      cx: a.sumX / a.count,
      cy: a.sumY / a.count,
      sizeMm,
      count: a.count
    })
  }
  return out
}
