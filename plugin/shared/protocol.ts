// The bridge's view of the shared message format. The types are defined once,
// in types/index.d.ts (the mod's state contract); this file adds the version.

export type {
  MapSnapshot,
  MapTicket,
  TicketType,
  TranscriptLine,
  VoiceActivity,
  VoiceControlAction,
  VoiceStateUnchanged,
  VoiceStateV1,
} from '../types/index.js'

export const PROTOCOL_VERSION = 1
