import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type TurnDetection =
  | { type: 'server_vad'; threshold: number; prefixPaddingMs: number; silenceDurationMs: number }
  | { type: 'semantic_vad'; eagerness: 'low' | 'medium' | 'high' | 'auto' }

export type OpenAIConfig = {
  model: string
  voice: string
  speed: number
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | null
  apiKeyEnv: string
  instructions?: string
  transcription: { model: string; language: string; prompt?: string }
  turnDetection: TurnDetection
  noiseReduction: 'near_field' | 'far_field' | null
  pricingUsd: { textInPerMTok: number; audioOutPerMTok: number; textOutPerMTok: number; transcriptionPerMin: number }
  /** A small text model that checks each spoken reply before a round moves on (bridge/src/understand.ts). */
  understanding?: {
    enabled: boolean
    /** "decisions": the Decisions API (typed answers, fixed confirmations); "responses": a text model writing JSON. */
    api?: 'decisions' | 'responses'
    model: string
    timeoutMs: number
    /** Decisions: an answer below this confidence counts as noise and is asked again. */
    minConfidence?: number
    pricingUsd: { inPerMTok: number; outPerMTok: number }
  }
}

export type BridgeConfig = {
  provider: 'openai-realtime'
  openai: OpenAIConfig
  audio: {
    echoCancellation: boolean
    /** Voice processing's automatic gain; off so a quiet room is not turned up. */
    autoGain?: boolean
    /** Room noise sent as silence before voice detection (bridge/src/gate.ts). */
    noiseGate?: { enabled: boolean; openDb?: number; minDb?: number; holdMs?: number; lookaheadMs?: number }
  }
  conversation: {
    endOfReplyMs: number
    replyTimeoutSec: number
    bargeInConfirmMs: number
    minUtteranceMs: number
    /** After a pause at least this long, Claude recaps where things stand (0: never). */
    recapAfterPauseSec?: number
    /** Short clips played the moment a reply is complete; [] turns them off. */
    acknowledgements: string[]
    /**
     * Played while Claude is still thinking after a reply: "tone" (a soft
     * harmonic wave, made locally), any other text to have it spoken, "" for none.
     */
    thinkingCue: string
    thinkingCueAfterMs: number
    /** Played again this often while Claude still thinks (0: once). */
    thinkingCueRepeatMs: number
  }
  session: { idleDisconnectMin: number; refreshAfterMin: number }
  vocabulary: string[]
  logDir: string | null
}

/** Where a person's own overrides live; anything they set wins over plugin/config/defaults.json. */
export const userConfigPath = () =>
  process.env.VOICE_WAYFINDER_CONFIG ?? join(homedir(), '.config', 'voice-wayfinder', 'config.json')

export function loadConfig(pluginRoot: string): BridgeConfig {
  const defaults = JSON.parse(readFileSync(join(pluginRoot, 'config', 'defaults.json'), 'utf8'))
  const path = userConfigPath()
  const overrides = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  return deepMerge(defaults, overrides) as BridgeConfig
}

export function defaultClipDir(): string {
  if (process.env.CLAUDE_PLUGIN_DATA) return join(process.env.CLAUDE_PLUGIN_DATA, 'clips')
  if (process.platform === 'win32') return join(localAppData(), 'voice-wayfinder', 'Cache', 'clips')
  return join(homedir(), 'Library', 'Caches', 'voice-wayfinder', 'clips')
}

export function defaultLogDir(): string {
  if (process.env.CLAUDE_PLUGIN_DATA) return join(process.env.CLAUDE_PLUGIN_DATA, 'transcripts')
  if (process.platform === 'win32') return join(localAppData(), 'voice-wayfinder', 'Logs')
  return join(homedir(), 'Library', 'Logs', 'voice-wayfinder')
}

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v)
  return out
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
