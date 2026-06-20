import { useEffect, useRef } from 'react'
import type { CalibrationPoints } from '@shared/types'

// Draggable 4-point calibration overlay. Sits absolutely on top of the LiDAR
// canvas and edits the LiDAR-mm quad that maps to the normalized unit square.
//
// Corner order is fixed to the unit-square order the homography expects:
//   index 0 -> (0,0)  top-left
//   index 1 -> (1,0)  top-right
//   index 2 -> (1,1)  bottom-right
//   index 3 -> (0,1)  bottom-left
//
// Coordinate transforms are owned by the parent (which also owns pan/zoom):
//   toScreen(xMm, yMm) -> [px, py]   LiDAR mm  -> CSS px in this overlay
//   toWorld(px, py)    -> [xMm, yMm] CSS px    -> LiDAR mm
// They change whenever the parent pans/zooms, so the parent must re-render this
// component when its view transform changes for the handles to stay aligned.

interface Props {
  points: CalibrationPoints | null
  onChange: (p: CalibrationPoints) => void
  toScreen: (xMm: number, yMm: number) => [number, number]
  toWorld: (px: number, py: number) => [number, number]
  width: number
  height: number
}

type Corner = [number, number]
type Quad = [Corner, Corner, Corner, Corner]

const ACCENT = '#e0b341' // amber, matches the calibration accent in the palette
const HANDLE_R = 9

// Linear interpolation between two screen-space corners.
function lerp(a: Corner, b: Corner, t: number): Corner {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

export default function CalibrationLayer({
  points,
  onChange,
  toScreen,
  toWorld,
  width,
  height
}: Props): JSX.Element {
  // Keep the latest transforms / callback in refs so pointer handlers always
  // read the current pan/zoom without re-binding listeners every render.
  const toWorldRef = useRef(toWorld)
  const onChangeRef = useRef(onChange)
  const pointsRef = useRef<CalibrationPoints | null>(points)
  toWorldRef.current = toWorld
  onChangeRef.current = onChange
  pointsRef.current = points

  const dragIdxRef = useRef<number | null>(null)
  const didInitRef = useRef(false)

  // Lazily seed a sensible default quad (a ~3 m square in front of the sensor)
  // exactly once when no calibration exists yet. We derive it from inset screen
  // corners so the quad lands on-screen regardless of the current pan/zoom.
  useEffect(() => {
    if (points || didInitRef.current) return
    if (width <= 0 || height <= 0) return
    didInitRef.current = true

    const inset = 0.18
    const left = width * inset
    const right = width * (1 - inset)
    const top = height * inset
    const bottom = height * (1 - inset)

    const seed: CalibrationPoints = {
      src: [
        toWorldRef.current(left, top), // (0,0) top-left
        toWorldRef.current(right, top), // (1,0) top-right
        toWorldRef.current(right, bottom), // (1,1) bottom-right
        toWorldRef.current(left, bottom) // (0,1) bottom-left
      ]
    }
    onChangeRef.current(seed)
  }, [points, width, height])

  // Project the LiDAR-mm corners to screen px for this render.
  const src = points?.src
  const screen: Quad | null = src
    ? [
        toScreen(src[0][0], src[0][1]),
        toScreen(src[1][0], src[1][1]),
        toScreen(src[2][0], src[2][1]),
        toScreen(src[3][0], src[3][1])
      ]
    : null

  const onHandleDown = (idx: number) => (e: React.PointerEvent<SVGCircleElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    dragIdxRef.current = idx
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onHandleMove = (e: React.PointerEvent<SVGCircleElement>): void => {
    const idx = dragIdxRef.current
    if (idx === null) return
    const cur = pointsRef.current
    if (!cur) return
    e.preventDefault()
    // offsetX/offsetY are relative to the SVG element == this overlay's px space.
    const world = toWorldRef.current(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    const next: CalibrationPoints = {
      src: [...cur.src] as CalibrationPoints['src']
    }
    next.src[idx] = world
    onChangeRef.current(next)
  }

  const onHandleUp = (e: React.PointerEvent<SVGCircleElement>): void => {
    if (dragIdxRef.current === null) return
    dragIdxRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Quarter grid lines: interpolate opposite edges to visualize the normalized
  // mapping (verticals at u = 1/4,1/2,3/4 ; horizontals at v = 1/4,1/2,3/4).
  const gridLines: Array<[Corner, Corner]> = []
  if (screen) {
    const [tl, tr, br, bl] = screen
    for (let i = 1; i < 4; i++) {
      const t = i / 4
      // vertical: top edge (tl->tr) to bottom edge (bl->br)
      gridLines.push([lerp(tl, tr, t), lerp(bl, br, t)])
      // horizontal: left edge (tl->bl) to right edge (tr->br)
      gridLines.push([lerp(tl, bl, t), lerp(tr, br, t)])
    }
  }

  return (
    <svg
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        // Let pan/zoom on the underlying canvas pass through everywhere except
        // the handles, which re-enable pointer events individually.
        pointerEvents: 'none',
        overflow: 'visible'
      }}
    >
      {screen && (
        <>
          {/* Faint internal quarter grid. */}
          {gridLines.map(([a, b], i) => (
            <line
              key={`g${i}`}
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              stroke={ACCENT}
              strokeOpacity={0.22}
              strokeWidth={1}
            />
          ))}

          {/* Quad outline. */}
          <polygon
            points={screen.map((p) => `${p[0]},${p[1]}`).join(' ')}
            fill={ACCENT}
            fillOpacity={0.06}
            stroke={ACCENT}
            strokeOpacity={0.9}
            strokeWidth={1.5}
          />

          {/* Corner drag handles, labelled 0..3. */}
          {screen.map((p, i) => (
            <g key={`h${i}`}>
              <circle
                cx={p[0]}
                cy={p[1]}
                r={HANDLE_R}
                fill="#11151f"
                stroke={ACCENT}
                strokeWidth={2}
                style={{ pointerEvents: 'all', cursor: 'grab' }}
                onPointerDown={onHandleDown(i)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              />
              <text
                x={p[0]}
                y={p[1]}
                fill="#d7dce5"
                fontSize={11}
                fontFamily="ui-monospace, monospace"
                textAnchor="middle"
                dominantBaseline="central"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {i}
              </text>
            </g>
          ))}
        </>
      )}
    </svg>
  )
}
