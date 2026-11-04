import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { TranscriptLine } from '../../plugin/shared/protocol.ts'

// Anything shaped like a key is masked before it reaches disk.
const SECRET = /\b(sk-[A-Za-z0-9_-]{12,}|0\.[0-9a-f-]{20,}\.[A-Za-z0-9+/=:]{20,})/g

export const redact = (text: string) => text.replace(SECRET, '[redacted]')

/** One JSONL file per voice session, for reviewing what was heard and said. */
export class TranscriptLog {
  private file?: string
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  begin(sessionId: string, meta: Record<string, unknown>) {
    const day = new Date().toISOString().slice(0, 10)
    const folder = join(this.dir, day)
    mkdirSync(folder, { recursive: true })
    this.file = join(folder, `${sessionId}.jsonl`)
    this.append({ kind: 'session', sessionId, ...meta, at: Date.now() })
  }

  line(line: TranscriptLine) {
    this.append({ kind: 'line', ...line, text: redact(line.text) })
  }

  /** Where a turn's time went: first audio, transcription, Claude's own gap. */
  timing(record: Record<string, number | string>) {
    this.append({ kind: 'timing', ...record, at: Date.now() })
  }

  end(reason: string) {
    this.append({ kind: 'end', reason, at: Date.now() })
    this.file = undefined
  }

  get path() {
    return this.file
  }

  private append(record: Record<string, unknown>) {
    if (!this.file) return
    try {
      appendFileSync(this.file, JSON.stringify(record) + '\n')
    } catch {
      // A full disk must not take the conversation down.
    }
  }
}
