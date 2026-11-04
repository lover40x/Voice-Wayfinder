import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Short spoken clips ("ค่ะ", "แป๊บนึงนะคะ") rendered once per voice and kept on
 * disk, so they play the instant they are needed, with no API round trip.
 */
export class ClipCache {
  private mem = new Map<string, Buffer>()
  private readonly dir?: string
  private readonly voiceKey: string

  /** `voiceKey` changes whenever the voice would sound different (model, voice, speed). */
  constructor(dir: string | undefined, voiceKey: string) {
    this.dir = dir
    this.voiceKey = voiceKey
  }

  get(text: string): Buffer | undefined {
    return this.mem.get(text)
  }

  async warm(texts: readonly string[], render: (text: string) => Promise<Buffer>) {
    for (const text of texts) {
      if (this.mem.has(text)) continue
      const file = this.file(text)
      if (file && existsSync(file)) {
        this.mem.set(text, readFileSync(file))
        continue
      }
      const pcm = await render(text)
      if (!pcm.length) continue
      this.mem.set(text, pcm)
      if (file) {
        try {
          mkdirSync(this.dir!, { recursive: true })
          writeFileSync(file, pcm)
        } catch {
          // A cache that can't be written only costs a render next time.
        }
      }
    }
  }

  private file(text: string) {
    if (!this.dir) return undefined
    return join(this.dir, `${createHash('sha1').update(`${this.voiceKey}\n${text}`).digest('hex')}.pcm`)
  }
}
