import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CalibrationPoints, Track } from '@shared/types'
import {
  applyHomographyStrict,
  computeHomographyChecked,
  invertMat3,
  validateQuad
} from '@shared/homography'
import type { FrameSource } from '../lib/frameStore'

interface Props {
  points: CalibrationPoints
  onChange: (p: CalibrationPoints) => void
  onApply: (p: CalibrationPoints) => Promise<void>
  onCancel: () => void
  frameSource: FrameSource
  toScreen: (xMm: number, yMm: number) => [number, number]
  toWorld: (px: number, py: number) => [number, number]
  width: number
  height: number
}

type Corner = [number, number]
type Quad = [Corner, Corner, Corner, Corner]
type CaptureStage =
  | 'idle'
  | 'arming'
  | 'waiting-clear'
  | 'waiting-touch'
  | 'sampling'
  | 'captured'
  | 'complete'
  | 'error'

const CORNERS = ['TOP-LEFT', 'TOP-RIGHT', 'BOTTOM-RIGHT', 'BOTTOM-LEFT'] as const
const CORNER_SHORT = ['TL', 'TR', 'BR', 'BL'] as const
const ACCENT = '#e0b341'
const HANDLE_R = 9
const REQUIRED_SAMPLES = 8
const MAX_SPREAD_MM = 30

function releaseCaptureGate(): void {
  void window.api.setCalibrating(false).catch((error: unknown) => {
    console.error('[calibration] could not clear capture mode', error)
  })
}

function isOnlyLiveTrack(tracks: Track[]): tracks is [Track] {
  return (
    tracks.length === 1 &&
    tracks[0].lostFrames === 0 &&
    Number.isFinite(tracks[0].x) &&
    Number.isFinite(tracks[0].y)
  )
}

function spreadMm(samples: Corner[]): number {
  let spread = 0
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      spread = Math.max(
        spread,
        Math.hypot(samples[i][0] - samples[j][0], samples[i][1] - samples[j][1])
      )
    }
  }
  return spread
}

function clonePoints(points: CalibrationPoints): CalibrationPoints {
  return {
    src: points.src.map(([x, y]) => [x, y]) as CalibrationPoints['src']
  }
}

export default function CalibrationLayer({
  points,
  onChange,
  onApply,
  onCancel,
  frameSource,
  toScreen,
  toWorld,
  width,
  height
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const pointsRef = useRef(points)
  const onChangeRef = useRef(onChange)
  const toWorldRef = useRef(toWorld)
  pointsRef.current = points
  onChangeRef.current = onChange
  toWorldRef.current = toWorld

  const dragIdxRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const requestTokenRef = useRef(0)
  const processingRef = useRef(false)
  const stageRef = useRef<CaptureStage>('idle')
  const cornerIndexRef = useRef(0)
  const capturedRef = useRef<Array<Corner | null>>([null, null, null, null])
  const samplesRef = useRef<Array<{ id: number; point: Corner }>>([])
  const lastSeqRef = useRef<number | null>(null)
  const sampleTimeRef = useRef(0)
  const progressTimeRef = useRef(0)

  const [captureOpen, setCaptureOpen] = useState(false)
  const [stage, setStage] = useState<CaptureStage>('idle')
  const [cornerIndex, setCornerIndex] = useState(0)
  const [captured, setCaptured] = useState<Array<Corner | null>>([null, null, null, null])
  const [progress, setProgress] = useState(0)
  const [releaseReady, setReleaseReady] = useState(false)
  const [captureError, setCaptureError] = useState('')
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState('')

  const changeStage = useCallback((next: CaptureStage): void => {
    stageRef.current = next
    setStage(next)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      processingRef.current = false
      requestTokenRef.current += 1
      releaseCaptureGate()
    }
  }, [])

  useEffect(() => {
    return frameSource.subscribe(() => {
      if (!processingRef.current) return
      const frame = frameSource.getFrame()
      if (!frame) {
        samplesRef.current = []
        lastSeqRef.current = null
        setProgress(0)
        return
      }
      if (frame.seq === lastSeqRef.current) return
      // Stability requires consecutive scans, with no skipped sequence.
      const now = performance.now()
      if ((lastSeqRef.current !== null && frame.seq !== lastSeqRef.current + 1) || now - sampleTimeRef.current > 300) {
        samplesRef.current = []
      }
      sampleTimeRef.current = now
      lastSeqRef.current = frame.seq

      const tracks = frame.tracks
      const currentStage = stageRef.current

      if (currentStage === 'waiting-clear') {
        if (tracks.length === 0) changeStage('waiting-touch')
        return
      }

      if (currentStage === 'captured') {
        if (tracks.length === 0) setReleaseReady(true)
        return
      }

      if (currentStage !== 'waiting-touch' && currentStage !== 'sampling') return

      // Lost tracks still count toward the exactly-one condition. A frame with
      // one live track plus one retained/lost track is deliberately rejected.
      if (!isOnlyLiveTrack(tracks)) {
        samplesRef.current = []
        setProgress(0)
        if (currentStage === 'sampling') changeStage('waiting-touch')
        return
      }

      const track = tracks[0]
      const point: Corner = [track.x, track.y]
      const previous = samplesRef.current
      const candidate =
        previous.length > 0 && previous[0].id === track.id
          ? [...previous, { id: track.id, point }]
          : [{ id: track.id, point }]
      const candidatePoints = candidate.map((sample) => sample.point)

      if (spreadMm(candidatePoints) >= MAX_SPREAD_MM) {
        samplesRef.current = [{ id: track.id, point }]
        setProgress(1)
        changeStage('sampling')
        return
      }

      samplesRef.current = candidate
      if (now - progressTimeRef.current >= 200 || candidate.length >= REQUIRED_SAMPLES) {
        progressTimeRef.current = now
        setProgress(candidate.length)
      }
      changeStage('sampling')
      if (candidate.length < REQUIRED_SAMPLES) return

      const sum = candidate.reduce<Corner>(
        (acc, sample) => [acc[0] + sample.point[0], acc[1] + sample.point[1]],
        [0, 0]
      )
      const average: Corner = [sum[0] / candidate.length, sum[1] / candidate.length]
      const nextCaptured = [...capturedRef.current]
      nextCaptured[cornerIndexRef.current] = average
      capturedRef.current = nextCaptured
      setCaptured(nextCaptured)
      samplesRef.current = []
      setReleaseReady(false)
      changeStage('captured')
    })
  }, [changeStage, frameSource])

  const startCapture = useCallback(async (): Promise<void> => {
    const token = ++requestTokenRef.current
    processingRef.current = false
    capturedRef.current = [null, null, null, null]
    setCaptured([null, null, null, null])
    cornerIndexRef.current = 0
    setCornerIndex(0)
    samplesRef.current = []
    lastSeqRef.current = null
    setProgress(0)
    setReleaseReady(false)
    setCaptureError('')
    setCaptureOpen(true)
    changeStage('arming')

    try {
      const ok = await window.api.setCalibrating(true)
      if (!mountedRef.current || token !== requestTokenRef.current) {
        // Cancel/unmount already released the gate. An old completion must not
        // clear a newer capture started after that cancellation.
        return
      }
      if (!ok) {
        setCaptureError('The tracker did not enter calibration capture mode.')
        changeStage('error')
        return
      }
      processingRef.current = true
      changeStage('waiting-clear')
    } catch (error) {
      if (!mountedRef.current || token !== requestTokenRef.current) return
      setCaptureError(error instanceof Error ? error.message : String(error))
      changeStage('error')
    }
  }, [changeStage])

  const cancelCapture = useCallback((): void => {
    requestTokenRef.current += 1
    processingRef.current = false
    samplesRef.current = []
    setCaptureOpen(false)
    setProgress(0)
    setReleaseReady(false)
    setCaptureError('')
    changeStage('idle')
    releaseCaptureGate()
  }, [changeStage])

  const selectCorner = useCallback(
    (index: number): void => {
      const nextCaptured = [...capturedRef.current]
      nextCaptured[index] = null
      capturedRef.current = nextCaptured
      setCaptured(nextCaptured)
      cornerIndexRef.current = index
      setCornerIndex(index)
      samplesRef.current = []
      lastSeqRef.current = null
      setProgress(0)
      setReleaseReady(false)
      processingRef.current = true
      changeStage('waiting-clear')
    },
    [changeStage]
  )

  const acceptCapturedCorner = useCallback((): void => {
    if (!releaseReady) return
    const all = capturedRef.current
    const nextIndex = all.findIndex((corner) => corner === null)
    if (nextIndex !== -1) {
      cornerIndexRef.current = nextIndex
      setCornerIndex(nextIndex)
      samplesRef.current = []
      setProgress(0)
      setReleaseReady(false)
      changeStage('waiting-touch')
      return
    }

    const next: CalibrationPoints = {
      src: [all[0]!, all[1]!, all[2]!, all[3]!]
    }
    processingRef.current = false
    onChangeRef.current(clonePoints(next))
    changeStage('complete')
  }, [changeStage, releaseReady])

  const validationReason = useMemo(() => validateQuad(points.src), [points])
  const geometry = useMemo(() => {
    const screen = points.src.map(([x, y]) => toScreen(x, y)) as Quad
    const gridLines: Array<[Corner, Corner]> = []
    const forward = computeHomographyChecked(points.src)
    if (!forward) return { screen, gridLines }

    let inverse = invertMat3(forward)
    const centerW = inverse[6] * 0.5 + inverse[7] * 0.5 + inverse[8]
    if (centerW < 0) inverse = inverse.map((value) => -value)

    const project = (u: number, v: number): Corner | null => {
      const [x, y] = applyHomographyStrict(inverse, u, v)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return toScreen(x, y)
    }

    for (let i = 1; i < 4; i++) {
      const t = i / 4
      const vt = project(t, 0)
      const vb = project(t, 1)
      const hl = project(0, t)
      const hr = project(1, t)
      if (vt && vb) gridLines.push([vt, vb])
      if (hl && hr) gridLines.push([hl, hr])
    }
    return { screen, gridLines }
  }, [points, toScreen])

  const onHandleDown = (idx: number) => (event: React.PointerEvent<SVGCircleElement>): void => {
    if ((captureOpen && stage !== 'complete') || applying) return
    event.preventDefault()
    event.stopPropagation()
    dragIdxRef.current = idx
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onHandleMove = (event: React.PointerEvent<SVGCircleElement>): void => {
    const idx = dragIdxRef.current
    const svg = svgRef.current
    if (idx === null || !svg || (captureOpen && stage !== 'complete') || applying) return
    event.preventDefault()
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const px = ((event.clientX - rect.left) / rect.width) * width
    const py = ((event.clientY - rect.top) / rect.height) * height
    const next = clonePoints(pointsRef.current)
    next.src[idx] = toWorldRef.current(px, py)
    onChangeRef.current(next)
  }

  const onHandleUp = (event: React.PointerEvent<SVGCircleElement>): void => {
    if (dragIdxRef.current === null) return
    dragIdxRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const apply = async (): Promise<void> => {
    if (validationReason !== null || applying || (captureOpen && stage !== 'complete')) return
    processingRef.current = false
    requestTokenRef.current += 1
    setApplying(true)
    setApplyError('')
    try {
      // App applies the quad before releasing the touch-output gate.
      await onApply(clonePoints(points))
    } catch (error) {
      if (mountedRef.current) setApplyError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) setApplying(false)
    }
  }

  const cancel = (): void => {
    processingRef.current = false
    requestTokenRef.current += 1
    releaseCaptureGate()
    onCancel()
  }

  const instruction = (() => {
    if (stage === 'arming') return 'Preparing touch capture…'
    if (stage === 'waiting-clear') return 'Clear every touch from the scan plane.'
    if (stage === 'captured') {
      return releaseReady
        ? `${CORNER_SHORT[cornerIndex]} captured. Continue when ready.`
        : `${CORNER_SHORT[cornerIndex]} captured. Release your hand.`
    }
    if (stage === 'complete') return 'Draft updated. Check the handles and press Apply.'
    if (stage === 'error') return captureError || 'Touch capture could not start.'
    return `Touch the ${CORNERS[cornerIndex]} corner of the projected image and hold.`
  })()

  const panelWidth = Math.min(390, Math.max(260, width - 16))
  const panelHeight = Math.min(400, Math.max(0, height - 16))

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        pointerEvents: 'none',
        overflow: 'visible'
      }}
    >
      {geometry.gridLines.map(([a, b], i) => (
        <line
          key={`grid-${i}`}
          x1={a[0]}
          y1={a[1]}
          x2={b[0]}
          y2={b[1]}
          stroke={ACCENT}
          strokeOpacity={0.25}
          strokeWidth={1}
        />
      ))}

      <polygon
        points={geometry.screen.map((point) => `${point[0]},${point[1]}`).join(' ')}
        fill={ACCENT}
        fillOpacity={0.06}
        stroke={ACCENT}
        strokeOpacity={0.9}
        strokeWidth={1.5}
      />

      {geometry.screen.map((point, index) => (
        <g key={`handle-${index}`}>
          <circle
            cx={point[0]}
            cy={point[1]}
            r={HANDLE_R}
            fill="#11151f"
            stroke={ACCENT}
            strokeWidth={2}
            style={{ pointerEvents: (captureOpen && stage !== 'complete') || applying ? 'none' : 'all', cursor: 'grab' }}
            onPointerDown={onHandleDown(index)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          />
          <text
            x={point[0]}
            y={point[1]}
            fill="#d7dce5"
            fontSize={10}
            fontFamily="ui-monospace, monospace"
            textAnchor="middle"
            dominantBaseline="central"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            {CORNER_SHORT[index]}
          </text>
        </g>
      ))}

      <foreignObject
        x={Math.max(8, width - panelWidth - 8)}
        y={8}
        width={panelWidth}
        height={panelHeight}
        style={{ pointerEvents: 'all' }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 10,
            maxHeight: panelHeight,
            overflowY: 'auto',
            border: '1px solid #2a3344',
            borderRadius: 8,
            background: 'rgba(17, 21, 31, 0.95)',
            color: '#d7dce5',
            fontSize: 12,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif'
          }}
        >
          <strong style={{ color: ACCENT }}>Calibration draft</strong>
          <span style={{ color: '#8a93a6' }}>
            Drag TL, TR, BR, BL into place, or capture the projected corners with one touch.
          </span>

          {!captureOpen ? (
            <button type="button" style={ghostButton} onClick={() => void startCapture()}>
              Capture by touch
            </button>
          ) : (
            <>
              <div style={{ color: stage === 'error' ? '#ff5d5d' : '#d7dce5' }}>{instruction}</div>
              <div style={{ color: '#8a93a6', fontFamily: 'ui-monospace, monospace' }}>
                Corner {cornerIndex + 1}/4 · stable frames {Math.min(progress, REQUIRED_SAMPLES)}/
                {REQUIRED_SAMPLES}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {captured.map((corner, index) => (
                  <button
                    key={CORNER_SHORT[index]}
                    type="button"
                    style={{ ...smallButton, opacity: corner ? 1 : 0.45 }}
                    disabled={!corner || stage === 'arming'}
                    onClick={() => selectCorner(index)}
                  >
                    {corner ? `Redo ${CORNER_SHORT[index]}` : CORNER_SHORT[index]}
                  </button>
                ))}
              </div>
              {stage === 'captured' && (
                <button
                  type="button"
                  style={{ ...primaryButton, opacity: releaseReady ? 1 : 0.5 }}
                  disabled={!releaseReady}
                  onClick={acceptCapturedCorner}
                >
                  {captured.every((corner) => corner !== null) ? 'Use captured corners' : 'Next corner'}
                </button>
              )}
              <button type="button" style={ghostButton} onClick={cancelCapture}>
                Cancel capture
              </button>
            </>
          )}

          {validationReason !== null ? (
            <span role="alert" style={{ color: '#ff8b8b' }}>
              Cannot apply: {validationReason}
            </span>
          ) : (
            <span style={{ color: '#3ad48c' }}>Quad is valid.</span>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={primaryButton} onClick={() => void apply()}
              disabled={validationReason !== null || applying || (captureOpen && stage !== 'complete')}>
              {applying ? 'Applying…' : 'Apply'}
            </button>
            <button type="button" style={ghostButton} onClick={cancel} disabled={applying}>
              Cancel
            </button>
          </div>
          {applyError && <span role="alert" style={{ color: '#ff8b8b' }}>{applyError}</span>}
        </div>
      </foreignObject>
    </svg>
  )
}

const primaryButton: CSSProperties = {
  background: '#2563a8',
  border: '1px solid #2f74c0',
  color: '#fff',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer'
}

const ghostButton: CSSProperties = {
  ...primaryButton,
  background: '#1c2436',
  borderColor: '#2a3344',
  color: '#d7dce5'
}

const smallButton: CSSProperties = {
  ...ghostButton,
  padding: '3px 7px',
  fontSize: 11
}
