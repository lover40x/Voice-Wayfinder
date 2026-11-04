import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { VoiceStateV1 } from '../types'

const OPEN_MAP = {
  command: 'voice-map',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const PANE = {
  plugin: 'voice-wayfinder',
  component: 'Pane',
  requestId: 'voice-map',
  props: {
    title: 'Voice Wayfinder',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

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
    { id: 1, at: 0, who: 'claude', text: 'จะใช้ GitHub Issues ไหมคะ' },
    { id: 2, at: 0, who: 'user', text: 'ใช้ครับ' },
  ],
  map: {
    mapTitle: 'Billing rewrite',
    current: { title: 'Pick the payment provider', type: 'grilling' },
    decided: [{ title: 'Keep invoices in Postgres' }],
    blocked: [{ title: 'Design the refund flow', type: 'prototype' }],
    fog: ['Tax rules per country'],
    updatedAt: 0,
  },
}

type Call = { tool: string; args: Record<string, unknown> }

/** Stands for the engine and the bridge's MCP server beneath the mod. */
function bridge(on: On, state: VoiceStateV1, calls: Call[], acceptsTyped = true, opened: string[] = []) {
  on('command.register', () => ({ value: { command: 'voice-map' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:voice-wayfinder:voice' } }))
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const body = e.tool === 'voice_status' ? state : e.args.action === 'type' ? { message: 'typed', accepted: acceptsTyped } : { ok: true }
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false, structuredContent: body } }
  })
  // The engine beneath: a prompt that reaches it enters the session.
  on('prompt.submit', (_, e) => ({ text: e.text }))
}

const typedPrompt = (text: string) => ({ text, wait: false, origin: { kind: 'sdk' } }) as const

test('typing during a voice question answers it instead of queueing in the chat', async ($, on) => {
  const calls: Call[] = []
  bridge(on, STATE, calls)
  await $.command.run(OPEN_MAP)
  const r = await $.prompt.submit(typedPrompt('ใช้ Stripe'))
  expect(r.drop).toContain('ใช้ Stripe')
  expect(calls.find(c => c.args.action === 'type')?.args).toEqual({ action: 'type', text: 'ใช้ Stripe' })
})

test('typing when the bridge has no question in progress goes to the chat', async ($, on) => {
  const calls: Call[] = []
  bridge(on, STATE, calls, false)
  await $.command.run(OPEN_MAP)
  const r = await $.prompt.submit(typedPrompt('อีกเรื่องนึง'))
  expect(r.drop).toBeUndefined()
  expect(r.text).toBe('อีกเรื่องนึง')
})

test('with voice off, prompts pass straight through without asking the bridge', async ($, on) => {
  const calls: Call[] = []
  bridge(on, { ...STATE, activity: 'off', awaitingReply: false }, calls)
  await $.command.run(OPEN_MAP)
  const r = await $.prompt.submit(typedPrompt('สวัสดี'))
  expect(r.text).toBe('สวัสดี')
  expect(calls.some(c => c.args.action === 'type')).toBe(false)
})

test('slash commands are never taken as an answer', async ($, on) => {
  const calls: Call[] = []
  bridge(on, STATE, calls)
  await $.command.run(OPEN_MAP)
  await $.prompt.submit({ ...typedPrompt('/voice-map'), command: { name: 'voice-map', args: '' } })
  expect(calls.some(c => c.args.action === 'type')).toBe(false)
})

test('after a session ends the pane shows what it cost, today and this month', async ($, on) => {
  const calls: Call[] = []
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
  bridge(on, ended, calls)
  await $.command.run(OPEN_MAP)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Last session/ }))?.text).toContain('4.2 min · est. $0.31 (speech $0.27')
  expect((await ui.find({ type: 'Text', text: /today/ }))?.text).toBe('OpenAI est. today $0.42 · this month $3.10')
  await ui.unmount()
})

const BAND = {
  plugin: 'voice-wayfinder',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 60, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band above the prompt captions the question and the live words on ${surface}`, async ($, on) => {
    const calls: Call[] = []
    bridge(on, { ...STATE, partial: 'คิดว่า' }, calls)
    await $.command.run(OPEN_MAP)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Listening/ }))?.text).toContain('จะใช้ GitHub Issues ไหมคะ')
    expect((await ui.find({ type: 'Text', text: /คิดว่า/ }))?.text).toBe('You: คิดว่า…')
    expect(await ui.find({ type: 'Text', text: /Type here/ })).toBeDefined()
    await ui.unmount()
  })
}

test('the band stays out of the way while voice is off', async ($, on) => {
  const calls: Call[] = []
  bridge(on, { ...STATE, activity: 'off', awaitingReply: false }, calls)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.command.run(OPEN_MAP)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
  await ui.unmount()
})

test('starting voice mode opens the map pane as the person asked', async ($, on) => {
  const opened: string[] = []
  bridge(on, STATE, [], true, opened)
  await $.prompt.submit({ ...typedPrompt('/voice-wayfinder:voice-mode'), command: { name: 'voice-wayfinder:voice-mode', args: '' } })
  expect(opened).toContain('voice-map')
})

test('the caption shows what Claude is asking and the words being heard', async ($, on) => {
  const calls: Call[] = []
  bridge(on, { ...STATE, partial: 'น่าจะใช้' }, calls)
  await $.command.run(OPEN_MAP)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^จะใช้ GitHub Issues ไหมคะ$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /น่าจะใช้/ }))?.text).toContain('You: น่าจะใช้')
  expect(await ui.find({ type: 'Text', text: /Type in the chat box/ })).toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows voice status, the map and the transcript on ${surface}`, async ($, on) => {
    const calls: Call[] = []
    bridge(on, STATE, calls)
    await $.command.run(OPEN_MAP)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Listening/ }))?.text).toContain('Listening')
    expect(await ui.find({ type: 'Text', text: /Pick the payment provider/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Keep invoices in Postgres/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Design the refund flow/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Tax rules per country/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ใช้ครับ/ })).toBeDefined()
    expect(calls[0]).toEqual({ tool: 'voice_status', args: { detail: 'full' } })
    await ui.unmount()
  })

  test(`the buttons send controls to the bridge on ${surface}`, async ($, on) => {
    const calls: Call[] = []
    bridge(on, STATE, calls)
    await $.command.run(OPEN_MAP)

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mute' })
    await ui.press({ key: 'skip' })
    await ui.press({ key: 'end' })
    const controls = calls.filter(c => c.tool === 'voice_control').map(c => c.args.action)
    expect(controls).toEqual(['mute', 'skip', 'end'])
    await ui.unmount()
  })
}

test('an unreachable bridge is said in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'voice-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'failed', message: 'voice: server failed to start' } }))
  await $.command.run(OPEN_MAP)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /failed to start/ }))?.text).toContain('failed to start')
  expect(await ui.find({ key: 'mute' })).toBeUndefined()
  await ui.unmount()
})

test('a protocol the pane does not know is refused', async ($, on) => {
  const calls: Call[] = []
  bridge(on, { ...STATE, v: 2 } as unknown as VoiceStateV1, calls)
  await $.command.run(OPEN_MAP)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /protocol v2/ }))?.text).toContain('Update the plugin')
  await ui.unmount()
})
