// The Voice Wayfinder map pane. It only displays: it reads the bridge's state
// through the bridge's own MCP tool and never approves tools or changes permissions.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { BridgeLink, MapTicket, TranscriptLine, VoiceActivity, VoiceControlAction, VoiceStateUnchanged, VoiceStateV1 } from '../types'

const PANE = 'voice-map'
const TITLE = 'Voice Wayfinder'
const SERVER_KEY = 'voice'
const MIN_CLAUDE_CODE = '2.1.287'
const POLL_MS = 600
const RETRY_POLLS = 8 // about 5 s between tries while the bridge is unreachable

// Prompts a person typed (terminal, desktop app, Remote Control); never a
// notification, a scheduled task or another session's message.
const TYPED_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

// Change the tag when VoiceStateV1 changes shape: a stored older value reads as null.
const voice = atom({ plugin: 'voice-wayfinder', key: 'voice' } as const, null, { shape: 'voice-v1' })
const link = atom({ plugin: 'voice-wayfinder', key: 'link' } as const, { status: 'connecting' })

const ACTIVITY: Record<VoiceActivity, { label: string; color?: string }> = {
  off: { label: '○ Voice off', color: 'subtle' },
  connecting: { label: '◌ Connecting…', color: 'subtle' },
  idle: { label: '● Connected', color: 'subtle' },
  listening: { label: '● Listening', color: 'success' },
  hearing: { label: '◉ Hearing you', color: 'success' },
  speaking: { label: '◉ Speaking', color: 'claude' },
  muted: { label: '⊘ Mic muted', color: 'warning' },
  error: { label: '✕ Voice error', color: 'error' },
}

const WHO: Record<TranscriptLine['who'], string> = { user: 'You', claude: 'Claude', system: '·' }

// The module's own bookkeeping; a reload starts it over, the drawn state lives in $.state.
let server: string | undefined
let busy = false
let lastRev: number | undefined
let lastLink = ''
let waitPolls = 0
let autoOpened = false

async function setLink($: EngineInterface, next: BridgeLink) {
  const key = `${next.status}:${next.message ?? ''}`
  if (key === lastLink) return
  lastLink = key
  await update($, link, () => next)
}

async function connect($: EngineInterface): Promise<string | undefined> {
  if (server) return server
  const c = await $.mcp.connect(SERVER_KEY)
  if (!c.isConnected) {
    await setLink($, { status: 'unreachable', message: c.message })
    return undefined
  }
  server = c.server
  return server
}

async function poll($: EngineInterface) {
  if (busy) return
  if (waitPolls > 0) {
    waitPolls--
    return
  }
  busy = true
  try {
    const name = await connect($)
    if (!name) {
      waitPolls = RETRY_POLLS
      return
    }
    const result = await $.mcp.call(name, 'voice_status', { detail: 'full', ...(lastRev === undefined ? {} : { sinceRev: lastRev }) })
    const state = parseState(result)
    if (!state) {
      await setLink($, { status: 'unreachable', message: 'The voice bridge answered without a state.' })
      waitPolls = RETRY_POLLS
      return
    }
    if (state.v !== 1) {
      await setLink($, { status: 'mismatch', message: `The voice bridge speaks protocol v${String(state.v)}; this pane reads v1. Update the plugin.` })
      waitPolls = RETRY_POLLS
      return
    }
    await setLink($, { status: 'ok' })
    if ('unchanged' in state) return
    lastRev = state.rev
    await update($, voice, () => state)
    showStatus($, state)
    if (!autoOpened && state.activity !== 'off' && state.activity !== 'error') {
      autoOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
  } catch (err) {
    server = undefined
    lastRev = undefined
    waitPolls = RETRY_POLLS
    await setLink($, { status: 'unreachable', message: err instanceof Error ? err.message : String(err) })
  } finally {
    busy = false
  }
}

async function control($: EngineInterface, action: VoiceControlAction) {
  const name = await connect($)
  if (!name) return
  await $.mcp.call(name, 'voice_control', { action })
  await poll($)
}

const LIVE = new Set<VoiceActivity>(['idle', 'listening', 'hearing', 'speaking', 'muted'])
let lastStatus: string | undefined

/** The line under the prompt: voice state and cost now, or what the last session cost. */
function showStatus($: EngineInterface, s: VoiceStateV1) {
  let text: string | undefined
  if (LIVE.has(s.activity)) text = `${ACTIVITY[s.activity].label} · est. ${usd(s.estimatedCostUsd)}`
  else if (s.lastSession) text = `Voice off · last session ${usd(s.lastSession.costUsd)} · today ${usd(s.todayCostUsd ?? s.lastSession.costUsd)}`
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** Hands typed text to the bridge as the answer; false when no question is in progress. */
async function deliverTyped($: EngineInterface, text: string): Promise<boolean> {
  const name = await connect($)
  if (!name) return false
  const result = await $.mcp.call(name, 'voice_control', { action: 'type', text })
  const s = result.structuredContent
  const accepted = !result.isError && typeof s === 'object' && s !== null && (s as { accepted?: unknown }).accepted === true
  if (accepted) await poll($)
  return accepted
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'voice-map', description: 'Show the Voice Wayfinder map pane' })
    const { version } = await $.session.version()
    if (isOlder(version, MIN_CLAUDE_CODE)) {
      $.ui.toast(`voice-wayfinder needs Claude Code ${MIN_CLAUDE_CODE} or later (this is ${version}). Run: claude update`)
    }
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  // Typing while Claude asks or waits by voice answers that question at once,
  // instead of waiting in the queue until the voice tool returns.
  on('prompt.submit', async ($, e, next) => {
    // Opened from the person's own command, the pane is placed at any width.
    if (e.command && (e.command.name === 'voice-mode' || e.command.name.endsWith(':voice-mode'))) {
      autoOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
    if (e.command || e.isMeta || e.attachments?.length || !TYPED_ORIGINS.has(e.origin.kind) || !e.text.trim()) return next(e)
    const s = await read($, voice)
    if (!s || s.activity === 'off' || s.activity === 'error') return next(e)
    if (!(await deliverTyped($, e.text))) return next(e)
    return { drop: `Sent to the voice conversation as your answer: ${e.text}` }
  })

  on('command.run', { command: 'voice-map' }, async $ => {
    waitPolls = 0
    await poll($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Voice Wayfinder map pane opened.' }
  })

  // Captions above the prompt, where they are always in view (a pane may not be
  // placed in a narrow window): what Claude is saying and what is being heard.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, voice)
    if (e.props.hasSurvey || !s || !LIVE.has(s.activity)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const a = ACTIVITY[s.activity]
    const asking = s.transcript.findLast(line => line.who === 'claude')
    const answer = s.transcript.findLast(line => line.who === 'user' && (!asking || line.id > asking.id))
    const inQuestion = s.activity === 'speaking' || s.awaitingReply
    return (
      <Box key="voice-band" flexDirection="column">
        <Text>
          <Text bold color={a.color}>
            {a.label}
          </Text>
          {asking ? (
            <Text bold color="claude">
              {' '}
              {asking.text}
            </Text>
          ) : (
            ''
          )}
        </Text>
        {s.partial ? (
          <Text>You: {s.partial}…</Text>
        ) : answer ? (
          <Text dimColor>
            You{answer.typed ? ' ⌨' : ''}: {answer.text}
          </Text>
        ) : (
          ''
        )}
        {inQuestion && <Text dimColor>Type here and press Enter to answer in text.</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, voice)
    const l = await read($, link)
    const live = s !== null && s.activity !== 'off' && s.activity !== 'error' && s.activity !== 'connecting'
    const a = ACTIVITY[s?.activity ?? 'off']
    const asking = s?.transcript.findLast(line => line.who === 'claude')
    const inQuestion = s !== null && (s.activity === 'speaking' || s.awaitingReply)

    const ticketRow = (t: MapTicket, mark: string, dim: boolean) => (
      <Text dimColor={dim} wrap="truncate-end">
        {mark} {t.title}
        {t.type ? <Text dimColor> [{t.type}]</Text> : ''}
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={a.color}>
            {a.label}
          </Text>
          {s?.sessionStartedAt !== undefined && (
            <Text dimColor>
              since {clock(s.sessionStartedAt)} · est. {usd(s.estimatedCostUsd)} · {s.model}
            </Text>
          )}
          {s?.sessionStartedAt === undefined && s?.lastSession && (
            <Text dimColor>
              Last session: {minutes(s.lastSession.durationMs)} · est. {usd(s.lastSession.costUsd)} (speech {usd(s.lastSession.speechUsd)} ·
              transcription {usd(s.lastSession.transcriptionUsd)})
            </Text>
          )}
          {s?.todayCostUsd !== undefined && (
            <Text dimColor>
              OpenAI est. today {usd(s.todayCostUsd)} · this month {usd(s.monthCostUsd ?? 0)}
            </Text>
          )}
          {l.status !== 'ok' && l.status !== 'connecting' && <Text color="warning">{l.message ?? 'The voice bridge is not reachable.'}</Text>}
          {s?.error && <Text color="error">{s.error}</Text>}
          {s?.warning && <Text color="warning">{s.warning}</Text>}
          {!live && s?.activity !== 'connecting' && <Text dimColor>Ask Claude for voice mode to start talking.</Text>}
        </Box>

        {live && asking && (
          <Box key="now" flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold color="claude">
              {asking.text}
            </Text>
            {s.partial && <Text>You: {s.partial}…</Text>}
            {inQuestion && <Text dimColor>Type in the chat box to answer instead.</Text>}
          </Box>
        )}

        {live && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="mute" onPress={() => void control($, s.muted ? 'unmute' : 'mute')}>
              {s.muted ? 'Unmute mic' : 'Mute mic'}
            </Button>
            <Button key="skip" onPress={() => void control($, 'skip')}>
              Skip question
            </Button>
            <Button key="end" onPress={() => void control($, 'end')}>
              End voice
            </Button>
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>{s?.map?.mapTitle ?? 'Map'}</Text>
          {!s?.map && <Text dimColor>No map yet. Claude fills this in while Wayfinder runs.</Text>}
          {s?.map?.current && (
            <Text wrap="truncate-end">
              ▶ <Text bold>{s.map.current.title}</Text>
              {s.map.current.type ? <Text color="claude"> [{s.map.current.type}]</Text> : ''}
            </Text>
          )}
        </Box>

        {s?.map && s.map.decided.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Decided ({s.map.decided.length})</Text>
            {s.map.decided.map(t => ticketRow(t, '✓', true))}
          </Box>
        )}

        {s?.map && s.map.blocked.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Blocked ({s.map.blocked.length})</Text>
            {s.map.blocked.map(t => ticketRow(t, '⧗', false))}
          </Box>
        )}

        {s?.map && s.map.fog.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Fog</Text>
            {s.map.fog.map(f => (
              <Text dimColor>· {f}</Text>
            ))}
          </Box>
        )}

        {s && s.transcript.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Transcript</Text>
            {s.transcript.slice(-12).map(line => (
              <Text dimColor={line.who === 'system'}>
                <Text bold={line.who !== 'system'} color={line.who === 'claude' ? 'claude' : undefined}>
                  {WHO[line.who]}
                  {line.typed ? ' ⌨' : ''}
                </Text>{' '}
                {line.text}
                {line.interrupted ? <Text dimColor> (interrupted)</Text> : ''}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

function parseState(result: McpToolResult): VoiceStateV1 | VoiceStateUnchanged | undefined {
  if (result.isError) return undefined
  const structured = result.structuredContent
  if (structured && typeof structured === 'object' && 'v' in structured) return structured as VoiceStateV1
  const text = result.content.find(b => b.type === 'text')?.text
  if (!text) return undefined
  try {
    return JSON.parse(text) as VoiceStateV1
  } catch {
    return undefined
  }
}

function isOlder(version: string, min: string): boolean {
  const a = version.split('.').map(n => parseInt(n, 10))
  const b = min.split('.').map(n => parseInt(n, 10))
  for (let i = 0; i < b.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d < 0
  }
  return false
}

function usd(n: number): string {
  return n > 0 && n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`
}

function minutes(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${(ms / 60_000).toFixed(1)} min`
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
