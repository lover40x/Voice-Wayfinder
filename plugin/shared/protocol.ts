// The bridge's view of the shared message format. The types are defined once,
// in types/index.d.ts (the mod's state contract); this file adds the version.

export type {
  RoundItem,
  VoiceModels,
  TranscriptLine,
  VoiceActivity,
  VoiceCard,
  VoiceControlAction,
  VoiceSessionCost,
  VoiceStateUnchanged,
  VoiceStateV1,
  VoiceRound,
} from '../types/index.js'

export const PROTOCOL_VERSION = 1
