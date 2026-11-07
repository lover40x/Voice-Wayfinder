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

export type VoiceStateV1 = {
  v: 1
  rev: number
  activity: VoiceActivity
  muted: boolean
  awaitingReply: boolean
  provider: string
  model: string
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
}

/** What `voice_status` answers when the caller already holds `sinceRev`. */
export type VoiceStateUnchanged = { v: 1; rev: number; unchanged: true }

/**
 * `type` delivers text the person typed as their answer (with `text`); `take`
 * hands over what they said while no question waited, answered with `heard`;
 * `start` turns voice mode back on after `end`; `pause` holds everything (mic, speech,
 * timeouts, Claude's next voice call) until `resume`.
 */
export type VoiceControlAction = 'start' | 'pause' | 'resume' | 'mute' | 'unmute' | 'skip' | 'end' | 'type' | 'take'

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
    }
  }
}
