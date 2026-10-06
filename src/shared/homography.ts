// Dependency-free 4-point homography (planar projective transform).
//
// Maps a LiDAR-mm quad to the unit square so downstream coordinates are
// placement-invariant. A general (perspective-distorted) quad is handled
// exactly; a parallelogram degrades gracefully to an affine map.
//
// Conventions:
//   - Mat3 is a length-9, row-major 3x3:
//       [ m0 m1 m2 ]
//       [ m3 m4 m5 ]
//       [ m6 m7 m8 ]
//   - Forward map: src LiDAR-mm (x, y) -> normalized (u, v) in [0, 1].
//   - No external dependencies; all linear algebra is hand-rolled.

import type { CalibrationPoints } from './types'

export type Mat3 = number[]

// Row-major 3x3 identity. Used as a safe fallback for degenerate input.
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

// Destination corners, in correspondence order with CalibrationPoints["src"]:
//   src[0] -> (0,0), src[1] -> (1,0), src[2] -> (1,1), src[3] -> (0,1).
const DST: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
]

const identity = (): Mat3 => IDENTITY.slice()

const isFiniteNum = (n: number): boolean => typeof n === 'number' && Number.isFinite(n)

/**
 * Compute the 3x3 homography mapping the 4 source LiDAR-mm points to the
 * unit-square corners (0,0), (1,0), (1,1), (0,1).
 *
 * Solves the standard 8x8 DLT linear system (h33 fixed to 1 in centered,
 * scaled source coordinates) via Gaussian
 * elimination with partial pivoting. For each correspondence (x, y) -> (u, v):
 *   u = (h0·x + h1·y + h2) / (h6·x + h7·y + 1)
 *   v = (h3·x + h4·y + h5) / (h6·x + h7·y + 1)
 * which rearranges (multiply through by the denominator) into two linear rows:
 *   h0·x + h1·y + h2            − h6·x·u − h7·y·u = u
 *               h3·x + h4·y + h5 − h6·x·v − h7·y·v = v
 *
 * Returns an identity matrix (with a console.warn) for degenerate or
 * non-finite input.
 */
export function computeHomography(src: CalibrationPoints['src']): Mat3 {
  if (!src || src.length !== 4) {
    console.warn('[homography] computeHomography: expected 4 source points; using identity')
    return identity()
  }
  for (const p of src) {
    if (!p || p.length !== 2 || !isFiniteNum(p[0]) || !isFiniteNum(p[1])) {
      console.warn('[homography] computeHomography: non-finite source point; using identity')
      return identity()
    }
  }

  // Normalize around an interior point. Besides improving conditioning, this
  // allows maps whose denominator is zero at the sensor origin (h33 = 0 in
  // millimeter coordinates), which a raw h33=1 solve cannot represent.
  const centerX = src.reduce((sum, p) => sum + p[0] / 4, 0)
  const centerY = src.reduce((sum, p) => sum + p[1] / 4, 0)
  const scale = Math.max(...src.map((p) => Math.hypot(p[0] - centerX, p[1] - centerY)))
  if (!(scale > 0) || !Number.isFinite(scale)) return identity()

  // Build the 8x8 system A·h = b, with unknowns h = [h0..h7] and h8 = 1.
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const x = (src[i][0] - centerX) / scale
    const y = (src[i][1] - centerY) / scale
    const u = DST[i][0]
    const v = DST[i][1]
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v])
    b.push(v)
  }

  const h = solve8(A, b)
  if (!h) {
    console.warn('[homography] computeHomography: degenerate quad (singular system); using identity')
    return identity()
  }

  // Compose the solved map with the source normalization.
  const H: Mat3 = [
    h[0] / scale, h[1] / scale, h[2] - (h[0] * centerX + h[1] * centerY) / scale,
    h[3] / scale, h[4] / scale, h[5] - (h[3] * centerX + h[4] * centerY) / scale,
    h[6] / scale, h[7] / scale, 1 - (h[6] * centerX + h[7] * centerY) / scale
  ]
  for (const m of H) {
    if (!isFiniteNum(m)) {
      console.warn('[homography] computeHomography: non-finite solution; using identity')
      return identity()
    }
  }
  return H
}

/**
 * Validate a calibration quad before trusting it for touch output. Returns
 * null when usable, else a short reason. Rejects non-finite / duplicate
 * points, a self-intersecting or non-convex ring, and a near-zero area
 * (< 100 cm^2), all of which make the homography singular or fold space.
 */
export function validateQuad(src: CalibrationPoints['src'] | null | undefined): string | null {
  if (!src || src.length !== 4) return 'need 4 points'
  for (const p of src) {
    if (!p || p.length !== 2 || !isFiniteNum(p[0]) || !isFiniteNum(p[1])) return 'non-finite point'
  }
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(src[i][0] - src[j][0], src[i][1] - src[j][1]) < 50) return 'points too close'
    }
  }
  // Convex + consistently wound: every consecutive edge turns the same way.
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = src[i]
    const b = src[(i + 1) % 4]
    const c = src[(i + 2) % 4]
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(cross) < 1e-6) return 'collinear points'
    const sgn = cross > 0 ? 1 : -1
    if (sign === 0) sign = sgn
    else if (sgn !== sign) return 'quad is not convex (check corner order TL, TR, BR, BL)'
  }
  let area2 = 0
  for (let i = 0; i < 4; i++) {
    const a = src[i]
    const b = src[(i + 1) % 4]
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  if (Math.abs(area2) / 2 < 10000) return 'area too small'
  return null
}

/**
 * Strict variant for the live pipeline: returns null instead of an identity
 * fallback when the quad is invalid, so raw millimeters are never mistaken
 * for normalized coordinates.
 */
export function computeHomographyChecked(src: CalibrationPoints['src'] | null | undefined): Mat3 | null {
  if (validateQuad(src) !== null) return null
  let H = computeHomography(src as CalibrationPoints['src'])
  // Scale-normalize so w > 0 across the quad (H and -H are the same map);
  // applyHomographyStrict then rejects points beyond the horizon via w <= 0.
  const w0 = H[6] * src![0][0] + H[7] * src![0][1] + H[8]
  if (w0 < 0) H = H.map((m) => -m)
  // computeHomography only falls back to identity on failure; a valid convex
  // quad never maps to identity unless it literally is the unit square in mm.
  for (let i = 0; i < 4; i++) {
    const [u, v] = applyHomographyStrict(H, src![i][0], src![i][1])
    const [eu, ev] = DST[i]
    if (!isFiniteNum(u) || !isFiniteNum(v) || Math.abs(u - eu) > 1e-6 || Math.abs(v - ev) > 1e-6) return null
  }
  return H
}

/**
 * Apply a homography to a point: perspective transform with divide by w.
 * Returns the mapped [u, v]. If w is ~0 (point on the line at infinity for
 * this map) the raw numerators are returned unscaled to avoid NaN/Infinity;
 * use applyHomographyStrict where such points must be rejected.
 */
export function applyHomography(H: Mat3, x: number, y: number): [number, number] {
  const u = H[0] * x + H[1] * y + H[2]
  const v = H[3] * x + H[4] * y + H[5]
  const w = H[6] * x + H[7] * y + H[8]
  if (Math.abs(w) < 1e-12) return [u, v]
  return [u / w, v / w]
}

/**
 * Invert a 3x3 matrix via adjugate / determinant. Used to draw the
 * normalized grid back into LiDAR space. Returns identity (with a
 * console.warn) when the matrix is singular or non-finite.
 */
export function invertMat3(H: Mat3): Mat3 {
  const a = H[0]
  const b = H[1]
  const c = H[2]
  const d = H[3]
  const e = H[4]
  const f = H[5]
  const g = H[6]
  const h = H[7]
  const i = H[8]

  // Cofactors (transposed into the adjugate layout).
  const A = e * i - f * h
  const B = c * h - b * i
  const C = b * f - c * e
  const D = f * g - d * i
  const E = a * i - c * g
  const F = c * d - a * f
  const G = d * h - e * g
  const Hc = b * g - a * h
  const I = a * e - b * d

  const det = a * A + b * D + c * G
  if (!isFiniteNum(det) || Math.abs(det) < 1e-12) {
    console.warn('[homography] invertMat3: singular matrix; using identity')
    return identity()
  }
  const inv = 1 / det
  const out: Mat3 = [A * inv, B * inv, C * inv, D * inv, E * inv, F * inv, G * inv, Hc * inv, I * inv]
  for (const m of out) {
    if (!isFiniteNum(m)) {
      console.warn('[homography] invertMat3: non-finite inverse; using identity')
      return identity()
    }
  }
  return out
}

/**
 * Solve a dense n×n linear system A·x = b by Gaussian elimination with
 * partial pivoting. Operates on copies; returns the solution vector, or
 * null if the matrix is singular (zero pivot). n is fixed at 8 here.
 */
function solve8(Ain: number[][], bin: number[]): number[] | null {
  const n = 8
  // Augmented matrix [A | b], copied so callers keep their inputs.
  const M: number[][] = new Array(n)
  for (let r = 0; r < n; r++) {
    const row = new Array<number>(n + 1)
    for (let cIdx = 0; cIdx < n; cIdx++) row[cIdx] = Ain[r][cIdx]
    row[n] = bin[r]
    M[r] = row
  }

  for (let col = 0; col < n; col++) {
    // Partial pivot: pick the row (at or below `col`) with the largest |value|.
    let pivot = col
    let best = Math.abs(M[col][col])
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col])
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (best < 1e-12) return null // singular
    if (pivot !== col) {
      const tmp = M[col]
      M[col] = M[pivot]
      M[pivot] = tmp
    }

    // Eliminate `col` from every other row.
    const pivRow = M[col]
    const pivVal = pivRow[col]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = M[r][col] / pivVal
      if (factor === 0) continue
      const row = M[r]
      for (let cIdx = col; cIdx <= n; cIdx++) row[cIdx] -= factor * pivRow[cIdx]
    }
  }

  // Back-substitution is trivial now: each row r holds pivVal·x_r = rhs.
  const x = new Array<number>(n)
  for (let r = 0; r < n; r++) x[r] = M[r][n] / M[r][r]
  return x
}

/** Like applyHomography but returns NaNs when w ~ 0 or w < 0 (point behind the map's horizon). */
export function applyHomographyStrict(H: Mat3, x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8]
  if (!(w > 1e-12)) return [NaN, NaN]
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]
}
