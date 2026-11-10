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
import type { Understanding, UnderstandRequest } from '../src/understand.ts'

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
  /** How replies read, as the understanding model would say; undefined: no opinion (the reply stands). */
  understandWith?: (r: UnderstandRequest) => Understanding | undefined
  understood: UnderstandRequest[] = []
  async understand(r: UnderstandRequest) {
    this.understood.push(r)
    return this.understandWith?.(r)
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
  // The acknowledgements, then the fixed confirmations used when replies are checked.
  assert.deepEqual(provider.synthesized.slice(0, 2), ['ค่ะ', 'รับทราบค่ะ'])
  assert.ok(provider.synthesized.includes('ขอโทษค่ะ ได้ยินไม่ชัด พูดอีกทีได้ไหมคะ'))
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
  // The first answer is taken and the second question is being asked.
  await until(() => provider.said.some(t => t.includes('ข้อสอง')))
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
  for (const t of ['ฟังไม่ทัน', 'ขออีกที', 'พูดใหม่ได้ไหม', 'อะไรนะคะ', 'ไม่ได้ยินครับ', 'ทวนหน่อย', 'repeat please', 'say that again', 'ขอฟังอีกรอบได้ไหมคะ', 'ถามใหม่อีกทีได้ไหม']) {
    assert.equal(isRepeatRequest(t), true, t)
  }
  for (const t of ['2', 'ข้อสอง', 'ใช่ครับ', 'ไม่ทัน', 'ยังไม่ชัดเจน', 'ให้ส่งแจ้งเตือนอีกครั้งตอนเช้า ถ้ายังไม่มีใครเปิดดูภายในหนึ่งชั่วโมง', 'ไม่ซ้ำกัน',
    // From a live session: answers and complaints the old check took as "say it again".
    'ไม่ต้องถามใหม่', 'ใช่ ไม่ต้องถามใหม่', 'ไม่ต้องถามใหม่ ทำไมถามซ้ำสองรอบแล้ว', 'ทำไมถามซ้ำ', 'ได้ ไม่ต้องทวน', "don't repeat it"]) {
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

/** Reads replies the way the model did on the live examples. */
const READS: Record<string, Understanding> = {
  กาฬสินธุ์: { kind: 'unclear', answer: '', echo: '' },
  ไทย: { kind: 'answer', answer: 'ใช่', echo: 'ใช่ค่ะ' },
  ข้อสอง: { kind: 'answer', answer: '2. withdrawn', echo: 'ข้อสองนะคะ' },
  'ไม่ค่อยเข้าใจว่าตัดสินใจเรื่องอะไร': { kind: 'question', answer: 'ไม่เข้าใจว่าตัดสินใจเรื่องอะไร', echo: '' },
  'ใช่ ไม่ต้องถามใหม่': { kind: 'answer', answer: 'ใช่', echo: 'ใช่ค่ะ' },
}

/** Speaks each new speech through and answers it with the next reply, until the call settles. */
async function answerInTurn(provider: FakeProvider, audio: FakeAudio, replies: string[], until: Promise<unknown>) {
  let settled = false
  void until.then(() => (settled = true))
  let spoken = 0
  while (!settled) {
    await tick(15)
    if (provider.said.length > spoken) {
      spoken = provider.said.length
      speakThrough(provider, audio, `s${spoken}`)
      await tick(15)
      const r = replies.shift()
      if (r) provider.utter(r, `${r}-${spoken}`)
    }
  }
}

test('noise in a round is asked again instead of taken as the answer, and the answer is echoed with the next question', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = r => READS[r.heard]
  const round = session.interview(['ข้อสาม เก็บสองชุด ใช้ได้ไหมคะ', 'ข้อสี่ แทนที่เลย ใช่ไหมคะ'], 5000)
  await answerInTurn(provider, audio, ['กาฬสินธุ์', 'ไทย', 'ข้อสอง'], round)
  const r = await round
  assert.deepEqual(provider.said.slice(0, 3), ['ข้อสาม เก็บสองชุด ใช้ได้ไหมคะ', 'ขอโทษค่ะ ได้ยินไม่ชัด ข้อสาม เก็บสองชุด ใช้ได้ไหมคะ', 'ใช่ค่ะ ข้อสี่ แทนที่เลย ใช่ไหมคะ'])
  assert.deepEqual(r.answers.map(a => a.understood?.answer), ['ใช่', '2. withdrawn'])
  assert.equal(r.unasked.length, 0)
  // The noise stays in the conversation, marked as not taken.
  assert.equal((session.state() as VoiceStateV1).transcript.find(l => l.text === 'กาฬสินธุ์')?.unclear, true)
})

test('a question back stops the round so Claude can answer it', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = r => READS[r.heard]
  const round = session.interview(['ข้อสี่ ใช่ไหมคะ', 'ข้อห้า ใช่ไหมคะ', 'ข้อหก ใช่ไหมคะ'], 5000)
  await answerInTurn(provider, audio, ['ไม่ค่อยเข้าใจว่าตัดสินใจเรื่องอะไร'], round)
  const r = await round
  assert.equal(r.answers[0]!.understood?.kind, 'question')
  assert.deepEqual(r.unasked, ['ข้อห้า ใช่ไหมคะ', 'ข้อหก ใช่ไหมคะ'])
  assert.equal(provider.said.length, 1)
})

test('noise that stays unclear goes to Claude after two more tries', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = r => READS[r.heard]
  const turn = session.converse('ข้อสาม ใช้ได้ไหมคะ', 5000)
  await answerInTurn(provider, audio, ['กาฬสินธุ์', 'กาฬสินธุ์', 'กาฬสินธุ์'], turn)
  const r = await turn
  assert.equal(provider.said.length, 3)
  assert.equal(r.understood?.kind, 'unclear')
  assert.equal(r.reply.text, 'กาฬสินธุ์')
})

test('without an understanding, "yes, don\'t ask again" is still an answer', async () => {
  const { provider, audio, session } = setup()
  const turn = session.converse('ข้อสี่ ใช่ไหมคะ', 5000)
  await answerInTurn(provider, audio, ['ใช่ ไม่ต้องถามใหม่'], turn)
  const r = await turn
  assert.equal(r.reply.text, 'ใช่ ไม่ต้องถามใหม่')
  assert.equal(r.repeats, 0)
  assert.equal(provider.understood.length, 1)
})

test('a typed answer is taken as written, without a check', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = () => ({ kind: 'unclear', answer: '', echo: '' })
  const turn = session.converse('ข้อสี่ ใช่ไหมคะ', 5000)
  await tick()
  speakThrough(provider, audio, 's1')
  await tick()
  session.control('type', '2')
  assert.equal((await turn).reply.text, '2')
  assert.equal(provider.understood.length, 0)
})

test('back from a long pause mid-question, converse returns for the recap instead of waiting for a reply', async () => {
  let skew = 0
  const { provider, audio, session } = setup({ recapAfterPauseMs: 60_000, now: () => Date.now() + skew })
  const turn = session.converse('ข้อสี่ ใช่ไหมคะ', 5000)
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  session.control('pause')
  skew += 120_000
  session.control('resume')
  const r = await Promise.race([turn, tick(500).then(() => undefined)])
  assert.equal(r?.reply.status, 'resumed')
  void audio
})

test('a lone word recognition makes of "ใช่" is read as yes; anything longer is kept', async () => {
  const { normaliseHeard, parseUnderstanding } = await import('../src/understand.ts')
  for (const t of ['ไทย', 'ไฮ', 'ไฉ่', 'ไทยครับ']) assert.equal(normaliseHeard(t), 'ใช่', t)
  for (const t of ['ประเทศไทย', 'ไทยดีกว่า', 'ข้อสอง']) assert.equal(normaliseHeard(t), t, t)
  assert.equal(parseUnderstanding('{"kind":"answer","answer":"yes","echo":"ใช่ค่ะ"}')?.echo, 'ใช่ค่ะ')
  assert.equal(parseUnderstanding('{"kind":"maybe"}'), undefined)
  assert.equal(parseUnderstanding('not json'), undefined)
})

test('with ready clips, noise gets an instant "say it again" without the question read again, and a yes is confirmed by clip', async () => {
  const { provider, audio, session } = setup({ ...withClips, clips: new ClipCache(undefined, 'echo') })
  provider.understandWith = r => (r.heard === 'กาฬสินธุ์' ? { kind: 'unclear', answer: '', echo: '' } : { kind: 'answer', answer: 'yes', echo: 'ใช่ค่ะ' })
  const round = session.interview(['ข้อสี่ ใช่ไหมคะ', 'ข้อห้า ใช่ไหมคะ'], 5000)
  await tick(30)
  speakThrough(provider, audio, 's1')
  await tick()
  provider.utter('กาฬสินธุ์', 'n1')
  await tick(80)
  // Asked again by clip: no new speech, the clip played, the line shown.
  assert.equal(provider.said.length, 1)
  assert.ok((session.state() as VoiceStateV1).transcript.some(l => l.who === 'claude' && l.text.startsWith('ขอโทษค่ะ ได้ยินไม่ชัด')))
  provider.utter('ไทย', 'y1')
  await tick(80)
  // The next question follows the "ใช่ค่ะ" clip, with no spoken lead.
  assert.equal(provider.said[1], 'ข้อห้า ใช่ไหมคะ')
  assert.ok((session.state() as VoiceStateV1).transcript.some(l => l.who === 'claude' && l.text === 'ใช่ค่ะ'))
  speakThrough(provider, audio, 's2')
  await tick()
  provider.utter('ได้', 'y2')
  const r = await round
  assert.deepEqual(r.answers.map(a => a.understood?.answer), ['yes', 'yes'])
  assert.equal(provider.understood[0]!.questionNo, 1)
})

test('the Decisions answers become an understanding with a fixed confirmation', async () => {
  const { cardChoices, decisionsRequest, readDecisions } = await import('../src/understand.ts')
  const card = '**Q1** Tracker?\n1. GitHub Issues (recommended)\n2. Linear\n\n**Q2** Alerts?\n1. Location manager\n2. Whole Lark group\n3. Nobody'
  assert.deepEqual(cardChoices(card, 2).map(c => c.value), ['1', '2', '3'])
  assert.equal(cardChoices(card, 2)[1]!.description, 'Whole Lark group')
  const req = { question: 'ข้อสอง แจ้งใคร', card, questionNo: 2, heard: 'ข้อสอง' }
  const body = decisionsRequest('gpt-6-luna', req) as { questions: { name: string; choices: { value: string }[] }[] }
  assert.deepEqual(body.questions.map(q => q.name), ['kind', 'which'])
  assert.deepEqual(body.questions[1]!.choices.map(c => c.value), ['1', '2', '3', 'none'])
  assert.deepEqual(readDecisions([{ type: 'choice', name: 'kind', choice: 'choice' }, { type: 'choice', name: 'which', choice: '2' }], req), {
    kind: 'answer',
    answer: '2. Whole Lark group',
    echo: 'ข้อสองนะคะ',
  })
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes' }], req)?.echo, 'ได้ค่ะ')
  // The confirmation follows the question: "ใช้ได้ไหม" → ได้ค่ะ, "…ใช่ไหม" → ใช่ค่ะ.
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes' }], { question: 'ข้อหนึ่ง แนะนำข้อสอง ใช้ได้ไหมคะ', heard: 'ได้' })?.echo, 'ได้ค่ะ')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes' }], { question: 'สรุปว่าใช้ GitHub Issues ถูกไหมคะ', heard: 'ถูก' })?.echo, 'ได้ค่ะ')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes' }], { question: 'ข้อสาม คนแก้ prompt เอง ใช่ไหมคะ', heard: 'ใช่' })?.echo, 'ใช่ค่ะ')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes' }], { question: 'ต้องเตือนก่อนลบใช่หรือเปล่าคะ?', heard: 'ใช่' })?.echo, 'ใช่ค่ะ')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'unclear' }], req)?.kind, 'unclear')
  assert.equal(readDecisions([{ type: 'refusal', name: 'kind' }], req), undefined)
  // Noise reads as a low-confidence answer ("แม่จ๋า มากจัง" → yes at 0.12): asked again.
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.12 }], req)?.kind, 'unclear')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.68 }], req)?.kind, 'answer')
  // A question back stays one even when unsure: Claude sees the words.
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'question', confidence: 0.2 }], req)?.kind, 'question')
  // No numbered choices: only the kind is asked.
  assert.equal((decisionsRequest('gpt-6-luna', { question: 'ใช้ได้ไหมคะ', heard: 'ได้' }) as { questions: unknown[] }).questions.length, 1)
})

test('"that was wrong" right after a confirmation goes back to the previous question and asks it again', async () => {
  const { provider, audio, session } = setup({ ...withClips, clips: new ClipCache(undefined, 'correct') })
  provider.understandWith = r =>
    r.heard === 'ไทย' ? { kind: 'answer', answer: 'no', echo: 'ไม่ใช่นะคะ' } : r.heard.startsWith('เดี๋ยว') ? { kind: 'correction', answer: r.heard, echo: '' } : { kind: 'answer', answer: 'yes', echo: 'ใช่ค่ะ' }
  const round = session.interview(['ข้อสี่ ใช่ไหมคะ', 'ข้อห้า ใช่ไหมคะ'], 5000)
  await answerInTurn(provider, audio, ['ไทย', 'เดี๋ยว เมื่อกี้บอกว่าใช่', 'ใช่', 'ได้'], round)
  const r = await round
  // Q4, Q5 (cut short by the correction), Q4 again, then Q5.
  assert.deepEqual(provider.said, ['ข้อสี่ ใช่ไหมคะ', 'ข้อห้า ใช่ไหมคะ', 'ข้อสี่ ใช่ไหมคะ', 'ข้อห้า ใช่ไหมคะ'])
  assert.ok((session.state() as VoiceStateV1).transcript.some(l => l.text === 'เมื่อกี้น่าจะฟังผิดค่ะ งั้นเรากลับไปข้อก่อนหน้าอีกครั้งนะคะ'))
  // The misheard "no" is gone; each question has its one, corrected answer.
  assert.deepEqual(r.answers.map(a => [a.question, a.understood?.answer]), [
    ['ข้อสี่ ใช่ไหมคะ', 'yes'],
    ['ข้อห้า ใช่ไหมคะ', 'yes'],
  ])
  // The check for Q5 knew what Q4's answer was taken as.
  assert.equal(provider.understood[1]!.previous?.answer, 'no (confirmed aloud: "ไม่ใช่นะคะ")')
})

test('words that point back, or a quick "no" over the new question, read as a correction', async () => {
  const { refineUnderstanding } = await import('../src/understand.ts')
  const previous = { question: 'ข้อสี่ ใช่ไหมคะ', answer: 'no (confirmed aloud: "ไม่ใช่นะคะ")' }
  const no = { kind: 'answer' as const, answer: 'no', echo: 'ไม่ใช่นะคะ' }
  const yes = { kind: 'answer' as const, answer: 'yes', echo: 'ใช่ค่ะ' }
  assert.equal(refineUnderstanding(no, { question: 'ข้อห้า', heard: 'ไม่ใช่ ข้อที่แล้วใช่', previous })?.kind, 'correction')
  assert.equal(refineUnderstanding(undefined, { question: 'ข้อห้า', heard: 'ย้อนกลับไปข้อที่แล้ว', previous })?.kind, 'correction')
  assert.equal(refineUnderstanding(no, { question: 'ข้อห้า', heard: 'ไม่ใช่ๆ', previous, cutInAfterMs: 400 })?.kind, 'correction')
  assert.equal(refineUnderstanding(yes, { question: 'ข้อห้า', heard: 'ใช่', previous, cutInAfterMs: 400 })?.kind, 'repeat')
  // Heard the new question through: a "no" answers it.
  assert.equal(refineUnderstanding(no, { question: 'ข้อห้า', heard: 'ไม่ใช่', previous })?.kind, 'answer')
  assert.equal(refineUnderstanding(no, { question: 'ข้อห้า', heard: 'ไม่ใช่', previous, cutInAfterMs: 4000 })?.kind, 'answer')
  // No earlier answer: nothing to correct.
  assert.equal(refineUnderstanding(no, { question: 'ข้อหนึ่ง', heard: 'เมื่อกี้ไม่ได้ยิน' })?.kind, 'answer')
})

test('a reply that opens with a plain yes or no is kept even when the model is unsure', async () => {
  const { readDecisions } = await import('../src/understand.ts')
  const req = { question: 'ข้อห้า ใช้ CRM reference อย่างเดียว ใช้ได้ไหมคะ', heard: 'ไม่ได้ ต้องใช้เบอร์โทรด้วย' }
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'no', confidence: 0.3 }], req)?.kind, 'answer')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.12 }], { ...req, heard: 'แม่จ๋า มากจัง' })?.kind, 'unclear')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.2 }], { ...req, heard: 'ได้ยินไม่ชัด' })?.kind, 'unclear')
  // Openings seen live: "ใช้ได้", "ใช่ได้", "คิดว่า…", "บอกว่า…", and "เชื่อได้" for "ใช้ได้".
  for (const heard of ['ใช่ได้ แต่ว่าถ้าเกิดเมนู Add Serial Number', 'บอกว่าใช้ได้ แต่ว่าถ้าเกิดพนักงานแอด', 'คิดว่าใช้ได้แต่ว่า', 'เชื่อได้', 'บอกว่าเชื่อได้แต่ว่าห้ามแอด'])
    assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'free_answer', confidence: 0.26 }], { ...req, heard })?.kind, 'answer', heard)
  // "เชื่อได้" is taken for "ใช้ได้" only when that is what was asked.
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.26 }], { question: 'ข้อสาม ใครดูแลคะ', heard: 'เชื่อได้' })?.kind, 'unclear')
})

test('a yes-with-a-condition split between kinds is still an answer, with its words kept', async () => {
  const { readDecisions, spokenAnswer } = await import('../src/understand.ts')
  const p = (yes: number, free: number, unclear: number) => [
    { value: 'free_answer', probability: free },
    { value: 'yes', probability: yes },
    { value: 'unclear', probability: unclear },
  ]
  const req = { question: 'ข้อห้า serial ที่พนักงานพิมพ์ก็นับ ใช้ได้ไหมคะ', heard: 'ต้องเพิ่มเป็น suggestion ไม่ใช่ว่าเราจะแอดเข้าไปเป็น asset ของลูกค้าเลย' }
  // Live: free_answer 0.41, yes 0.24, no 0.13: unsure of the kind, sure it is an answer.
  const split = readDecisions([{ type: 'choice', name: 'kind', choice: 'free_answer', confidence: 0.34, probabilities: [...p(0.24, 0.41, 0.05), { value: 'no', probability: 0.13 }] }], req)
  assert.equal(split?.kind, 'answer')
  assert.equal(split?.answer, req.heard)
  // Noise spreads over unclear: still asked again.
  const noise = readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.3, probabilities: p(0.3, 0.1, 0.5) }], { ...req, heard: 'แม่จ๋า มากจัง' })
  assert.equal(noise?.kind, 'unclear')

  // A yes with "แต่…" keeps the condition and is not confirmed as a bare "ใช่ค่ะ".
  const heard = 'ใช่ได้ แต่ว่าถ้าเกิดพนักงานแอดเองก็ยังต้องแอดได้'
  const hedged = readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.44 }], { ...req, heard })
  assert.deepEqual(hedged, { kind: 'answer', answer: `yes, with a condition: ${heard}`, echo: '', confidence: 0.44 })
  assert.equal(spokenAnswer(hedged, heard), heard)
  // A plain yes to "ใช้ได้ไหม" is still confirmed, as "ได้ค่ะ".
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.9 }], { ...req, heard: 'ใช่ ไม่ต้องถามใหม่' })?.echo, 'ได้ค่ะ')
})

test('a long explanation is never taken for noise, and a garbled "ทวนคำถาม" repeats', async () => {
  const { readDecisions } = await import('../src/understand.ts')
  const question = 'ข้อหก ถ้าเครื่องถูกย้ายไปเป็นของคนอื่น ลิงก์ผู้ติดต่อแทนของเครื่องนั้นหลุดไปด้วย ใช้ได้ไหมคะ'
  const unclear = [{ type: 'choice', name: 'kind', choice: 'unclear', confidence: 0.5 }]
  // Seen live: a coherent explanation with a few misheard words got "ได้ยินไม่ชัด" twice.
  const heard =
    'เวลาที่เรา เปลี่ยนเมนโปรไฟล์ แอสซิสแตนท์ลิงก์มันจะไม่ต่อกับซีเรียลนั้นแล้ว แต่ว่ามันควรจะยังต่อกับเมนโปรไฟล์อันเดิมอยู่'
  assert.deepEqual(readDecisions(unclear, { question, heard }), { kind: 'answer', answer: heard, echo: '', confidence: 0.5 })
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'free_answer', confidence: 0.2 }], { question, heard })?.kind, 'answer')
  // Short noise and a short aside to someone else are still asked again.
  for (const h of ['เหรอ', 'เฮ้ย', 'เขาก็อยากจะกลับไปเรียนเหมือนกัน', 'แม่จ๋า มากจัง']) assert.equal(readDecisions(unclear, { question, heard: h })?.kind, 'unclear', h)
  // "ทวนคำถามข้อห้า…" as recognition heard it.
  for (const h of ['หวานคำถามขอห้ามหน่อย ครับ', 'บนคำถามข้อห้าใหม่ให้น้อง', 'ทวนอีกทีได้ไหม']) assert.equal(readDecisions(unclear, { question, heard: h })?.kind, 'repeat', h)
  // Luna read it as an unsure yes, with yes and no summing high: still a repeat.
  const unsureYes = [{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.27, probabilities: [{ value: 'yes', probability: 0.3 }, { value: 'free_answer', probability: 0.25 }, { value: 'no', probability: 0.2 }] }]
  assert.equal(readDecisions(unsureYes, { question, heard: 'บนคำถามข้อห้าใหม่ให้น้อง' })?.kind, 'repeat')
  // A short noise word summing high over the answer kinds is still noise.
  for (const h of ['เฮ้ย', 'ผิดหวังบน']) assert.equal(readDecisions(unsureYes, { question, heard: h })?.kind, 'unclear', h)
  // "ใช่ ไม่ต้องถามใหม่" is a yes, not a repeat.
  assert.equal(readDecisions(unsureYes, { question, heard: 'ใช่ ไม่ต้องถามใหม่' })?.kind, 'answer')
})

test('"ใครได้" and "ให้ได้" opening a reply to "ใช้ได้ไหม" read as "ใช้ได้"', async () => {
  const { normaliseHeard, readDecisions } = await import('../src/understand.ts')
  const question = 'ข้อสาม ใช้ serial lookup เดียวกัน ใช้ได้ไหมคะ'
  assert.equal(normaliseHeard('ใครได้', question), 'ใช้ได้')
  assert.equal(normaliseHeard('ใครได้ แต่ว่าต้องเตือนก่อน', question), 'ใช้ได้ แต่ว่าต้องเตือนก่อน')
  assert.equal(normaliseHeard('คิดว่าให้ได้', question), 'คิดว่าใช้ได้')
  // Only when that is what was asked: "ใครได้รับแจ้งเตือน" is a real question.
  assert.equal(normaliseHeard('ใครได้รับแจ้งเตือน', 'ข้อสอง แจ้งเตือนไปที่กลุ่ม Lark ดีไหมคะ'), 'ใครได้รับแจ้งเตือน')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'question', confidence: 0.3 }], { question, heard: 'ใครได้' })?.kind, 'question')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.2 }], { question, heard: 'ใครได้' })?.kind, 'answer')
})

/** Reads review replies (keep / change) and answers the way Luna did live. */
const reads = (r: UnderstandRequest): Understanding | undefined => {
  if (r.review) return r.heard === 'เหมือนเดิม' ? { kind: 'keep', answer: '', echo: '' } : r.heard === 'เปลี่ยน' ? { kind: 'change', answer: '', echo: '' } : undefined
  if (r.heard === 'ใช่') return { kind: 'answer', answer: 'yes', echo: 'ใช่ค่ะ' }
  if (r.heard === 'ไม่ใช่') return { kind: 'answer', answer: 'no', echo: 'ไม่ใช่นะคะ' }
  return { kind: 'answer', answer: r.heard, echo: '' }
}

/** Waits (up to 2 s) until `ok` holds: the round runs on real timers. */
async function until(ok: () => boolean) {
  for (let n = 0; n < 200 && !ok(); n++) await tick(10)
  assert.ok(ok(), 'timed out waiting')
}

/** Speaks the newest speech through, then the person says `text`. */
async function hearNext(provider: FakeProvider, audio: FakeAudio, text: string) {
  await tick(20)
  speakThrough(provider, audio, `s${provider.said.length}`)
  await tick(10)
  provider.utter(text, `${text}-${provider.said.length}`)
  await tick(30)
}

test('clicking a later question jumps to it, then the round comes back to the first one not answered', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = reads
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง', 'ข้อสาม'], 5000)
  await tick(20)
  speakThrough(provider, audio, 's1')
  await tick(10)
  assert.equal(session.control('goto', '', 3).accepted, true)
  await hearNext(provider, audio, 'ตอบสาม')
  await hearNext(provider, audio, 'ตอบหนึ่ง')
  await hearNext(provider, audio, 'ตอบสอง')
  const r = await round
  assert.deepEqual(provider.said, ['ข้อหนึ่ง', 'ข้อสาม', 'ข้อหนึ่ง', 'ข้อสอง'])
  // Answers come back in question order.
  assert.deepEqual(r.answers.map(a => a.answer), ['ตอบหนึ่ง', 'ตอบสอง', 'ตอบสาม'])
  assert.deepEqual(r.unasked, [])
})

test('clicking an answered question reads the answer back; keeping it carries on where the round was', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = reads
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง'], 5000)
  await hearNext(provider, audio, 'ใช่')
  await until(() => provider.said.length === 2)
  session.control('goto', '', 1)
  await until(() => provider.said.length === 3)
  assert.equal(provider.said.at(-1), 'ข้อหนึ่ง ตอบไว้ว่า ใช่ ค่ะ จะเปลี่ยนไหมคะ')
  const s = session.state() as VoiceStateV1
  assert.deepEqual(s.round?.items.map(i => [i.status, i.answer]), [['answered', 'ใช่'], ['pending', undefined]])
  assert.equal(s.round?.current, 0)
  await hearNext(provider, audio, 'เหมือนเดิม')
  await hearNext(provider, audio, 'ไม่ใช่')
  const r = await round
  // No ready clips here, so confirmations are spoken: with the next question, or on their own.
  assert.deepEqual(provider.said, ['ข้อหนึ่ง', 'ใช่ค่ะ ข้อสอง', 'ข้อหนึ่ง ตอบไว้ว่า ใช่ ค่ะ จะเปลี่ยนไหมคะ', 'ได้ค่ะ คงคำตอบเดิมนะคะ', 'ข้อสอง'])
  assert.deepEqual(r.answers.map(a => [a.understood?.answer, a.changedFrom]), [['yes', undefined], ['no', undefined]])
})

test('changing an earlier answer asks that question again and notes what it was', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = reads
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง'], 5000)
  await hearNext(provider, audio, 'ใช่')
  await hearNext(provider, audio, 'ใช่')
  // Round done for the bridge? No: wait until it returns, then it is the last round.
  const first = await round
  assert.equal(first.answers.length, 2)
  const round2 = session.interview(['ข้อหนึ่ง', 'ข้อสอง'], 5000)
  await hearNext(provider, audio, 'ใช่')
  await until(() => provider.said.at(-1) === 'ใช่ค่ะ ข้อสอง' && provider.said.length === 5)
  session.control('goto', '', 1)
  await hearNext(provider, audio, 'เปลี่ยน')
  await hearNext(provider, audio, 'ไม่ใช่')
  await hearNext(provider, audio, 'ใช่')
  const r = await round2
  assert.equal(r.answers[0]!.understood?.answer, 'no')
  assert.equal(r.answers[0]!.changedFrom, 'ใช่')
  assert.equal(r.answers[1]!.understood?.answer, 'yes')
})

test('after the round, clicking a question goes to Claude to revisit, even while it waits on another question', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = reads
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง'], 5000)
  await hearNext(provider, audio, 'ใช่')
  await hearNext(provider, audio, 'ไม่ใช่')
  await round
  assert.equal((session.state() as VoiceStateV1).round?.active, false)
  // Claude is asking something else when the person clicks question 1.
  const turn = session.converse('อีกเรื่องค่ะ', 5000)
  await tick(20)
  speakThrough(provider, audio, `s${provider.said.length}`)
  await tick(10)
  assert.equal(session.control('goto', '', 1).accepted, true)
  const r = await turn
  assert.equal(r.reply.status, 'navigated')
  assert.deepEqual(r.revisit, { number: 1, question: 'ข้อหนึ่ง', answer: 'ใช่' })
  // Handed over once.
  assert.equal(session.control('take').revisit, undefined)
})

test('with no voice call waiting, the pane takes a revisit for Claude', async () => {
  const { provider, audio, session } = setup()
  provider.understandWith = reads
  const round = session.interview(['ข้อหนึ่ง'], 5000)
  await hearNext(provider, audio, 'ใช่')
  await round
  // The spoken "ใช่ค่ะ" finishes; then no voice call is in progress.
  await tick(20)
  speakThrough(provider, audio, `s${provider.said.length}`)
  await tick(20)
  session.control('goto', '', 1)
  assert.equal((session.state() as VoiceStateV1).revisitDue, 1)
  assert.deepEqual(session.control('take').revisit, { number: 1, question: 'ข้อหนึ่ง', answer: 'ใช่' })
  assert.equal((session.state() as VoiceStateV1).revisitDue, undefined)
})

test('a read-back reply is understood with words when there is no model', async () => {
  const { reviewByWords, choiceNumber, spokenAnswer } = await import('../src/understand.ts')
  assert.equal(reviewByWords('เหมือนเดิมค่ะ')?.kind, 'keep')
  assert.equal(reviewByWords('ไม่')?.kind, 'keep')
  assert.equal(reviewByWords('เปลี่ยน')?.kind, 'change')
  assert.equal(reviewByWords('ใช่')?.kind, 'change')
  assert.equal(reviewByWords('กาฬสินธุ์'), undefined)
  assert.equal(choiceNumber('เอาข้อสองแทน'), 2)
  assert.equal(choiceNumber('อันแรก'), 1)
  assert.equal(choiceNumber('ข้อ 3'), 3)
  assert.equal(choiceNumber('ไม่รู้'), undefined)
  assert.equal(spokenAnswer({ kind: 'answer', answer: '2. Linear', echo: '' }, 'ข้อสอง'), 'ข้อสอง Linear')
})

test('the English terms of the question and its card become recognition hints', async () => {
  const { vocabularyFrom } = await import('../src/session.ts')
  assert.deepEqual(
    vocabularyFrom('ข้อสาม ถ้า SKU ไม่ตรงกับแถว Legacy ใช้ได้ไหมคะ กด dismiss แล้ว\n**Q3 Owned Unit**\n1. Add Serial Number then retry first (recommended)\n2. See `foo_bar` at https://x.io'),
    ['SKU', 'Legacy', 'dismiss', 'Owned Unit', 'Add Serial Number'],
  )
  assert.deepEqual(vocabularyFrom('ใช้ได้ไหมคะ'), [])

  const { provider, audio, session } = setup()
  void session.converse('ข้อหนึ่ง เสนอ Proposal จาก serial ใช้ได้ไหมคะ', 5000, undefined, '**Q1** Owned Unit Proposal\n1. Check SupplyChainOS first')
  await tick()
  assert.deepEqual(provider.vocabulary, ['Proposal', 'serial', 'Owned Unit Proposal', 'Check SupplyChainOS', 'Wayfinder'])
  speakThrough(provider, audio, 's1')
  provider.utter('ใช่')
  await tick(80)
  session.control('end')
})

test('a reply that stops mid-thought is waited for, so a thinking pause does not end it', async () => {
  const { soundsUnfinished } = await import('../src/session.ts')
  for (const t of ['คิดว่าใช้ได้ แต่ว่า', 'ถ้าเกิดว่า', 'คือ', 'เอ่อ', 'อันนี้ได้นะ แบบว่า', 'บอกว่าเชื่อได้แต่ว่า...', 'but'])
    assert.equal(soundsUnfinished(t), true, t)
  for (const t of ['ใช้ได้ค่ะ', 'ได้แล้ว', 'ทวนคำถามให้หน่อย', 'ไม่เอา', '']) assert.equal(soundsUnfinished(t), false, t)

  const { provider, audio, session } = setup({ endOfReplyMs: 40, unfinishedReplyMs: 400 })
  const turn = session.converse('ข้อหก ใช้ได้ไหมคะ', 5000)
  await tick()
  speakThrough(provider, audio, 's1')
  await tick()
  provider.utter('คิดว่าใช้ได้ แต่ว่า', 'a')
  await tick(150) // longer than endOfReplyMs: a finished reply would have been taken by now
  provider.utter('ต้องเตือนก่อนลบนะ', 'b')
  const r = await turn
  assert.equal(r.reply.text, 'คิดว่าใช้ได้ แต่ว่า ต้องเตือนก่อนลบนะ')
  session.control('end')
})

test('a discussion waits through longer pauses and goes to Claude as said, unchecked', async () => {
  const { provider, audio, session } = setup({ endOfReplyMs: 40, discussEndOfReplyMs: 300 })
  provider.understandWith = () => ({ kind: 'unclear', answer: '', echo: '' })
  const turn = session.converse('ข้อหก เล่าให้ฟังหน่อยว่าลิงก์ควรติดกับอะไรคะ', 5000, undefined, undefined, true)
  await tick()
  speakThrough(provider, audio, 's1')
  await tick()
  provider.utter('มันควรติดกับโปรไฟล์เดิม', 'a')
  await tick(120)
  provider.utter('เพราะคนส่งแทนยังเป็นคนเดิม', 'b')
  const r = await turn
  assert.equal(r.reply.text, 'มันควรติดกับโปรไฟล์เดิม เพราะคนส่งแทนยังเป็นคนเดิม')
  assert.equal(r.understood, undefined)
  assert.equal(provider.understood.length, 0, 'no answer check in a discussion')
  assert.equal(r.repeats, 0)
  session.control('end')
})

test('a question asked back is a question, whatever kind the model guessed', async () => {
  const { asksBack, readDecisions } = await import('../src/understand.ts')
  for (const t of ['จะให้แจงมาทำอะไรนะ', 'ทำไมต้องมีกดปุ่มด้วยนะ', 'อันนี้คือยังไงนะ', 'หมายถึงแจ้งทุกครั้งเลยเหรอ', 'แจ้งไปให้ใครนะ', 'ใช้ได้ไหมนะ ไม่แน่ใจ', 'เก็บกี่วัน'])
    assert.equal(asksBack(t), true, t)
  for (const t of ['ใช้ได้', 'อะไรก็ได้', 'ว่าอะไรนะ', 'อะไรนะครับ', 'ทวนคำถามให้หน่อย', 'ใช่ ไม่ต้องถามใหม่', 'ไม่หรอก', 'ถูกต้อง'])
    assert.equal(asksBack(t), false, t)
  const question = 'ข้อสาม แนะนำให้แจ้งทั้งตอน lifecycle stage เปลี่ยน ใช้ได้ไหมคะ'
  // Seen live as yes ("ใช่ค่ะ", next question), and as repeat and comment in probes.
  for (const choice of ['yes', 'repeat', 'comment'])
    assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice, confidence: 0.3 }], { question, heard: 'จะให้แจงมาทำอะไรนะ' })?.kind, 'question', choice)
  // Noise the model calls unclear stays unclear; a yes that opens the reply stays an answer.
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'unclear', confidence: 0.5 }], { question, heard: 'ใช่ไหมอเมริกา' })?.kind, 'unclear')
  assert.equal(readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.6 }], { question, heard: 'ใช้ได้ แต่ทำไมต้องแจ้งทุกครั้ง' })?.kind, 'answer')
  // "ถูกต้อง" is a plain yes however unsure the model is; its confidence is kept for the log.
  const right = readDecisions([{ type: 'choice', name: 'kind', choice: 'yes', confidence: 0.39 }], { question, heard: 'ถูกต้อง' })
  assert.equal(right?.kind, 'answer')
  assert.equal(right?.confidence, 0.39)
})

test('"แต่ว่า…" spoken over the next question is added to the answer just given', async () => {
  const { refineUnderstanding } = await import('../src/understand.ts')
  const previous = { question: 'ข้อหนึ่ง', answer: 'yes (confirmed aloud: "ใช่ค่ะ")' }
  const yes: Understanding = { kind: 'answer', answer: 'yes', echo: 'ใช่ค่ะ' }
  assert.equal(refineUnderstanding(yes, { question: 'ข้อสอง', heard: 'แต่ว่าต้องเตือนก่อนลบ', previous, cutInAfterMs: 1200 })?.kind, 'addition')
  assert.equal(refineUnderstanding(yes, { question: 'ข้อสอง', heard: 'เอ่อ แล้วก็ต้องมี log ด้วย', previous, cutInAfterMs: 2500 })?.kind, 'addition')
  // Later in the question, or not carrying on: as before.
  assert.equal(refineUnderstanding(yes, { question: 'ข้อสอง', heard: 'แต่ว่าต้องเตือนก่อนลบ', previous, cutInAfterMs: 5000 })?.kind, 'answer')
  assert.equal(refineUnderstanding(yes, { question: 'ข้อสอง', heard: 'ใช้ได้', previous, cutInAfterMs: 1200 })?.kind, 'repeat')

  const { provider, audio, session } = setup()
  provider.understandWith = r => (/^ใช้ได้/.test(r.heard) ? { kind: 'answer', answer: 'yes', echo: 'ใช่ค่ะ' } : { kind: 'answer', answer: r.heard, echo: '' })
  const round = session.interview(['ข้อหนึ่ง ใช้ได้ไหมคะ', 'ข้อสอง ใช้ได้ไหมคะ'], 5000)
  await hearNext(provider, audio, 'ใช้ได้')
  // The second question starts; they carry on about the first over it.
  await until(() => provider.said.some(t => t.includes('ข้อสอง')))
  const q2 = `s${provider.said.findIndex(t => t.includes('ข้อสอง')) + 1}`
  provider.emit({ type: 'speech.audio', speechId: q2, pcm: Buffer.alloc(4800) })
  provider.utter('แต่ว่าต้องเตือนก่อนลบ', 'more')
  // Acknowledged, and the second question is asked again.
  await until(() => provider.said.filter(t => t.includes('ข้อสอง')).length >= 2)
  await hearNext(provider, audio, 'ใช้ได้')
  const r = await round
  assert.equal(r.answers.length, 2)
  assert.equal(r.answers[0]?.answer, 'ใช้ได้ แต่ว่าต้องเตือนก่อนลบ')
  assert.equal(r.answers[0]?.understood?.answer, 'yes, with a condition: ใช้ได้ แต่ว่าต้องเตือนก่อนลบ')
  assert.equal(r.answers[1]?.answer, 'ใช้ได้')
})

test('a voice call stopped mid-question leaves that question open in the pane, not ticked', async () => {
  const { provider, session } = setup()
  const stop = new AbortController()
  const round = session.interview(['ข้อหนึ่ง', 'ข้อสอง'], 5000, stop.signal)
  await tick()
  provider.emit({ type: 'speech.audio', speechId: 's1', pcm: Buffer.alloc(4800) })
  await tick()
  stop.abort()
  const r = await round
  assert.equal(r.answers[0]?.status, 'cancelled')
  const items = (session.state() as VoiceStateV1).round?.items
  assert.deepEqual(items?.map(i => i.status), ['pending', 'pending'])
})

test('a term never runs across a line break, and keywords go to OpenAI one line each', async () => {
  const { vocabularyFrom } = await import('../src/session.ts')
  const { keywordsFrom } = await import('../src/providers/openai-realtime.ts')
  const card = '**Q2. After-sales intents**\n- Repair Status\n- Warranty Claim\nParts Order และ After-Sales Follow-up'
  const terms = vocabularyFrom(card)
  assert.ok(terms.includes('Repair Status') && terms.includes('Warranty Claim'), terms.join(' | '))
  assert.ok(terms.every(t => !/\n/.test(t)), terms.join(' | '))
  assert.deepEqual(keywordsFrom(['Repair Status\nWarranty Claim', ' Owned  Unit ', 'Owned Unit', '', 'CRM#88']), ['Repair Status Warranty Claim', 'Owned Unit', 'CRM#88'])
})

test("Claude's speech is priced by the model that speaks", async () => {
  const { OpenAIRealtimeProvider } = await import('../src/providers/openai-realtime.ts')
  const { loadConfig } = await import('../src/config.ts')
  // The plugin's defaults, not a personal config on this machine.
  process.env.VOICE_WAYFINDER_CONFIG = join(tmpdir(), 'no-voice-wayfinder-config.json')
  const base = loadConfig(join(import.meta.dirname, '..', '..', 'plugin')).openai
  const costOf = (model: string) => {
    const p = new OpenAIRealtimeProvider({ ...base, model }, 'test')
    let usd = 0
    p.onEvent(e => {
      if (e.type === 'usage' && e.kind === 'speech') usd += e.costUsd
    })
    ;(p as unknown as { handle(m: unknown): void }).handle({ type: 'response.done', response: { usage: { input_tokens: 0, output_token_details: { audio_tokens: 1_000_000, text_tokens: 0 } } } })
    return usd
  }
  assert.equal(base.model, 'gpt-realtime-2.1-mini')
  assert.equal(costOf('gpt-realtime-2.1-mini'), 20)
  assert.equal(costOf('gpt-realtime-2.1'), 64)
  assert.equal(costOf('some-new-model'), 64)
})
