# Voice Wayfinder

A Claude Code plugin that lets you run Matt Pocock's `/wayfinder` as a spoken Thai conversation. Claude (in Claude Code) stays the brain and writes the map and tickets to your real issue tracker; an OpenAI realtime voice model is only the ears and mouth. Both directions stream at once, so you can interrupt Claude mid-sentence. A voice pane beside the transcript, and captions above the prompt, show the question being asked with its answer choices, what Claude is saying, and your own words live as you speak; answer by voice or by typing (a choice number works).

```
you ⇄ vw-audio (mic + speaker, with the OS's echo cancellation)
         ⇅ PCM16 24 kHz
     voice bridge (MCP server "voice") ⇄ OpenAI Realtime (speech in/out only)
         ⇅ voice_* tools                      ⇅ voice_status / voice_control
     Claude Code running /wayfinder      voice pane + captions mod (/voice-pane)
```

| Part | Where | What it does |
| --- | --- | --- |
| Bridge | `bridge/src` → bundled to `plugin/server/bridge.mjs` | MCP server: `voice_say`, `voice_listen`, `voice_converse`, `voice_interview`, `voice_status`, `voice_control`. Provider adapter seam in `bridge/src/provider.ts`; OpenAI Realtime is the first adapter. |
| Audio helper | `plugin/native/vw-audio/main.swift` (macOS), `main.cpp` (Windows) | Full-duplex audio, instant flush on barge-in, echo cancellation and noise suppression (macOS voice processing; on Windows the Voice Capture DSP). Built per machine. |
| Skill | `plugin/skills/voice-mode/SKILL.md` | The voice rules for Wayfinder: one short Thai question at a time, nothing long read aloud, confirm before writing to the tracker. |
| Launcher | `plugin/scripts/start-bridge.mjs` | Started by Claude Code with `node` on both systems: reads the Bitwarden token from the macOS Keychain or Windows Credential Manager, fetches the OpenAI key, then runs the bridge in the same process. |
| Mod | `plugin/hooks/register.tsx` | The voice pane, the captions above the prompt and a status line; hands typed answers to the bridge. It reads the bridge through its MCP tools and never approves tools or changes permissions. |
| Message format | `plugin/types/index.d.ts` (protocol v1) | The one versioned format the three parts share. |

## Quick start

About ten minutes, most of it in Bitwarden. It works on macOS and on Windows 10 or 11; the steps are the same, and [Windows](#windows) lists what differs.

### 1. Have these

- [Claude Code](https://claude.com/claude-code) 2.1.287 or later and [Node](https://nodejs.org) 22.18+.
- A compiler for the audio helper. On a Mac, the Xcode command line tools (`xcode-select --install`). On Windows, Visual Studio 2022 Build Tools with the "Desktop development with C++" workload (see [Windows](#windows)).
- The Bitwarden Secrets Manager CLI, [`bws`](https://bitwarden.com/help/secrets-manager-cli/), on your PATH.
- An OpenAI API key with Realtime access. Make it in its own OpenAI project, so its cost shows on its own and you can revoke it alone.
- Matt Pocock's skills (`mattpocock-skills` 1.3.1+, which has `/wayfinder`), installed with `/plugin` from the `mattpocock/skills` marketplace.

### 2. Make four things in Bitwarden Secrets Manager

| Item | Name | Notes |
| --- | --- | --- |
| Project | `realtime-voice-wayfinder` | This project's secrets only |
| Secret | `OPENAI_REALTIME_API_KEY` | The OpenAI key. The name must be exactly this. |
| Machine account | `realtime-voice-wayfinder-mac` | Read-only access to that project only |
| Access token | one per computer, named after it (`tan-macbook-pro`, `tan-desktop-pc`) | Copy it now: step 3 asks for it. Revoke it when the computer is retired. |

### 3. Run the setup

```bash
git clone https://github.com/lover40x/Voice-Wayfinder.git && cd Voice-Wayfinder
```

```bash
npm run setup
```

It checks the computer, builds the bridge and the audio helper, asks you to paste the access token (into the macOS Keychain or Windows Credential Manager, never into a file), checks that Bitwarden hands over the OpenAI key, installs the plugin for your user, and adds the permission rule below to `~/.claude/settings.json` after asking (your old file is kept as `settings.json.bak-voice-wayfinder`):

```json
{ "permissions": { "allow": ["mcp__plugin_voice-wayfinder_voice"] } }
```

Without that rule, auto mode blocks the voice pane's buttons and typed answers, and every voice turn waits on a permission check. Run `npm run setup` again any time: it only does what is missing. `npm run setup:check` reports what is set up and changes nothing. `npm run setup -- --new-token` replaces a stored token (after you rotate it).

### 4. Talk

Start a **new** Claude Code session in the repo you plan in (the first time there, run `/setup-matt-pocock-skills` once), then type:

```text
/voice-wayfinder:voice-mode
/wayfinder <your idea, or the map issue URL>
```

macOS asks for microphone access the first time: allow it. On Windows, "Let desktop apps access your microphone" must be on (Settings > Privacy & security > Microphone). See [Use](#use) for what you see and how to answer.

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

On a Mac, put this computer's access token in the Keychain (it prompts for the value, so it never lands in shell history):

```bash
security add-generic-password -s voice-wayfinder-bws -a "$USER" -w
```

On Windows, put it in Credential Manager as a generic credential named `voice-wayfinder-bws`. `npm run setup` does this; by hand, `cmdkey` prompts for the value when `/pass` has none (or use Control Panel > Credential Manager > Windows Credentials > Add a generic credential):

```bat
cmdkey /generic:voice-wayfinder-bws /user:%USERNAME% /pass
```

Check that the key loads, without printing it (either system):

```bash
npm run setup:check
```

Claude Code starts the bridge with `node plugin/scripts/start-bridge.mjs`. It reads the token, asks `bws secret list` for the one secret named `OPENAI_REALTIME_API_KEY` (the token goes to `bws` in its environment only), and runs the bridge in that same process: the key exists only in the bridge process's memory, and the bridge removes it from its own environment so no child process inherits it. There is no `.env` file. If the machine account can read more than one project, set `VOICE_WAYFINDER_BWS_PROJECT_ID`.

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
3. Read along in the voice pane (it opens with voice mode; `/voice-pane` reopens it) or the captions above the prompt. Answer by speaking, or type in the chat box and press Enter: during a question, what you type goes straight in as your answer. The pane's buttons pause (someone came to talk to you: the mic goes off and Claude waits until you press Resume; after a minute or more away, Claude starts with a short recap of where you were), mute the mic, skip a question, or end the voice session; under them, − and + make Claude speak slower or faster (0.7× to 1.5×, kept for next time), or just ask "พูดช้าลงหน่อย". The pane lists the round's questions: click one to jump to it, or click an answered one to hear your answer and keep or change it (you may change your mind as you go). Missed a question? Say or type "ฟังไม่ทัน" or "อีกที" and it is asked again, a little slower. A soft tone means Claude is still thinking. Quick confirmations come in a round of short questions; open questions (how something should work, edge cases) are talked through: explain as long as you need, pause to think (a sentence left hanging on "แต่ว่า…" or "ถ้าเกิดว่า…" is waited for), and Claude says back what it understood and follows up until the decision is clear. Your words appear in the pane as you speak. In a round, each spoken answer is checked against its question before the round moves on: noise gets an instant "ขอโทษค่ะ ได้ยินไม่ชัด พูดอีกทีได้ไหมคะ" and is listened for again, and what was understood is said back to you ("ใช่ค่ะ", "ข้อสองนะคะ") before the next question. If that confirmation is wrong, say so ("เมื่อกี้บอกว่าใช่", "ฟังผิด", or just "ไม่ใช่" as soon as you hear it): it goes back and asks that question again. You can also speak while Claude is working (writing code, running a build): it hears you at its next step and answers by voice, and once it has finished, what you say starts its next turn. Mute the mic when you talk to someone else in the room.

Use headphones if echo cancellation reports it could not start (the pane shows the warning); otherwise the speakers work too. For a noisy room, turn on macOS Voice Isolation while voice is on (Control Center → Mic Mode → Voice Isolation); the bridge also gates out steady room noise on its own. End in the pane stops voice for good: Claude carries on in text until you run `/voice-wayfinder:voice-mode` again.

## Configuration

Defaults are in `plugin/config/defaults.json`. Put your own overrides in `~/.config/voice-wayfinder/config.json` (deep-merged), for example:

```json
{
  "openai": { "model": "gpt-realtime-2.1-mini", "voice": "cedar", "turnDetection": { "type": "semantic_vad", "eagerness": "low" } },
  "audio": { "echoCancellation": false, "noiseGate": { "enabled": true, "openDb": 15 } },
  "conversation": { "endOfReplyMs": 2000 },
  "vocabulary": ["Supabase", "RLS", "Edge Function"]
}
```

A new OpenAI model is a config change; a new provider is one new adapter implementing `VoiceProvider`. If you switch to a voice that speaks as a man (`cedar`, `ash`), tell Claude to use ครับ; the skill assumes `marin` and ค่ะ.

## Cost

The realtime model only speaks (it never answers on its own), and OpenAI's Decisions API (`gpt-6-luna`) checks each spoken answer (about $0.00004 each), so you pay mainly for spoken output (about $0.03 per minute of Claude's speech on the default `gpt-realtime-2.1-mini`, which reads Claude's script word for word as well as the full model; about $0.10 on `gpt-realtime-2.1`) plus transcription of your speech ($0.017 per minute on `gpt-live-transcribe`, which shows your words as you speak and gets the English terms on the question card right). The pane shows a running estimate, and every voice session ends with a summary (minutes, Claude's speech, transcription) plus today's and this month's totals, added up from the local logs. These are estimates from the usage OpenAI reports and the prices in the config; the real bill is on OpenAI's usage page. The bridge disconnects after 10 idle minutes and refreshes the session before OpenAI's 60-minute limit; it reconnects on the next question.

## Transcripts

Each voice session is logged as JSONL under `$CLAUDE_PLUGIN_DATA/transcripts` when Claude Code sets it, otherwise `~/Library/Logs/voice-wayfinder/<date>/` on a Mac or `%LOCALAPPDATA%\voice-wayfinder\Logs` on Windows, with anything shaped like a key masked. The OpenAI key is never logged.

## Windows

Everything above applies; these are the Windows specifics.

- **Compiler.** The audio helper (`plugin/native/vw-audio/main.cpp`) builds with MSVC from Visual Studio 2022 Build Tools (the free compiler-only install), "Desktop development with C++" workload. One way, from a terminal:

  ```bat
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```

  `npm run build` finds it through `vswhere` and builds `plugin/native/vw-audio/vw-audio.exe`; no Developer Command Prompt is needed. A full Visual Studio with the C++ workload works too. On Windows on Arm it builds an Arm64 helper when the Arm64 C++ tools are installed, and an x64 one otherwise.
- **bws.** Download `bws` for Windows from the [Bitwarden releases](https://github.com/bitwarden/sdk-sm/releases) and put `bws.exe` in a folder on your PATH (or set `VOICE_WAYFINDER_BWS` to its full path).
- **Token.** Stored in Windows Credential Manager (generic credential `voice-wayfinder-bws`), read at bridge start with a short PowerShell call to the Credential Manager API. It is never written to a file.
- **Echo cancellation.** The helper uses the Windows Voice Capture DSP (the system acoustic echo canceller, with noise suppression on and automatic gain off). It cancels what your default speakers play, so keep Claude's voice on the default output device. If it cannot start, the pane says so and the helper falls back to the plain microphone: use headphones then.
- **Other apps get quieter.** Windows treats the echo-cancelled mic as a call and may lower other sounds while voice mode is on. To stop that: Sound settings > More sound settings > Communications > "Do nothing".
- **Microphone privacy.** Settings > Privacy & security > Microphone > "Let desktop apps access your microphone" must be on.

## Development

```bash
npm run check
```

That runs the bridge type-check and tests, builds the bundle and the audio helper for the computer you are on, validates the plugin and the marketplace, and runs the pane tests. Run it after every Claude Code update. The mod type-checks against the types Claude Code lays in `plugin/.claude-plugin/types/` once it has loaded the plugin (`npx tsc -p plugin`).

## Phase 6 checklist

Run a small throwaway Wayfinder map fully by voice, then note what breaks:

- [ ] Barge-in: interrupting mid-question stops Claude within a moment, and your words become the answer.
- [ ] Thai with English tech terms is transcribed well enough; Claude repeats key terms back before writing them.
- [ ] Latency between your answer and the next question feels conversational.
- [ ] Tickets, resolution comments and the map's Decisions-so-far land correctly on GitHub.
- [ ] The pane and captions follow along: question card with choices, Claude's line, your live words, conversation, mute / skip / end; typed answers land as answers.
- [ ] Speakers without headphones: Claude does not interrupt itself.
