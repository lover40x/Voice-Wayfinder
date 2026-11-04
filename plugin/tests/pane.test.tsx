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
function bridge(on: On, state: VoiceStateV1, calls: Call[]) {
  on('command.register', () => ({ value: { command: 'voice-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:voice-wayfinder:voice' } }))
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const body = e.tool === 'voice_status' ? state : { ok: true }
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false, structuredContent: body } }
  })
}

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
