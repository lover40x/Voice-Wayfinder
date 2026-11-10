import WebSocket from 'ws'

import type { OpenAIConfig } from '../config.ts'
import { decisionsRequest, INSTRUCTIONS, parseUnderstanding, readDecisions, SCHEMA, userMessage, type DecisionAnswer, type Understanding, type UnderstandRequest } from '../understand.ts'
import type { ProviderEvent, SpeechStatus, VoiceProvider } from '../provider.ts'

const URL = 'wss://api.openai.com/v1/realtime'

export const DEFAULT_INSTRUCTIONS = [
  'You are only the voice of another assistant, speaking Thai with a Thai-speaking engineer.',
  'You never answer questions, give opinions, plan, or decide anything yourself.',
  'You only read aloud the script you are given, word for word, in natural conversational Thai at a brisk, lively pace, like a quick chat between colleagues. Never slow down, drag words out or pause between phrases.',
  'Pronounce English technical terms, product names and code identifiers in English.',
].join(' ')

const READ_ALOUD = [
  'Read the script below aloud exactly as written.',
  'Do not translate, summarise, answer, comment or add anything before or after it.',
].join(' ')

const SLOWER = ' The person asked to hear it again: read it a little slower and very clearly this time.'

type Pending = {
  speechId: string
  responseId?: string
  cancelRequested: boolean
  /** Set for synthesize(): audio is collected here instead of played. */
  clip?: { chunks: Buffer[]; resolve: (pcm: Buffer) => void; reject: (err: Error) => void }
}

/**
 * Recognition hints as OpenAI takes them: one line each (a line break makes it
 * refuse the whole session.update), no blanks or repeats, 80 at most.
 */
export function keywordsFrom(terms: readonly string[]): string[] {
  return [...new Set(terms.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 80)
}

/** OpenAI Realtime (GA) over WebSocket: server VAD, no automatic replies, out-of-band speech. */
export class OpenAIRealtimeProvider implements VoiceProvider {
  readonly name = 'openai-realtime'
  readonly model: string

  private ws?: WebSocket
  private handlers: ((e: ProviderEvent) => void)[] = []
  private speeches = new Map<string, Pending>()
  private byResponse = new Map<string, Pending>()
  private nextId = 1
  private vocabulary: readonly string[] = []
  private speechStartMs?: number
  private closingOnPurpose = false
  private readonly cfg: OpenAIConfig
  private readonly apiKey: string

  constructor(cfg: OpenAIConfig, apiKey: string) {
    this.cfg = cfg
    this.apiKey = apiKey
    this.model = cfg.model
  }

  onEvent(handler: (e: ProviderEvent) => void) {
    this.handlers.push(handler)
  }

  connect(): Promise<void> {
    this.closingOnPurpose = false
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${URL}?model=${encodeURIComponent(this.cfg.model)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      this.ws = ws
      let ready = false
      const fail = (message: string) => {
        if (!ready) reject(new Error(message))
      }
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0
        fail(
          status === 401
            ? 'OpenAI rejected the API key (401). Check OPENAI_REALTIME_API_KEY in Bitwarden.'
            : `OpenAI Realtime refused the connection (HTTP ${status}).`,
        )
      })
      ws.on('error', err => fail(`OpenAI Realtime connection failed: ${err.message}`))
      ws.on('open', () => this.send({ type: 'session.update', session: this.sessionConfig() }))
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString()) as ServerEvent
        if (!ready && msg.type === 'session.updated') {
          ready = true
          resolve()
        }
        if (!ready && msg.type === 'error') fail(`OpenAI Realtime: ${msg.error?.message ?? 'session setup failed'}`)
        this.handle(msg)
      })
      ws.on('close', (code, reason) => {
        fail(`OpenAI Realtime closed during setup (${code} ${reason.toString()})`)
        for (const p of this.speeches.values()) {
          if (p.clip) p.clip.reject(new Error('connection closed'))
          else this.emit({ type: 'speech.done', speechId: p.speechId, status: 'failed', detail: 'connection closed' })
        }
        this.speeches.clear()
        this.byResponse.clear()
        if (ready) this.emit({ type: 'closed', reason: `${code} ${reason.toString()}`.trim(), isExpected: this.closingOnPurpose })
      })
    })
  }

  close() {
    this.closingOnPurpose = true
    this.ws?.close()
    this.ws = undefined
  }

  say(text: string, options: { slower?: boolean } = {}): string {
    const speechId = `say_${this.nextId++}`
    this.speeches.set(speechId, { speechId, cancelRequested: false })
    this.requestSpeech(speechId, text, options.slower ? SLOWER : '')
    return speechId
  }

  synthesize(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const speechId = `clip_${this.nextId++}`
      this.speeches.set(speechId, { speechId, cancelRequested: false, clip: { chunks: [], resolve, reject } })
      this.requestSpeech(speechId, text)
    })
  }

  /** One Responses API call with a strict JSON schema; undefined on any failure or timeout. */
  async understand(request: UnderstandRequest, signal?: AbortSignal): Promise<Understanding | undefined> {
    const u = this.cfg.understanding
    if (!u?.enabled) return undefined
    const timeout = AbortSignal.timeout(u.timeoutMs)
    if ((u.api ?? 'decisions') === 'decisions') return this.decide(request, signal ? AbortSignal.any([signal, timeout]) : timeout)
    // The JSON prompt reads answers, not keep-or-change: the bridge reads those from plain words.
    if (request.review) return undefined
    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: u.model,
          instructions: INSTRUCTIONS,
          input: userMessage(request),
          ...(/^(gpt-5|o\d)/.test(u.model) ? { reasoning: { effort: 'minimal' } } : { temperature: 0 }),
          text: { format: { type: 'json_schema', name: 'understanding', strict: true, schema: SCHEMA } },
          max_output_tokens: 300,
          store: false,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as {
        output?: { content?: { type: string; text?: string }[] }[]
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const tokensIn = body.usage?.input_tokens ?? 0
      const tokensOut = body.usage?.output_tokens ?? 0
      if (tokensIn || tokensOut) {
        this.emit({ type: 'usage', kind: 'understanding', costUsd: (tokensIn * u.pricingUsd.inPerMTok + tokensOut * u.pricingUsd.outPerMTok) / 1e6 })
      }
      const text = body.output?.flatMap(o => o.content ?? []).find(c => c.type === 'output_text')?.text
      return text ? parseUnderstanding(text) : undefined
    } catch {
      return undefined
    }
  }

  /** The Decisions API: typed answers, about 0.3 s, input tokens only. */
  private async decide(request: UnderstandRequest, signal: AbortSignal): Promise<Understanding | undefined> {
    const u = this.cfg.understanding!
    try {
      const res = await fetch('https://api.openai.com/v1/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(decisionsRequest(u.model, request)),
        signal,
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { answers?: DecisionAnswer[]; usage?: { input_tokens?: number; output_tokens?: number } }
      const tokensIn = body.usage?.input_tokens ?? 0
      const tokensOut = body.usage?.output_tokens ?? 0
      if (tokensIn || tokensOut) {
        this.emit({ type: 'usage', kind: 'understanding', costUsd: (tokensIn * u.pricingUsd.inPerMTok + tokensOut * u.pricingUsd.outPerMTok) / 1e6 })
      }
      return body.answers ? readDecisions(body.answers, request, u.minConfidence) : undefined
    } catch {
      return undefined
    }
  }

  private requestSpeech(speechId: string, text: string, extra = '') {
    this.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['audio'],
        instructions: `${this.cfg.instructions ?? DEFAULT_INSTRUCTIONS}\n\n${READ_ALOUD}${extra}\n\n<script>\n${text}\n</script>`,
        input: [],
        metadata: { speech_id: speechId },
      },
    })
  }

  interrupt(speechId: string) {
    const p = this.speeches.get(speechId)
    if (!p) return
    p.cancelRequested = true
    // Out-of-band responses are not cancelled by server VAD: cancel by id.
    if (p.responseId) this.send({ type: 'response.cancel', response_id: p.responseId })
  }

  appendAudio(pcm: Buffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
  }

  clearInput() {
    this.send({ type: 'input_audio_buffer.clear' })
  }

  setVocabulary(terms: readonly string[]) {
    this.vocabulary = terms
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'session.update', session: { type: 'realtime', audio: { input: { transcription: this.transcription() } } } })
    }
  }

  private sessionConfig() {
    const td = this.cfg.turnDetection
    return {
      type: 'realtime',
      model: this.cfg.model,
      instructions: this.cfg.instructions ?? DEFAULT_INSTRUCTIONS,
      output_modalities: ['audio'],
      ...(this.cfg.reasoningEffort && /^gpt-realtime-2/.test(this.cfg.model) ? { reasoning: { effort: this.cfg.reasoningEffort } } : {}),
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          noise_reduction: this.cfg.noiseReduction ? { type: this.cfg.noiseReduction } : null,
          transcription: this.transcription(),
          // Claude Code is the brain: the realtime model never replies on its own.
          turn_detection:
            td.type === 'server_vad'
              ? {
                  type: 'server_vad',
                  threshold: td.threshold,
                  prefix_padding_ms: td.prefixPaddingMs,
                  silence_duration_ms: td.silenceDurationMs,
                  create_response: false,
                  interrupt_response: false,
                }
              : { type: 'semantic_vad', eagerness: td.eagerness, create_response: false, interrupt_response: false },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this.cfg.voice, speed: this.cfg.speed },
      },
    }
  }

  private transcription() {
    const { model, language, prompt } = this.cfg.transcription
    const out: Record<string, unknown> = { model }
    // The newer models take a list of language hints in place of `language`; never both.
    if (model === 'gpt-live-transcribe' || model === 'gpt-transcribe') out.languages = [language]
    else out.language = language
    // Vocabulary goes only to models with a keywords field. A word list in
    // `prompt` gets transcribed back verbatim when the mic hears only noise.
    if (this.vocabulary.length && (model === 'gpt-transcribe' || model === 'gpt-live-transcribe')) out.keywords = keywordsFrom(this.vocabulary)
    if (prompt && model !== 'gpt-realtime-whisper') out.prompt = prompt
    return out
  }

  private handle(msg: ServerEvent) {
    const pricing = this.cfg.pricingUsd
    // Speech is priced by the model that speaks; the flat prices are the fallback.
    const speech = this.cfg.speechPricingUsd?.[this.cfg.model] ?? pricing
    switch (msg.type) {
      case 'response.created': {
        const speechId = msg.response?.metadata?.speech_id
        const p = speechId ? this.speeches.get(speechId) : undefined
        if (!p || !msg.response?.id) return
        p.responseId = msg.response.id
        this.byResponse.set(p.responseId, p)
        if (p.cancelRequested) this.send({ type: 'response.cancel', response_id: p.responseId })
        return
      }
      case 'response.output_audio.delta': {
        const p = msg.response_id ? this.byResponse.get(msg.response_id) : undefined
        if (!p || p.cancelRequested || !msg.delta) return
        const pcm = Buffer.from(msg.delta, 'base64')
        if (p.clip) p.clip.chunks.push(pcm)
        else this.emit({ type: 'speech.audio', speechId: p.speechId, pcm })
        return
      }
      case 'response.done': {
        const r = msg.response
        const p = r?.id ? this.byResponse.get(r.id) : undefined
        const u = r?.usage
        if (u) {
          const audioOut = u.output_token_details?.audio_tokens ?? 0
          const textOut = u.output_token_details?.text_tokens ?? 0
          const textIn = u.input_tokens ?? 0
          this.emit({
            type: 'usage',
            kind: 'speech',
            costUsd: (textIn * speech.textInPerMTok + audioOut * speech.audioOutPerMTok + textOut * speech.textOutPerMTok) / 1e6,
          })
        }
        if (!p) return
        this.speeches.delete(p.speechId)
        this.byResponse.delete(r!.id!)
        if (p.clip) {
          if (r?.status === 'completed') p.clip.resolve(Buffer.concat(p.clip.chunks))
          else p.clip.reject(new Error(`clip not rendered (${r?.status ?? 'unknown'})`))
          return
        }
        const status: SpeechStatus = r?.status === 'completed' ? 'completed' : r?.status === 'cancelled' || p.cancelRequested ? 'cancelled' : 'failed'
        this.emit({ type: 'speech.done', speechId: p.speechId, status, detail: r?.status_details?.error?.message })
        return
      }
      case 'input_audio_buffer.speech_started':
        this.speechStartMs = msg.audio_start_ms
        this.emit({ type: 'user.speech_started' })
        return
      case 'input_audio_buffer.speech_stopped': {
        const durationMs = this.speechStartMs !== undefined && msg.audio_end_ms !== undefined ? msg.audio_end_ms - this.speechStartMs : undefined
        if (durationMs) this.emit({ type: 'usage', kind: 'transcription', costUsd: (durationMs / 60000) * pricing.transcriptionPerMin })
        this.emit({ type: 'user.speech_stopped', itemId: msg.item_id, durationMs })
        return
      }
      case 'input_audio_buffer.committed':
        if (msg.item_id) this.emit({ type: 'user.transcript_pending', itemId: msg.item_id })
        return
      case 'conversation.item.input_audio_transcription.delta':
        if (msg.item_id && msg.delta) this.emit({ type: 'user.transcript_delta', itemId: msg.item_id, delta: msg.delta })
        return
      case 'conversation.item.input_audio_transcription.completed':
        this.emit({ type: 'user.transcript', itemId: msg.item_id ?? '', text: msg.transcript ?? '' })
        return
      case 'conversation.item.input_audio_transcription.failed':
        this.emit({ type: 'user.transcript_failed', itemId: msg.item_id ?? '', message: msg.error?.message ?? 'transcription failed' })
        return
      case 'error': {
        const code = msg.error?.code
        if (code === 'response_cancel_not_active') return
        this.emit({ type: 'warning', message: `OpenAI Realtime: ${msg.error?.message ?? code ?? 'unknown error'}` })
        return
      }
    }
  }

  private send(event: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event))
  }

  private emit(e: ProviderEvent) {
    for (const h of this.handlers) h(e)
  }
}

type ServerEvent = {
  type: string
  response_id?: string
  item_id?: string
  delta?: string
  transcript?: string
  audio_start_ms?: number
  audio_end_ms?: number
  error?: { type?: string; code?: string; message?: string }
  response?: {
    id?: string
    status?: string
    status_details?: { error?: { message?: string } }
    metadata?: { speech_id?: string }
    usage?: {
      input_tokens?: number
      output_token_details?: { audio_tokens?: number; text_tokens?: number }
    }
  }
}
