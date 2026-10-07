import { angleInSector, keptSectorSpan, sensorDegrees } from './scanMask'

export interface ViewOrientation {
  rotationDeg: number
  mirror: boolean
  alignDirection: 'down' | 'up'
}

export interface View extends ViewOrientation {
  scale: number
  ox: number
  oy: number
  dpr: number
  cssW: number
  cssH: number
  // Orthogonal world-mm -> view-mm matrix, including the screen y inversion.
  xx: number
  xy: number
  yx: number
  yy: number
}

export const VIEW_STORAGE_KEY = 's2e.lidar-view.v1'
const DEFAULT_ORIENTATION: ViewOrientation = { rotationDeg: 0, mirror: false, alignDirection: 'down' }

export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const normalized = sensorDegrees(degrees)
  return normalized >= 180 ? normalized - 360 : normalized
}

export function loadViewOrientation(): ViewOrientation {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? 'null')
    if (saved && typeof saved === 'object') return {
      rotationDeg: typeof saved.rotationDeg === 'number' ? normalizeRotation(saved.rotationDeg) : 0,
      mirror: saved.mirror === true,
      alignDirection: saved.alignDirection === 'up' ? 'up' : 'down'
    }
  } catch { /* View controls also work when storage is unavailable. */ }
  return { ...DEFAULT_ORIENTATION }
}

export function saveViewOrientation(orientation: ViewOrientation): void {
  try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(orientation)) } catch { /* Optional persistence. */ }
}

export function setViewOrientation(view: View, orientation: ViewOrientation): void {
  view.rotationDeg = normalizeRotation(orientation.rotationDeg)
  view.mirror = orientation.mirror
  view.alignDirection = orientation.alignDirection
  const radians = view.rotationDeg * Math.PI / 180
  const cos = Math.cos(radians); const sin = Math.sin(radians)
  const horizontal = view.mirror ? -1 : 1
  view.xx = horizontal * cos; view.xy = -horizontal * sin
  view.yx = -sin; view.yy = -cos
}

export function viewX(view: View, x: number, y: number): number { return view.xx * x + view.xy * y }
export function viewY(view: View, x: number, y: number): number { return view.yx * x + view.yy * y }

// Scalar projections keep scan drawing allocation-free. Device pixels internally,
// CSS pixels at the SVG/input boundary; all renderer projections use this matrix.
export function deviceX(view: View, x: number, y: number): number { return view.ox + viewX(view, x, y) * view.scale }
export function deviceY(view: View, x: number, y: number): number { return view.oy + viewY(view, x, y) * view.scale }

export function toScreen(view: View, x: number, y: number): [number, number] {
  return [deviceX(view, x, y) / view.dpr, deviceY(view, x, y) / view.dpr]
}

export function toWorld(view: View, x: number, y: number): [number, number] {
  const vx = (x * view.dpr - view.ox) / view.scale
  const vy = (y * view.dpr - view.oy) / view.scale
  // The inverse of an orthogonal matrix is its transpose, even with a mirror.
  return [view.xx * vx + view.yx * vy, view.xy * vx + view.yy * vy]
}

export function screenAngle(view: View, sensorAngleDeg: number): number {
  const a = sensorAngleDeg * Math.PI / 180
  return Math.atan2(viewY(view, Math.cos(a), Math.sin(a)), viewX(view, Math.cos(a), Math.sin(a)))
}

export function alignedRotation(min: number, max: number, direction: 'down' | 'up', current: number): number {
  const span = keptSectorSpan(min, max)
  if (span === 360) return current
  const middle = sensorDegrees(min + span / 2)
  return normalizeRotation((direction === 'down' ? 270 : 90) - middle)
}

export function fitView(
  view: View, min: number, max: number, rangeMm: number,
  quad: ReadonlyArray<readonly [number, number]> | undefined
): void {
  let minX = 0; let maxX = 0; let minY = 0; let maxY = 0
  const include = (x: number, y: number): void => {
    const vx = viewX(view, x, y); const vy = viewY(view, x, y)
    minX = Math.min(minX, vx); maxX = Math.max(maxX, vx)
    minY = Math.min(minY, vy); maxY = Math.max(maxY, vy)
  }
  const radius = Math.max(1, rangeMm)
  const includeAngle = (angle: number): void => {
    if (!angleInSector(angle, min, max)) return
    const a = angle * Math.PI / 180
    include(radius * Math.cos(a), radius * Math.sin(a))
  }
  includeAngle(min); includeAngle(max)
  // Exact extrema of the rotated/mirrored circular arc, including wrap sectors.
  const xExtreme = Math.atan2(view.xy, view.xx) * 180 / Math.PI
  const yExtreme = Math.atan2(view.yy, view.yx) * 180 / Math.PI
  includeAngle(xExtreme); includeAngle(xExtreme + 180)
  includeAngle(yExtreme); includeAngle(yExtreme + 180)
  if (quad) for (const [x, y] of quad) include(x, y)
  const width = view.cssW * view.dpr; const height = view.cssH * view.dpr
  const padding = Math.min(32 * view.dpr, width * 0.1, height * 0.1)
  view.scale = Math.min((width - padding * 2) / Math.max(1, maxX - minX), (height - padding * 2) / Math.max(1, maxY - minY))
  view.ox = width / 2 - (minX + maxX) / 2 * view.scale
  view.oy = height / 2 - (minY + maxY) / 2 * view.scale
}
