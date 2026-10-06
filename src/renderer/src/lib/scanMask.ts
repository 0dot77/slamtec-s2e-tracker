export function sensorDegrees(angle: number): number {
  return ((angle % 360) + 360) % 360
}

export function angleInSector(angle: number, min: number, max: number): boolean {
  if (![angle, min, max].every(Number.isFinite)) return false
  if (max - min >= 360) return true
  const value = sensorDegrees(angle)
  const lo = sensorDegrees(min)
  const hi = sensorDegrees(max)
  if (lo === hi) return true
  return lo <= hi ? value >= lo && value <= hi : value >= lo || value <= hi
}

export function keptSectorSpan(min: number, max: number): number {
  const span = sensorDegrees(sensorDegrees(max) - sensorDegrees(min))
  return max - min >= 360 || span === 0 ? 360 : span
}
