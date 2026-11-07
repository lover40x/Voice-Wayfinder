# Changelog

All notable changes to the voice-wayfinder plugin. Versions follow semantic versioning; the bridge/mod message format has its own `v` (see `plugin/types/index.d.ts`).

## 0.2.0

- End means end: after the pane's End button (or `voice_control end`), every voice call answers `ended` without reconnecting or speaking, until voice mode is started again (`/voice-wayfinder:voice-mode`, which calls the new `voice_control start`). Before, Claude's next voice call reconnected and spoke. The pane says voice ended and how to start it again.
- Less room noise: a noise gate in the bridge learns the room's level and sends steady sound (fan, air conditioning, hum) as silence, so it no longer opens listening; a 120 ms lookahead keeps word starts whole (`audio.noiseGate`). macOS voice processing's automatic gain is off (`audio.autoGain`), so a quiet room is not turned up. Barge-in needs 500 ms of speech (was 250), so a throat clear no longer stops Claude. Coughs, "อืม", and stock phrases recognition invents from noise ("ขอบคุณที่รับชม") are dropped instead of taken as an answer. When macOS Voice Isolation is off, the pane suggests turning it on.
- Speaking while Claude works now gets an answer. What you say while Claude writes code or runs a build reaches it beside its next tool call's result (not only at its next voice question), and when Claude has finished its turn, what you say starts a new turn as your own words (marked 🎙). The skill tells Claude to answer at once by voice before carrying on. New `voice_control` action `take`, which the pane uses to collect those words once.
- Pane and captions restyled: one color per speaker (Claude orange, you blue) on every name; text in the normal color; the question card in an orange frame. The status animates while voice is on (sound bars while someone speaks, a breathing dot while listening, a spinner while connecting) in the speaker's color. Controls are three short buttons on one row (🔇 Mute · ⏭ Skip · ⏹ End). The conversation lists the newest line first.
- One-command setup: `npm run setup` checks the Mac, builds, stores the Bitwarden token in the Keychain, checks the OpenAI key arrives, installs the plugin and (after asking, with a backup) adds the voice tools allow rule to `~/.claude/settings.json`. `npm run setup:check` only reports. The README starts with a four-step quick start.
- The thinking cue is a soft harmonic tone made locally (a chord with a slow swell and shimmer), after 3 s and again every 8 s while Claude still thinks, instead of the same spoken words every time. `thinkingCue: "<text>"` still speaks a line instead; `""` turns it off.
- "ฟังไม่ทัน", "อีกที", "อะไรนะ", "repeat" and the like are no longer taken as the answer: the question is asked again, a little slower (up to 3 times), and the results say how often (`repeats`). Short utterances only, so a real answer that contains "again" still counts.
- The pane is now a live voice conversation, not a map: the question card Claude sends as `screen` (full question, numbered choices, recommendation; "Question 2 of 5" during a round), what Claude is saying, your words live as you speak, and the conversation. Answer by voice or by typing a choice.
- `voice_converse` and `voice_interview` take `screen` (Markdown for the card).
- Removed `voice_map_update` and the map from the pane, the state and the skill.
- `/voice-map` is now `/voice-pane`.
- `voice_status` is marked read-only, so auto mode lets the pane poll it. The pane explains a permission refusal and points at the allow rule in the README. It polls every 0.3 s while voice is on, every ~3 s while off.

## 0.1.0

- Realtime voice bridge (MCP server `voice`): `voice_say`, `voice_listen`, `voice_converse`, `voice_status`, `voice_map_update`, `voice_control`.
- OpenAI Realtime adapter (GA protocol, default model `gpt-realtime-2.1`) behind the `VoiceProvider` interface; Claude Code stays the brain, the realtime model never replies on its own.
- Native `vw-audio` helper: full-duplex 24 kHz PCM16, instant playback flush on barge-in, optional macOS voice processing (echo cancellation).
- Idle auto-disconnect, session refresh before the provider's 60-minute limit, running cost estimate, local JSONL transcripts with key redaction.
- `voice-mode` skill: spoken Thai rules for /wayfinder.
- Map pane mod (`/voice-map`): voice status, current ticket, decided / blocked / fog, live transcript, mute / skip / end buttons. Protocol v1.
- Secrets through Bitwarden Secrets Manager (`bws run`), access token in the macOS Keychain.

### Added after the first live tests

- Faster turns: speech at speed 1.2 with brisk-pace instructions; 0.5 s VAD silence and a 0.9 s end-of-reply window; per-turn timings in the log (first audio, transcription, Claude's gap).
- Instant acknowledgement ("ค่ะ") the moment a reply is complete and a thinking cue after 4 s, from clips rendered once and cached on disk.
- `voice_interview`: a whole grilling round asked back to back, with no wait on Claude between questions.
- Read along: Claude writes each spoken line on screen; the pane's Now box shows the current question and the words being heard live.
- Type to answer: Enter in the chat box during a voice question hands the text to the bridge as the answer (and stops Claude's speech); otherwise it goes to the chat as usual.
- Captions above the prompt (always in view, unlike a pane, which is held back in windows narrower than 144 columns unless the person opens it): status, Claude's current line, the live words or the last answer. A status line under the prompt shows voice state and cost. `/voice-wayfinder:voice-mode` opens the map pane as the person's own request, so it is placed at any width.
- Cost summary at every voice session end (duration, speech and transcription), plus today's and this month's totals from the local logs, in the transcript, the pane and `voice_status`. Log folders are named by local date.

### Fixed during the first live test

- The launcher quotes paths for `bws run`, which joins its arguments into one shell string (the plugin folder has a space).
- No vocabulary word list in the transcription `prompt`: on noise, the recogniser returned the list as a fake utterance. Vocabulary now goes only to models with a `keywords` field.
- Noise no longer cuts Claude off: the mic stays closed for 0.6 s after the audio engine starts, barge-in needs 250 ms of sustained speech (`bargeInConfirmMs`), utterances under 300 ms are dropped (`minUtteranceMs`), and the VAD threshold is 0.6.
- Echo cancellation: the playback chain is reconnected after voice processing reconfigures the engine (nothing played before).
