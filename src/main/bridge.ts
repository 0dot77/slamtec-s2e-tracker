import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { FRAME_MAGIC, HEADER_BYTES, POINT_BYTES, MAX_POINTS } from '../shared/protocol'

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
 * Emits: 'scan' (RawScan), 'status' (BridgeStatus-like), 'log' (string).
 */
export class Bridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly bridgePath: string) {
    super()
  }

  start(ip = '192.168.11.2', port = 8089): void {
    this.stop()
    this.buf = Buffer.alloc(0)
    this.emit('status', { state: 'connecting', message: `${ip}:${port}` })

    const child = spawn(this.bridgePath, [ip, String(port)])
    this.child = child

    child.stdout.on('data', (c: Buffer) => this.onData(c))
    child.stderr.on('data', (c: Buffer) => this.onStderr(c.toString()))
    child.on('error', (err) =>
      this.emit('status', { state: 'error', message: `spawn failed: ${err.message}` })
    )
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      this.emit('status', { state: 'stopped', message: `exited (${code ?? signal})` })
    })
  }

  stop(): void {
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = undefined
    }
  }

  get running(): boolean {
    return !!this.child
  }

  private onStderr(text: string): void {
    for (const raw of text.split('\n')) {
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
      for (let i = 0; i < count; i++) {
        angle[i] = buf.readFloatLE(p)
        dist[i] = buf.readFloatLE(p + 4)
        quality[i] = buf[p + 8]
        p += POINT_BYTES
      }
      this.emit('scan', { seq, tMs, count, angle, dist, quality } satisfies RawScan)
      off += need
    }

    this.buf = off > 0 ? buf.subarray(off) : buf
  }
}
