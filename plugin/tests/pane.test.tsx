import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { VoiceStateV1 } from '../types'

const OPEN_PANE = {
  command: 'voice-pane',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const PANE = {
  plugin: 'voice-wayfinder',
  component: 'Pane',
  requestId: 'voice-pane',
  props: {
    title: 'Voice',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'voice-wayfinder',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 60, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const SCREEN = '**Q2. Who gets the SOP alert?**\n1. The location manager\n2. The whole Lark group\n\nRecommended: 1'

const STATE: VoiceStateV1 = {
  v: 1,
  rev: 7,
  activity: 'listening',
  muted: false,
  awaitingReply: true,
  provider: 'openai-realtime',
  model: 'gpt-realtime-2.1',
  sessionStartedAt: 0,
  estimatedCostUsd: 0.42,
  queuedUtterances: 0,
  transcript: [
    { id: 1, at: 0, who: 'claude', text: 'ข้อแรก ใช้ GitHub Issues ไหมคะ' },
    { id: 2, at: 0, who: 'user', text: 'ใช้ครับ' },
    { id: 3, at: 0, who: 'claude', text: 'ข้อสอง ใครได้รับแจ้งเตือนคะ' },
  ],
  card: { screen: SCREEN, question: 2, of: 5 },
}

type Call = { tool: string; args: Record<string, unknown> }

/** Stands for the engine and the bridge's MCP server beneath the mod. */
function bridge(on: On, state: VoiceStateV1, calls: Call[], acceptsTyped = true, opened: string[] = [], prompts: string[] = []) {
  on('command.register', () => ({ value: { command: 'voice-pane' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:voice-wayfinder:voice' } }))
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const body =
      e.tool === 'voice_status'
        ? state
        : e.args.action === 'type'
          ? { message: 'typed', accepted: acceptsTyped }
          : e.args.action === 'take'
            ? take(state)
            : { ok: true }
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false, structuredContent: body } }
  })
  // The engine beneath: a prompt that reaches it enters the session; turns and tools just run.
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
}

/** The bridge hands over what is queued once, as the real one does. */
function take(state: VoiceStateV1) {
  const heard = state.queuedUtterances ? state.transcript.filter(l => l.who === 'user').slice(-state.queuedUtterances).map(l => l.text) : []
  state.queuedUtterances = 0
  return { message: 'took', accepted: heard.length > 0, heard }
}

const typedPrompt = (text: string) => ({ text, wait: false, origin: { kind: 'sdk' } }) as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows the question card, the live words and the conversation on ${surface}`, async ($, on) => {
    bridge(on, { ...STATE, partial: 'น่าจะเป็นข้อหนึ่ง' }, [])
    await $.command.run(OPEN_PANE)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Question 2 of 5/ })).toBeDefined()
    expect((await ui.find({ type: 'Markdown' }))?.text).toBe(SCREEN)
    expect((await ui.find({ type: 'Text', text: /^Claude ข้อสอง/ }))?.text).toBe('Claude ข้อสอง ใครได้รับแจ้งเตือนคะ')
    expect((await ui.find({ type: 'Text', text: /น่าจะเป็น/ }))?.text).toBe('You น่าจะเป็นข้อหนึ่ง…')
    expect(await ui.find({ type: 'Text', text: /^Conversation$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ใช้ครับ/ })).toBeDefined()
    await ui.unmount()
  })

  test(`the buttons send controls to the bridge on ${surface}`, async ($, on) => {
    const calls: Call[] = []
    bridge(on, STATE, calls)
    await $.command.run(OPEN_PANE)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mute' })
    await ui.press({ key: 'skip' })
    await ui.press({ key: 'end' })
    expect(calls.filter(c => c.tool === 'voice_control').map(c => c.args.action)).toEqual(['mute', 'skip', 'end'])
    await ui.unmount()
  })

  test(`the band above the prompt captions the question and the live words on ${surface}`, async ($, on) => {
    bridge(on, { ...STATE, partial: 'คิดว่า' }, [])
    await $.command.run(OPEN_PANE)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Listening/ }))?.text).toContain('Listening · Q2/5')
    expect((await ui.find({ type: 'Text', text: /^Claude/ }))?.text).toBe('Claude ข้อสอง ใครได้รับแจ้งเตือนคะ')
    expect((await ui.find({ type: 'Text', text: /คิดว่า/ }))?.text).toBe('You คิดว่า…')
    expect(await ui.find({ type: 'Text', text: /type here/ })).toBeDefined()
    await ui.unmount()
  })
}

test('the conversation lists the newest line first', async ($, on) => {
  bridge(on, STATE, [])
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const lines = (await ui.findAll({ type: 'Text', text: /^(Claude|You) / })).map(t => t.text)
  const conversation = lines.slice(lines.indexOf('Claude ข้อแรก ใช้ GitHub Issues ไหมคะ') - 2)
  expect(conversation.slice(0, 3)).toEqual(['Claude ข้อสอง ใครได้รับแจ้งเตือนคะ', 'You ใช้ครับ', 'Claude ข้อแรก ใช้ GitHub Issues ไหมคะ'])
  await ui.unmount()
})

test('the controls are three short buttons', async ($, on) => {
  bridge(on, STATE, [])
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const [key, label] of [['mute', '🔇 Mute'], ['skip', '⏭ Skip'], ['end', '⏹ End']]) {
    expect((await ui.find({ key }))?.text).toBe(label)
  }
  await ui.unmount()
})

test('without a screen card, the card shows what Claude is saying', async ($, on) => {
  bridge(on, { ...STATE, card: undefined }, [])
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ข้อสอง ใครได้รับแจ้งเตือนคะ$/ })).toBeDefined()
  await ui.unmount()
})

test('a refusal from the permission check is explained in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'voice-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:voice-wayfinder:voice' } }))
  on('mcp.call', () => ({
    value: { content: [{ type: 'text', text: 'refused: The server-side auto mode classifier gave no verdict' }], isError: true },
  }))
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /permission check/ }))?.text).toContain('npm run setup')
  await ui.unmount()
})

test('an unreachable bridge is said in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'voice-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'failed', message: 'voice: server failed to start' } }))
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /failed to start/ }))?.text).toContain('failed to start')
  expect(await ui.find({ key: 'mute' })).toBeUndefined()
  await ui.unmount()
})

test('a protocol the pane does not know is refused', async ($, on) => {
  bridge(on, { ...STATE, v: 2 } as unknown as VoiceStateV1, [])
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /protocol v2/ }))?.text).toContain('Update the plugin')
  await ui.unmount()
})

test('after a session ends the pane shows what it cost, today and this month', async ($, on) => {
  const ended: VoiceStateV1 = {
    ...STATE,
    activity: 'off',
    awaitingReply: false,
    sessionStartedAt: undefined,
    estimatedCostUsd: 0,
    lastSession: { endedAt: 0, reason: 'Voice session ended.', durationMs: 252_000, costUsd: 0.31, speechUsd: 0.27, transcriptionUsd: 0.04, spokenMs: 180_000, heardMs: 60_000 },
    todayCostUsd: 0.42,
    monthCostUsd: 3.1,
  }
  bridge(on, ended, [])
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Last session/ }))?.text).toContain('4.2 min · est. $0.31 (speech $0.27')
  expect((await ui.find({ type: 'Text', text: /today/ }))?.text).toBe('OpenAI est. today $0.42 · this month $3.10')
  expect(await ui.find({ key: 'card' })).toBeUndefined()
  await ui.unmount()
})

test('the band stays out of the way while voice is off', async ($, on) => {
  bridge(on, { ...STATE, activity: 'off', awaitingReply: false }, [])
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
  await ui.unmount()
})

test('typing during a voice question answers it instead of queueing in the chat', async ($, on) => {
  const calls: Call[] = []
  bridge(on, STATE, calls)
  await $.command.run(OPEN_PANE)
  const r = await $.prompt.submit(typedPrompt('1'))
  expect(r.drop).toContain('1')
  expect(calls.find(c => c.args.action === 'type')?.args).toEqual({ action: 'type', text: '1' })
})

test('typing when the bridge has no question in progress goes to the chat', async ($, on) => {
  bridge(on, STATE, [], false)
  await $.command.run(OPEN_PANE)
  const r = await $.prompt.submit(typedPrompt('อีกเรื่องนึง'))
  expect(r.drop).toBeUndefined()
  expect(r.text).toBe('อีกเรื่องนึง')
})

test('with voice off, prompts pass straight through without asking the bridge', async ($, on) => {
  const calls: Call[] = []
  bridge(on, { ...STATE, activity: 'off', awaitingReply: false }, calls)
  await $.command.run(OPEN_PANE)
  const r = await $.prompt.submit(typedPrompt('สวัสดี'))
  expect(r.text).toBe('สวัสดี')
  expect(calls.some(c => c.args.action === 'type')).toBe(false)
})

test('slash commands are never taken as an answer', async ($, on) => {
  const calls: Call[] = []
  bridge(on, STATE, calls)
  await $.command.run(OPEN_PANE)
  await $.prompt.submit({ ...typedPrompt('/voice-pane'), command: { name: 'voice-pane', args: '' } })
  expect(calls.some(c => c.args.action === 'type')).toBe(false)
})

test('starting voice mode turns the bridge back on and opens the pane as the person asked', async ($, on) => {
  const opened: string[] = []
  const calls: Call[] = []
  bridge(on, { ...STATE, activity: 'off', stopped: true }, calls, true, opened)
  await $.prompt.submit({ ...typedPrompt('/voice-wayfinder:voice-mode'), command: { name: 'voice-wayfinder:voice-mode', args: '' } })
  expect(opened).toContain('voice-pane')
  expect(calls.some(c => c.tool === 'voice_control' && c.args.action === 'start')).toBe(true)
})

test('after End the pane says voice is off until voice mode is started again', async ($, on) => {
  bridge(on, { ...STATE, activity: 'off', awaitingReply: false, stopped: true }, [])
  await $.command.run(OPEN_PANE)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Voice ended/ }))?.text).toContain('/voice-wayfinder:voice-mode')
  await ui.unmount()
})

/** Claude at work: connected, no question waiting, one thing said meanwhile. */
const WORKING = (): VoiceStateV1 => ({
  ...STATE,
  activity: 'idle',
  awaitingReply: false,
  card: undefined,
  queuedUtterances: 1,
  transcript: [...STATE.transcript, { id: 4, at: 0, who: 'user', text: 'ใน system context ไม่ได้บอกไว้เหรอ' }],
})

test('what the person says while Claude works reaches it at the next tool call', async ($, on) => {
  const calls: Call[] = []
  const prompts: string[] = []
  bridge(on, WORKING(), calls, true, [], prompts)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.command.run(OPEN_PANE)
  const r = await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(r.context?.join('\n')).toContain('ใน system context ไม่ได้บอกไว้เหรอ')
  expect(r.context?.join('\n')).toContain('voice_say')
  // Handed over once: the next tool's result carries nothing, and no prompt was started.
  const again = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(again.context ?? []).toEqual([])
  expect(calls.filter(c => c.args.action === 'take').length).toBe(1)
  expect(prompts).toEqual([])
})

test('a voice question takes the words itself, so its result gets no note', async ($, on) => {
  const calls: Call[] = []
  bridge(on, WORKING(), calls)
  await $.turn.start({ text: 'ask', turnId: 't1' })
  await $.command.run(OPEN_PANE)
  const r = await $.tool.call({ tool: 'mcp__plugin_voice-wayfinder_voice__voice_converse', text: 'ข้อต่อไปค่ะ' })
  expect(r.context ?? []).toEqual([])
  expect(calls.some(c => c.args.action === 'take')).toBe(false)
})

test('what the person says while Claude is idle starts a turn in their own words', async ($, on) => {
  const prompts: string[] = []
  const clock = mock.clock(on)
  bridge(on, WORKING(), [], true, [], prompts)
  await $.command.run(OPEN_PANE)
  await clock.settle()
  expect(prompts).toEqual(['🎙 ใน system context ไม่ได้บอกไว้เหรอ'])
})
