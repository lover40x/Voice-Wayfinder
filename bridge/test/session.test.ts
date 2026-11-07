import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { VoiceStateV1 } from '../../plugin/shared/protocol.ts'
import type { AudioDevice, AudioEvent } from '../src/audio.ts'
import { ClipCache } from '../src/clips.ts'
import { localDay, TranscriptLog } from '../src/log.ts'
import { isRepeatRequest } from '../src/session.ts'
import { waveTone } from '../src/tone.ts'
import type { ProviderEvent, VoiceProvider } from '../src/provider.ts'
import { VoiceSession } from '../src/session.ts'

class FakeProvider implements VoiceProvider {
  readonly name = 'fake'
  readonly model = 'fake-1'
  said: string[] = []
  interrupted: string[] = []
  appended = 0
  cleared = 0
  vocabulary: readonly string[] = []
  private handlers: ((e: ProviderEvent) => void)[] = []
  async connect() {}
  close() {}
  say(text: string) {
    this.said.push(text)
    return `s${this.said.length}`
  }
  synthesized: string[] = []
  async synthesize(text: string) {
    this.synthesized.push(text)
    return Buffer.alloc(2400, 1)
  }
  interrupt(id: string) {
    this.interrupted.push(id)
  }
  appendAudio() {
    this.appended++
  }
  clearInput() {
    this.cleared++
  }
  setVocabulary(terms: readonly string[]) {
    this.vocabulary = terms
  }
  onEvent(h: (e: ProviderEvent) => void) {
    this.handlers.push(h)
  }
  emit(e: ProviderEvent) {
    for (const h of this.handlers) h(e)
  }
  /** The person says `text`: VAD start, stop, commit, transcript. */
  utter(text: string, id = text) {
    this.emit({ type: 'user.speech_started' })
    this.emit({ type: 'user.speech_stopped' })
    this.emit({ type: 'user.transcript_pending', itemId: id })
    this.emit({ type: 'user.transcript', itemId: id, text })
  }
}

class FakeAudio implements AudioDevice {
  seq = 0
  flushes = 0
  /** Byte length of everything queued for playback, in order. */
  plays: number[] = []
  private handlers: ((e: AudioEvent) => void)[] = []
  async start() {}
  stop() {}
  play(pcm: Buffer) {
    this.plays.push(pcm.length)
    return ++this.seq
  }
  flush() {
    this.flushes++
  }
  onEvent(h: (e: AudioEvent) => void) {
    this.handlers.push(h)
  }
  emit(e: AudioEvent) {
    for (const h of this.handlers) h(e)
  }
}

function setup(over: Partial<ConstructorParameters<typeof VoiceSession>[0]> = {}) {
  const provider = new FakeProvider()
  const audio = new FakeAudio()
  const session = new VoiceSession({
    createProvider: () => provider,
    createAudio: () => audio,
    endOfReplyMs: 40,
    idleDisconnectMs: 60_000,
    refreshAfterMs: 60_000,
    baseVocabulary: ['Wayfinder'],
    tickMs: 5,
    ...over,
  })
  return { provider, audio, session }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

/** Plays one chunk of the current speech to the end. */
function speakThrough(provider: FakeProvider, audio: FakeAudio, speechId: string) {
  provider.emit({ type: 'speech.audio', speechId, pcm: Buffer.alloc(4800) })
  provider.emit({ type: 'speech.done', speechId, status: 'completed' })
  audio.emit({ type: 'played', seq: audio.seq })
}

test('converse speaks, then returns the reply once the person goes quiet', async () => {
  const { provider, audio, session } = setup()
  const turn = session.converse('จะใช้ GitHub เป็น tracker ไหมครับ', 5000)
  await tick()
  assert.equal((session.state() as VoiceStateV1).activity, 'speaking')
  speakThrough(provider, audio, 's1')
  await tick()
  assert.equal((session.state() as VoiceStateV1).activity, 'listening')
  provider.utter('ใช้ GitHub ครับ')
  const r = await turn
  assert.equal(r.said.status, 'completed')
  assert.equal(r.said.spokenMs, 100)
  assert.equal(r.reply.status, 'replied')
  assert.equal(r.reply.text, 'ใช้ GitHub ครับ')
})

test('barge-in stops playback and the interruption becomes the reply', async () => {
  const { provider, audio, session } = setup()
  const turn = session.converse('คำถามยาวมาก', 5000)
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  provider.utter('เดี๋ยวครับ ขอเปลี่ยนเรื่อง')
  const r = await turn
  assert.equal(r.said.status, 'interrupted')
  assert.equal(audio.flushes, 1)
  assert.deepEqual(provider.interrupted, ['s1'])
  assert.equal(r.reply.text, 'เดี๋ยวครับ ขอเปลี่ยนเรื่อง')
  const line = (session.state() as VoiceStateV1).transcript.find(l => l.who === 'claude')
  assert.equal(line?.interrupted, true)
})

const CLIP = 2400 // FakeProvider.synthesize's clip length
const withClips = { acknowledgements: ['ค่ะ', 'รับทราบค่ะ'], clips: new ClipCache(undefined, 'test') }

test('a finished reply is acknowledged at once with a ready clip', async () => {
  const { provider, audio, session } = setup({ ...withClips, clips: new ClipCache(undefined, 't1') })
  const reply = session.listen(5000)
  await tick()
  assert.deepEqual(provider.synthesized, ['ค่ะ', 'รับทราบค่ะ'])
  provider.utter('ได้ค่ะ')
  await reply
  assert.deepEqual(audio.plays, [CLIP])
})

test('a thinking cue plays once when Claude is slow to answer', async () => {
  const { provider, audio, session } = setup({
    clips: new ClipCache(undefined, 't2'),
    thinkingCue: { text: 'แป๊บนึงนะคะ', afterMs: 30 },
  })
  const reply = session.listen(5000)
  await tick()
  provider.utter('ตอบแล้ว')
  await reply
  assert.equal(audio.plays.length, 0)
  await tick(60)
  assert.deepEqual(audio.plays, [CLIP])
})

test('the thinking cue is dropped when Claude speaks first', async () => {
  const { provider, audio, session } = setup({
    clips: new ClipCache(undefined, 't3'),
    thinkingCue: { text: 'แป๊บนึงนะคะ', afterMs: 40 },
  })
  const reply = session.listen(5000)
  await tick()
  provider.utter('ตอบแล้ว')
  await reply
  void session.say('คำถามต่อไป')
  await tick(80)
  assert.equal(audio.plays.length, 0)
})

test('an acknowledgement stops the moment the person speaks again', async () => {
  const { provider, audio, session } = setup({ ...withClips, clips: new ClipCache(undefined, 't4') })
  const reply = session.listen(5000)
  await tick()
  provider.utter('ข้อแรก')
  await reply
  assert.equal(audio.plays.length, 1)
  provider.emit({ type: 'user.speech_started' })
  assert.equal(audio.flushes, 1)
})

test('an interview asks every question and returns each answer', async () => {
  const { provider, audio, session } = setup()
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง', 'ข้อสาม'], 5000)
  await tick()
  speakThrough(provider, audio, 's1')
  await tick()
  provider.utter('ตอบหนึ่ง')
  await tick(80)
  speakThrough(provider, audio, 's2')
  await tick()
  session.control('skip')
  await tick(20)
  speakThrough(provider, audio, 's3')
  await tick()
  provider.utter('ตอบสาม')
  const r = await round
  assert.deepEqual(provider.said, ['ข้อหนึ่ง', 'ข้อสอง', 'ข้อสาม'])
  assert.deepEqual(
    r.answers.map(a => [a.status, a.answer]),
    [
      ['replied', 'ตอบหนึ่ง'],
      ['skipped', ''],
      ['replied', 'ตอบสาม'],
    ],
  )
  assert.deepEqual(r.unasked, [])
})

test('ending mid-interview returns what was answered and what was not asked', async () => {
  const { provider, audio, session } = setup()
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง', 'ข้อสาม'], 5000)
  await tick()
  speakThrough(provider, audio, 's1')
  await tick()
  provider.utter('ตอบหนึ่ง')
  await tick(80)
  session.control('end')
  const r = await round
  assert.equal(r.answers.length, 2)
  assert.equal(r.answers[1]?.status, 'ended')
  assert.deepEqual(r.unasked, ['ข้อสาม'])
})

test('a noise blip shorter than the barge-in window does not stop Claude', async () => {
  const { provider, audio, session } = setup({ bargeInConfirmMs: 40 })
  const said = session.say('ประโยคยาว')
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  provider.emit({ type: 'user.speech_started' })
  provider.emit({ type: 'user.speech_stopped' })
  await tick(80)
  assert.equal(audio.flushes, 0)
  provider.emit({ type: 'speech.done', speechId: 's1', status: 'completed' })
  audio.emit({ type: 'played', seq: audio.seq })
  assert.equal((await said).status, 'completed')
})

test('speech that lasts past the barge-in window stops Claude', async () => {
  const { provider, audio, session } = setup({ bargeInConfirmMs: 40 })
  const said = session.say('ประโยคยาว')
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  provider.emit({ type: 'user.speech_started' })
  await tick(80)
  assert.equal((await said).status, 'interrupted')
  assert.equal(audio.flushes, 1)
})

test('an utterance too short to be speech is dropped', async () => {
  const { provider, session } = setup({ minUtteranceMs: 300 })
  const reply = session.listen(200)
  await tick()
  provider.emit({ type: 'user.speech_started' })
  provider.emit({ type: 'user.speech_stopped', itemId: 'n', durationMs: 120 })
  provider.emit({ type: 'user.transcript_pending', itemId: 'n' })
  provider.emit({ type: 'user.transcript', itemId: 'n', text: 'ขอบคุณที่รับชม' })
  const r = await reply
  assert.equal(r.status, 'timeout')
  assert.equal((session.state() as VoiceStateV1).transcript.some(l => l.who === 'user'), false)
})

test('a reply in several breaths is joined until the quiet window passes', async () => {
  const { provider, session } = setup({ endOfReplyMs: 80 })
  const reply = session.listen(5000)
  await tick()
  provider.utter('ส่วนแรก', 'a')
  await tick(20)
  provider.utter('ส่วนที่สอง', 'b')
  const r = await reply
  assert.deepEqual(r.parts, ['ส่วนแรก', 'ส่วนที่สอง'])
})

test('a transcript still pending keeps the reply open', async () => {
  const { provider, session } = setup({ endOfReplyMs: 30 })
  const reply = session.listen(5000)
  await tick()
  provider.emit({ type: 'user.speech_started' })
  provider.emit({ type: 'user.speech_stopped' })
  provider.emit({ type: 'user.transcript_pending', itemId: 'x' })
  await tick(80)
  provider.emit({ type: 'user.transcript', itemId: 'x', text: 'มาช้าหน่อย' })
  assert.equal((await reply).text, 'มาช้าหน่อย')
})

test('skip from the pane ends the wait without an answer', async () => {
  const { session } = setup()
  const reply = session.listen(5000)
  await tick()
  assert.equal(session.control('skip').message, 'Question skipped.')
  assert.equal((await reply).status, 'skipped')
})

test('skip while speaking stops speech and skips the question', async () => {
  const { provider, audio, session } = setup()
  const turn = session.converse('คำถาม', 5000)
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  session.control('skip')
  const r = await turn
  assert.equal(r.said.status, 'skipped')
  assert.equal(r.reply.status, 'skipped')
  assert.equal(audio.flushes, 1)
})

test('end disconnects and unblocks a waiting reply', async () => {
  const { session } = setup()
  const reply = session.listen(5000)
  await tick()
  session.control('end')
  assert.equal((await reply).status, 'ended')
  assert.equal((session.state() as VoiceStateV1).activity, 'off')
})

test('mute stops mic audio reaching the provider', async () => {
  const { provider, audio, session } = setup()
  void session.say('ทดสอบ')
  await tick()
  audio.emit({ type: 'mic', pcm: Buffer.alloc(10) })
  assert.equal(provider.appended, 1)
  session.control('mute')
  audio.emit({ type: 'mic', pcm: Buffer.alloc(10) })
  assert.equal(provider.appended, 1)
  assert.equal(provider.cleared, 1)
})

test('what the person said while Claude was thinking is reported before the question', async () => {
  const { provider, audio, session } = setup()
  const first = session.listen(5000)
  await tick()
  provider.utter('ตอบข้อแรก')
  await first
  provider.utter('อ้อ อีกเรื่องหนึ่ง')
  const turn = session.converse('ข้อต่อไป', 5000)
  await tick()
  speakThrough(provider, audio, 's1')
  provider.utter('ได้ครับ')
  const r = await turn
  assert.deepEqual(r.heardBefore, ['อ้อ อีกเรื่องหนึ่ง'])
  assert.equal(r.reply.text, 'ได้ครับ')
})

test('the pane can ask for state since a revision', async () => {
  const { session } = setup()
  const s = session.state() as VoiceStateV1
  assert.deepEqual(session.state(s.rev), { v: 1, rev: s.rev, unchanged: true })
  void session.converse('เลือกข้อไหนคะ', 5000, undefined, '**Q1** Auth?\n1. Clerk\n2. Supabase')
  await tick()
  const next = session.state(s.rev) as VoiceStateV1
  assert.equal(next.card?.screen, '**Q1** Auth?\n1. Clerk\n2. Supabase')
})

test('an interview round shows its card and which question is being asked', async () => {
  const { provider, audio, session } = setup()
  void session.interview(['ข้อหนึ่ง', 'ข้อสอง'], 5000, undefined, 'Q1 …\nQ2 …')
  await tick()
  assert.deepEqual((session.state() as VoiceStateV1).card, { screen: 'Q1 …\nQ2 …', question: 1, of: 2 })
  speakThrough(provider, audio, 's1')
  await tick()
  provider.utter('ได้')
  await tick(80)
  assert.deepEqual((session.state() as VoiceStateV1).card, { screen: 'Q1 …\nQ2 …', question: 2, of: 2 })
})

test('a typed answer while listening returns at once, marked as typed', async () => {
  const { session } = setup({ endOfReplyMs: 5000 })
  const reply = session.listen(5000)
  await tick()
  assert.equal(session.control('type', 'ใช้ Supabase ครับ').accepted, true)
  const r = await reply
  assert.equal(r.status, 'replied')
  assert.equal(r.text, 'ใช้ Supabase ครับ')
  assert.equal(r.typed, true)
  const line = (session.state() as VoiceStateV1).transcript.at(-1)
  assert.deepEqual([line?.who, line?.typed], ['user', true])
})

test('typing over Claude stops its speech and becomes the reply', async () => {
  const { provider, audio, session } = setup()
  const turn = session.converse('คำถามยาวๆ', 5000)
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  session.control('type', 'ข้ามไปเลย')
  const r = await turn
  assert.equal(r.said.status, 'interrupted')
  assert.equal(audio.flushes, 1)
  assert.equal(r.reply.text, 'ข้ามไปเลย')
})

test('typing while no question is in progress is not taken as an answer', async () => {
  const { session } = setup()
  assert.equal(session.control('type', 'สวัสดี').accepted, false)
})

test('the words being heard show in the state until the utterance is done', async () => {
  const { provider, session } = setup()
  void session.listen(5000)
  await tick()
  provider.emit({ type: 'user.speech_started' })
  provider.emit({ type: 'user.transcript_delta', itemId: 'p', delta: 'กำลัง' })
  provider.emit({ type: 'user.transcript_delta', itemId: 'p', delta: 'พูด' })
  assert.equal((session.state() as VoiceStateV1).partial, 'กำลังพูด')
  provider.emit({ type: 'user.speech_stopped', itemId: 'p' })
  provider.emit({ type: 'user.transcript', itemId: 'p', text: 'กำลังพูดอยู่' })
  assert.equal((session.state() as VoiceStateV1).partial, undefined)
})

test('ending a session summarises its OpenAI cost by kind', async () => {
  const { provider, session } = setup()
  void session.listen(5000)
  await tick()
  provider.emit({ type: 'usage', kind: 'speech', costUsd: 0.02 })
  provider.emit({ type: 'usage', kind: 'transcription', costUsd: 0.003 })
  assert.equal((session.state() as VoiceStateV1).estimatedCostUsd, 0.023)
  const { message } = session.control('end')
  assert.match(message, /this session: .*\$0\.02 \(Claude's speech \$0\.02 .* transcription <\$0\.01/)
  const s = session.state() as VoiceStateV1
  assert.deepEqual([s.lastSession?.costUsd, s.lastSession?.speechUsd, s.lastSession?.transcriptionUsd], [0.023, 0.02, 0.003])
  assert.equal(s.estimatedCostUsd, 0)
  assert.match(s.transcript.at(-1)?.text ?? '', /Voice session ended\. OpenAI est\./)
})

test('today and this month add up every ended session in the log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-log-'))
  const now = new Date(2026, 10, 4, 22, 0).getTime()
  const write = (at: number, costUsd: number) => {
    const folder = join(dir, localDay(at))
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${at}.jsonl`), `{"kind":"session"}\n{"kind":"end","reason":"x","costUsd":${costUsd},"at":${at}}\n`)
  }
  write(new Date(2026, 10, 4, 9, 0).getTime(), 0.1) // today
  write(new Date(2026, 10, 4, 21, 0).getTime(), 0.05) // today
  write(new Date(2026, 10, 1, 8, 0).getTime(), 0.2) // this month
  write(new Date(2026, 9, 31, 23, 0).getTime(), 9) // last month
  const t = new TranscriptLog(dir).totals(now)
  assert.equal(Math.round(t.todayUsd * 100) / 100, 0.15)
  assert.equal(Math.round(t.monthUsd * 100) / 100, 0.35)
})

test('the running total includes the session in progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-log-'))
  const { provider, session } = setup({ log: new TranscriptLog(dir) })
  void session.listen(5000)
  await tick()
  provider.emit({ type: 'usage', kind: 'speech', costUsd: 0.04 })
  assert.equal((session.state() as VoiceStateV1).todayCostUsd, 0.04)
  session.control('end')
  const s = session.state() as VoiceStateV1
  assert.deepEqual([s.todayCostUsd, s.monthCostUsd], [0.04, 0.04])
})

test('the thinking tone is soft and starts and ends in silence', () => {
  const pcm = waveTone({ durationMs: 1400, volume: 0.12 })
  assert.equal(pcm.length, 1400 * 24 * 2)
  const samples = Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2))
  assert.ok(Math.abs(samples[0]!) < 50 && Math.abs(samples.at(-1)!) < 50)
  assert.ok(Math.max(...samples.map(Math.abs)) <= 0.12 * 32767 + 1)
  assert.ok(Math.max(...samples.map(Math.abs)) > 1000)
})

test('the thinking tone plays after a pause and again while Claude still thinks', async () => {
  const { provider, audio, session } = setup({ thinkingCue: { pcm: Buffer.alloc(960), afterMs: 20, repeatMs: 30, maxTimes: 3 } })
  const reply = session.listen(5000)
  await tick()
  provider.utter('ตอบแล้ว')
  await reply
  await tick(150)
  assert.deepEqual(audio.plays, [960, 960, 960])
})

test('saying you did not catch it repeats the question instead of answering', async () => {
  const { provider, audio, session } = setup({ ...withClips, clips: new ClipCache(undefined, 'r1') })
  const turn = session.converse('ข้อสอง ใครได้รับแจ้งเตือนคะ', 5000)
  await tick()
  speakThrough(provider, audio, 's1')
  await tick()
  provider.utter('ฟังไม่ทันครับ')
  await tick(80)
  assert.deepEqual(provider.said, ['ข้อสอง ใครได้รับแจ้งเตือนคะ', 'ได้ค่ะ ข้อสอง ใครได้รับแจ้งเตือนคะ'])
  assert.equal(audio.plays.filter(n => n === CLIP).length, 0) // no "ค่ะ" for a repeat request
  speakThrough(provider, audio, 's2')
  await tick()
  provider.utter('ผู้จัดการสาขา')
  const r = await turn
  assert.equal(r.reply.text, 'ผู้จัดการสาขา')
  assert.equal(r.repeats, 1)
})

test('in a round, a typed "again" repeats that question and the round goes on', async () => {
  const { provider, audio, session } = setup()
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง'], 5000)
  await tick()
  speakThrough(provider, audio, 's1')
  await tick()
  session.control('type', 'อีกที')
  await tick(30)
  assert.equal(provider.said.at(-1), 'ได้ค่ะ ข้อหนึ่ง')
  speakThrough(provider, audio, 's2')
  await tick()
  provider.utter('หนึ่ง')
  await tick(80)
  speakThrough(provider, audio, 's3')
  await tick()
  provider.utter('สอง')
  const r = await round
  assert.deepEqual(
    r.answers.map(a => [a.answer, a.repeats]),
    [
      ['หนึ่ง', 1],
      ['สอง', 0],
    ],
  )
})

test('repeat requests are told apart from real answers', () => {
  for (const t of ['ฟังไม่ทัน', 'ขออีกที', 'พูดใหม่ได้ไหม', 'อะไรนะคะ', 'ไม่ได้ยินครับ', 'ทวนหน่อย', 'repeat please', 'say that again']) {
    assert.equal(isRepeatRequest(t), true, t)
  }
  for (const t of ['2', 'ข้อสอง', 'ใช่ครับ', 'ไม่ทัน', 'ยังไม่ชัดเจน', 'ให้ส่งแจ้งเตือนอีกครั้งตอนเช้า ถ้ายังไม่มีใครเปิดดูภายในหนึ่งชั่วโมง', 'ไม่ซ้ำกัน']) {
    assert.equal(isRepeatRequest(t), false, t)
  }
})

test('a missing key is reported, not thrown away', async () => {
  const { session } = setup({
    createProvider: () => {
      throw new Error('No OpenAI key')
    },
  })
  await assert.rejects(session.say('x'), /No OpenAI key/)
  const s = session.state() as VoiceStateV1
  assert.equal(s.activity, 'error')
  assert.equal(s.error, 'No OpenAI key')
})

test('what the person says while Claude works can be taken at once, and only once', async () => {
  const { provider, session } = setup()
  await session.listen(10) // connects; nothing said yet
  provider.utter('ระบบ context ไม่ได้บอกเหรอ')
  const taken = session.control('take')
  assert.equal(taken.accepted, true)
  assert.deepEqual(taken.heard, ['ระบบ context ไม่ได้บอกเหรอ'])
  assert.equal((session.state() as VoiceStateV1).queuedUtterances, 0)
  assert.deepEqual(session.control('take').heard, [])
})

test('take leaves an utterance still being transcribed, and a waiting question keeps its reply', async () => {
  const { provider, session } = setup()
  const first = session.listen(5000)
  await tick()
  provider.utter('ตอบ')
  await first
  provider.emit({ type: 'user.speech_started' })
  provider.emit({ type: 'user.speech_stopped' })
  provider.emit({ type: 'user.transcript_pending', itemId: 'p' })
  assert.deepEqual(session.control('take').heard, [])
  provider.emit({ type: 'user.transcript', itemId: 'p', text: 'อีกเรื่อง' })
  const reply = session.listen(5000)
  await tick()
  assert.deepEqual(session.control('take').heard, [])
  assert.equal((await reply).text, 'อีกเรื่อง')
})

test('after End nothing speaks or reconnects until voice mode is started again', async () => {
  let connects = 0
  const { provider, audio, session } = setup({ createProvider: () => (connects++, provider) })
  const turn = session.converse('ข้อแรกค่ะ', 5000)
  await tick()
  session.control('end')
  assert.equal((await turn).reply.status, 'ended')
  // Claude finishes thinking and speaks again: refused, no reconnect, nothing said.
  const said = provider.said.length
  assert.equal((await session.say('เสร็จแล้วค่ะ')).status, 'ended')
  assert.equal((await session.converse('ต่อเลยไหมคะ', 5000)).reply.status, 'ended')
  assert.equal((await session.listen(5000)).status, 'ended')
  assert.equal((await session.interview(['ข้อหนึ่ง'], 5000)).unasked.length, 1)
  assert.equal(connects, 1)
  assert.equal(provider.said.length, said)
  assert.equal((session.state() as VoiceStateV1).stopped, true)
  session.control('start')
  const again = session.say('กลับมาแล้วค่ะ')
  await tick()
  speakThrough(provider, audio, `s${provider.said.length}`)
  assert.equal((await again).status, 'completed')
  assert.equal(connects, 2)
})

/** PCM16 of `ms` at a steady level (dBFS), a sine so it reads like sound. */
function tone(ms: number, db: number, hz = 220): Buffer {
  const n = Math.round(24 * ms)
  const amp = Math.pow(10, db / 20) * 32767 * Math.SQRT2
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-32767, Math.min(32767, amp * Math.sin((2 * Math.PI * hz * i) / 24000)))), i * 2)
  return b
}
const peak = (b: Buffer) => {
  let m = 0
  for (let i = 0; i + 1 < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i)))
  return m
}

test('the noise gate sends steady room noise as silence and a voice above it through, word start included', async () => {
  const { NoiseGate } = await import('../src/gate.ts')
  const gate = new NoiseGate()
  // Two seconds of a fan at -45 dBFS: learned, then silenced.
  const room = gate.process(tone(2000, -45, 120))
  assert.equal(peak(room.subarray(room.length / 2)), 0)
  // A voice 25 dB above it passes, and with the lookahead its first 100 ms too.
  const voice = Buffer.concat([gate.process(tone(600, -20)), gate.process(tone(300, -45, 120))])
  const startOfVoice = voice.subarray(voice.length - 2 * 24 * 900 + 2 * 24 * 120, voice.length - 2 * 24 * 900 + 2 * 24 * 220)
  assert.ok(peak(startOfVoice) > 1000)
  assert.ok(gate.noiseFloorDb! < -40)
})

test('a cough or a stock phrase invented from noise is not taken as an answer', async () => {
  const { isNoiseTranscript } = await import('../src/gate.ts')
  for (const t of ['', '...', 'อืม', 'อะแฮ่ม', 'แค่ก แค่ก', 'Hmm.', '(ไอ)', 'ขอบคุณที่รับชมค่ะ', 'Thank you for watching!']) assert.equal(isNoiseTranscript(t), true, t)
  for (const t of ['ข้อสอง', '2', 'ใช่ค่ะ', 'อืม ข้อแรกดีกว่า', 'ใช้ GitHub']) assert.equal(isNoiseTranscript(t), false, t)
  const { provider, session } = setup()
  const reply = session.listen(300)
  await tick()
  provider.utter('อะแฮ่ม')
  assert.equal((await reply).status, 'timeout')
})

test('with the gate on, the mic reaches the provider delayed and room noise as silence', async () => {
  const { provider, audio, session } = setup({ noiseGate: {} })
  const sent: Buffer[] = []
  Object.assign(provider, { appendAudio: (pcm: Buffer) => void sent.push(pcm) })
  await session.listen(10)
  audio.emit({ type: 'mic', pcm: tone(2000, -50, 120) })
  const all = Buffer.concat(sent)
  assert.ok(all.length > 0 && all.length < tone(2000, -50).length)
  assert.equal(peak(all.subarray(all.length / 2)), 0)
})

test('pause stops Claude mid-sentence and says it again from the start on resume', async () => {
  const { provider, audio, session } = setup()
  const said = session.say('มีอะไรจะถามอีกนิดค่ะ')
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  session.control('pause')
  assert.equal((session.state() as VoiceStateV1).activity, 'paused')
  const flushes = audio.flushes
  assert.ok(flushes > 0)
  await tick(50)
  assert.equal(provider.said.length, 1)
  session.control('resume')
  await tick(30)
  assert.equal(provider.said.length, 2)
  speakThrough(provider, audio, 's2')
  assert.equal((await said).status, 'completed')
})

test('while paused the mic is off, a question does not time out, and a new voice call waits', async () => {
  const { provider, session } = setup()
  let sent = 0
  Object.assign(provider, { appendAudio: () => void sent++ })
  const reply = session.listen(60)
  await tick()
  session.control('pause')
  await tick(150)
  // Past the 60 ms timeout, still waiting; mic audio is dropped.
  ;(session as unknown as { onAudio: (a: unknown, e: unknown) => void }).onAudio((session as unknown as { audio: unknown }).audio, { type: 'mic', pcm: Buffer.alloc(480) })
  assert.equal(sent, 0)
  let waited = true
  const next = session.say('ต่อนะคะ').then(r => ((waited = false), r))
  await tick(50)
  assert.equal(waited, true)
  session.control('resume')
  provider.utter('กลับมาแล้วครับ')
  assert.equal((await reply).text, 'กลับมาแล้วครับ')
  session.control('end')
  assert.equal((await next).status, 'ended')
})

test('typing while paused still answers the waiting question', async () => {
  const { session } = setup()
  const reply = session.listen(5000)
  await tick()
  session.control('pause')
  assert.equal(session.control('type', '2').accepted, true)
  const r = await reply
  assert.equal(r.text, '2')
  assert.equal(r.typed, true)
})

test('back from a pause over a minute, a waiting question returns so Claude can recap first', async () => {
  let skew = 0 // pauses are jumped over; real time still runs for the waits
  const { provider, session } = setup({ recapAfterPauseMs: 60_000, now: () => Date.now() + skew })
  const reply = session.listen(5000)
  await tick()
  session.control('pause')
  skew += 3 * 60_000
  session.control('resume')
  assert.ok(Math.abs((session.state() as VoiceStateV1).recapDueAfterMs! - 180_000) < 1000)
  const r = await reply
  assert.equal(r.status, 'resumed')
  assert.ok(Math.abs(r.pausedMs! - 180_000) < 1000)
  assert.equal((session.state() as VoiceStateV1).recapDueAfterMs, undefined)
  // Owed once: the next question goes ahead.
  const next = session.listen(5000)
  await tick()
  provider.utter('ต่อเลย')
  assert.equal((await next).text, 'ต่อเลย')
})

test('a short pause just carries on, and a waiting say returns for the recap instead of speaking', async () => {
  let skew = 0 // pauses are jumped over; real time still runs for the waits
  const { provider, session } = setup({ recapAfterPauseMs: 60_000, now: () => Date.now() + skew })
  await session.listen(10)
  session.control('pause')
  skew += 20_000
  session.control('resume')
  assert.equal((session.state() as VoiceStateV1).recapDueAfterMs, undefined)
  session.control('pause')
  const said = session.say('ข้อต่อไปค่ะ')
  await tick(20)
  skew += 90_000
  session.control('resume')
  const r = await said
  assert.equal(r.status, 'resumed')
  assert.equal(provider.said.length, 0)
})

test('with no voice call waiting, the pane takes the recap request once', async () => {
  let skew = 0 // pauses are jumped over; real time still runs for the waits
  const { session } = setup({ recapAfterPauseMs: 60_000, now: () => Date.now() + skew })
  await session.listen(10)
  session.control('pause')
  skew += 120_000
  session.control('resume')
  const t = session.control('take')
  assert.equal(t.accepted, true)
  assert.ok(Math.abs(t.pausedMs! - 120_000) < 1000)
  assert.equal(session.control('take').accepted, false)
})
