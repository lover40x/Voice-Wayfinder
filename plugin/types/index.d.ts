// The one message format the bridge, the mod and the skill share (protocol v1).
// It lives here because the mod's state contract must be self-contained; the
// bridge reads the same types through shared/protocol.ts. Breaking change:
// bump `v` and PROTOCOL_VERSION together; readers refuse versions they don't know.

export type VoiceActivity =
  | 'off' // no realtime session
  | 'connecting'
  | 'idle' // connected, nothing in flight
  | 'listening' // waiting for the person's reply
  | 'hearing' // the person is speaking right now
  | 'speaking' // Claude's text is being spoken
  | 'muted'
  | 'paused' // the person paused: mic off, Claude waits until Resume
  | 'error'

/** One question of a `voice_interview` round, as the pane lists it. */
export type RoundItem = {
  question: string
  status: 'pending' | 'answered' | 'skipped'
  /** How the answer was understood, short ("ใช่", "ข้อสอง Linear", their words). */
  answer?: string
}

/** The round in progress, or the last one (`active` false): the pane's clickable question list. */
export type VoiceRound = {
  items: RoundItem[]
  /** Index (0-based) of the question being asked or read back. */
  current?: number
  active: boolean
}

/** What Claude put on screen for the question in progress: its full text and choices. */
export type VoiceCard = {
  /** Markdown: the question, numbered choices, the recommendation. */
  screen?: string
  /** In a `voice_interview` round: which question is being asked, of how many. */
  question?: number
  of?: number
}

export type TranscriptLine = {
  id: number
  at: number
  who: 'user' | 'claude' | 'system'
  text: string
  interrupted?: boolean
  /** Heard but not understood as an answer (noise, garbled): the question was asked again. */
  unclear?: boolean
  /** The person typed this instead of saying it. */
  typed?: boolean
}

/** What one voice session cost, estimated from the provider's usage and the config's prices. */
export type VoiceSessionCost = {
  endedAt: number
  reason: string
  durationMs: number
  costUsd: number
  /** Claude's speech: the realtime model's audio output and its instructions. */
  speechUsd: number
  /** Transcribing the person's speech. */
  transcriptionUsd: number
  /** Checking each spoken reply against its question (a small text model). */
  understandingUsd?: number
  spokenMs: number
  heardMs: number
}

/** The models a voice session uses, from the config: shown in the pane. */
export type VoiceModels = {
  /** The realtime model that speaks Claude's words. */
  speech: string
  /** Its voice. */
  voice: string
  /** The model that transcribes the person. */
  transcription: string
  /** The model that checks each spoken answer; absent when the check is off. */
  understanding?: string
}

export type VoiceStateV1 = {
  v: 1
  rev: number
  activity: VoiceActivity
  muted: boolean
  /** How fast Claude's speech is read (1 is normal), set with the pane's speed control. */
  speed?: number
  awaitingReply: boolean
  provider: string
  model: string
  models?: VoiceModels
  sessionStartedAt?: number
  /** The voice session in progress (0 when none). */
  estimatedCostUsd: number
  lastSession?: VoiceSessionCost
  /** Every voice session today and this month, the one in progress included. */
  todayCostUsd?: number
  monthCostUsd?: number
  queuedUtterances: number
  /** Voice mode was ended (End): nothing speaks, listens or reconnects until it is started again. */
  stopped?: true
  /** Resumed after a long pause; Claude owes a short recap (ms the pause lasted), until it is delivered. */
  recapDueAfterMs?: number
  /** The words being heard right now, before the utterance is finished. */
  partial?: string
  warning?: string
  error?: string
  transcript: TranscriptLine[]
  card?: VoiceCard
  round?: VoiceRound
  /** A question of the last round the person clicked to revisit, waiting for Claude (1-based). */
  revisitDue?: number
}

/** What `voice_status` answers when the caller already holds `sinceRev`. */
export type VoiceStateUnchanged = { v: 1; rev: number; unchanged: true }

/**
 * `type` delivers text the person typed as their answer (with `text`); `take`
 * hands over what they said while no question waited, answered with `heard`;
 * `start` turns voice mode back on after `end`; `pause` holds everything (mic, speech,
 * timeouts, Claude's next voice call) until `resume`; `goto` (with `question`, 1-based)
 * jumps the round to that question, or asks Claude to revisit it once the round is over;
 * `speed` (with `speed`) sets how fast speech is read, from the next sentence on.
 */
export type VoiceControlAction = 'start' | 'pause' | 'resume' | 'mute' | 'unmute' | 'skip' | 'end' | 'type' | 'take' | 'goto' | 'speed'

/** Whether the pane can reach the bridge's MCP server. */
export type BridgeLink = {
  status: 'connecting' | 'ok' | 'unreachable' | 'mismatch'
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    'voice-wayfinder': {
      voice: Shaped<VoiceStateV1 | null>
      link: BridgeLink
      /** Animation frame counter, advanced only while voice is on. */
      tick: number
      /** Whether Claude's main loop is working on a turn. */
      working: boolean
    }
  }
}
