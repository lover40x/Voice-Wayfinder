import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { defaultClipDir, defaultLogDir, loadConfig, userConfigPath } from './config.ts'
import { HelperAudioDevice, helperPath } from './audio.ts'
import { ClipCache } from './clips.ts'
import { TranscriptLog } from './log.ts'
import { DEFAULT_INSTRUCTIONS, OpenAIRealtimeProvider } from './providers/openai-realtime.ts'
import { VoiceSession, type ReplyResult, type SayResult } from './session.ts'
import { waveTone } from './tone.ts'
import { checkClaudeCodeVersion } from './version.ts'

const VERSION = '0.2.0'
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig(pluginRoot)

// Read the key once and drop it from the environment, so no child process inherits it.
const apiKey = process.env[cfg.openai.apiKeyEnv]
delete process.env[cfg.openai.apiKeyEnv]
delete process.env.BWS_ACCESS_TOKEN

function storeTokenHint() {
  return process.platform === 'win32'
    ? 'Store the bws access token in Windows Credential Manager with npm run setup (in the plugin repo), or: cmdkey /generic:voice-wayfinder-bws /user:%USERNAME% /pass'
    : 'Store the bws access token with: security add-generic-password -s voice-wayfinder-bws -a "$USER" -w'
}

function thinkingCue() {
  const { thinkingCue: cue, thinkingCueAfterMs: afterMs, thinkingCueRepeatMs: repeatMs } = cfg.conversation
  if (!cue) return undefined
  return cue === 'tone' ? { pcm: waveTone(), afterMs, repeatMs } : { text: cue, afterMs, repeatMs }
}

const session = new VoiceSession({
  createProvider: () => {
    if (!apiKey) {
      const why = process.env.VOICE_WAYFINDER_SECRET_PROBLEM ?? `${cfg.openai.apiKeyEnv} is not set`
      throw new Error(
        `No OpenAI key: ${why}. ${storeTokenHint()} then restart Claude Code. See the README section "Secrets".`,
      )
    }
    return new OpenAIRealtimeProvider(cfg.openai, apiKey)
  },
  createAudio: () => new HelperAudioDevice(helperPath(pluginRoot), cfg.audio.echoCancellation, cfg.audio.autoGain ?? false),
  log: new TranscriptLog(cfg.logDir ?? defaultLogDir()),
  endOfReplyMs: cfg.conversation.endOfReplyMs,
  recapAfterPauseMs: (cfg.conversation.recapAfterPauseSec ?? 60) * 1000,
  bargeInConfirmMs: cfg.conversation.bargeInConfirmMs,
  noiseGate: cfg.audio.noiseGate?.enabled === false ? false : { ...cfg.audio.noiseGate },
  minUtteranceMs: cfg.conversation.minUtteranceMs,
  acknowledgements: cfg.conversation.acknowledgements,
  thinkingCue: thinkingCue(),
  // Anything that changes how a clip sounds is part of its cache key.
  clips: new ClipCache(defaultClipDir(), [cfg.openai.model, cfg.openai.voice, cfg.openai.speed, cfg.openai.instructions ?? DEFAULT_INSTRUCTIONS].join('|')),
  idleDisconnectMs: cfg.session.idleDisconnectMin * 60_000,
  refreshAfterMs: cfg.session.refreshAfterMin * 60_000,
  baseVocabulary: cfg.vocabulary,
})

void checkClaudeCodeVersion().then(w => w && session.warn(w))

const server = new McpServer({ name: 'voice-wayfinder', version: VERSION })

type Extra = {
  signal: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>
}

const text = (t: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(structured ? { structuredContent: structured } : {}),
})

async function guarded<T>(extra: Extra, run: () => Promise<T>, render: (r: T) => ReturnType<typeof text>) {
  // Keep long waits alive in the client with progress notifications.
  const token = extra._meta?.progressToken
  let ticks = 0
  const beat =
    token === undefined
      ? undefined
      : setInterval(() => {
          void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: session.summary() } }).catch(() => {})
        }, 10_000)
  try {
    return render(await run())
  } catch (err) {
    return { ...text((err as Error).message), isError: true }
  } finally {
    clearInterval(beat)
  }
}

const minutesSaid = (ms = 0) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

const describeSay = (r: SayResult) => {
  switch (r.status) {
    case 'completed':
      return 'Spoken in full.'
    case 'interrupted':
      return `The person interrupted after ${(r.spokenMs / 1000).toFixed(1)}s. Treat what they say next as the new input: call voice_listen.`
    case 'skipped':
      return 'The person pressed "skip question" in the voice pane. Move on without an answer.'
    case 'ended':
      return 'The person ended voice mode. Continue in text, and make no more voice calls until they start voice mode again (they will ask).'
    case 'cancelled':
      return 'Speech cancelled.'
    case 'paused':
      return 'Paused by the person.'
    case 'resumed':
      return `The person paused voice for ${minutesSaid(r.pausedMs)} (someone came to talk to them) and just resumed. First give a short spoken recap with voice_say, one or two sentences: where you are and what you were about to say or ask. Then say it or ask it again.`
    case 'failed':
      return `Speech failed: ${r.detail ?? 'unknown error'}. Say it again or continue in text.`
  }
}

const describeReply = (r: ReplyResult) => {
  switch (r.status) {
    case 'replied':
      return r.typed
        ? `The person answered (typed, at least in part, so take the words as written): ${r.text}`
        : `The person said (Thai speech, transcribed; English terms may be misheard): ${r.text}`
    case 'timeout':
      return 'No reply before the timeout. Ask again briefly, or call voice_listen to keep waiting.'
    case 'skipped':
      return 'The person skipped this question.'
    case 'ended':
      return 'The person ended voice mode. Continue in text, and make no more voice calls until they start voice mode again (they will ask).'
    case 'cancelled':
      return 'Listening was cancelled.'
    case 'resumed':
      return `The person paused voice for ${minutesSaid(r.pausedMs)} (someone came to talk to them) and just resumed. First give a short spoken recap with voice_say, one or two sentences: where you are and what you were about to say or ask. Then say it or ask it again.`
    case 'disconnected':
      return `The voice connection dropped${r.text ? ` after hearing: ${r.text}` : ''}. The next voice call reconnects.`
  }
}

const timeoutSec = z.number().int().min(5).max(900).optional().describe(`How long to wait for the person to start speaking (default ${cfg.conversation.replyTimeoutSec}s).`)

const screen = z
  .string()
  .max(6000)
  .optional()
  .describe(
    'Markdown shown in the voice pane while you ask: the full question, numbered answer choices and your recommendation. The person reads it and answers by voice or by typing (e.g. "2"). Speak only the short version.',
  )

server.registerTool(
  'voice_say',
  {
    title: 'Speak (Thai)',
    description:
      'Speak a short text aloud to the person in Thai, through the realtime voice session. Interruptible: if they start talking, speech stops at once and the result says so. Use for summaries and confirmations that need no answer; use voice_converse for questions.',
    inputSchema: { text: z.string().min(1).max(2000).describe('What to say, written in natural spoken Thai. No code, tables, markdown or URLs.') },
  },
  ({ text: t }, extra) => guarded(extra as Extra, () => session.say(t, extra.signal), r => text(describeSay(r), r)),
)

server.registerTool(
  'voice_listen',
  {
    title: 'Listen',
    description:
      "Return the person's next finished utterance as a transcript (anything they already said that nobody has heard yet comes back first). Waits until they finish speaking.",
    inputSchema: { timeoutSec },
  },
  ({ timeoutSec: t }, extra) =>
    guarded(extra as Extra, () => session.listen((t ?? cfg.conversation.replyTimeoutSec) * 1000, extra.signal), r => text(describeReply(r), r)),
)

server.registerTool(
  'voice_converse',
  {
    title: 'Ask by voice',
    description:
      "Speak a question in Thai, then wait for the person's spoken reply and return its transcript. Handles barge-in: if they interrupt, speech stops and the interruption is treated as their reply. The main tool for grilling and decision turns.",
    inputSchema: {
      text: z.string().min(1).max(2000).describe('One question, in short natural spoken Thai. No code, tables, lists or URLs.'),
      screen,
      timeoutSec,
    },
  },
  ({ text: t, screen: card, timeoutSec: s }, extra) =>
    guarded(
      extra as Extra,
      () => session.converse(t, (s ?? cfg.conversation.replyTimeoutSec) * 1000, extra.signal, card),
      r => {
        const lines = []
        if (r.heardBefore.length) lines.push(`Before this question the person had also said: ${r.heardBefore.join(' ')}`)
        if (r.repeats) lines.push(`The person asked to hear the question again; it was repeated ${r.repeats} time(s) before this answer.`)
        if (r.said.status !== 'completed') lines.push(describeSay(r.said))
        if (r.said.status === 'completed' || r.said.status === 'interrupted') lines.push(describeReply(r.reply))
        return text(lines.join('\n'), r)
      },
    ),
)

server.registerTool(
  'voice_interview',
  {
    title: 'Ask a round by voice',
    description:
      "Ask a whole round of independent questions by voice, back to back: each is spoken, the person's reply is captured and acknowledged at once, then the next question follows with no wait for you. Returns every answer. Use it for a grilling round; use voice_converse for a single question or a follow-up that depends on an answer.",
    inputSchema: {
      questions: z
        .array(z.string().min(1).max(600))
        .min(1)
        .max(8)
        .describe('Each question in short natural spoken Thai, worded so a yes accepts your recommendation. No code, tables, lists or URLs.'),
      screen: screen.describe(
        'Markdown for the whole round, shown in the voice pane while it runs: each question numbered (Q1, Q2, …) with its choices and your recommendation. The pane marks which one is being asked.',
      ),
      timeoutSec,
    },
  },
  ({ questions, screen: card, timeoutSec: s }, extra) =>
    guarded(
      extra as Extra,
      () => session.interview(questions, (s ?? cfg.conversation.replyTimeoutSec) * 1000, extra.signal, card),
      r => {
        if (r.ended) return text(r.ended, r)
        const lines = []
        if (r.heardBefore.length) lines.push(`Before the round the person had also said: ${r.heardBefore.join(' ')}`)
        r.answers.forEach((a, i) => {
          const heard = a.status === 'replied' ? a.answer : `(${describeReply({ status: a.status, text: a.answer, parts: [], pausedMs: a.pausedMs })})`
          const notes = [a.interrupted && 'they cut in while it was being asked', a.repeats && `asked to hear it again, repeated ${a.repeats}×`].filter(Boolean)
          lines.push(`Q${i + 1}: ${a.question}\nA${i + 1}${notes.length ? ` (${notes.join('; ')})` : ''}: ${heard}`)
        })
        if (r.unasked.length) lines.push(`Not asked: ${r.unasked.join(' | ')}`)
        lines.push('Answers are Thai speech, transcribed; English terms may be misheard.')
        return text(lines.join('\n\n'), r)
      },
    ),
)

server.registerTool(
  'voice_status',
  {
    title: 'Voice status',
    description: 'Report whether the voice session is off, idle, listening, hearing or speaking, plus cost so far and any problem. detail "full" is for the voice pane.',
    inputSchema: {
      detail: z.enum(['summary', 'full']).optional(),
      sinceRev: z.number().int().optional().describe('Full detail only: answer { unchanged: true } when the state is still at this revision.'),
    },
    // It only reads the bridge's state. Marked so, auto mode lets the pane poll it.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ detail, sinceRev }) => {
    if (detail !== 'full') return text(session.summary())
    const state = session.state(sinceRev)
    return text(JSON.stringify(state), state as Record<string, unknown>)
  },
)

server.registerTool(
  'voice_control',
  {
    title: 'Voice control',
    description:
      'Start voice mode (call "start" first: after "end" every voice call answers "ended" until then), mute or unmute the microphone, skip the current question, or end the voice session. "pause" and "resume" belong to the person (the Pause button in the voice pane): while paused, your voice calls wait. The voice pane buttons call this too; the pane uses "type" to hand over what the person typed as their answer and "take" to bring you what they said while you worked. You never need "type" or "take".',
    inputSchema: {
      action: z.enum(['start', 'pause', 'resume', 'mute', 'unmute', 'skip', 'end', 'type', 'take']),
      text: z.string().max(4000).optional().describe('With "type": what the person typed.'),
    },
  },
  async ({ action, text: typed }) => {
    const r = session.control(action, typed)
    return text(r.message, r)
  },
)

process.on('SIGTERM', () => {
  session.shutdown()
  process.exit(0)
})
process.stdin.on('end', () => {
  session.shutdown()
  process.exit(0)
})

await server.connect(new StdioServerTransport())
process.stderr.write(`voice-wayfinder bridge ${VERSION} ready (config overrides: ${userConfigPath()})\n`)
