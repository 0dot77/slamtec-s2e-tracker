import type { OscConfig, Track, ZoneRuntime, ZoneEvent } from '../shared/types'

// The `osc` npm package ships no type declarations. We default-import it
// (esModuleInterop maps this to its CommonJS `module.exports`) and describe the
// tiny slice of its surface we use through local interfaces, so the rest of
// this file stays strictly typed without leaking `any`.
// @ts-expect-error no types for osc
import oscDefault from 'osc'

// --- Minimal local typings for the bits of osc.js we touch ----------------

type OscArg = { type: 'i' | 'f'; value: number }
interface OscMessage {
  address: string
  args: OscArg[]
}

interface UdpPortOptions {
  localAddress: string
  localPort: number
  remoteAddress: string
  remotePort: number
  metadata: boolean
}

interface UdpPort {
  open(): void
  close(): void
  send(packet: OscMessage): void
  on(event: 'ready' | 'error', listener: (arg?: unknown) => void): void
  removeAllListeners(): void
}

interface OscModule {
  UDPPort: new (options: UdpPortOptions) => UdpPort
}

const osc = oscDefault as OscModule

/**
 * OSC sender over UDP for the tracker's main process.
 *
 * Streams per-frame tracking state to a downstream OSC consumer
 * (e.g. TouchDesigner). A stable id->slot map keeps each track pinned to a
 * fixed slot index for its lifetime, so the receiver can wire fixed channels.
 *
 * The transport is rebuilt only when the destination or enabled flag changes.
 * Every socket interaction is guarded so a transient UDP error can never crash
 * the main process.
 */
export class OscSender {
  private port: UdpPort | null = null
  private ready = false

  // Last opened destination, used to decide whether configure() must reopen.
  private openedHost: string | null = null
  private openedPort: number | null = null
  private openedEnabled = false

  // Stable track id -> slot index (0..maxSlots-1).
  private slots = new Map<number, number>()

  /**
   * (Re)opens the UDP port when host, port, or enabled state changes.
   * When disabled, any existing port is closed and no socket is held.
   */
  configure(cfg: OscConfig): void {
    const sameDest =
      this.openedHost === cfg.host &&
      this.openedPort === cfg.port &&
      this.openedEnabled === cfg.enabled

    if (sameDest && (!cfg.enabled || this.port)) return

    this.closePort()

    this.openedHost = cfg.host
    this.openedPort = cfg.port
    this.openedEnabled = cfg.enabled

    if (!cfg.enabled) return

    try {
      const port: UdpPort = new osc.UDPPort({
        localAddress: '0.0.0.0',
        localPort: 0,
        remoteAddress: cfg.host,
        remotePort: cfg.port,
        metadata: true
      })
      port.on('ready', () => {
        this.ready = true
      })
      // Swallow async socket errors; never let them reach the process.
      port.on('error', () => {
        /* transient UDP error: ignore */
      })
      this.port = port
      port.open()
    } catch {
      this.port = null
      this.ready = false
    }
  }

  /**
   * Emits one OSC bundle's worth of messages for the current frame. No-op
   * unless enabled and the port is ready. Assigns/releases slots for tracks,
   * then sends count, per-slot active/u/v, per-zone active/count, and per-event
   * enter/exit messages.
   */
  send(tracks: Track[], zones: ZoneRuntime[], events: ZoneEvent[], cfg: OscConfig): void {
    if (!cfg.enabled || !this.ready || !this.port) return

    const maxSlots = Math.max(0, Math.floor(cfg.maxSlots))
    this.reconcileSlots(tracks, maxSlots)

    const prefix = cfg.addrPrefix || '/lidar'

    try {
      // Active track count.
      this.sendInt(`${prefix}/count`, tracks.length)

      // Resolve which slot holds which track this frame.
      const trackBySlot = new Map<number, Track>()
      for (const t of tracks) {
        const slot = this.slots.get(t.id)
        if (slot !== undefined) trackBySlot.set(slot, t)
      }

      // Every slot reports, inactive ones with active 0.
      for (let slot = 0; slot < maxSlots; slot++) {
        const t = trackBySlot.get(slot)
        const base = `${prefix}/track/${slot}`
        if (t) {
          this.sendInt(`${base}/active`, 1)
          this.sendFloat(`${base}/u`, t.u)
          this.sendFloat(`${base}/v`, t.v)
        } else {
          this.sendInt(`${base}/active`, 0)
          this.sendFloat(`${base}/u`, 0)
          this.sendFloat(`${base}/v`, 0)
        }
      }

      // Per-zone occupancy.
      for (const z of zones) {
        const base = `${prefix}/zone/${z.name}`
        this.sendInt(`${base}/active`, z.active ? 1 : 0)
        this.sendInt(`${base}/count`, z.occupants.length)
      }

      // Per-event enter/exit pulses.
      for (const e of events) {
        const base = `${prefix}/zone/${e.zone}`
        this.sendInt(`${base}/${e.type}`, e.id)
      }
    } catch {
      // A send failure (closed socket, bad address) must not crash main.
      this.ready = false
    }
  }

  /** Closes the UDP port and clears all transient state. */
  close(): void {
    this.closePort()
    this.slots.clear()
    this.openedHost = null
    this.openedPort = null
    this.openedEnabled = false
  }

  // --- internals ----------------------------------------------------------

  /**
   * Releases slots whose track id vanished, then assigns the lowest free slot
   * to each newly seen track. Drops any assignment outside [0, maxSlots).
   */
  private reconcileSlots(tracks: Track[], maxSlots: number): void {
    const live = new Set<number>()
    for (const t of tracks) live.add(t.id)

    // Release vanished ids and any assignment now out of range.
    for (const [id, slot] of this.slots) {
      if (!live.has(id) || slot >= maxSlots) this.slots.delete(id)
    }

    // Slots currently occupied.
    const taken = new Set<number>()
    for (const slot of this.slots.values()) taken.add(slot)

    // Assign a free slot to each unassigned, live track.
    for (const t of tracks) {
      if (this.slots.has(t.id)) continue
      for (let slot = 0; slot < maxSlots; slot++) {
        if (!taken.has(slot)) {
          this.slots.set(t.id, slot)
          taken.add(slot)
          break
        }
      }
      // No free slot (more tracks than maxSlots): track stays unassigned.
    }
  }

  private sendInt(address: string, value: number): void {
    this.port?.send({ address, args: [{ type: 'i', value: Math.round(value) }] })
  }

  private sendFloat(address: string, value: number): void {
    this.port?.send({ address, args: [{ type: 'f', value }] })
  }

  private closePort(): void {
    if (this.port) {
      try {
        this.port.removeAllListeners()
        this.port.close()
      } catch {
        /* already closed / never opened: ignore */
      }
    }
    this.port = null
    this.ready = false
  }
}
