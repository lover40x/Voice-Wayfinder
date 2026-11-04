import { spawn, type ChildProcess } from 'node:child_process'

export type AudioEvent =
  | { type: 'mic'; pcm: Buffer }
  | { type: 'played'; seq: number }
  | { type: 'ready'; voiceProcessing: boolean }
  | { type: 'warning'; message: string }
  | { type: 'exit'; code: number | null; message?: string }

export interface AudioDevice {
  start(): Promise<void>
  stop(): void
  /** Queues PCM16 mono 24 kHz for playback; returns its sequence number. */
  play(pcm: Buffer): number
  /** Stops playback at once and drops everything queued. */
  flush(): void
  onEvent(handler: (e: AudioEvent) => void): void
}

class EchoCancellationUnavailable extends Error {}

/** Drives the native vw-audio helper over framed stdin/stdout. */
export class HelperAudioDevice implements AudioDevice {
  private child?: ChildProcess
  private handlers: ((e: AudioEvent) => void)[] = []
  private seq = 0
  private readBuf = Buffer.alloc(0)
  private lastError?: string
  private readonly binary: string
  private echoCancellation: boolean

  constructor(binary: string, echoCancellation: boolean) {
    this.binary = binary
    this.echoCancellation = echoCancellation
  }

  onEvent(handler: (e: AudioEvent) => void) {
    this.handlers.push(handler)
  }

  async start(): Promise<void> {
    try {
      await this.launch()
    } catch (err) {
      if (!(err instanceof EchoCancellationUnavailable)) throw err
      // The helper exits 4 when this device setup refuses voice processing.
      this.echoCancellation = false
      this.emit({ type: 'warning', message: err.message })
      await this.launch()
    }
  }

  private launch(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, this.echoCancellation ? ['--voice-processing'] : [], { stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      let ready = false
      child.on('error', err => reject(new Error(`audio helper failed to start (${this.binary}): ${err.message}. Run npm run build:audio.`)))
      child.stderr!.on('data', d => (this.lastError = d.toString().trim()))
      child.stdout!.on('data', (chunk: Buffer) => {
        this.readBuf = Buffer.concat([this.readBuf, chunk])
        while (this.readBuf.length >= 5) {
          const len = this.readBuf.readUInt32LE(1)
          if (this.readBuf.length < 5 + len) break
          const type = String.fromCharCode(this.readBuf[0]!)
          const payload = this.readBuf.subarray(5, 5 + len)
          this.readBuf = this.readBuf.subarray(5 + len)
          if (type === 'A') this.emit({ type: 'mic', pcm: Buffer.from(payload) })
          else if (type === 'P') this.emit({ type: 'played', seq: payload.readUInt32LE(0) })
          else if (type === 'E') {
            const e = JSON.parse(payload.toString()) as { type: string; message?: string; voiceProcessing?: boolean }
            if (e.type === 'ready') {
              ready = true
              this.emit({ type: 'ready', voiceProcessing: !!e.voiceProcessing })
              resolve()
            } else if (e.type === 'error') {
              this.lastError = e.message
              if (!ready) reject(new Error(e.message))
            } else if (e.type === 'warning' && e.message) {
              this.lastError = e.message
              if (ready) this.emit({ type: 'warning', message: e.message })
            }
          }
        }
      })
      child.on('exit', code => {
        if (!ready && code === 4) return reject(new EchoCancellationUnavailable(this.lastError ?? 'Echo cancellation unavailable; use headphones.'))
        if (!ready) reject(new Error(this.lastError ?? `audio helper exited (${code})`))
        if (this.child === child) this.child = undefined
        this.emit({ type: 'exit', code, message: this.lastError })
      })
    })
  }

  stop() {
    const child = this.child
    this.child = undefined
    if (!child) return
    this.write('Q', Buffer.alloc(0), child)
    child.stdin?.end()
    setTimeout(() => child.kill(), 500).unref()
  }

  play(pcm: Buffer): number {
    const seq = ++this.seq
    const payload = Buffer.alloc(4 + pcm.length)
    payload.writeUInt32LE(seq, 0)
    pcm.copy(payload, 4)
    this.write('A', payload)
    return seq
  }

  flush() {
    this.write('F', Buffer.alloc(0))
  }

  private write(type: string, payload: Buffer, child = this.child) {
    if (!child?.stdin?.writable) return
    const header = Buffer.alloc(5)
    header[0] = type.charCodeAt(0)
    header.writeUInt32LE(payload.length, 1)
    child.stdin.write(Buffer.concat([header, payload]))
  }

  private emit(e: AudioEvent) {
    for (const h of this.handlers) h(e)
  }
}
