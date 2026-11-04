---
name: voice-mode
description: Run a conversation, especially /wayfinder grilling and decision turns, as spoken Thai through the realtime voice bridge (voice_converse, voice_say, voice_listen). Use when the person asks for voice mode, to talk instead of type, "คุยด้วยเสียง", or to run Wayfinder by voice.
---

# Voice mode

You stay the brain. The realtime voice model behind the `voice_*` tools is only ears and mouth: it reads your text aloud and transcribes the person. It never plans or decides, so never ask it to.

## Start

1. Call `voice_status`. If it reports an error (no key, no microphone), tell the person in text what it says and stop voice mode.
2. Greet in one short Thai sentence with `voice_say`, then carry on with the task. With `/wayfinder`, its rules all still hold: one resolved ticket per session (research excepted), research as a subagent, HITL tickets resolved only by the person's own answers.

## Speaking

- A grilling round (several questions whose prerequisites are all settled) goes through `voice_interview`, the whole round in one call: the bridge asks each in turn and acknowledges each answer itself, so the person never waits on you between them. Write the round on screen first in the grilling format, then send the spoken versions.
- A single question, or a follow-up that depends on an answer just heard, goes through `voice_converse`.
- Never type a question and wait for a typed answer while voice mode is on.
- The bridge already says a short "ค่ะ" the moment an answer is complete, and "ขอคิดแป๊บนึงนะคะ" if you take a while. Don't open your next turn with an acknowledgement of your own.
- Speak short, natural Thai: one or two sentences, about 20 seconds at most. Polite and consistent: the default voice (`marin`) speaks as a woman, so end with ค่ะ/คะ.
- Say English technical terms, product names and ticket names in English inside the Thai sentence.
- Never speak code, tables, ticket bodies, URLs, issue numbers or lists longer than three items. Write them on screen as normal text first, then speak a one-line gist: "รายละเอียดสามทางเลือกอยู่บนจอแล้วนะคะ เลือกทางไหนดีคะ".

## Pace

Every second you spend between their reply and your next question is dead air for them.

- Call the next `voice_*` tool as soon as you know what to say. Send tracker writes, file reads or note-taking in the same message as that call (parallel tool calls), not in turns of their own before it.
- Write on screen only what they must see (options, a table, a link), and keep it short. Don't type out what you are about to say.
- Keep each spoken turn to one sentence of about 15 words where you can; two at most.

## Hearing

- Transcripts are Thai speech recognition with English mixed in; terms can be misheard. When an answer contains a term that will land in the tracker (a ticket name, a product, an API), repeat it back in your confirmation.
- When `voice_say` or `voice_converse` reports an interruption, stop the point you were making. What the person said is the new input; answer that.
- `heardBefore` in a result is something the person said while you were working. Take it into account before acting on the reply.

## Deciding

After each decision, confirm it in one spoken sentence with `voice_converse` ("สรุปว่าใช้ GitHub Issues เป็น tracker ถูกไหมคะ"). Write to the tracker only after a clear yes. On a no or a correction, fix it and confirm again.

## Results

| Result | What to do |
| --- | --- |
| `replied` | Use the transcript. |
| `timeout` | Ask again once, shorter. Then `voice_listen`. If still nothing, continue in text. |
| `skipped` | The person pressed skip in the map pane: leave this question open (note it in the ticket or fog) and move on. |
| `ended` | The person ended voice mode: continue in text, no more `voice_*` calls unless asked. |
| `disconnected` | Call the same tool once more (it reconnects). If it fails again, continue in text. |

## The map pane

Keep the pane beside the transcript current with `voice_map_update`, read from the tracker (the `wayfinder:map` issue and its child issues, never Wayfinder's internal files):

- after loading the map: `mapTitle`, `mapUrl`, `decided` (Decisions so far), `blocked` (open children with open blockers), `fog` (one line per patch of Not yet specified);
- after claiming a ticket: `current` with its `wayfinder:<type>` as `type`;
- after recording a resolution: the new `decided`, `blocked`, `fog`, and `current` cleared or moved on.

Send only the fields that changed. Ticket titles stay in English.

## Ending

When the session's ticket is resolved, or the person says to stop, say a one-line Thai summary with `voice_say`, then call `voice_control` with `end` so the realtime session stops costing money.
