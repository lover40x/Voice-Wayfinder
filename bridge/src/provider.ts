// The adapter seam: a voice provider is the ears and mouth, nothing more.
// OpenAI Realtime is the first adapter; another provider is one new file.

import type { Understanding, UnderstandRequest } from './understand.ts'

export type SpeechStatus = 'completed' | 'cancelled' | 'failed'

export type ProviderEvent =
  | { type: 'speech.audio'; speechId: string; pcm: Buffer }
  | { type: 'speech.done'; speechId: string; status: SpeechStatus; detail?: string }
  | { type: 'user.speech_started' }
  | { type: 'user.speech_stopped'; itemId?: string; durationMs?: number }
  | { type: 'user.transcript_pending'; itemId: string }
  | { type: 'user.transcript_delta'; itemId: string; delta: string }
  | { type: 'user.transcript'; itemId: string; text: string }
  | { type: 'user.transcript_failed'; itemId: string; message: string }
  | { type: 'usage'; costUsd: number; kind: 'speech' | 'transcription' | 'understanding' }
  | { type: 'warning'; message: string }
  | { type: 'closed'; reason: string; isExpected: boolean }

export interface VoiceProvider {
  readonly name: string
  readonly model: string
  /** Resolves once the session is configured and ready for audio. */
  connect(): Promise<void>
  close(): void
  /** Starts speaking `text` verbatim (`slower` for a repeat); returns the id its events carry. */
  say(text: string, options?: { slower?: boolean }): string
  /** Renders `text` to PCM16 without playing it (short clips kept for instant playback). */
  synthesize(text: string): Promise<Buffer>
  /** Stops generating one speech (barge-in, skip, cancel). */
  interrupt(speechId: string): void
  /** Streams PCM16 mono 24 kHz mic audio. */
  appendAudio(pcm: Buffer): void
  /** Drops mic audio not yet committed (used when muting). */
  clearInput(): void
  /** Terms the speech recogniser should expect (ticket names, tech words). */
  setVocabulary(terms: readonly string[]): void
  /** How fast speech is read (1 is normal); takes effect from the next speech. Optional. */
  setSpeed?(speed: number): void
  onEvent(handler: (e: ProviderEvent) => void): void
  /**
   * Reads a spoken reply against its question (see understand.ts). Optional:
   * without it, or when it fails, the bridge takes what was heard as the answer.
   */
  understand?(request: UnderstandRequest, signal?: AbortSignal): Promise<Understanding | undefined>
}
