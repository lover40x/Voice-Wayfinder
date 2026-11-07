import { isNoiseTranscript, NoiseGate, type NoiseGateOptions } from './gate.ts'
import { ECHO, ECHO_CLIPS, refineUnderstanding, reviewByWords, spokenAnswer, thaiNumber, type Understanding } from './understand.ts'
import { randomUUID } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  type TranscriptLine,
  type VoiceActivity,
  type VoiceCard,
  type VoiceControlAction,
  type VoiceRound,
  type VoiceSessionCost,
  type VoiceStateUnchanged,
  type VoiceStateV1,
} from '../../plugin/shared/protocol.ts'
import type { AudioDevice, AudioEvent } from './audio.ts'
import type { ClipCache } from './clips.ts'
import { localDay, type TranscriptLog } from './log.ts'
import type { ProviderEvent, VoiceProvider } from './provider.ts'

export type SessionDeps = {
  createProvider: () => VoiceProvider
  createAudio: () => AudioDevice
  log?: TranscriptLog
  endOfReplyMs: number
  idleDisconnectMs: number
  refreshAfterMs: number
  baseVocabulary: readonly string[]
  /** Speech must last this long before it stops Claude (noise bursts don't). */
  bargeInConfirmMs?: number
  /** Utterances shorter than this are treated as noise and dropped. */
  minUtteranceMs?: number
  /** A pause at least this long ends with a recap from Claude before it goes on (0: never). */
  recapAfterPauseMs?: number
  /** Room noise is sent as silence (see gate.ts); false sends the mic as it is. */
  noiseGate?: NoiseGateOptions | false
  /** Played the instant a reply is complete, so the person hears they were heard. */
  acknowledgements?: readonly string[]
  /**
   * Played when Claude has not spoken `afterMs` after a reply, then every
   * `repeatMs` (up to `maxTimes`): a sound (`pcm`) or a clip of spoken `text`.
   */
  thinkingCue?: { pcm?: Buffer; text?: string; afterMs: number; repeatMs?: number; maxTimes?: number }
  clips?: ClipCache
  now?: () => number
  tickMs?: number
}

/** An answer as it was taken, for the next question's check: what was understood and said back. */
function describeTaken(a: { answer: string; understood?: Understanding }): string {
  const u = a.understood
  if (!u || u.kind !== 'answer') return a.answer
  return `${u.answer}${u.echo ? ` (confirmed aloud: "${u.echo}")` : ''}`
}

const STOPPED = 'The person ended voice mode (End). Continue in text and make no more voice calls until they start voice mode again.'

export type SayStatus = 'completed' | 'interrupted' | 'cancelled' | 'failed' | 'skipped' | 'ended' | 'paused' | 'resumed' | 'navigated'
/** `pausedMs`: with `resumed`, how long the person had paused. */
export type SayResult = { status: SayStatus; spokenMs: number; detail?: string; pausedMs?: number }

export type ReplyStatus = 'replied' | 'timeout' | 'skipped' | 'ended' | 'cancelled' | 'disconnected' | 'resumed' | 'navigated'
export type ReplyResult = { status: ReplyStatus; text: string; parts: string[]; typed?: boolean; pausedMs?: number }

/** `repeats`: how many times the person asked to hear the question again. */
/**
 * `understood`: how the reply reads against the question, when it was checked (understand.ts).
 * `revisit`: instead of answering, the person clicked a question of the last round in the pane.
 */
export type ConverseResult = { said: SayResult; heardBefore: string[]; reply: ReplyResult; repeats: number; understood?: Understanding; revisit?: Revisit }

/** A question of the last round the person asked to go back to, with how it was answered. */
export type Revisit = { number: number; question: string; answer: string }

type Round = {
  questions: readonly string[]
  /** One entry per question; undefined until answered or skipped. */
  answers: (InterviewAnswer | undefined)[]
  current?: number
  active: boolean
}

/** `changedFrom`: the person went back to this question in the pane and changed this earlier answer. */
export type InterviewAnswer = { question: string; status: ReplyStatus; answer: string; interrupted: boolean; repeats: number; pausedMs?: number; understood?: Understanding; changedFrom?: string }
export type InterviewResult = { heardBefore: string[]; answers: InterviewAnswer[]; unasked: string[]; ended?: string }

type ActiveSpeech = {
  id: string
  lineId: number
  requestedAt: number
  firstAudioAt?: number
  lastSeq: number
  generated: boolean
  bytesAtSeq: Map<number, number>
  sentBytes: number
  playedBytes: number
  finish: (status: SayStatus, detail?: string) => void
}

type Utterance = { text: string; at: number; typed?: boolean }

const BYTES_PER_MS = 48 // PCM16 mono 24 kHz
const MAX_LINES = 200
const MAX_REPEATS = 3
/** Noise or garbled words: the question is asked again this many times, then the reply goes to Claude as it is. */
const MAX_UNCLEAR = 2
/** How often one round may go back to an earlier question because an answer was misheard. */
const MAX_CORRECTIONS = 3

// "I didn't catch that / say it again", in the ways people say it. Matched only
// on a short utterance, so an answer that happens to contain "again" is kept.
const REPEAT =
  /ฟังไม่ทัน|ไม่ได้ยิน|ได้ยินไม่ชัด|ฟังไม่ชัด|อีกที|อีกรอบ|อีกครั้ง|พูดใหม่|ถามใหม่|พูดอีก|พูดซ้ำ|ถามซ้ำ|ทวนคำถาม|ทวนอีก|ทวนหน่อย|ทวนให้|อะไรนะ|ว่าไงนะ|ว่าอะไรนะ|พูดช้า|ช้าๆ|\brepeat\b|\bagain\b|\bpardon\b|say that|didn'?t catch/i

// "Don't ask again", "why ask twice": the opposite of a repeat request. An
// answer in the same breath ("ใช่ ไม่ต้องถามใหม่") also means it was heard.
const NOT_REPEAT = /ไม่ต้อง|ไม่เป็นไร|อย่า|ทำไม|พอแล้ว|เข้าใจแล้ว|ได้ยินแล้ว|\b(don'?t|no need|why|stop)\b/i
const ANSWER = /(^|\s)(ใช่|ไม่ใช่|ได้|ไม่ได้|โอเค|ok|okay|ตกลง|ถูก|ถูกต้อง|yes|no)(ค่ะ|คะ|ครับ|จ้ะ|จ้า|นะ)?($|\s)|ข้อ\s*(หนึ่ง|สอง|สาม|สี่|ห้า|แรก|\d)|\d/i

export function isRepeatRequest(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 40 || !REPEAT.test(t)) return false
  return !NOT_REPEAT.test(t) && !ANSWER.test(t)
}

const round = (usdValue: number) => Math.round(usdValue * 1000) / 1000
export const usd = (n: number) => (n > 0 && n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`)
const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${(ms / 60_000).toFixed(1)} min`)

/** "4.2 min, $0.31 (Claude's speech $0.27, transcription $0.04)" */
export const describeCost = (c: VoiceSessionCost) =>
  `${minutes(c.durationMs)}, ${usd(c.costUsd)} (Claude's speech ${usd(c.speechUsd)} for ${minutes(c.spokenMs)}, transcription ${usd(c.transcriptionUsd)} for ${minutes(c.heardMs)}${c.understandingUsd ? `, understanding ${usd(c.understandingUsd)}` : ''})`

/**
 * One long-lived voice conversation. The provider is the ears and mouth; every
 * decision stays with Claude Code, which drives this through the MCP tools.
 */
export class VoiceSession {
  private provider?: VoiceProvider
  private audio?: AudioDevice
  private connecting?: Promise<void>
  private speech?: ActiveSpeech
  private queue: Utterance[] = []
  private pending = new Set<string>()
  private userSpeaking = false
  private awaiting = false
  private muted = false
  private skipRequested = false
  private endRequested = false
  /**
   * The person (or Claude, at the end) ended voice mode: no voice call speaks or
   * listens again, and nothing reconnects, until voice mode is started again.
   */
  private stopped = false
  private gate?: NoiseGate
  /**
   * Paused from the pane (someone came to talk to the person): the mic is off,
   * nothing is spoken, a waiting question does not time out, and Claude's next
   * voice call waits; Resume picks up where it was, the interrupted line again.
   */
  private paused = false
  /** The last answer taken and how it was understood: what a "that was wrong" refers to. */
  private lastAnswer?: { question: string; answer: string }
  private round?: Round
  /** A question (0-based) the person clicked while the round runs. */
  private gotoRequested?: number
  private revisit?: Revisit
  private pausedAt = 0
  /** How long the last pause was, while Claude still owes the person a recap of where things stand. */
  private recapDue?: number
  /** Voice calls in progress: a recap goes to one of them before the pane may take it. */
  private calls = 0
  private micModeTold = false
  private lines: TranscriptLine[] = []
  private nextLineId = 1
  private card?: VoiceCard
  private rev = 1
  private spend = { speech: 0, transcription: 0, understanding: 0 }
  private spokenMs = 0
  private heardMs = 0
  private lastSession?: VoiceSessionCost
  /** Spend of sessions already ended today and this month, read from the log. */
  private history?: { day: string; todayUsd: number; monthUsd: number }
  private startedAt?: number
  private lastActivityAt = 0
  private warning?: string
  private error?: string
  private readonly now: () => number
  private readonly tickMs: number
  private timer?: NodeJS.Timeout
  private audioRestarts: number[] = []
  private bargeInTimer?: NodeJS.Timeout
  private heard = new Map<string, { durationMs?: number; stoppedAt: number }>()
  private partials = new Map<string, string>()
  private lastReplyAt?: number
  private clipSeq?: number
  private lastAck?: string
  private cueTimer?: NodeJS.Timeout
  private readonly deps: SessionDeps

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    if (deps.noiseGate !== false && deps.noiseGate !== undefined) this.gate = new NoiseGate(deps.noiseGate)
    this.tickMs = deps.tickMs ?? 50
  }

  // ---- tools ---------------------------------------------------------------

  /** `card` is what goes on screen while this is spoken; each call replaces the last. */
  async say(text: string, signal?: AbortSignal, card?: VoiceCard, slower = false): Promise<SayResult> {
    this.calls++
    try {
      for (;;) {
        await this.untilResumed(signal)
        if (this.stopped) return { status: 'ended', spokenMs: 0, detail: STOPPED }
        if (signal?.aborted) return { status: 'cancelled', spokenMs: 0 }
        // Back from a long pause: Claude recaps before saying this.
        const pausedMs = this.takeRecap()
        if (pausedMs !== undefined) return { status: 'resumed', spokenMs: 0, pausedMs }
        const said = await this.speakOnce(text, signal, card, slower)
        // Paused mid-sentence: say it again from the start once resumed.
        if (said.status !== 'paused') return said
      }
    } finally {
      this.calls--
    }
  }

  private takeRecap(): number | undefined {
    const pausedMs = this.recapDue
    if (pausedMs === undefined) return undefined
    this.recapDue = undefined
    this.changed()
    return pausedMs
  }

  /** Waits while paused; returns at once otherwise, or when ended or cancelled. */
  private async untilResumed(signal?: AbortSignal) {
    while (this.paused && !this.stopped && !signal?.aborted) await new Promise(r => setTimeout(r, this.tickMs))
  }

  private async speakOnce(text: string, signal: AbortSignal | undefined, card: VoiceCard | undefined, slower: boolean): Promise<SayResult> {
    await this.ensureConnected()
    const provider = this.provider!
    if (this.speech) this.stopSpeech('cancelled')
    clearTimeout(this.cueTimer)
    this.card = card
    const line = this.addLine('claude', text)
    const requestedAt = this.now()
    if (this.lastReplyAt !== undefined) {
      this.deps.log?.timing({ what: 'claude-turn', ms: requestedAt - this.lastReplyAt })
      this.lastReplyAt = undefined
    }
    return new Promise<SayResult>(resolve => {
      const speech: ActiveSpeech = {
        id: provider.say(text, { slower }),
        lineId: line.id,
        requestedAt,
        lastSeq: -1,
        generated: false,
        bytesAtSeq: new Map(),
        sentBytes: 0,
        playedBytes: 0,
        finish: (status, detail) => {
          if (this.speech !== speech) return
          this.speech = undefined
          signal?.removeEventListener('abort', onAbort)
          if (status !== 'completed') this.markLine(speech.lineId, { interrupted: true })
          this.spokenMs += Math.round(speech.playedBytes / BYTES_PER_MS)
          this.deps.log?.timing({
            what: 'speech',
            status,
            firstAudioMs: speech.firstAudioAt === undefined ? -1 : speech.firstAudioAt - speech.requestedAt,
            playedMs: Math.round(speech.playedBytes / BYTES_PER_MS),
            totalMs: this.now() - speech.requestedAt,
          })
          this.touch()
          resolve({ status, spokenMs: Math.round(speech.playedBytes / BYTES_PER_MS), detail })
        },
      }
      const onAbort = () => this.stopSpeech('cancelled')
      signal?.addEventListener('abort', onAbort)
      this.speech = speech
      this.touch()
    })
  }

  async listen(timeoutMs: number, signal?: AbortSignal): Promise<ReplyResult> {
    if (this.stopped) return { status: 'ended', text: '', parts: [] }
    await this.ensureConnected()
    this.calls++
    const reply = await this.collectReply(timeoutMs, signal).finally(() => this.calls--)
    if (reply.status === 'replied') this.acknowledge()
    return reply
  }

  async converse(text: string, timeoutMs: number, signal?: AbortSignal, screen?: string): Promise<ConverseResult> {
    if (this.stopped) return { said: { status: 'ended', spokenMs: 0, detail: STOPPED }, heardBefore: [], reply: { status: 'ended', text: '', parts: [] }, repeats: 0 }
    await this.ensureConnected()
    const heardBefore = this.queue.splice(0).map(u => u.text)
    const { said, reply, repeats, understood } = await this.ask(text, screen ? { screen } : undefined, timeoutMs, signal, '', this.lastAnswer)
    if (!reply || reply.status === 'navigated') {
      if (said.status === 'skipped') this.skipRequested = false
      const pausedMs = said.pausedMs !== undefined ? { pausedMs: said.pausedMs } : {}
      const revisit = this.takeRevisit()
      const status: ReplyStatus = reply?.status ?? (said.status === 'failed' ? 'disconnected' : (said.status as ReplyStatus))
      return { said, heardBefore, reply: { status, text: '', parts: [], ...pausedMs }, repeats, ...(revisit ? { revisit } : {}) }
    }
    // Claude speaks next: confirm what was understood meanwhile, or a quick "ค่ะ".
    if (reply.status === 'replied') this.acknowledge(understood?.kind === 'answer' ? understood.echo : '')
    return { said, heardBefore, reply, repeats, ...(understood ? { understood } : {}) }
  }

  /**
   * Asks a whole round of questions back to back, acknowledging each answer
   * at once, so Claude thinks only once per round instead of once per question.
   */
  async interview(questions: readonly string[], timeoutMs: number, signal?: AbortSignal, screen?: string): Promise<InterviewResult> {
    if (this.stopped) return { heardBefore: [], answers: [], unasked: [...questions], ended: STOPPED }
    await this.ensureConnected()
    const heardBefore = this.queue.splice(0).map(u => u.text)
    const round: Round = { questions, answers: [], active: true }
    this.round = round
    this.revisit = undefined
    this.changed()
    const answers = () => round.answers.filter((a): a is InterviewAnswer => a !== undefined && a.status !== 'navigated')
    const unasked = () => questions.filter((_, k) => round.answers[k] === undefined)
    const finish = () => {
      round.active = false
      round.current = undefined
      this.gotoRequested = undefined
      this.changed()
      return { heardBefore, answers: answers(), unasked: unasked() }
    }
    const card = (i: number): VoiceCard => ({ ...(screen ? { screen } : {}), question: i + 1, of: questions.length })
    // What was understood of the last answer, said just before the next question.
    let lead = ''
    let corrections = 0
    /** The question answered last: what a "that was wrong" goes back to. */
    let lastDone: number | undefined
    /** A question the person clicked in the pane; else the first one not yet answered. */
    let jumpTo: number | undefined
    for (;;) {
      // A click that came between two questions counts too.
      const i = jumpTo ?? this.takeGoto() ?? round.answers.findIndex((a, k) => k < questions.length && a === undefined)
      const next = i === -1 && round.answers.length < questions.length ? round.answers.length : i
      jumpTo = undefined
      if (next === -1 || next >= questions.length) break
      round.current = next
      this.changed()
      const question = questions[next]!

      // Clicked back to an answered question: read the answer back, keep or change it.
      const earlier = round.answers[next]
      if (earlier && earlier.status === 'replied') {
        const review = await this.review(next, earlier, card(next), timeoutMs, signal)
        if (review === 'navigated') {
          jumpTo = this.takeGoto()
          continue
        }
        if (review === 'keep') continue
        if (review !== 'change') {
          if (typeof review === 'object') {
            round.answers[next] = review
            lastDone = next
            continue
          }
          return finish()
        }
        lead = ''
      }

      const before = lastDone !== undefined ? round.answers[lastDone] : undefined
      const previous = before ? { question: before.question, answer: describeTaken(before) } : this.lastAnswer
      const { said, reply, repeats, understood } = await this.ask(question, card(next), timeoutMs, signal, lead, previous)
      lead = ''
      if (said.status === 'navigated' || reply?.status === 'navigated') {
        jumpTo = this.takeGoto()
        continue
      }
      if (said.status === 'skipped') {
        this.skipRequested = false
        round.answers[next] = { question, status: 'skipped', answer: '', interrupted: false, repeats }
        continue
      }
      if (!reply) {
        const status: ReplyStatus = said.status === 'failed' ? 'disconnected' : said.status === 'ended' ? 'ended' : said.status === 'resumed' ? 'resumed' : 'cancelled'
        round.answers[next] = { question, status, answer: '', interrupted: false, repeats, ...(said.pausedMs !== undefined ? { pausedMs: said.pausedMs } : {}) }
        return finish()
      }
      // "That was wrong": say so, drop the earlier answer and ask that question again.
      if (understood?.kind === 'correction' && lastDone !== undefined && corrections < MAX_CORRECTIONS) {
        corrections++
        this.deps.log?.timing({ what: 'correction', from: next + 1, to: lastDone + 1, heard: reply.text })
        round.answers[lastDone] = undefined
        this.lastAnswer = undefined
        const clip = this.clipFor(ECHO.correction)
        if (clip) {
          this.addLine('claude', ECHO.correction)
          this.playPcm(clip, ECHO.correction)
        } else lead = ECHO.correction
        jumpTo = lastDone
        lastDone = undefined
        continue
      }
      const changedFrom = earlier && earlier.status === 'replied' ? spokenAnswer(earlier.understood, earlier.answer) : undefined
      round.answers[next] = {
        question,
        status: reply.status,
        answer: reply.text,
        interrupted: said.status === 'interrupted',
        repeats,
        ...(reply.pausedMs !== undefined ? { pausedMs: reply.pausedMs } : {}),
        ...(understood ? { understood } : {}),
        ...(changedFrom !== undefined ? { changedFrom } : {}),
      }
      lastDone = next
      this.changed()
      if (reply.status === 'ended' || reply.status === 'cancelled' || reply.status === 'disconnected' || reply.status === 'resumed') {
        return finish()
      }
      const last = unasked().length === 0
      // Asked back, talked about something else, or a correction with no earlier question here: Claude takes it.
      if (understood && (understood.kind === 'question' || understood.kind === 'comment' || understood.kind === 'correction')) {
        this.acknowledge()
        return finish()
      }
      // What was understood, said back: a ready clip at once, else spoken with the next question.
      const echo = understood?.kind === 'answer' ? understood.echo : ''
      if (echo && !last && !this.clipFor(echo)) lead = echo
      else this.acknowledge(echo)
    }
    return finish()
  }

  /**
   * Reads an earlier answer back ("ข้อสอง ตอบไว้ว่า ใช่ ค่ะ จะเปลี่ยนไหมคะ") and
   * hears whether to keep it, change it (the question is asked again), or
   * a new answer straight away (returned as the new entry).
   */
  private async review(
    i: number,
    earlier: InterviewAnswer,
    card: VoiceCard,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<'keep' | 'change' | 'navigated' | 'stop' | InterviewAnswer> {
    const was = spokenAnswer(earlier.understood, earlier.answer)
    let said = await this.say(`ข้อ${thaiNumber(i + 1)} ตอบไว้ว่า ${was} ค่ะ จะเปลี่ยนไหมคะ`, signal, card)
    let unclear = 0
    for (;;) {
      if (said.status === 'navigated') return 'navigated'
      if (said.status !== 'completed' && said.status !== 'interrupted') return 'stop'
      const reply = await this.collectReply(timeoutMs, signal)
      if (reply.status === 'navigated') return 'navigated'
      if (reply.status === 'skipped') {
        this.skipRequested = false
        return 'keep'
      }
      if (reply.status !== 'replied') return reply.status === 'timeout' ? 'keep' : 'stop'
      const provider = this.provider
      const request = { question: earlier.question, heard: reply.text, review: { answer: was }, ...(card.screen ? { card: card.screen } : {}), questionNo: i + 1 }
      const read = reply.typed || !provider?.understand ? undefined : await provider.understand(request, signal)
      const u = read && read.kind !== 'unclear' ? read : (reviewByWords(reply.text) ?? read)
      this.deps.log?.timing({ what: 'review', question: i + 1, heard: reply.text, kind: u?.kind ?? 'none' })
      if (u?.kind === 'keep') {
        this.acknowledge(ECHO.keep)
        return 'keep'
      }
      if (u?.kind === 'change') {
        const clip = this.clipFor(ECHO.change)
        if (clip) {
          this.addLine('claude', ECHO.change)
          this.playPcm(clip, ECHO.change)
        }
        return 'change'
      }
      if (u?.kind === 'answer') {
        this.acknowledge(u.echo)
        return { question: earlier.question, status: 'replied', answer: reply.text, interrupted: false, repeats: 0, understood: u, changedFrom: was }
      }
      // Unclear, or a question back: ask once more by clip, then keep what was there.
      if (++unclear > MAX_UNCLEAR) {
        this.acknowledge(ECHO.keep)
        return 'keep'
      }
      this.markLine(this.lastUserLineId(), { unclear: true })
      const clip = this.clipFor(ECHO.unclear)
      if (clip) {
        this.addLine('claude', ECHO.unclear)
        this.playPcm(clip, ECHO.unclear)
        said = { status: 'completed', spokenMs: 0 }
      } else said = await this.say(`${ECHO.unclear} จะเปลี่ยนคำตอบข้อ${thaiNumber(i + 1)}ไหมคะ`, signal, card)
    }
  }

  private takeGoto(): number | undefined {
    const n = this.gotoRequested
    this.gotoRequested = undefined
    return n
  }

  private takeRevisit(): Revisit | undefined {
    const r = this.revisit
    if (r) {
      this.revisit = undefined
      this.changed()
    }
    return r
  }

  control(action: VoiceControlAction, text = '', question?: number): { message: string; accepted: boolean; heard?: string[]; pausedMs?: number; revisit?: Revisit } {
    const done = (message: string, accepted = true) => ({ message, accepted })
    switch (action) {
      case 'mute':
        this.muted = true
        this.userSpeaking = false
        this.gate?.reset()
        this.provider?.clearInput()
        this.touch()
        return done('Microphone muted.')
      case 'unmute':
        this.muted = false
        this.touch()
        return done('Microphone on.')
      case 'skip':
        if (!this.speech && !this.awaiting) return done('Nothing to skip.', false)
        this.skipRequested = true
        if (this.speech) this.stopSpeech('skipped')
        this.touch()
        return done('Question skipped.')
      case 'pause':
        if (this.paused) return done('Already paused.', false)
        this.paused = true
        this.pausedAt = this.now()
        this.userSpeaking = false
        clearTimeout(this.cueTimer)
        clearTimeout(this.bargeInTimer)
        this.gate?.reset()
        this.provider?.clearInput()
        if (this.speech) this.stopSpeech('paused')
        else if (this.clipSeq !== undefined) {
          this.audio?.flush()
          this.clipSeq = undefined
        }
        this.touch()
        return done('Paused: the mic is off and Claude waits until Resume.')
      case 'resume':
        if (!this.paused) return done('Not paused.', false)
        this.paused = false
        {
          const pausedMs = this.now() - this.pausedAt
          const after = this.deps.recapAfterPauseMs ?? 0
          if (after > 0 && pausedMs >= after) this.recapDue = pausedMs
        }
        this.touch()
        return done('Resumed.')
      case 'start':
        this.recapDue = undefined
        this.paused = false
        this.stopped = false
        this.endRequested = false
        this.touch()
        return done('Voice mode on. It connects on the first voice call.')
      case 'end': {
        this.recapDue = undefined
        this.paused = false
        this.stopped = true
        this.endRequested = true
        this.queue = []
        if (this.speech) this.stopSpeech('ended')
        const wasOn = !!this.provider
        this.disconnect('Voice session ended.')
        if (!wasOn || !this.lastSession) return done('Voice session ended.')
        const t = this.totals()
        return done(
          `Voice session ended. OpenAI est. this session: ${describeCost(this.lastSession)}. ` +
            `Today ${usd(t.todayCostUsd ?? 0)}, this month ${usd(t.monthCostUsd ?? 0)}.`,
        )
      }
      case 'goto': {
        const round = this.round
        const i = (question ?? 0) - 1
        if (!round || i < 0 || i >= round.questions.length) return done('No such question in the round.', false)
        if (round.active) {
          if (round.current === i && !this.speech && !this.awaiting) return done('Already on that question.', false)
          this.gotoRequested = i
          if (this.speech) this.stopSpeech('navigated')
          this.touch()
          return done(`Going to question ${i + 1}.`)
        }
        // The round is over: Claude asks it again; tell it which, and what was answered.
        const a = round.answers[i]
        this.revisit = { number: i + 1, question: round.questions[i]!, answer: a && a.status === 'replied' ? spokenAnswer(a.understood, a.answer) : '' }
        this.touch()
        return done(`Question ${i + 1} goes to Claude to revisit.`)
      }
      case 'take': {
        const heard = this.takeHeard()
        // A recap owed after a long pause goes to a waiting voice call if there is one.
        const pausedMs = this.calls === 0 ? this.takeRecap() : undefined
        const revisit = this.calls === 0 ? this.takeRevisit() : undefined
        return heard.length || pausedMs !== undefined || revisit
          ? { message: 'Took what was waiting for Claude.', accepted: true, heard, ...(pausedMs !== undefined ? { pausedMs } : {}), ...(revisit ? { revisit } : {}) }
          : { message: 'Nothing waiting.', accepted: false, heard }
      }
      case 'type':
        return this.typed(text)
          ? done('Typed reply delivered as the answer.')
          : done('No voice question is in progress, so the text was not taken as an answer.', false)
    }
  }

  /**
   * Hands over what the person said while no question was waiting (Claude at
   * work), so the pane can put it in front of Claude now instead of at the
   * next question. Nothing while a question waits (that reply takes it) or
   * while an utterance is still being spoken or transcribed (it would be cut).
   */
  private takeHeard(): string[] {
    if (this.awaiting || this.userSpeaking || this.pending.size > 0) return []
    const heard = this.queue.splice(0).map(u => u.text)
    if (heard.length) this.changed()
    return heard
  }

  /**
   * Takes what the person typed as their answer, while a question is being
   * spoken or awaited. Typing over Claude stops its speech, as speaking would.
   */
  private typed(text: string): boolean {
    const t = text.trim()
    if (!t || !this.provider || (!this.speech && !this.awaiting)) return false
    if (this.speech) this.stopSpeech('interrupted')
    this.queue.push({ text: t, at: this.now(), typed: true })
    this.addLine('user', t, { typed: true })
    this.touch()
    return true
  }

  state(sinceRev?: number): VoiceStateV1 | VoiceStateUnchanged {
    if (sinceRev === this.rev) return { v: PROTOCOL_VERSION, rev: this.rev, unchanged: true }
    return {
      v: PROTOCOL_VERSION,
      rev: this.rev,
      activity: this.activity(),
      muted: this.muted,
      awaitingReply: this.awaiting,
      provider: this.provider?.name ?? 'openai-realtime',
      model: this.provider?.model ?? '',
      sessionStartedAt: this.startedAt,
      estimatedCostUsd: round(this.currentCost()),
      lastSession: this.lastSession,
      ...this.totals(),
      queuedUtterances: this.queue.length,
      ...(this.stopped ? { stopped: true as const } : {}),
      ...(this.recapDue !== undefined ? { recapDueAfterMs: this.recapDue } : {}),
      ...(this.round ? { round: this.roundState(this.round) } : {}),
      ...(this.revisit ? { revisitDue: this.revisit.number } : {}),
      partial: [...this.partials.values()].join(' ').trim() || undefined,
      warning: this.warning,
      error: this.error,
      transcript: this.lines.slice(-40),
      card: this.card,
    }
  }

  private roundState(r: Round): VoiceRound {
    return {
      items: r.questions.map((question, k) => {
        const a = r.answers[k]
        if (!a || a.status === 'navigated') return { question, status: 'pending' as const }
        if (a.status === 'skipped') return { question, status: 'skipped' as const }
        return { question, status: 'answered' as const, answer: spokenAnswer(a.understood, a.answer) }
      }),
      ...(r.current !== undefined ? { current: r.current } : {}),
      active: r.active,
    }
  }

  summary(): string {
    const s = this.state() as VoiceStateV1
    const parts: string[] = [s.activity]
    if (s.sessionStartedAt) {
      parts.push(`connected ${Math.round((this.now() - s.sessionStartedAt) / 60000)} min`)
      parts.push(`est. ${usd(s.estimatedCostUsd)} so far`)
    } else if (s.lastSession) parts.push(`last voice session: ${describeCost(s.lastSession)}`)
    if (s.todayCostUsd !== undefined) parts.push(`OpenAI est. today ${usd(s.todayCostUsd)}, this month ${usd(s.monthCostUsd ?? 0)}`)
    if (s.queuedUtterances) parts.push(`${s.queuedUtterances} unheard utterance(s) waiting: call voice_listen`)
    if (s.activity === 'paused') parts.push('paused by the person: voice calls wait until they resume')
    if (s.muted) parts.push('mic muted')
    if (s.error) parts.push(`error: ${s.error}`)
    if (s.warning) parts.push(`warning: ${s.warning}`)
    return parts.join('; ')
  }

  warn(message: string) {
    this.warning = message
    this.changed()
  }

  shutdown() {
    clearInterval(this.timer)
    this.disconnect('Bridge stopped.')
  }

  // ---- connection ----------------------------------------------------------

  private async ensureConnected() {
    if (this.provider) return
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined
        this.changed()
      })
      this.changed()
    }
    await this.connecting
  }

  private async connect() {
    this.gate?.reset()
    this.endRequested = false
    this.skipRequested = false
    this.error = undefined
    let provider: VoiceProvider | undefined
    let audio: AudioDevice | undefined
    try {
      provider = this.deps.createProvider()
      audio = this.deps.createAudio()
      const p = provider
      const a = audio
      p.onEvent(e => this.onProvider(p, e))
      a.onEvent(e => this.onAudio(a, e))
      p.setVocabulary(this.vocabulary())
      await a.start() // mic permission problems surface before any API cost
      await p.connect()
    } catch (err) {
      provider?.close()
      audio?.stop()
      this.error = (err as Error).message
      throw err
    }
    this.provider = provider
    this.audio = audio
    this.spend = { speech: 0, transcription: 0, understanding: 0 }
    this.spokenMs = 0
    this.heardMs = 0
    this.startedAt = this.now()
    this.lastActivityAt = this.now()
    this.deps.log?.begin(randomUUID(), { provider: provider.name, model: provider.model })
    this.addLine('system', `Voice connected (${provider.model}).`)
    this.warmClips(provider)
    this.timer ??= setInterval(() => this.maintain(), 15_000)
    this.timer.unref?.()
  }

  private disconnect(reason: string) {
    const provider = this.provider
    const audio = this.audio
    if (!provider && !audio) return
    this.provider = undefined
    this.audio = undefined
    clearTimeout(this.cueTimer)
    this.clipSeq = undefined
    if (this.speech) this.stopSpeech('failed', reason)
    provider?.close()
    audio?.stop()
    this.userSpeaking = false
    this.pending.clear()
    this.partials.clear()
    const cost: VoiceSessionCost = {
      endedAt: this.now(),
      reason,
      durationMs: this.startedAt === undefined ? 0 : this.now() - this.startedAt,
      costUsd: round(this.currentCost()),
      speechUsd: round(this.spend.speech),
      transcriptionUsd: round(this.spend.transcription),
      ...(this.spend.understanding ? { understandingUsd: round(this.spend.understanding) } : {}),
      spokenMs: this.spokenMs,
      heardMs: this.heardMs,
    }
    this.startedAt = undefined
    this.lastSession = cost
    this.spend = { speech: 0, transcription: 0, understanding: 0 }
    this.addLine('system', `${reason} OpenAI est.: ${describeCost(cost)}.`)
    this.deps.log?.end(reason, cost)
    this.history = undefined // re-read with this session in it
  }

  private currentCost() {
    return this.spend.speech + this.spend.transcription + this.spend.understanding
  }

  /** Today's and this month's spend: ended sessions from the log, plus the one in progress. */
  private totals(): { todayCostUsd?: number; monthCostUsd?: number } {
    const log = this.deps.log
    if (!log) return {}
    const day = localDay(this.now())
    if (this.history?.day !== day) {
      const t = log.totals(this.now())
      this.history = { day, ...t }
    }
    return { todayCostUsd: round(this.history.todayUsd + this.currentCost()), monthCostUsd: round(this.history.monthUsd + this.currentCost()) }
  }

  private maintain() {
    if (!this.provider || this.speech || this.awaiting || this.userSpeaking) return
    const now = this.now()
    if (now - this.lastActivityAt > this.deps.idleDisconnectMs) this.disconnect('Disconnected after being idle (saves cost). It reconnects on the next question.')
    else if (this.startedAt && now - this.startedAt > this.deps.refreshAfterMs) this.disconnect('Session refreshed before the provider time limit.')
  }

  // ---- events --------------------------------------------------------------

  private onProvider(provider: VoiceProvider, e: ProviderEvent) {
    if (provider !== this.provider && e.type !== 'speech.done') return
    const speech = this.speech
    switch (e.type) {
      case 'speech.audio':
        if (!speech || speech.id !== e.speechId || !this.audio) return
        speech.firstAudioAt ??= this.now()
        speech.sentBytes += e.pcm.length
        speech.lastSeq = this.audio.play(e.pcm)
        speech.bytesAtSeq.set(speech.lastSeq, speech.sentBytes)
        return
      case 'speech.done':
        if (!speech || speech.id !== e.speechId) return
        speech.generated = true
        if (e.status === 'failed') speech.finish('failed', e.detail)
        else if (e.status === 'cancelled') speech.finish('cancelled')
        else if (speech.lastSeq < 0 || speech.playedBytes >= speech.sentBytes) speech.finish('completed')
        return
      case 'user.speech_started':
        this.userSpeaking = true
        clearTimeout(this.cueTimer)
        this.touch()
        // Barge-in: the person's voice wins over Claude's, once it is clearly speech.
        if (this.speech) this.confirmBargeIn(this.speech)
        else if (this.clipSeq !== undefined) {
          this.audio?.flush()
          this.clipSeq = undefined
        }
        return
      case 'user.speech_stopped':
        this.userSpeaking = false
        clearTimeout(this.bargeInTimer)
        if (e.itemId) this.heard.set(e.itemId, { durationMs: e.durationMs, stoppedAt: this.now() })
        this.heardMs += e.durationMs ?? 0
        this.touch()
        return
      case 'user.transcript_pending':
        this.pending.add(e.itemId)
        this.changed()
        return
      case 'user.transcript_delta':
        this.partials.set(e.itemId, (this.partials.get(e.itemId) ?? '') + e.delta)
        this.changed()
        return
      case 'user.transcript': {
        this.pending.delete(e.itemId)
        this.partials.delete(e.itemId)
        const heard = this.heard.get(e.itemId)
        this.heard.delete(e.itemId)
        const durationMs = heard?.durationMs
        const tooShort = durationMs !== undefined && durationMs < (this.deps.minUtteranceMs ?? 0)
        const text = e.text.trim()
        // A cough, a sigh, or what recognition invents from noise: not an answer.
        const noise = !tooShort && isNoiseTranscript(text)
        if (heard) this.deps.log?.timing({ what: 'heard', speechMs: durationMs ?? -1, transcribeMs: this.now() - heard.stoppedAt, dropped: tooShort ? 'short' : noise ? 'noise' : 'no' })
        if (text && !tooShort && !noise) {
          this.queue.push({ text, at: this.now() })
          this.addLine('user', text)
        }
        this.touch()
        return
      }
      case 'user.transcript_failed':
        this.pending.delete(e.itemId)
        this.partials.delete(e.itemId)
        this.warning = `Could not transcribe one utterance: ${e.message}`
        this.changed()
        return
      case 'usage':
        this.spend[e.kind] += e.costUsd
        this.changed()
        return
      case 'warning':
        this.warning = e.message
        this.changed()
        return
      case 'closed':
        if (!e.isExpected) {
          this.warning = `Voice connection closed (${e.reason}). It reconnects on the next call.`
          this.disconnect('Voice connection lost.')
        }
        return
    }
  }

  private onAudio(audio: AudioDevice, e: AudioEvent) {
    if (audio !== this.audio) return
    switch (e.type) {
      case 'mic': {
        if (this.muted || this.paused || !this.provider) return
        const pcm = this.gate ? this.gate.process(e.pcm) : e.pcm
        if (pcm.length) this.provider.appendAudio(pcm)
        return
      }
      case 'played': {
        if (this.clipSeq !== undefined && e.seq >= this.clipSeq) this.clipSeq = undefined
        const speech = this.speech
        if (!speech) return
        speech.playedBytes = speech.bytesAtSeq.get(e.seq) ?? speech.playedBytes
        if (speech.generated && e.seq >= speech.lastSeq) speech.finish('completed')
        return
      }
      case 'warning':
        this.warning = e.message
        this.changed()
        return
      case 'exit':
        // Device change or crash: start a fresh helper and keep the session.
        this.audio = undefined
        if (this.speech) this.stopSpeech('failed', 'audio device changed')
        this.restartAudio()
        return
      case 'ready':
        // macOS's own noise removal for calls: suggest it once when it is off.
        if (e.micMode && e.micMode !== 'voiceIsolation' && !this.micModeTold) {
          this.micModeTold = true
          this.warning =
            'For less room noise, turn on Voice Isolation while voice is on: Control Center → Mic Mode → Voice Isolation.'
          this.changed()
        }
        return
    }
  }

  private restartAudio() {
    if (!this.provider) return
    const now = this.now()
    this.audioRestarts = this.audioRestarts.filter(t => now - t < 60_000)
    if (this.audioRestarts.length >= 3) {
      this.error = 'The audio device keeps failing. Check the microphone and speakers, then ask again.'
      this.disconnect('Audio device unavailable.')
      return
    }
    this.audioRestarts.push(now)
    const audio = this.deps.createAudio()
    audio.onEvent(e => this.onAudio(audio, e))
    audio.start().then(
      () => {
        this.audio = audio
        this.changed()
      },
      err => {
        this.error = (err as Error).message
        this.disconnect('Audio device unavailable.')
      },
    )
  }

  // ---- helpers -------------------------------------------------------------

  /**
   * Says "heard you" at once, then the thinking cue if Claude takes a while:
   * `echo` (what was understood, "ข้อสองนะคะ") when there is one, else a ready clip.
   */
  private acknowledge(echo = '') {
    const echoClip = echo ? this.clipFor(echo) : undefined
    if (echoClip) {
      this.addLine('claude', echo)
      this.playPcm(echoClip, echo)
      this.startThinkingCue()
      return
    }
    if (echo) {
      void this.say(echo).then(() => this.startThinkingCue())
      return
    }
    const clips = this.deps.clips
    const ready = clips ? (this.deps.acknowledgements ?? []).filter(t => clips.get(t)) : []
    if (ready.length) {
      const choices = ready.length > 1 ? ready.filter(t => t !== this.lastAck) : ready
      const text = choices[Math.floor(Math.random() * choices.length)]!
      this.lastAck = text
      this.playPcm(clips!.get(text)!, text)
    }
    this.startThinkingCue()
  }

  private startThinkingCue() {
    const cue = this.deps.thinkingCue
    if (!cue) return
    clearTimeout(this.cueTimer)
    let played = 0
    const fire = () => {
      if (!this.provider || this.speech || this.awaiting || this.userSpeaking) return
      const pcm = cue.pcm ?? (cue.text ? this.deps.clips?.get(cue.text) : undefined)
      if (pcm) this.playPcm(pcm, cue.text ?? 'thinking tone')
      played++
      if (cue.repeatMs && played < (cue.maxTimes ?? 4)) {
        this.cueTimer = setTimeout(fire, cue.repeatMs)
        this.cueTimer.unref?.()
      }
    }
    this.cueTimer = setTimeout(fire, cue.afterMs)
    this.cueTimer.unref?.()
  }

  private playPcm(pcm: Buffer, label: string) {
    if (!this.audio || this.speech || this.paused) return
    this.clipSeq = this.audio.play(pcm)
    this.deps.log?.timing({ what: 'clip', text: label, afterReplyMs: this.lastReplyAt === undefined ? -1 : this.now() - this.lastReplyAt })
  }

  /**
   * Speaks a question and collects the answer. "I didn't catch that" is no
   * answer: the question is asked again, a little slower, until one comes.
   */
  private async ask(
    question: string,
    card: VoiceCard | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    lead = '',
    previous?: { question: string; answer: string },
  ): Promise<{ said: SayResult; repeats: number; reply?: ReplyResult; understood?: Understanding }> {
    let repeats = 0
    let unclear = 0
    let text = lead ? `${lead} ${question}` : question
    let said: SayResult | undefined
    let speak = true
    for (;;) {
      if (speak || !said) {
        said = await this.say(text, signal, card, repeats > 0)
        if (said.status === 'skipped' || said.status === 'ended' || said.status === 'cancelled' || said.status === 'failed' || said.status === 'resumed' || said.status === 'navigated') {
          return { said, repeats }
        }
      }
      // Spoken over this question: when, so a "no" to the last confirmation is told from an answer.
      const cutInAfterMs = speak && said.status === 'interrupted' ? said.spokenMs : undefined
      speak = true
      const reply = await this.collectReply(timeoutMs, signal)
      if (reply.status !== 'replied') return { said, repeats, reply }
      // A typed reply is meant as written; a spoken one is checked against the question.
      const understood = reply.typed ? undefined : await this.understandReply(question, card, reply.text, signal, previous, cutInAfterMs)
      const kind = understood?.kind ?? (isRepeatRequest(reply.text) ? 'repeat' : 'answer')
      if (kind === 'repeat' && repeats < MAX_REPEATS) {
        repeats++
        this.deps.log?.timing({ what: 'repeat', n: repeats, heard: reply.text })
        text = `ได้ค่ะ ${question}`
        continue
      }
      if (kind === 'unclear' && unclear < MAX_UNCLEAR) {
        unclear++
        this.deps.log?.timing({ what: 'unclear', n: unclear, heard: reply.text })
        this.markLine(this.lastUserLineId(), { unclear: true })
        // A ready clip asks again at once; the question stays on screen, not read again.
        const clip = this.clipFor(ECHO.unclear)
        if (clip) {
          this.addLine('claude', ECHO.unclear)
          this.playPcm(clip, ECHO.unclear)
          speak = false
          continue
        }
        text = `ขอโทษค่ะ ได้ยินไม่ชัด ${question}`
        continue
      }
      if (!understood || understood.kind === 'answer') {
        this.lastAnswer = { question, answer: understood ? describeTaken({ answer: reply.text, understood }) : reply.text }
      }
      return { said, repeats, reply, ...(understood ? { understood } : {}) }
    }
  }

  /** Asks the provider how the reply reads against the question; undefined when it can't tell (the reply then stands). */
  private async understandReply(
    question: string,
    card: VoiceCard | undefined,
    heard: string,
    signal?: AbortSignal,
    previous?: { question: string; answer: string },
    cutInAfterMs?: number,
  ): Promise<Understanding | undefined> {
    const provider = this.provider
    if (!provider?.understand) return undefined
    const started = this.now()
    const request = {
      question,
      heard,
      ...(card?.screen ? { card: card.screen } : {}),
      ...(card?.question !== undefined ? { questionNo: card.question } : {}),
      ...(previous ? { previous } : {}),
      ...(cutInAfterMs !== undefined ? { cutInAfterMs } : {}),
    }
    const understood = refineUnderstanding(await provider.understand(request, signal), request)
    this.deps.log?.timing({ what: 'understood', ms: this.now() - started, kind: understood?.kind ?? 'none', heard, answer: understood?.answer ?? '' })
    return understood
  }

  private clipFor(text: string): Buffer | undefined {
    return this.deps.clips?.get(text)
  }

  private warmClips(provider: VoiceProvider) {
    const clips = this.deps.clips
    const cueText = this.deps.thinkingCue && !this.deps.thinkingCue.pcm ? this.deps.thinkingCue.text : undefined
    // The fixed confirmations ("ใช่ค่ะ", "ข้อสองนะคะ", "ขอโทษค่ะ ได้ยินไม่ชัด…") when replies are checked.
    const texts = [...(this.deps.acknowledgements ?? []), ...(cueText ? [cueText] : []), ...(provider.understand ? ECHO_CLIPS : [])]
    if (!clips || !texts.length) return
    clips.warm(texts, t => provider.synthesize(t)).catch(err => this.warn(`Acknowledgement clips not ready: ${(err as Error).message}`))
  }

  private confirmBargeIn(speech: ActiveSpeech) {
    const wait = this.deps.bargeInConfirmMs ?? 0
    if (wait <= 0) return this.stopSpeech('interrupted')
    clearTimeout(this.bargeInTimer)
    this.bargeInTimer = setTimeout(() => {
      if (this.userSpeaking && this.speech === speech) this.stopSpeech('interrupted')
    }, wait)
  }

  private stopSpeech(status: SayStatus, detail?: string) {
    const speech = this.speech
    if (!speech) return
    this.audio?.flush()
    this.provider?.interrupt(speech.id)
    speech.finish(status, detail)
  }

  private async collectReply(timeoutMs: number, signal?: AbortSignal): Promise<ReplyResult> {
    clearTimeout(this.cueTimer)
    this.awaiting = true
    this.changed()
    const parts: string[] = []
    let deadline = this.now() + timeoutMs
    let lastHeardAt = this.now()
    let typed = false
    const result = (status: ReplyStatus): ReplyResult => ({ status, text: parts.join(' '), parts, ...(typed ? { typed } : {}) })
    try {
      for (;;) {
        if (signal?.aborted) return result('cancelled')
        if (this.endRequested) return result('ended')
        if (this.skipRequested) {
          this.skipRequested = false
          return result('skipped')
        }
        if (!this.provider && !this.connecting) return result('disconnected')
        while (this.queue.length) {
          const u = this.queue.shift()!
          parts.push(u.text)
          typed ||= !!u.typed
          lastHeardAt = this.now()
        }
        // Paused: the clock stops; an answer typed meanwhile still counts.
        if (this.paused && !typed) {
          deadline += this.tickMs
          lastHeardAt = this.now()
          await new Promise(r => setTimeout(r, this.tickMs))
          continue
        }
        // A question clicked in the pane: in the round, go there; after it, Claude revisits it.
        if (!parts.length && (this.gotoRequested !== undefined || (this.revisit && !this.round?.active))) return result('navigated')
        // Back from a long pause with no answer yet: Claude recaps and asks again.
        if (!parts.length && this.recapDue !== undefined) {
          const pausedMs = this.takeRecap()!
          return { ...result('resumed'), pausedMs }
        }
        const busy = this.userSpeaking || this.pending.size > 0
        if (busy) lastHeardAt = this.now()
        // A typed answer is finished when it is sent: no quiet window to wait out.
        const quietEnough = typed || this.now() - lastHeardAt >= this.deps.endOfReplyMs
        if (parts.length && !busy && quietEnough) {
          this.lastReplyAt = this.now()
          return result('replied')
        }
        if (!parts.length && !busy && this.now() >= deadline) return result('timeout')
        await new Promise(r => setTimeout(r, this.tickMs))
      }
    } finally {
      this.awaiting = false
      this.touch()
    }
  }

  private activity(): VoiceActivity {
    if (this.paused && !this.stopped) return 'paused'
    if (this.connecting) return 'connecting'
    if (!this.provider) return this.error ? 'error' : 'off'
    if (this.speech) return 'speaking'
    if (this.muted) return 'muted'
    if (this.userSpeaking) return 'hearing'
    if (this.awaiting) return 'listening'
    return 'idle'
  }

  private vocabulary(): string[] {
    return [...new Set(this.deps.baseVocabulary)]
  }

  private addLine(who: TranscriptLine['who'], text: string, extra: Partial<TranscriptLine> = {}): TranscriptLine {
    const line: TranscriptLine = { ...extra, id: this.nextLineId++, at: this.now(), who, text }
    this.lines.push(line)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    this.deps.log?.line(line)
    this.changed()
    return line
  }

  private lastUserLineId(): number {
    return this.lines.findLast(l => l.who === 'user')?.id ?? -1
  }

  private markLine(id: number, patch: Partial<TranscriptLine>) {
    const i = this.lines.findIndex(l => l.id === id)
    if (i >= 0) this.lines[i] = { ...this.lines[i]!, ...patch }
    this.changed()
  }

  private touch() {
    this.lastActivityAt = this.now()
    this.changed()
  }

  private changed() {
    this.rev++
  }
}
