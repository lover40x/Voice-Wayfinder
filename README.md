# Voice Wayfinder

A Claude Code plugin that lets you run Matt Pocock's `/wayfinder` as a spoken Thai conversation. Claude (in Claude Code) stays the brain and writes the map and tickets to your real issue tracker; an OpenAI realtime voice model is only the ears and mouth. Both directions stream at once, so you can interrupt Claude mid-sentence. A pane beside the transcript shows the voice status, the current ticket, the map and the live transcript.

```
you ⇄ vw-audio (mic + speaker, macOS echo cancellation)
         ⇅ PCM16 24 kHz
     voice bridge (MCP server "voice") ⇄ OpenAI Realtime (speech in/out only)
         ⇅ voice_* tools                      ⇅ voice_status / voice_control
     Claude Code running /wayfinder      map pane mod (/voice-map)
```

| Part | Where | What it does |
| --- | --- | --- |
| Bridge | `bridge/src` → bundled to `plugin/server/bridge.mjs` | MCP server: `voice_say`, `voice_listen`, `voice_converse`, `voice_status`, `voice_map_update`, `voice_control`. Provider adapter seam in `bridge/src/provider.ts`; OpenAI Realtime is the first adapter. |
| Audio helper | `plugin/native/vw-audio/main.swift` | Full-duplex audio, instant flush on barge-in, macOS voice processing. Built per machine. |
| Skill | `plugin/skills/voice-mode/SKILL.md` | The voice rules for Wayfinder: one short Thai question at a time, nothing long read aloud, confirm before writing to the tracker. |
| Mod | `plugin/hooks/register.tsx` | The map pane. Display only: it reads the bridge through its MCP tools and never approves tools or changes permissions. |
| Message format | `plugin/types/index.d.ts` (protocol v1) | The one versioned format the three parts share. |

## Requirements

- macOS, Claude Code 2.1.287 or later (`claude --version`; the pane and the bridge both warn when it is older).
- Node 22.18+, Xcode command line tools (`xcrun swiftc`), the Bitwarden Secrets Manager CLI `bws`.
- An OpenAI API key with Realtime access, in its own OpenAI project so its cost is tracked and it can be revoked alone.
- Microphone permission for the app that runs Claude Code (macOS asks the first time).

## Setup

### 1. Get it and build

The plugin runs from a local clone: the audio helper is compiled on your Mac.

```bash
git clone https://github.com/lover40x/Voice-Wayfinder.git && cd Voice-Wayfinder
```

```bash
npm install
```

```bash
npm run build
```

### 2. Secrets (Bitwarden Secrets Manager)

In Bitwarden Secrets Manager create:

| Item | Name | Notes |
| --- | --- | --- |
| Project | `realtime-voice-wayfinder` | This project's secrets only |
| Secret | `OPENAI_REALTIME_API_KEY` | The dedicated OpenAI key |
| Machine account | `realtime-voice-wayfinder-mac` | Read-only on that project only |
| Access token | one per Mac, named after it (`tan-macbook-pro`) | Revoke it when the Mac is retired |

Put this Mac's access token in the Keychain (it prompts for the value, so it never lands in shell history):

```bash
security add-generic-password -s voice-wayfinder-bws -a "$USER" -w
```

Check that the key loads, without printing it:

```bash
BWS_ACCESS_TOKEN="$(security find-generic-password -s voice-wayfinder-bws -w)" bws run -- 'test -n "$OPENAI_REALTIME_API_KEY" && echo "key loaded" || echo "key missing"'
```

The bridge is started by `plugin/scripts/start-bridge.sh`, which runs it under `bws run`: the key exists only in the bridge process's memory, and the bridge removes it from its own environment so no child process inherits it. There is no `.env` file. If the machine account can read more than one project, set `VOICE_WAYFINDER_BWS_PROJECT_ID`.

### 3. Install the plugin

From the clone's folder, in a terminal:

```bash
claude plugin marketplace add "$PWD"
```

```bash
claude plugin install voice-wayfinder@voice-wayfinder-dev
```

In the desktop app: + next to the prompt box → Plugins → Add marketplace with the clone's folder path → Add plugin. The plugin is read from this folder, so after editing it run `npm run build` and `/reload-plugins`. `/reload-plugins` reloads the skill and the pane but keeps the running bridge: for a bridge change, start a new session (or stop that session's `bridge.mjs` process; Claude Code starts the new build on the next voice call).

### 4. Wayfinder in the target repo (Phase 1)

Install Matt Pocock's skills (`mattpocock-skills`, 1.3.1 or later, which includes `/wayfinder`) from the `mattpocock/skills` marketplace with `/plugin`. Then, in the repo you want to plan in:

1. Run `/setup-matt-pocock-skills` so it writes the "Wayfinding operations" section and the `CLAUDE.md` pointer.
2. Run a short text-only `/wayfinder` session and check that the map issue (label `wayfinder:map`) and its child tickets appear on GitHub.

## Use

In the target repo:

1. `/voice-wayfinder:voice-mode` turns voice mode on (Claude checks the bridge and greets you).
2. `/wayfinder <idea, or the map's URL>` runs Wayfinder; every question now comes by voice.
3. `/voice-map` opens the map pane if it did not open by itself. Its buttons mute the mic, skip a question, or end the voice session.

Use headphones if echo cancellation reports it could not start (the pane shows the warning); otherwise the speakers work too.

## Configuration

Defaults are in `plugin/config/defaults.json`. Put your own overrides in `~/.config/voice-wayfinder/config.json` (deep-merged), for example:

```json
{
  "openai": { "model": "gpt-realtime-2.1-mini", "voice": "cedar", "turnDetection": { "type": "semantic_vad", "eagerness": "low" } },
  "audio": { "echoCancellation": false },
  "conversation": { "endOfReplyMs": 2000 },
  "vocabulary": ["Supabase", "RLS", "Edge Function"]
}
```

A new OpenAI model is a config change; a new provider is one new adapter implementing `VoiceProvider`. If you switch to a voice that speaks as a man (`cedar`, `ash`), tell Claude to use ครับ; the skill assumes `marin` and ค่ะ.

## Cost

The realtime model only speaks (it never answers on its own), so you pay mainly for spoken output (about $0.08 per minute of Claude's speech on `gpt-realtime-2.1`, about a third of that on `-mini`) plus transcription of your speech ($0.006 per minute on `gpt-4o-transcribe`). The pane shows a running estimate, and every voice session ends with a summary (minutes, Claude's speech, transcription) plus today's and this month's totals, added up from the local logs. These are estimates from the usage OpenAI reports and the prices in the config; the real bill is on OpenAI's usage page. The bridge disconnects after 10 idle minutes and refreshes the session before OpenAI's 60-minute limit; it reconnects on the next question.

## Transcripts

Each voice session is logged as JSONL under `~/Library/Logs/voice-wayfinder/<date>/` (or `$CLAUDE_PLUGIN_DATA/transcripts`), with anything shaped like a key masked. The OpenAI key is never logged.

## Development

```bash
npm run check
```

That runs the bridge type-check and tests, builds the bundle and the audio helper, validates the plugin and the marketplace, and runs the pane tests. Run it after every Claude Code update. The mod type-checks against the types Claude Code lays in `plugin/.claude-plugin/types/` once it has loaded the plugin (`npx tsc -p plugin`).

## Phase 6 checklist

Run a small throwaway Wayfinder map fully by voice, then note what breaks:

- [ ] Barge-in: interrupting mid-question stops Claude within a moment, and your words become the answer.
- [ ] Thai with English tech terms is transcribed well enough; Claude repeats key terms back before writing them.
- [ ] Latency between your answer and the next question feels conversational.
- [ ] Tickets, resolution comments and the map's Decisions-so-far land correctly on GitHub.
- [ ] The pane follows along: current ticket, decided / blocked / fog, transcript, mute / skip / end.
- [ ] Speakers without headphones: Claude does not interrupt itself.
