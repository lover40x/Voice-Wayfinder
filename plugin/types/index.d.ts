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
  | 'error'

export type TicketType = 'grilling' | 'prototype' | 'research' | 'task'

export type MapTicket = {
  title: string
  url?: string
  type?: TicketType
}

export type MapSnapshot = {
  mapTitle?: string
  mapUrl?: string
  current?: MapTicket
  decided: MapTicket[]
  blocked: MapTicket[]
  fog: string[]
  updatedAt: number
}

export type TranscriptLine = {
  id: number
  at: number
  who: 'user' | 'claude' | 'system'
  text: string
  interrupted?: boolean
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
  estimatedCostUsd: number
  queuedUtterances: number
  warning?: string
  error?: string
  transcript: TranscriptLine[]
  map?: MapSnapshot
}

/** What `voice_status` answers when the caller already holds `sinceRev`. */
export type VoiceStateUnchanged = { v: 1; rev: number; unchanged: true }

export type VoiceControlAction = 'mute' | 'unmute' | 'skip' | 'end'

/** Whether the map pane can reach the bridge's MCP server. */
export type BridgeLink = {
  status: 'connecting' | 'ok' | 'unreachable' | 'mismatch'
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    'voice-wayfinder': {
      voice: Shaped<VoiceStateV1 | null>
      link: BridgeLink
    }
  }
}
