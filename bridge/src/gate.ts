// A noise gate for the microphone, before anything reaches the provider's
// voice detection: steady room sound (a fan, an air conditioner, a hum) is
// sent as silence, so it neither opens "listening" nor cuts Claude off. Only
// sound well above the room's own level goes through.
//
// It learns the room's level as it goes (quick to fall, slow to rise) and
// opens on anything `openDb` above it. A short lookahead lets the first
// syllable through whole: the stream is delayed by `lookaheadMs`, and the
// audio just before the gate opened is sent as it was.

export type NoiseGateOptions = {
  /** How far above the room's level sound must be to pass, in dB. */
  openDb?: number
  /** Sound quieter than this never passes, however quiet the room (dBFS). */
  minDb?: number
  /** How long the gate stays open after the last loud moment. */
  holdMs?: number
  /** Audio kept before the gate opened, so word starts are not clipped. */
  lookaheadMs?: number
  sampleRate?: number
}

const CHUNK_MS = 10

type Chunk = { pcm: Buffer; keep: boolean }

export class NoiseGate {
  private readonly openDb: number
  private readonly minDb: number
  private readonly holdChunks: number
  private readonly lookahead: number
  private readonly chunkBytes: number
  private floor?: number
  private rest = Buffer.alloc(0)
  private queue: Chunk[] = []
  private holdLeft = 0

  constructor(o: NoiseGateOptions = {}) {
    this.openDb = o.openDb ?? 12
    this.minDb = o.minDb ?? -55
    this.holdChunks = Math.round((o.holdMs ?? 350) / CHUNK_MS)
    this.lookahead = Math.round((o.lookaheadMs ?? 120) / CHUNK_MS)
    this.chunkBytes = Math.round(((o.sampleRate ?? 24_000) * CHUNK_MS) / 1000) * 2
  }

  /** The room's level as learned so far, in dBFS. */
  get noiseFloorDb(): number | undefined {
    return this.floor
  }

  /** Takes PCM16 mono; returns what to send on, delayed by the lookahead, gated sound zeroed. */
  process(pcm: Buffer): Buffer {
    let data = this.rest.length ? Buffer.concat([this.rest, pcm]) : pcm
    const out: Buffer[] = []
    while (data.length >= this.chunkBytes) {
      const chunk = data.subarray(0, this.chunkBytes)
      data = data.subarray(this.chunkBytes)
      const sent = this.push(Buffer.from(chunk))
      if (sent) out.push(sent)
    }
    this.rest = Buffer.from(data)
    return Buffer.concat(out)
  }

  /** Forgets the queued audio (the mic was muted or the session restarted); keeps the room level. */
  reset() {
    this.queue = []
    this.rest = Buffer.alloc(0)
    this.holdLeft = 0
  }

  private push(pcm: Buffer): Buffer | undefined {
    const level = levelDb(pcm)
    const floor = this.learn(level)
    const loud = level >= Math.max(floor + this.openDb, this.minDb)
    if (loud) {
      this.holdLeft = this.holdChunks
      for (const c of this.queue) c.keep = true
    } else if (this.holdLeft > 0) this.holdLeft--
    this.queue.push({ pcm, keep: loud || this.holdLeft > 0 })
    if (this.queue.length <= this.lookahead) return undefined
    const c = this.queue.shift()!
    return c.keep ? c.pcm : Buffer.alloc(c.pcm.length)
  }

  private learn(level: number): number {
    if (this.floor === undefined) this.floor = level
    // Falls within a few chunks of quiet; rises over about five seconds, so a
    // long answer barely moves it but a fan switched on is learned.
    else if (level < this.floor) this.floor += (level - this.floor) * 0.5
    else this.floor += (level - this.floor) * 0.002
    this.floor = Math.max(this.floor, -90)
    return this.floor
  }
}

/** RMS level of PCM16 audio in dBFS (-90 for silence). */
export function levelDb(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2)
  if (!n) return -90
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  const rms = Math.sqrt(sum / n)
  return rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90
}

// What speech recognition makes of a cough, a sigh or room noise: nothing to
// answer. Whisper-style models also invent stock phrases from noise.
const NOISE_WORDS = /^(อืม+|อือ+|เอ่อ+|อ่า+|อ้า+|อ๋อ|แค่ก+|ค่อก+|อะแฮ่ม|อะเฮ็ม|ฮึ+|หึ+|เฮ้อ+|hmm+|mm+|uh+|um+|ah+|oh|ehem|ahem|cough|\(.*\)|\[.*\])$/i
const HALLUCINATIONS = [
  /ขอบคุณที่รับชม/,
  /ติดตามตอนต่อไป/,
  /กดติดตาม|กด subscribe|subscribe/i,
  /ซับไตเติ้ล|subtitles? by/i,
  /thank you for watching/i,
  /thanks for watching/i,
]

/** True for a transcript that is noise, not words someone meant to say. */
export function isNoiseTranscript(text: string): boolean {
  const t = text
    .trim()
    .replace(/[\s.,!?…。、"'“”‘’\-–—~*]+/g, ' ')
    .trim()
  if (!t) return true
  if (t.split(' ').every(w => NOISE_WORDS.test(w))) return true
  return HALLUCINATIONS.some(re => re.test(t)) && t.length < 60
}
