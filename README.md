# Voice Wayfinder

A Claude Code plugin that lets you run Matt Pocock's `/wayfinder` as a spoken Thai conversation. Claude (in Claude Code) stays the brain and writes the map and tickets to your real issue tracker; an OpenAI realtime voice model is only the ears and mouth. Both directions stream at once, so you can interrupt Claude mid-sentence. A voice pane beside the transcript, and captions above the prompt, show the question being asked with its answer choices, what Claude is saying, and your own words live as you speak; answer by voice or by typing (a choice number works).

```
you ⇄ vw-audio (mic + speaker, macOS echo cancellation)
         ⇅ PCM16 24 kHz
     voice bridge (MCP server "voice") ⇄ OpenAI Realtime (speech in/out only)
         ⇅ voice_* tools                      ⇅ voice_status / voice_control
     Claude Code running /wayfinder      voice pane + captions mod (/voice-pane)
```

| Part | Where | What it does |
| --- | --- | --- |
| Bridge | `bridge/src` → bundled to `plugin/server/bridge.mjs` | MCP server: `voice_say`, `voice_listen`, `voice_converse`, `voice_interview`, `voice_status`, `voice_control`. Provider adapter seam in `bridge/src/provider.ts`; OpenAI Realtime is the first adapter. |
| Audio helper | `plugin/native/vw-audio/main.swift` | Full-duplex audio, instant flush on barge-in, macOS voice processing. Built per machine. |
| Skill | `plugin/skills/voice-mode/SKILL.md` | The voice rules for Wayfinder: one short Thai question at a time, nothing long read aloud, confirm before writing to the tracker. |
| Mod | `plugin/hooks/register.tsx` | The voice pane, the captions above the prompt and a status line; hands typed answers to the bridge. It reads the bridge through its MCP tools and never approves tools or changes permissions. |
| Message format | `plugin/types/index.d.ts` (protocol v1) | The one versioned format the three parts share. |

## Quick start

About ten minutes, most of it in Bitwarden.

### 1. Have these

- A Mac with [Claude Code](https://claude.com/claude-code) 2.1.287 or later, [Node](https://nodejs.org) 22.18+, and the Xcode command line tools (`xcode-select --install`).
- The Bitwarden Secrets Manager CLI, [`bws`](https://bitwarden.com/help/secrets-manager-cli/).
- An OpenAI API key with Realtime access. Make it in its own OpenAI project, so its cost shows on its own and you can revoke it alone.
- Matt Pocock's skills (`mattpocock-skills` 1.3.1+, which has `/wayfinder`), installed with `/plugin` from the `mattpocock/skills` marketplace.

### 2. Make four things in Bitwarden Secrets Manager

| Item | Name | Notes |
| --- | --- | --- |
| Project | `realtime-voice-wayfinder` | This project's secrets only |
| Secret | `OPENAI_REALTIME_API_KEY` | The OpenAI key. The name must be exactly this. |
| Machine account | `realtime-voice-wayfinder-mac` | Read-only access to that project only |
| Access token | one per Mac, named after it (`tan-macbook-pro`) | Copy it now: step 3 asks for it. Revoke it when the Mac is retired. |

### 3. Run the setup

```bash
git clone https://github.com/lover40x/Voice-Wayfinder.git && cd Voice-Wayfinder
```

```bash
npm run setup
```

It checks the Mac, builds the bridge and the audio helper, asks you to paste the access token (into the macOS Keychain, never into a file), checks that Bitwarden hands over the OpenAI key, installs the plugin for your user, and adds the permission rule below to `~/.claude/settings.json` after asking (your old file is kept as `settings.json.bak-voice-wayfinder`):

```json
{ "permissions": { "allow": ["mcp__plugin_voice-wayfinder_voice"] } }
```

Without that rule, auto mode blocks the voice pane's buttons and typed answers, and every voice turn waits on a permission check. Run `npm run setup` again any time: it only does what is missing. `npm run setup:check` reports what is set up and changes nothing.

### 4. Talk

Start a **new** Claude Code session in the repo you plan in (the first time there, run `/setup-matt-pocock-skills` once), then type:

```text
/voice-wayfinder:voice-mode
/wayfinder <your idea, or the map issue URL>
```

macOS asks for microphone access the first time: allow it. See [Use](#use) for what you see and how to answer.

## Manual setup

What `npm run setup` does, step by step, if you'd rather do it yourself.

### Build

```bash
npm install
```

```bash
npm run build
```

### Secrets

Put this Mac's access token in the Keychain (it prompts for the value, so it never lands in shell history):

```bash
security add-generic-password -s voice-wayfinder-bws -a "$USER" -w
```

Check that the key loads, without printing it:

```bash
BWS_ACCESS_TOKEN="$(security find-generic-password -s voice-wayfinder-bws -w)" bws run -- 'test -n "$OPENAI_REALTIME_API_KEY" && echo "key loaded" || echo "key missing"'
```

The bridge is started by `plugin/scripts/start-bridge.sh`, which runs it under `bws run`: the key exists only in the bridge process's memory, and the bridge removes it from its own environment so no child process inherits it. There is no `.env` file. If the machine account can read more than one project, set `VOICE_WAYFINDER_BWS_PROJECT_ID`.

### Install the plugin

From the clone's folder, in a terminal:

```bash
claude plugin marketplace add "$PWD"
```

```bash
claude plugin install voice-wayfinder@voice-wayfinder-dev
```

In the desktop app: + next to the prompt box → Plugins → Add marketplace with the clone's folder path → Add plugin. The plugin is read from this folder, so after editing it run `npm run build` and `/reload-plugins`. `/reload-plugins` reloads the skill and the pane but keeps the running bridge: for a bridge change, start a new session (or stop that session's `bridge.mjs` process; Claude Code starts the new build on the next voice call).

### Allow the voice tools

Add the rule to `permissions.allow` in `~/.claude/settings.json`, next to the rules already there:

```json
{ "permissions": { "allow": ["mcp__plugin_voice-wayfinder_voice"] } }
```

In auto mode, Claude Code's permission check refuses the pane's own calls to the bridge for anything but reading state (the buttons, typed answers), since no request of yours asked for them. The rule also spares every voice turn that check.

### Wayfinder in the target repo

In the repo you want to plan in, run `/setup-matt-pocock-skills` once so it writes the "Wayfinding operations" section and the `CLAUDE.md` pointer. A short text-only `/wayfinder` then shows whether the map issue (label `wayfinder:map`) and its child tickets land on GitHub.

## Use

In the target repo:

1. `/voice-wayfinder:voice-mode` turns voice mode on (Claude checks the bridge and greets you).
2. `/wayfinder <idea, or the map's URL>` runs Wayfinder; every question now comes by voice.
3. Read along in the voice pane (it opens with voice mode; `/voice-pane` reopens it) or the captions above the prompt. Answer by speaking, or type in the chat box and press Enter: during a question, what you type goes straight in as your answer. The pane's buttons mute the mic, skip a question, or end the voice session. Missed a question? Say or type "ฟังไม่ทัน" or "อีกที" and it is asked again, a little slower. A soft tone means Claude is still thinking.

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
- [ ] The pane and captions follow along: question card with choices, Claude's line, your live words, conversation, mute / skip / end; typed answers land as answers.
- [ ] Speakers without headphones: Claude does not interrupt itself.
