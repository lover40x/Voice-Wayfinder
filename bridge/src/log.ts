import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TranscriptLine, VoiceSessionCost } from '../../plugin/shared/protocol.ts'

// Anything shaped like a key is masked before it reaches disk.
const SECRET = /\b(sk-[A-Za-z0-9_-]{12,}|0\.[0-9a-f-]{20,}\.[A-Za-z0-9+/=:]{20,})/g

export const redact = (text: string) => text.replace(SECRET, '[redacted]')

/** YYYY-MM-DD in local time, so "today" is the person's day. */
export const localDay = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** One JSONL file per voice session, for reviewing what was heard and said, and what it cost. */
export class TranscriptLog {
  private file?: string
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  begin(sessionId: string, meta: Record<string, unknown>) {
    const folder = join(this.dir, localDay(Date.now()))
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

  end(reason: string, cost?: VoiceSessionCost) {
    this.append({ kind: 'end', reason, ...cost, at: Date.now() })
    this.file = undefined
  }

  /** Estimated spend of the sessions logged so far today and this month (local time). */
  totals(now: number): { todayUsd: number; monthUsd: number } {
    const today = localDay(now)
    const month = today.slice(0, 7)
    let todayUsd = 0
    let monthUsd = 0
    if (!existsSync(this.dir)) return { todayUsd, monthUsd }
    // Folder names are days (older ones in UTC): start from the day before the
    // 1st, so a session filed under that edge is still counted by its own time.
    const n = new Date(now)
    const from = localDay(new Date(n.getFullYear(), n.getMonth(), 0).getTime())
    for (const day of readdirSync(this.dir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d <= today)) {
      for (const f of readdirSync(join(this.dir, day)).filter(f => f.endsWith('.jsonl'))) {
        for (const raw of readFileSync(join(this.dir, day, f), 'utf8').split('\n')) {
          if (!raw.includes('"kind":"end"')) continue
          try {
            const r = JSON.parse(raw) as { kind?: string; at?: number; costUsd?: number }
            if (r.kind !== 'end' || typeof r.costUsd !== 'number' || typeof r.at !== 'number') continue
            const d = localDay(r.at)
            if (d.slice(0, 7) === month) monthUsd += r.costUsd
            if (d === today) todayUsd += r.costUsd
          } catch {
            // A line cut short by a crash is skipped.
          }
        }
      }
    }
    return { todayUsd, monthUsd }
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
