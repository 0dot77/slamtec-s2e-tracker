import type { VizFrame } from '@shared/types'

export interface FrameSource {
  getFrame(): VizFrame | null
  getReceivedAt(): number
  getHz(): number
  subscribe(listener: () => void): () => void
}

export interface MutableFrameSource extends FrameSource {
  setFrame(frame: VizFrame | null): void
}

export function createFrameStore(): MutableFrameSource {
  const latest = { current: null as VizFrame | null }
  let receivedAt = 0
  let stamps: number[] = []
  const listeners = new Set<() => void>()

  return {
    getFrame: () => latest.current,
    getReceivedAt: () => receivedAt,
    getHz: () => {
      if (stamps.length < 2) return 0
      const span = stamps[stamps.length - 1] - stamps[0]
      return span > 0 ? ((stamps.length - 1) * 1000) / span : 0
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setFrame(next) {
      if (next) {
        receivedAt = performance.now()
        if (next.seq !== latest.current?.seq) {
          stamps.push(receivedAt)
          stamps = stamps.filter((stamp) => stamp >= receivedAt - 2000).slice(-60)
        }
      } else {
        stamps = []
      }
      latest.current = next
      for (const listener of listeners) listener()
    }
  }
}
