# Changelog

All notable changes to the voice-wayfinder plugin. Versions follow semantic versioning; the bridge/mod message format has its own `v` (see `plugin/types/index.d.ts`).

## 0.1.0 (unreleased)

- Realtime voice bridge (MCP server `voice`): `voice_say`, `voice_listen`, `voice_converse`, `voice_status`, `voice_map_update`, `voice_control`.
- OpenAI Realtime adapter (GA protocol, default model `gpt-realtime-2.1`) behind the `VoiceProvider` interface; Claude Code stays the brain, the realtime model never replies on its own.
- Native `vw-audio` helper: full-duplex 24 kHz PCM16, instant playback flush on barge-in, optional macOS voice processing (echo cancellation).
- Idle auto-disconnect, session refresh before the provider's 60-minute limit, running cost estimate, local JSONL transcripts with key redaction.
- `voice-mode` skill: spoken Thai rules for /wayfinder.
- Map pane mod (`/voice-map`): voice status, current ticket, decided / blocked / fog, live transcript, mute / skip / end buttons. Protocol v1.
- Secrets through Bitwarden Secrets Manager (`bws run`), access token in the macOS Keychain.

### Fixed during the first live test

- The launcher quotes paths for `bws run`, which joins its arguments into one shell string (the plugin folder has a space).
- No vocabulary word list in the transcription `prompt`: on noise, the recogniser returned the list as a fake utterance. Vocabulary now goes only to models with a `keywords` field.
- Noise no longer cuts Claude off: the mic stays closed for 0.6 s after the audio engine starts, barge-in needs 250 ms of sustained speech (`bargeInConfirmMs`), utterances under 300 ms are dropped (`minUtteranceMs`), and the VAD threshold is 0.6.
- Echo cancellation: the playback chain is reconnected after voice processing reconfigures the engine (nothing played before).
