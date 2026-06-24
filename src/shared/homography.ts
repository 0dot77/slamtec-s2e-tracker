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
 * Solves the standard 8x8 DLT linear system (h33 fixed to 1) via Gaussian
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

  // Build the 8x8 system A·h = b, with unknowns h = [h0..h7] and h8 = 1.
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const x = src[i][0]
    const y = src[i][1]
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

  const H: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
  for (const m of H) {
    if (!isFiniteNum(m)) {
      console.warn('[homography] computeHomography: non-finite solution; using identity')
      return identity()
    }
  }
  return H
}

/**
 * Apply a homography to a point: perspective transform with divide by w.
 * Returns the mapped [u, v]. If w is ~0 (point on the line at infinity for
 * this map) the raw numerators are returned unscaled to avoid NaN/Infinity.
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
