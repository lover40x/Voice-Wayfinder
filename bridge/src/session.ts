import { isNoiseTranscript, NoiseGate, type NoiseGateOptions } from './gate.ts'
import { randomUUID } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  type TranscriptLine,
  type VoiceActivity,
  type VoiceCard,
  type VoiceControlAction,
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

const STOPPED = 'The person ended voice mode (End). Continue in text and make no more voice calls until they start voice mode again.'

export type SayStatus = 'completed' | 'interrupted' | 'cancelled' | 'failed' | 'skipped' | 'ended' | 'paused' | 'resumed'
/** `pausedMs`: with `resumed`, how long the person had paused. */
export type SayResult = { status: SayStatus; spokenMs: number; detail?: string; pausedMs?: number }

export type ReplyStatus = 'replied' | 'timeout' | 'skipped' | 'ended' | 'cancelled' | 'disconnected' | 'resumed'
export type ReplyResult = { status: ReplyStatus; text: string; parts: string[]; typed?: boolean; pausedMs?: number }

/** `repeats`: how many times the person asked to hear the question again. */
export type ConverseResult = { said: SayResult; heardBefore: string[]; reply: ReplyResult; repeats: number }

export type InterviewAnswer = { question: string; status: ReplyStatus; answer: string; interrupted: boolean; repeats: number; pausedMs?: number }
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

// "I didn't catch that / say it again", in the ways people say it. Matched only
// on a short utterance, so an answer that happens to contain "again" is kept.
const REPEAT =
  /ฟังไม่ทัน|ไม่ได้ยิน|ได้ยินไม่ชัด|ฟังไม่ชัด|อีกที|อีกรอบ|อีกครั้ง|พูดใหม่|ถามใหม่|พูดอีก|พูดซ้ำ|ถามซ้ำ|ทวนคำถาม|ทวนอีก|ทวนหน่อย|ทวนให้|อะไรนะ|ว่าไงนะ|ว่าอะไรนะ|พูดช้า|ช้าๆ|\brepeat\b|\bagain\b|\bpardon\b|say that|didn'?t catch/i

export function isRepeatRequest(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.length <= 40 && REPEAT.test(t)
}

const round = (usdValue: number) => Math.round(usdValue * 1000) / 1000
export const usd = (n: number) => (n > 0 && n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`)
const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${(ms / 60_000).toFixed(1)} min`)

/** "4.2 min, $0.31 (Claude's speech $0.27, transcription $0.04)" */
export const describeCost = (c: VoiceSessionCost) =>
  `${minutes(c.durationMs)}, ${usd(c.costUsd)} (Claude's speech ${usd(c.speechUsd)} for ${minutes(c.spokenMs)}, transcription ${usd(c.transcriptionUsd)} for ${minutes(c.heardMs)})`

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
  private spend = { speech: 0, transcription: 0 }
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
    const { said, reply, repeats } = await this.ask(text, screen ? { screen } : undefined, timeoutMs, signal)
    if (!reply) {
      if (said.status === 'skipped') this.skipRequested = false
      const pausedMs = said.pausedMs !== undefined ? { pausedMs: said.pausedMs } : {}
      return { said, heardBefore, reply: { status: said.status === 'failed' ? 'disconnected' : (said.status as ReplyStatus), text: '', parts: [], ...pausedMs }, repeats }
    }
    return { said, heardBefore, reply, repeats }
  }

  /**
   * Asks a whole round of questions back to back, acknowledging each answer
   * at once, so Claude thinks only once per round instead of once per question.
   */
  async interview(questions: readonly string[], timeoutMs: number, signal?: AbortSignal, screen?: string): Promise<InterviewResult> {
    if (this.stopped) return { heardBefore: [], answers: [], unasked: [...questions], ended: STOPPED }
    await this.ensureConnected()
    const heardBefore = this.queue.splice(0).map(u => u.text)
    const answers: InterviewAnswer[] = []
    for (const [i, question] of questions.entries()) {
      const unasked = () => questions.slice(i + 1)
      const { said, reply, repeats } = await this.ask(question, { screen, question: i + 1, of: questions.length }, timeoutMs, signal)
      if (said.status === 'skipped') {
        this.skipRequested = false
        answers.push({ question, status: 'skipped', answer: '', interrupted: false, repeats })
        continue
      }
      if (!reply) {
        const status: ReplyStatus = said.status === 'failed' ? 'disconnected' : said.status === 'ended' ? 'ended' : said.status === 'resumed' ? 'resumed' : 'cancelled'
        answers.push({ question, status, answer: '', interrupted: false, repeats, ...(said.pausedMs !== undefined ? { pausedMs: said.pausedMs } : {}) })
        return { heardBefore, answers, unasked: unasked() }
      }
      answers.push({ question, status: reply.status, answer: reply.text, interrupted: said.status === 'interrupted', repeats, ...(reply.pausedMs !== undefined ? { pausedMs: reply.pausedMs } : {}) })
      if (reply.status === 'ended' || reply.status === 'cancelled' || reply.status === 'disconnected' || reply.status === 'resumed') {
        return { heardBefore, answers, unasked: unasked() }
      }
    }
    return { heardBefore, answers, unasked: [] }
  }

  control(action: VoiceControlAction, text = ''): { message: string; accepted: boolean; heard?: string[]; pausedMs?: number } {
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
      case 'take': {
        const heard = this.takeHeard()
        // A recap owed after a long pause goes to a waiting voice call if there is one.
        const pausedMs = this.calls === 0 ? this.takeRecap() : undefined
        return heard.length || pausedMs !== undefined
          ? { message: 'Took what was waiting for Claude.', accepted: true, heard, ...(pausedMs !== undefined ? { pausedMs } : {}) }
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
      partial: [...this.partials.values()].join(' ').trim() || undefined,
      warning: this.warning,
      error: this.error,
      transcript: this.lines.slice(-40),
      card: this.card,
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
    this.spend = { speech: 0, transcription: 0 }
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
      spokenMs: this.spokenMs,
      heardMs: this.heardMs,
    }
    this.startedAt = undefined
    this.lastSession = cost
    this.spend = { speech: 0, transcription: 0 }
    this.addLine('system', `${reason} OpenAI est.: ${describeCost(cost)}.`)
    this.deps.log?.end(reason, cost)
    this.history = undefined // re-read with this session in it
  }

  private currentCost() {
    return this.spend.speech + this.spend.transcription
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

  /** Says "heard you" at once, then the thinking cue if Claude takes a while. */
  private acknowledge() {
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
  private async ask(question: string, card: VoiceCard | undefined, timeoutMs: number, signal?: AbortSignal) {
    let repeats = 0
    let text = question
    for (;;) {
      const said = await this.say(text, signal, card, repeats > 0)
      if (said.status === 'skipped' || said.status === 'ended' || said.status === 'cancelled' || said.status === 'failed') {
        return { said, repeats, reply: undefined }
      }
      const reply = await this.collectReply(timeoutMs, signal)
      if (reply.status === 'replied' && repeats < MAX_REPEATS && isRepeatRequest(reply.text)) {
        repeats++
        this.deps.log?.timing({ what: 'repeat', n: repeats })
        text = `ได้ค่ะ ${question}`
        continue
      }
      if (reply.status === 'replied') this.acknowledge()
      return { said, repeats, reply }
    }
  }

  private warmClips(provider: VoiceProvider) {
    const clips = this.deps.clips
    const cueText = this.deps.thinkingCue && !this.deps.thinkingCue.pcm ? this.deps.thinkingCue.text : undefined
    const texts = [...(this.deps.acknowledgements ?? []), ...(cueText ? [cueText] : [])]
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
