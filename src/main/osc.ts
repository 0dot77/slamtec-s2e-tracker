import { MAX_OSC_SLOTS, type OscConfig, type Track, type ZoneRuntime, type ZoneEvent, type Zone } from '../shared/types'
import { oscZoneNames, type TouchEvent } from './touch'

// The `osc` npm package ships no type declarations. We default-import it
// (esModuleInterop maps this to its CommonJS `module.exports`) and describe the
// tiny slice of its surface we use through local interfaces.
// @ts-expect-error no types for osc
import oscDefault from 'osc'

type OscArg = { type: 'i'; value: number } | { type: 'f'; value: number } | { type: 's'; value: string }
interface OscMessage {
  address: string
  args: OscArg[]
}
interface OscBundle {
  timeTag: { raw: [number, number] }
  packets: OscMessage[]
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
  send(packet: OscMessage | OscBundle): void
  on(event: 'ready' | 'error' | 'close', listener: (arg?: unknown) => void): void
  removeAllListeners(): void
}

interface OscModule {
  UDPPort: new (options: UdpPortOptions) => UdpPort
}

const osc = oscDefault as OscModule

// OSC "immediately" time tag.
const IMMEDIATE: { raw: [number, number] } = { raw: [0, 1] }
// Keep every datagram below a typical Ethernet MTU payload.
const MAX_BUNDLE_BYTES = 1200

/** Everything the touch protocol sends for one scan frame. */
export interface TouchFrame {
  session: number
  seq: number
  ready: boolean
  touches: TouchEvent[]
  alive: number[]
}

const pad4 = (n: number): number => (n + 3) & ~3

function messageBytes(m: OscMessage): number {
  let n = pad4(Buffer.byteLength(m.address) + 1) + pad4(m.args.length + 2)
  for (const a of m.args) n += a.type === 's' ? pad4(Buffer.byteLength(a.value) + 1) : 4
  return n
}

/** Normalize the configured address prefix to "/a/b" (no trailing slash). */
export function normalizePrefix(raw: string, fallback = '/wall'): string {
  let p = (raw || fallback).trim()
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/+$/, '').replace(/[ #*,?[\]{}]+/g, '_')
  return p || fallback
}

/**
 * OSC sender over UDP for the tracker's main process.
 *
 * Touch mode (default, Unity): per frame one or more bundles with touch
 * lifecycle messages, zone-local touch messages, then `/frame` + `/alive`.
 * Slots mode (legacy, TouchDesigner): fixed-slot active/u/v + zone state.
 *
 * The UDP socket is rebuilt when the destination changes or after a socket
 * error (exponential backoff). No socket error can reach the process.
 */
export class OscSender {
  private port: UdpPort | null = null
  private ready = false

  private openedHost: string | null = null
  private openedPort: number | null = null
  private openedEnabled = false

  private reopenTimer?: ReturnType<typeof setTimeout>
  private backoffMs = 500
  private lastCfg: OscConfig | null = null

  // Stable track id -> slot index (slots mode).
  private slots = new Map<number, number>()
  private previousZones = new Map<string, { name: string; segment: string; occupants: Set<number> }>()

  constructor(private readonly log: (line: string) => void = () => {}) {}

  get isReady(): boolean {
    return this.ready
  }

  configure(cfg: OscConfig): void {
    this.lastCfg = cfg
    const sameDest =
      this.openedHost === cfg.host && this.openedPort === cfg.port && this.openedEnabled === cfg.enabled
    if (sameDest && (!cfg.enabled || this.port || this.reopenTimer)) return
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer)
      this.reopenTimer = undefined
    }
    this.backoffMs = 500
    this.reopen(cfg)
  }

  private reopen(cfg: OscConfig): void {
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
        if (this.port !== port) return
        this.ready = true
        this.backoffMs = 500
      })
      port.on('error', (err) => {
        if (this.port !== port) return
        const msg = err instanceof Error ? err.message : String(err)
        this.log(`[osc] socket error: ${msg}; retrying in ${this.backoffMs}ms`)
        this.scheduleReopen()
      })
      port.on('close', () => {
        if (this.port === port) this.scheduleReopen()
      })
      this.port = port
      port.open()
    } catch (err) {
      this.log(`[osc] open failed: ${(err as Error).message}`)
      this.scheduleReopen()
    }
  }

  private scheduleReopen(): void {
    this.closePort()
    if (this.reopenTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(10000, this.backoffMs * 2)
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = undefined
      if (this.lastCfg?.enabled) this.reopen(this.lastCfg)
    }, delay)
  }

  /** Touch protocol: one frame's touches + frame/alive snapshot. */
  sendTouchFrame(frame: TouchFrame, cfg: OscConfig, zones: Zone[]): void {
    if (!cfg.enabled || cfg.mode === 'slots') return
    const prefix = normalizePrefix(cfg.addrPrefix)
    const fy = (v: number): number => (cfg.yUp ? 1 - v : v)
    const msgs: OscMessage[] = []
    for (const t of frame.touches) {
      msgs.push({
        address: `${prefix}/touch`,
        args: [
          { type: 'i', value: t.id },
          { type: 'i', value: t.phase },
          { type: 'f', value: t.u },
          { type: 'f', value: fy(t.v) },
          { type: 's', value: t.zone }
        ]
      })
    }
    if (zones.length) {
      for (const t of frame.touches) {
        if (!t.zone) continue
        msgs.push({
          address: `${prefix}/zone/${t.zone}/touch`,
          args: [
            { type: 'i', value: t.id },
            { type: 'i', value: t.phase },
            { type: 'f', value: t.lu },
            { type: 'f', value: fy(t.lv) }
          ]
        })
      }
    }
    msgs.push({
      address: `${prefix}/frame`,
      args: [
        { type: 'i', value: frame.session | 0 },
        { type: 'i', value: frame.seq | 0 },
        { type: 'i', value: frame.alive.length },
        { type: 'i', value: frame.ready ? 1 : 0 }
      ]
    })
    msgs.push({ address: `${prefix}/alive`, args: frame.alive.map((id) => ({ type: 'i' as const, value: id })) })
    this.sendBundles(msgs, 2)
  }

  /** Legacy fixed-slot stream (TouchDesigner). */
  sendSlots(tracks: Track[], zones: ZoneRuntime[], events: ZoneEvent[], cfg: OscConfig): void {
    if (!cfg.enabled || cfg.mode === 'touch') return
    const maxSlots = Math.max(1, Math.min(MAX_OSC_SLOTS, Math.floor(cfg.maxSlots) || 1))
    this.reconcileSlots(tracks, maxSlots)
    const prefix = normalizePrefix(cfg.addrPrefix)
    const msgs: OscMessage[] = []
    const int = (address: string, value: number): void => {
      msgs.push({ address, args: [{ type: 'i', value: Math.round(value) }] })
    }
    const flt = (address: string, value: number): void => {
      msgs.push({ address, args: [{ type: 'f', value }] })
    }

    const trackBySlot = new Map<number, Track>()
    for (const t of tracks) {
      const slot = this.slots.get(t.id)
      if (slot !== undefined) trackBySlot.set(slot, t)
    }
    int(`${prefix}/count`, trackBySlot.size)
    for (let slot = 0; slot < maxSlots; slot++) {
      const t = trackBySlot.get(slot)
      const base = `${prefix}/track/${slot}`
      int(`${base}/active`, t ? 1 : 0)
      flt(`${base}/u`, t ? t.u : 0)
      flt(`${base}/v`, t ? t.v : 0)
    }
    const names = oscZoneNames(zones)
    for (const z of zones) {
      const base = `${prefix}/zone/${names.get(z.id)}`
      int(`${base}/active`, z.active ? 1 : 0)
      int(`${base}/count`, z.occupants.length)
    }
    const currentZones = new Map(zones.map((z) => [z.id, {
      name: z.name, segment: names.get(z.id) ?? 'zone', occupants: new Set(z.occupants)
    }]))
    const sentEvents = new Set<string>()
    for (const e of events) {
      const candidates = [...(e.type === 'exit' ? this.previousZones : currentZones).values()]
        .filter((z) => z.name === e.zone && z.occupants.has(e.id))
      // An explicit exit may be supplied before this sender saw occupancy.
      const routes = candidates.length ? candidates : [...currentZones.values()].filter((z) => z.name === e.zone)
      for (const z of routes) {
        const key = `${z.segment}/${e.type}:${e.id}`
        if (sentEvents.has(key)) continue
        sentEvents.add(key)
        int(`${prefix}/zone/${z.segment}/${e.type}`, e.id)
      }
    }
    this.previousZones = currentZones
    this.sendBundles(msgs)
  }

  close(): void {
    this.lastCfg = null
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer)
      this.reopenTimer = undefined
    }
    this.closePort()
    this.slots.clear()
    this.previousZones.clear()
    this.openedHost = null
    this.openedPort = null
    this.openedEnabled = false
  }

  // --- internals ----------------------------------------------------------

  /** Pack messages into as few bundles as fit MAX_BUNDLE_BYTES, in order. */
  private sendBundles(msgs: OscMessage[], tailCount = 0): void {
    if (!this.ready || !this.port) return
    const port = this.port
    const tail = msgs.slice(msgs.length - tailCount)
    const body = tailCount ? msgs.slice(0, -tailCount) : msgs
    const tailBytes = tail.reduce((n, m) => n + 4 + messageBytes(m), 0)
    if (tailBytes + 16 > MAX_BUNDLE_BYTES || body.some((m) => 20 + messageBytes(m) > MAX_BUNDLE_BYTES)) {
      this.log('[osc] frame exceeds the 1200-byte bundle limit')
      return
    }
    try {
      let packets: OscMessage[] = []
      let size = 16 // "#bundle\0" + time tag
      for (const m of body) {
        const n = 4 + messageBytes(m)
        if (packets.length && size + n > MAX_BUNDLE_BYTES) {
          port.send({ timeTag: IMMEDIATE, packets })
          packets = []
          size = 16
        }
        packets.push(m)
        size += n
      }
      // /frame and the complete /alive snapshot form one indivisible tail.
      // A receiver can reconcile touches as soon as this last bundle arrives.
      if (tailCount && packets.length && size + tailBytes > MAX_BUNDLE_BYTES) {
        port.send({ timeTag: IMMEDIATE, packets })
        packets = []
      }
      packets.push(...tail)
      if (packets.length) port.send({ timeTag: IMMEDIATE, packets })
    } catch (err) {
      // Closed socket / bad address: rebuild instead of latching off forever.
      this.log(`[osc] send failed: ${(err as Error).message}`)
      this.scheduleReopen()
    }
  }

  private reconcileSlots(tracks: Track[], maxSlots: number): void {
    const live = new Set<number>()
    for (const t of tracks) live.add(t.id)
    for (const [id, slot] of this.slots) {
      if (!live.has(id) || slot >= maxSlots) this.slots.delete(id)
    }
    const taken = new Set<number>(this.slots.values())
    for (const t of tracks) {
      if (this.slots.has(t.id)) continue
      for (let slot = 0; slot < maxSlots; slot++) {
        if (!taken.has(slot)) {
          this.slots.set(t.id, slot)
          taken.add(slot)
          break
        }
      }
    }
  }

  private closePort(): void {
    if (this.port) {
      try {
        this.port.removeAllListeners()
        // A late async error on a closing socket must still have a listener,
        // or EventEmitter throws it into the process.
        this.port.on('error', () => {})
        this.port.close()
      } catch {
        /* already closed / never opened */
      }
    }
    this.port = null
    this.ready = false
  }
}
