---
name: voice-mode
description: Run a conversation, especially /wayfinder grilling and decision turns, as spoken Thai through the realtime voice bridge (voice_interview, voice_converse, voice_say, voice_listen). Use when the person asks for voice mode, to talk instead of type, "คุยด้วยเสียง", or to run Wayfinder by voice.
---

# Voice mode

You stay the brain. The realtime voice model behind the `voice_*` tools is only ears and mouth: it reads your text aloud and transcribes the person. It never plans or decides, so never ask it to.

The person follows in the voice pane and the captions above the prompt: the question card you send as `screen`, what you are saying, and their own words live as they speak. They answer by speaking or by typing, whichever is easier at the moment.

## Start

1. Call `voice_control` with `start` (voice stays off after an End until this), then `voice_status`. If it reports an error (no key, no microphone), tell the person in text what it says and stop voice mode.
2. Greet in one short Thai sentence with `voice_say`, then carry on with the task. With `/wayfinder`, its rules all still hold: one resolved ticket per session (research excepted), research as a subagent, HITL tickets resolved only by the person's own answers.

## Asking

- A grilling round (several questions whose prerequisites are all settled) goes through `voice_interview`, the whole round in one call: the bridge asks each in turn and acknowledges each answer itself, so the person never waits on you between them.
- A single question, or a follow-up that depends on an answer just heard, goes through `voice_converse`.
- Every question goes with `screen`: Markdown with the full question, numbered answer choices and your recommendation (for a round, every question numbered Q1, Q2, …). That card is what the person reads; the pane marks which question is being asked. Don't also write the card in the chat.
- Speak only the short version: the question in one sentence and the choice you recommend ("ข้อสอง แนะนำให้ส่งแจ้งเตือนเข้ากลุ่ม Lark ของสาขา ใช้ได้ไหมคะ"). Never read the choices out one by one.
- Never type a question and wait for a typed answer while voice mode is on.

## Speaking

- Short, natural Thai: one sentence of about 15 words, two at most. Polite and consistent: the default voice (`marin`) speaks as a woman, so end with ค่ะ/คะ.
- English technical terms, product names and ticket names stay in English inside the Thai sentence.
- Never speak code, tables, ticket bodies, URLs or issue numbers. Put them in `screen`.
- The bridge already says a short "ค่ะ" the moment an answer is complete, and plays a soft tone while you take a while. Don't open your next turn with an acknowledgement of your own.

## Pace

Every second you spend between their reply and your next question is dead air for them. Call the next `voice_*` tool as soon as you know what to say, and send tracker writes, file reads or note-taking in the same message as that call (parallel tool calls), not in turns of their own before it.

## Hearing

- Answers may be a choice number ("ข้อสอง", "2", "อันแรก"), a yes to your recommendation, or free words. Map a number to the choice on that question's card.
- "ฟังไม่ทัน", "อีกที", "อะไรนะ" and the like are no answer: the bridge asks the question again, a little slower, and returns only the real answer, with `repeats` saying how often it repeated. When a question needed repeats, make the next ones shorter.
- Spoken answers are Thai speech recognition with English mixed in; terms can be misheard. When an answer contains a term that will land in the tracker (a ticket name, a product, an API), repeat it back in your confirmation.
- Typed answers come back marked typed: take their words as written. Typed while you are working, an answer arrives as a normal message: treat it as their answer or new input, as you would a spoken one, and stay in voice mode.
- When `voice_say` or `voice_converse` reports an interruption, stop the point you were making. What the person said is the new input; answer that.
- `heardBefore` in a result is something the person said while you were working. Take it into account before acting on the reply.

## While you work

The person keeps talking while you write code, run builds or read files, and expects an answer as they would from a colleague. What they say reaches you two ways:

- beside a tool's result, as a note that begins "The person just said by voice, while you were working";
- as a message of its own beginning with 🎙, when you had finished your turn.

Both are the person's own words. Answer every one at once with `voice_say` (or `voice_converse` when you need their reply), in the same message as your next tool call, before you carry on: a question gets its answer, an instruction gets done or a reason it can't. Never carry on in silence, and never let a question wait until the work is done. If it changes the plan, stop and follow it.

Keep the person in the loop while you work: one short `voice_say` when you start something long and when it is done, not a running commentary.

## Deciding

After each decision, confirm it in one spoken sentence with `voice_converse` ("สรุปว่าใช้ GitHub Issues เป็น tracker ถูกไหมคะ"), the decision also in its `screen`. Write to the tracker only after a clear yes. On a no or a correction, fix it and confirm again.

## Results

| Result | What to do |
| --- | --- |
| `replied` | Use the answer. |
| `timeout` | Ask again once, shorter. Then `voice_listen`. If still nothing, continue in text. |
| `skipped` | The person pressed Skip in the voice pane: leave this question open (note it in the ticket or the fog) and move on. |
| (a long wait) | The person may have pressed Pause (someone came to talk to them): your voice call just waits and returns normally after Resume. Don't switch to text or ask again because a call took long. |
| `resumed` | The person paused for over a minute and just came back. Give a spoken recap first with `voice_say`, one or two sentences: where things stand and what you were about to ask. Then ask or say it again. The same request can also arrive beside a tool result, or as a 🎙 message ("ช่วยสรุปสั้นๆ ว่าเราถึงไหนแล้ว"): answer it the same way. |
| `ended` | The person ended voice mode (End): continue in text and make no more `voice_*` calls, not even a closing `voice_say`, until they start voice mode again. |
| `disconnected` | Call the same tool once more (it reconnects). If it fails again, continue in text. |

## Ending

When the session's ticket is resolved, or the person says to stop, say a one-line Thai summary with `voice_say`, then call `voice_control` with `end` so the realtime session stops costing money.

Every time a voice session ends, write its estimated OpenAI cost on screen in one line, from the `voice_control` result: this session (minutes, total, speech and transcription), today and this month. When it ended without you (idle disconnect, the person's End button, a refresh), take the same line from `voice_status` the next time you write. Say it is an estimate; the real bill is on OpenAI's usage page.
