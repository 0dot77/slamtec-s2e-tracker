import { useEffect, useState } from 'react'
import type { BgStatus, ReadyReason, ZoneRuntime } from '@shared/types'
import type { MutableFrameSource } from './frameStore'

export interface FrameHud {
  seq: number | null
  count: number
  tracks: number
  hz: number
  procMs: number
  ready: boolean
  readyReason: ReadyReason
  stale: boolean
  bg?: BgStatus
  zones: ZoneRuntime[]
}

const EMPTY: FrameHud = {
  seq: null, count: 0, tracks: 0, hz: 0, procMs: 0,
  ready: false, readyReason: 'stalled', stale: false, zones: []
}

// IPC and canvas drawing stay at scan rate; React only receives small HUD data.
export function useFrameHud(source: MutableFrameSource): FrameHud {
  const [hud, setHud] = useState<FrameHud>(EMPTY)
  useEffect(() => {
    const update = (): void => {
      const received = source.getReceivedAt()
      const stale = received > 0 && performance.now() - received > 1000
      if (stale && source.getFrame()) source.setFrame(null)
      const frame = source.getFrame()
      setHud((previous) => {
        if (previous.seq === (frame?.seq ?? null) && previous.stale === stale) return previous
        return frame ? {
          seq: frame.seq, count: frame.count, tracks: frame.tracks.length,
          hz: source.getHz(), procMs: frame.procMs,
          ready: frame.ready, readyReason: frame.readyReason, stale,
          bg: frame.bg, zones: frame.zones
        } : { ...EMPTY, stale }
      })
    }
    update()
    const timer = window.setInterval(update, 200)
    return () => window.clearInterval(timer)
  }, [source])
  return hud
}
