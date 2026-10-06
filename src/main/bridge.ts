import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { FRAME_MAGIC, HEADER_BYTES, POINT_BYTES, MAX_POINTS } from '../shared/protocol'

// Explicit error text for the bridge's non-zero exit codes (see
// bridge/src/main.cpp). Anything not listed is an ordinary crash/disconnect and
// is handled by the reconnect path only.
const EXIT_REASONS: Record<number, string> = {
  2: 'driver init failed',
  3: 'connect failed',
  4: 'no response from device',
  5: 'device health error',
  6: 'start scan failed'
}

export interface RawScan {
  seq: number
  tMs: number
  count: number
  angle: Float32Array // degrees
  dist: Float32Array // millimeters
  quality: Uint8Array
}

/**
 * Spawns the C++ s2e_bridge process and parses its binary frame stream.
 * Emits: 'scan' (RawScan), 'status' (BridgeStatus-like), 'log' (string),
 * 'exit' (code).
 *
 * Shutdown is graceful first: closing the child's stdin tells the bridge to
 * stop the motor and exit (it also exits by itself if this process dies), and
 * a hard kill follows only if it has not exited within `killGraceMs`.
 */
export class Bridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private drainingChild?: ChildProcessWithoutNullStreams
  private buf: Buffer = Buffer.alloc(0)
  private errBuf = ''

  // `stopping` distinguishes an explicit stop()/restart from an unexpected exit
  // (sensor unplugged, bridge crash) so only the latter triggers a respawn.
  private stopping = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private killTimer?: ReturnType<typeof setTimeout>
  // Target to spawn once the previous child has exited (restart).
  private pending: { ip: string; port: number } | null = null
  private ip = '192.168.11.2'
  private port = 8089
  private readonly reconnectDelayMs = 1500
  private readonly killGraceMs = 1500

  constructor(private readonly bridgePath: string) {
    super()
  }

  start(ip = '192.168.11.2', port = 8089): void {
    this.ip = ip
    this.port = port
    this.stopping = false
    this.clearReconnect()
    if (this.child) {
      // Restart: let the old child release the sensor before spawning anew.
      this.pending = { ip, port }
      this.shutdownChild()
      return
    }
    this.spawn()
  }

  stop(): void {
    this.stopping = true
    this.pending = null
    this.clearReconnect()
    if (this.child) {
      this.shutdownChild() // exit handler emits the 'stopped' status
    } else {
      this.emit('status', { state: 'stopped', message: 'stopped' })
    }
  }

  /** Synchronous hard kill for app quit (no time to wait for a graceful exit). */
  kill(): void {
    this.stopping = true
    this.pending = null
    this.clearReconnect()
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = undefined
    }
    this.drainingChild = this.child
    try {
      this.child?.kill()
    } catch {
      /* already gone */
    }
  }

  get running(): boolean {
    return !!this.child
  }

  private shutdownChild(): void {
    const child = this.child
    if (!child) return
    this.drainingChild = child
    try {
      child.stdin.end()
    } catch {
      /* pipe already closed */
    }
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined
      if (this.child === child) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    }, this.killGraceMs)
  }

  private spawn(): void {
    this.buf = Buffer.alloc(0)
    this.errBuf = ''
    this.emit('status', { state: 'connecting', message: `${this.ip}:${this.port}` })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.bridgePath, [this.ip, String(this.port)], { windowsHide: true })
    } catch (err) {
      this.emit('status', { state: 'error', message: `spawn failed: ${(err as Error).message}` })
      this.scheduleReconnect()
      return
    }
    this.child = child

    // Every handler checks identity: a superseded child's late output or exit
    // must never reach the current parser/state.
    child.stdout.on('data', (c: Buffer) => {
      if (this.child === child && this.drainingChild !== child) this.onData(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (this.child === child && this.drainingChild !== child) this.onStderr(c.toString())
    })
    child.stdin.on('error', () => {
      /* EPIPE when the child exits first: ignore */
    })

    let finished = false
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (finished) return
      finished = true
      if (this.child !== child) return
      const intentional = this.drainingChild === child
      if (intentional) this.drainingChild = undefined
      this.child = undefined
      if (this.killTimer) {
        clearTimeout(this.killTimer)
        this.killTimer = undefined
      }
      // A replaced child's exit must not be interpreted as failure of the new
      // target (or trigger exit diagnosis after its preflight has completed).
      if (!intentional) this.emit('exit', code)

      if (this.pending) {
        const next = this.pending
        this.pending = null
        this.ip = next.ip
        this.port = next.port
        this.spawn()
        return
      }
      if (this.stopping) {
        this.emit('status', { state: 'stopped', message: `exited (${code ?? signal})` })
        return
      }
      if (spawnError) {
        this.emit('status', { state: 'error', message: `spawn failed: ${spawnError.message}` })
        // A missing binary will not appear by retrying every 1.5 s.
        if ((spawnError as NodeJS.ErrnoException).code === 'ENOENT') return
        this.scheduleReconnect(5000)
        return
      }
      const reason = EXIT_REASONS[code ?? -1]
      if (reason) this.emit('status', { state: 'error', message: reason })
      // Driver initialization failures are terminal because reconnecting cannot heal them.
      if (code === 2) return
      this.emit('status', {
        state: 'connecting',
        message: `connection lost (${code ?? signal}); reconnecting in ${this.reconnectDelayMs}ms…`
      })
      this.scheduleReconnect()
    }
    child.on('error', (err) => finish(null, null, err))
    child.on('exit', (code, signal) => finish(code, signal))
  }

  private scheduleReconnect(delay = this.reconnectDelayMs): void {
    this.clearReconnect()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopping && !this.child) this.spawn()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private onStderr(text: string): void {
    // Keep a partial trailing line until its newline arrives.
    this.errBuf += text
    if (this.errBuf.length > 64 * 1024) this.errBuf = this.errBuf.slice(-4096)
    const lines = this.errBuf.split('\n')
    this.errBuf = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      const lower = line.toLowerCase()
      if (lower.includes('connected')) this.emit('status', { state: 'connected', message: line })
      else if (lower.includes('scanning')) this.emit('status', { state: 'scanning', message: line })
      else if (lower.includes('fail') || lower.includes('error'))
        this.emit('status', { state: 'error', message: line })
      else this.emit('log', line)
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const buf = this.buf
    let off = 0

    while (buf.length - off >= HEADER_BYTES) {
      const magic = buf.readUInt32LE(off)
      if (magic !== FRAME_MAGIC) {
        off += 1 // desync: scan forward one byte
        continue
      }
      const seq = buf.readUInt32LE(off + 4)
      const tMs = buf.readUInt32LE(off + 8)
      const count = buf.readUInt32LE(off + 12)
      if (count > MAX_POINTS) {
        off += 1
        continue
      }
      const need = HEADER_BYTES + count * POINT_BYTES
      if (buf.length - off < need) break // wait for the rest of this frame

      const angle = new Float32Array(count)
      const dist = new Float32Array(count)
      const quality = new Uint8Array(count)
      let p = off + HEADER_BYTES
      let m = 0
      for (let i = 0; i < count; i++) {
        const a = buf.readFloatLE(p)
        const d = buf.readFloatLE(p + 4)
        // Drop corrupt points instead of letting NaN/huge values into the pipeline.
        if (a >= 0 && a <= 360 && d > 0 && d < 100000) {
          angle[m] = a
          dist[m] = d
          quality[m] = buf[p + 8]
          m++
        }
        p += POINT_BYTES
      }
      this.emit('scan', {
        seq,
        tMs,
        count: m,
        angle: m === count ? angle : angle.subarray(0, m),
        dist: m === count ? dist : dist.subarray(0, m),
        quality: m === count ? quality : quality.subarray(0, m)
      } satisfies RawScan)
      off += need
    }

    this.buf = off > 0 ? buf.subarray(off) : buf
    // A stream that never resyncs must not grow without bound.
    if (this.buf.length > HEADER_BYTES + MAX_POINTS * POINT_BYTES * 2) this.buf = Buffer.alloc(0)
  }
}
