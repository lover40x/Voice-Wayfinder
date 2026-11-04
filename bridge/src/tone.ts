// A soft "still thinking" sound made on the spot: a few harmonics of one chord,
// slightly detuned against each other so they shimmer, under a swell that rises
// and falls like a wave. Easier on the ear than the same words every time.

const RATE = 24_000

/** A partial: its frequency in Hz and its share of the mix. */
type Partial = { hz: number; gain: number }

// A major chord around A3, with the octave above; a quiet fifth on top.
const CHORD: Partial[] = [
  { hz: 220.0, gain: 1.0 },
  { hz: 277.18, gain: 0.55 },
  { hz: 329.63, gain: 0.6 },
  { hz: 440.0, gain: 0.35 },
  { hz: 659.26, gain: 0.12 },
]

export type ToneOptions = { durationMs?: number; volume?: number }

/** PCM16 mono 24 kHz, starting and ending in silence so it never clicks. */
export function waveTone({ durationMs = 1400, volume = 0.12 }: ToneOptions = {}): Buffer {
  const n = Math.round((durationMs / 1000) * RATE)
  const out = Buffer.alloc(n * 2)
  const total = CHORD.reduce((s, p) => s + p.gain, 0) * 2 // two detuned voices per partial
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const x = i / (n - 1)
    // Swell: a raised sine over the whole tone, so it rises and falls once.
    const swell = Math.sin(Math.PI * x) ** 2
    // A slow ripple on top, the "wave" in it.
    const ripple = 0.85 + 0.15 * Math.sin(2 * Math.PI * 2.2 * t)
    let v = 0
    for (const p of CHORD) {
      v += p.gain * Math.sin(2 * Math.PI * p.hz * t)
      v += p.gain * Math.sin(2 * Math.PI * p.hz * 1.003 * t + 0.6) // detuned twin
    }
    const sample = (v / total) * swell * ripple * volume
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2)
  }
  return out
}
