// Shared zone helpers used by the side-panel editor, the on-canvas overlay,
// and the main LiDAR view so color logic stays in one place.
import type { Zone } from '@shared/types'

// Small dark-theme-friendly palette new zones cycle through.
export const PALETTE = ['#37a0d4', '#3ad48c', '#e0b341', '#ff5d5d', '#a079e0', '#37d4c8', '#e07ab4']

// Closing threshold (normalized units) for clicking back onto the first vertex.
export const CLOSE_DIST = 0.03

export function nextColor(zones: Zone[]): string {
  return PALETTE[zones.length % PALETTE.length]
}

// Map a hex color to an rgba() string at the given alpha (handles #rgb and #rrggbb).
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

// Build a fresh Zone from a normalized polygon, with a cycled color + unique id.
export function makeZone(polygon: Array<[number, number]>, existing: Zone[]): Zone {
  return {
    id: `z${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: `zone ${existing.length + 1}`,
    color: nextColor(existing),
    enabled: true,
    polygon: polygon.map(([x, y]) => [x, y] as [number, number])
  }
}
