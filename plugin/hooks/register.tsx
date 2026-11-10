// The voice pane and the captions above the prompt: the question in progress
// (with its choices), what Claude is saying, what is being heard live, and the
// conversation so far. It reads the bridge through the bridge's own MCP tool and
// never approves tools or changes permissions.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { BridgeLink, RoundItem, TranscriptLine, VoiceActivity, VoiceControlAction, VoiceModels, VoiceStateUnchanged, VoiceStateV1 } from '../types'

const PANE = 'voice-pane'
const TITLE = 'Voice'
const SERVER_KEY = 'voice'
const MIN_CLAUDE_CODE = '2.1.287'
const POLL_MS = 300
const IDLE_POLLS = 10 // while voice is off, read the bridge every ~3 s
const RETRY_POLLS = 16 // about 5 s between tries while the bridge is unreachable

// Prompts a person typed (terminal, desktop app, Remote Control); never a
// notification, a scheduled task or another session's message.
const TYPED_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

// Change the tag when VoiceStateV1 changes shape: a stored older value reads as null.
const voice = atom({ plugin: 'voice-wayfinder', key: 'voice' } as const, null, { shape: 'voice-v2' })
const link = atom({ plugin: 'voice-wayfinder', key: 'link' } as const, { status: 'connecting' })
const tick = atom({ plugin: 'voice-wayfinder', key: 'tick' } as const, 0)
/** Whether Claude's main loop is working on a turn right now. */
const working = atom({ plugin: 'voice-wayfinder', key: 'working' } as const, false)

const TICK_MS = 400

// What the person said while Claude works waits this long after their last
// words before it starts a turn of its own, so one thought is one prompt.
const QUIET_MS = 1200

// Voice tools that take the person's words themselves (or are the pane's own
// calls): nothing is added to their results.
const OWN_TOOLS = /voice_(status|control|converse|interview|listen)$/

// One color per speaker, used for their name everywhere and for the status
// while they talk: Claude warm, the person cool, so either is found at a glance.
const CLAUDE = 'claude'
const YOU = 'suggestion'

const BARS = ['▁▃▅', '▃▅▇', '▅▇▅', '▇▅▃', '▅▃▁', '▃▁▃']

const ACTIVITY: Record<VoiceActivity, { label: string; color: string; frames: string[] }> = {
  off: { label: 'Voice off', color: 'subtle', frames: ['○'] },
  connecting: { label: 'Connecting…', color: 'subtle', frames: ['◜', '◝', '◞', '◟'] },
  // Connected to OpenAI but no voice call from Claude waiting: say what Claude is doing (see labelFor).
  idle: { label: 'Claude idle', color: 'subtle', frames: ['●'] },
  listening: { label: 'Listening', color: 'success', frames: ['●', '◉', '○', '◉'] },
  hearing: { label: 'Hearing you', color: YOU, frames: BARS },
  speaking: { label: 'Claude speaking', color: CLAUDE, frames: BARS },
  muted: { label: 'Mic muted', color: 'warning', frames: ['⊘'] },
  paused: { label: 'Paused', color: 'warning', frames: ['⏸', '⏸', '⏸', ' '] },
  error: { label: 'Voice error', color: 'error', frames: ['✕'] },
}

/**
 * The status label. With no voice call waiting, "Connected" would read as
 * "Claude hears me": say whether Claude is working (it hears you at its next
 * step) or idle (what you say starts its next turn) instead.
 */
function labelFor(activity: VoiceActivity, isWorking: boolean): string {
  if (activity === 'idle') return isWorking ? 'Claude working' : 'Claude idle'
  return ACTIVITY[activity].label
}

/** What happens to what you say now, under the status in the pane; none while a question waits. */
function hintFor(activity: VoiceActivity, isWorking: boolean): string | undefined {
  if (activity !== 'idle') return undefined
  return isWorking ? 'Not on a voice call: what you say reaches Claude at its next step.' : 'Not on a voice call: speak or type and Claude picks it up.'
}

const glyph = (activity: VoiceActivity, n: number) => {
  const frames = ACTIVITY[activity].frames
  return frames[n % frames.length]!
}

const LIVE = new Set<VoiceActivity>(['idle', 'listening', 'hearing', 'speaking', 'muted', 'paused'])

const WHO: Record<TranscriptLine['who'], string> = { user: 'You', claude: 'Claude', system: '·' }

// The module's own bookkeeping; a reload starts it over, the drawn state lives in $.state.
let server: string | undefined
let busy = false
let lastRev: number | undefined
let lastLink = ''
let waitPolls = 0
let isLive = false
let autoOpened = false
let lastStatus: string | undefined
let taking = false
// Main-loop turns in flight; a reload starts empty, and a prompt submitted then waits for idle anyway.
const turns = new Set<string>()

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

/** A refusal from auto mode reads as an instruction, not a stack of jargon. */
function explain(message: string): string {
  if (/auto mode|classifier|permission/i.test(message)) {
    return "Claude Code's permission check blocked the pane from reading the voice bridge. Run npm run setup in the plugin's folder (or see README: Allow the voice tools), then start a new session."
  }
  return message
}

async function poll($: EngineInterface, force = false) {
  if (busy) return
  if (!force && waitPolls > 0) {
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
    if (result.isError) throw new Error(result.content.find(b => b.type === 'text')?.text ?? 'voice_status failed')
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
    if ('unchanged' in state) {
      if (!isLive) waitPolls = IDLE_POLLS
      return
    }
    lastRev = state.rev
    isLive = LIVE.has(state.activity) || state.activity === 'connecting'
    if (!isLive) waitPolls = IDLE_POLLS
    await update($, voice, () => state)
    showStatus($, state)
    if (hasWaiting(state)) void deliverIdle($)
    if (!autoOpened && isLive) {
      autoOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
  } catch (err) {
    server = undefined
    lastRev = undefined
    waitPolls = RETRY_POLLS
    await setLink($, { status: 'unreachable', message: explain(err instanceof Error ? err.message : String(err)) })
  } finally {
    busy = false
  }
}

async function control($: EngineInterface, action: VoiceControlAction, question?: number) {
  const name = await connect($)
  if (!name) return
  await $.mcp.call(name, 'voice_control', question === undefined ? { action } : { action, question })
  await poll($, true)
}

const ROUND_GLYPH: Record<RoundItem['status'] | 'current', string> = { current: '▶', answered: '✓', skipped: '⤼', pending: '○' }

/** One question's button label: its status, number, the question cut short, and the answer taken. */
function roundLabel(item: RoundItem, n: number, isCurrent: boolean): string {
  const q = item.question.length > 38 ? `${item.question.slice(0, 37)}…` : item.question
  const a = item.answer ? ` → ${item.answer.length > 24 ? `${item.answer.slice(0, 23)}…` : item.answer}` : ''
  return `${ROUND_GLYPH[isCurrent ? 'current' : item.status]} ${n}. ${q}${a}`
}

/** Claude started or finished a turn: the status says whether it is working. */
async function setWorking($: EngineInterface) {
  const now = turns.size > 0
  if ((await read($, working)) === now) return
  await update($, working, () => now)
  const s = await read($, voice)
  if (s) showStatus($, s)
}

/** The line under the prompt: voice state and cost now, or what the last session cost. */
function showStatus($: EngineInterface, s: VoiceStateV1) {
  let text: string | undefined
  if (LIVE.has(s.activity)) text = `${ACTIVITY[s.activity].frames[0]} ${labelFor(s.activity, turns.size > 0)} · est. ${usd(s.estimatedCostUsd)}`
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
  if (accepted) await poll($, true)
  return accepted
}

/**
 * Takes what the person said while no question waited; empty when nothing is
 * finished and waiting, or another take is in flight.
 */
type Revisit = { number: number; question: string; answer: string }

type Waiting = { heard: string[]; pausedMs?: number; revisit?: Revisit }

const NOTHING: Waiting = { heard: [] }

async function takeHeard($: EngineInterface): Promise<Waiting> {
  if (taking) return NOTHING
  taking = true
  try {
    const name = await connect($)
    if (!name) return NOTHING
    const result = await $.mcp.call(name, 'voice_control', { action: 'take' })
    const s = result.structuredContent as { heard?: unknown; pausedMs?: unknown; revisit?: Revisit } | undefined
    if (result.isError || !s || !Array.isArray(s.heard)) return NOTHING
    const heard = s.heard.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    const pausedMs = typeof s.pausedMs === 'number' ? s.pausedMs : undefined
    const revisit = s.revisit && typeof s.revisit.number === 'number' ? s.revisit : undefined
    if (heard.length || pausedMs !== undefined || revisit) await poll($, true)
    return { heard, ...(pausedMs !== undefined ? { pausedMs } : {}), ...(revisit ? { revisit } : {}) }
  } catch {
    return NOTHING
  } finally {
    taking = false
  }
}

const hasAny = (w: Waiting) => w.heard.length > 0 || w.pausedMs !== undefined || w.revisit !== undefined

function minutesSaid(ms: number): string {
  return ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`
}

/** Something the person said is finished and waiting, with no question to take it. */
function hasWaiting(s: VoiceStateV1 | null): s is VoiceStateV1 {
  if (s === null || !LIVE.has(s.activity) || s.activity === 'paused') return false
  if (s.recapDueAfterMs !== undefined || s.revisitDue !== undefined) return true
  return s.activity !== 'hearing' && !s.awaitingReply && !s.partial && s.queuedUtterances > 0
}

/** The words the model reads after a tool's result while it works. */
function spokenNote(w: Waiting): string {
  const notes: string[] = []
  if (w.pausedMs !== undefined) {
    notes.push(
      `The person paused voice for ${minutesSaid(w.pausedMs)} (someone came to talk to them) and just resumed. ` +
        'Give them a short spoken recap now with voice_say, one or two sentences: where things stand and what you are doing.',
    )
  }
  if (w.revisit) {
    const v = w.revisit
    notes.push(
      `The person clicked question ${v.number} of the last round in the voice pane to revisit it ("${v.question}"${v.answer ? `; they had answered: ${v.answer}` : '; not answered'}). ` +
        'Read their answer back by voice, ask whether they want to keep or change it (voice_converse), and update your notes and the tracker if it changes.',
    )
  }
  if (w.heard.length) {
    notes.push(
      `The person just said by voice, while you were working: "${w.heard.join(' ')}". ` +
        'Answer them now by voice (voice_say, or voice_converse when you need their reply) before you carry on, ' +
        'and take it into account: it may change what you are doing.',
    )
  }
  return notes.join(' ')
}

/** What starts a turn when Claude is idle: the person's words, as theirs. */
function idlePrompt(w: Waiting): string {
  const recap = w.pausedMs !== undefined ? `(กลับมาแล้ว หลัง pause ไป ${minutesSaid(w.pausedMs)}) ช่วยสรุปสั้นๆ ว่าเราถึงไหนแล้ว` : ''
  const revisit = w.revisit
    ? `ขอกลับไปทบทวนข้อ ${w.revisit.number} "${w.revisit.question}"${w.revisit.answer ? ` (เดิมตอบว่า ${w.revisit.answer})` : ''} อ่านคำตอบเดิมให้ฟังแล้วถามว่าจะเปลี่ยนไหม`
    : ''
  return `🎙 ${[recap, revisit, w.heard.join(' ')].filter(Boolean).join(' ')}`
}

/** With Claude idle, what the person said starts a turn, as their own words. */
async function deliverIdle($: EngineInterface) {
  if (turns.size > 0 || taking) return
  const s = await read($, voice)
  if (!hasWaiting(s)) return
  const last = s.transcript.findLast(line => line.who === 'user')
  const quietFor = last ? (await $.clock.now()) - last.at : Infinity
  if (s.recapDueAfterMs === undefined && quietFor < QUIET_MS) {
    // They may go on talking. Look again once the quiet window has passed,
    // as nothing else may change in the state to bring us back here.
    $.clock.after(QUIET_MS - quietFor + 50, () => void deliverIdle($))
    return
  }
  const waiting = await takeHeard($)
  if (!hasAny(waiting)) return
  void $.prompt.submit({ text: idlePrompt(waiting), asUser: true })
}

function openPane($: EngineInterface) {
  autoOpened = true
  void $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'voice-pane', description: 'Show the live voice conversation pane' })
    const { version } = await $.session.version()
    if (isOlder(version, MIN_CLAUDE_CODE)) {
      $.ui.toast(`voice-wayfinder needs Claude Code ${MIN_CLAUDE_CODE} or later (this is ${version}). Run: claude update`)
    }
    $.clock.every(POLL_MS, () => void poll($))
    // Moves the status animation; idle while voice is off, so nothing redraws then.
    $.clock.every(TICK_MS, () => {
      if (isLive) void update($, tick, n => (n + 1) % 1200)
    })
    return next(e)
  })

  // Speaking while Claude works (writing code, running a build) reaches it at
  // its next tool call, beside that tool's result, instead of waiting for the
  // next voice question; the bridge hands each utterance over once.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || r.deny !== undefined || OWN_TOOLS.test(e.tool)) return r
    if (!hasWaiting(await read($, voice))) return r
    const waiting = await takeHeard($)
    if (!hasAny(waiting)) return r
    return { ...r, context: [...(r.context ?? []), spokenNote(waiting)] }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turns.add(e.turnId)
      await setWorking($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (turns.delete(e.turnId)) {
      await setWorking($)
      void deliverIdle($)
    }
    return r
  })

  // Typing while Claude asks or waits by voice answers that question at once,
  // instead of waiting in the queue until the voice tool returns.
  on('prompt.submit', async ($, e, next) => {
    // Voice mode asked for by the person: turn the bridge back on after an End,
    // and open the pane (from their own command it is placed at any width).
    if (e.command && (e.command.name === 'voice-mode' || e.command.name.endsWith(':voice-mode'))) {
      await control($, 'start')
      openPane($)
    }
    // Opening the pane mid-question: open it here, so no prompt enters the queue
    // and cuts the voice call short.
    if (e.command && (e.command.name === 'voice-pane' || e.command.name.endsWith(':voice-pane'))) {
      const s = await read($, voice)
      if (s && LIVE.has(s.activity)) {
        await poll($, true)
        await $.ui.open({ id: PANE, title: TITLE })
        return { drop: 'Voice pane opened.' }
      }
    }
    if (e.command || e.isMeta || e.attachments?.length || !TYPED_ORIGINS.has(e.origin.kind) || !e.text.trim()) return next(e)
    const s = await read($, voice)
    if (!s || !LIVE.has(s.activity)) return next(e)
    if (!(await deliverTyped($, e.text))) return next(e)
    return { drop: `Sent to the voice conversation as your answer: ${e.text}` }
  })

  on('command.run', { command: 'voice-pane' }, async $ => {
    await poll($, true)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Voice pane opened.' }
  })

  // Captions above the prompt, always in view: the question being asked and the
  // words being heard, so the person can follow without listening closely.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, voice)
    if (e.props.hasSurvey || !s || !LIVE.has(s.activity)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const n = await read($, tick)
    const a = ACTIVITY[s.activity]
    const label = labelFor(s.activity, await read($, working))
    const asking = s.transcript.findLast(line => line.who === 'claude')
    const answer = s.transcript.findLast(line => line.who === 'user' && (!asking || line.id > asking.id))
    const inQuestion = s.activity === 'speaking' || s.awaitingReply
    const round = s.card?.question !== undefined ? ` · Q${s.card.question}/${s.card.of}` : ''
    return (
      <Box key="voice-band" flexDirection="column">
        <Text>
          <Text bold color={a.color}>
            {glyph(s.activity, n)} {label}
          </Text>
          <Text dimColor>{round}</Text>
        </Text>
        {asking && (
          <Text>
            <Text bold color={CLAUDE}>
              Claude
            </Text>{' '}
            {asking.text}
          </Text>
        )}
        {s.partial ? (
          <Text>
            <Text bold color={YOU}>
              You
            </Text>{' '}
            {s.partial}…
          </Text>
        ) : answer ? (
          <Text>
            <Text bold color={YOU}>
              You{answer.typed ? ' ⌨' : ''}
            </Text>{' '}
            {answer.text}
          </Text>
        ) : (
          ''
        )}
        {s.activity === 'paused' ? (
          <Text dimColor>Paused: Claude waits and the mic is off. Press ▶ Resume in the voice pane (/voice-pane).</Text>
        ) : (
          inQuestion && <Text dimColor>Speak, or type here and press Enter (a choice number works).</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    // Graphical surfaces draw the status as an animated icon; the terminal keeps its glyphs.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const s = await read($, voice)
    const l = await read($, link)
    const n = await read($, tick)
    const live = s !== null && LIVE.has(s.activity)
    const activity = s?.activity ?? 'off'
    const a = ACTIVITY[activity]
    const isWorking = await read($, working)
    const label = labelFor(activity, isWorking)
    const hint = live ? hintFor(activity, isWorking) : undefined
    const asking = s?.transcript.findLast(line => line.who === 'claude')
    const answer = s?.transcript.findLast(line => line.who === 'user' && (!asking || line.id > asking.id))
    const inQuestion = s !== null && (s.activity === 'speaking' || s.awaitingReply)
    const card = s?.card
    const models = s?.models
    const heading = (text: string, hint?: string) => (
      <Text size="footnote" weight="semibold" dimColor>
        {text}
        {hint ? <Text weight="regular"> · {hint}</Text> : ''}
      </Text>
    )

    return (
      <Box flexDirection="column" gap="md">
        <Box key="head" flexDirection="column" gap="xs">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Box flexDirection="row" alignItems="center" gap="sm">
              {Svg && <Svg key={`status-${activity}`} source={statusIcon(activity)} alt={label} width={24} height={18} />}
              <Text size="heading" weight="semibold" color={a.color}>
                {Svg ? '' : `${glyph(activity, n)} `}
                {label}
              </Text>
            </Box>
            {s?.sessionStartedAt !== undefined && (
              <Text size="footnote" dimColor tabular>
                since {clock(s.sessionStartedAt)} · est. {usd(s.estimatedCostUsd)}
              </Text>
            )}
          </Box>
          {hint && (
            <Text key="call-hint" size="caption" dimColor>
              {hint}
            </Text>
          )}
          {models &&
            (Svg ? (
              <Box key="models" flexDirection="row" flexWrap="wrap" gap="xs">
                {modelChips(models).map(([role, name]) => (
                  <Box key={`model-${role}`} borderStyle="round" borderDimColor paddingX={1}>
                    <Text size="caption">
                      <Text dimColor>{role} </Text>
                      <Text mono>{name}</Text>
                    </Text>
                  </Box>
                ))}
              </Box>
            ) : (
              <Text dimColor>{modelChips(models).map(([role, name]) => `${role} ${name}`).join(' · ')}</Text>
            ))}
          {l.status !== 'ok' && l.status !== 'connecting' && <Text color="warning">{l.message ?? 'The voice bridge is not reachable.'}</Text>}
          {s?.error && <Text color="error">{s.error}</Text>}
          {s?.warning && <Text color="warning">{s.warning}</Text>}
          {!live && s?.activity !== 'connecting' && (
            <Text dimColor>
              {s?.stopped ? 'Voice ended. Claude carries on in text; ' : ''}Start with /voice-wayfinder:voice-mode{s?.stopped ? ' to talk again.' : ', then /wayfinder.'}
            </Text>
          )}
        </Box>

        {live && (card?.screen || asking) && (
          <Box key="card" flexDirection="column" gap="xs" borderStyle="round" borderColor={CLAUDE} paddingX={1} paddingY={Svg ? 'xs' : 0}>
            {card?.question !== undefined && (
              <Text size="caption" weight="semibold" color={CLAUDE}>
                Question {card.question} of {card.of}
              </Text>
            )}
            {card?.screen ? <Markdown key="screen" text={card.screen} /> : <Text weight="semibold">{asking?.text}</Text>}
          </Box>
        )}

        {live && (
          <Box key="live" flexDirection="column" gap="xs">
            {card?.screen && asking && (
              <Text dimColor={s.activity !== 'speaking'}>
                <Text bold color={CLAUDE}>
                  Claude
                </Text>{' '}
                {asking.text}
              </Text>
            )}
            {s.partial ? (
              <Text>
                <Text bold color={YOU}>
                  You
                </Text>{' '}
                {s.partial}…
              </Text>
            ) : answer ? (
              <Text>
                <Text bold color={YOU}>
                  You{answer.typed ? ' ⌨' : ''}
                </Text>{' '}
                {answer.text}
              </Text>
            ) : (
              ''
            )}
            {s.activity === 'paused' ? (
              <Text size="caption" dimColor>
                Paused: the mic is off and Claude waits. Resume picks up where it stopped.
              </Text>
            ) : (
              inQuestion && (
                <Text size="caption" dimColor>
                  Speak, or type in the chat box (a choice number works).
                </Text>
              )
            )}
          </Box>
        )}

        {live && (
          <Box key="controls" flexDirection="row" flexWrap="wrap" gap="xs">
            <Button
              key="pause"
              variant={s.activity === 'paused' ? 'primary' : 'secondary'}
              onPress={() => void control($, s.activity === 'paused' ? 'resume' : 'pause')}
            >
              {s.activity === 'paused' ? '▶ Resume' : '⏸ Pause'}
            </Button>
            <Button key="mute" variant={s.muted ? 'primary' : 'secondary'} onPress={() => void control($, s.muted ? 'unmute' : 'mute')}>
              {s.muted ? '🎙 Unmute' : '🔇 Mute'}
            </Button>
            <Button key="skip" variant="secondary" onPress={() => void control($, 'skip')}>
              ⏭ Skip
            </Button>
            <Button key="end" variant="secondary" onPress={() => void control($, 'end')}>
              ⏹ End
            </Button>
          </Box>
        )}

        {live && s.round && (
          <Box key="round" flexDirection="column" gap="xs">
            {heading('Questions', s.round.active ? 'click one to go to it' : 'click one to go back to it')}
            {s.round.items.map((item, k) => {
              const current = s.round?.active === true && s.round.current === k
              return (
                <Button
                  key={`q-${k + 1}`}
                  {...(current ? { variant: 'primary' as const } : {})}
                  {...(item.status === 'answered' && !current ? { dimColor: true } : {})}
                  onPress={() => void control($, 'goto', k + 1)}
                >
                  {roundLabel(item, k + 1, current)}
                </Button>
              )
            })}
            {s.revisitDue !== undefined && (
              <Text size="caption" dimColor>
                Question {s.revisitDue} goes to Claude to revisit next.
              </Text>
            )}
          </Box>
        )}

        {s && s.transcript.length > 0 && (
          <Box key="conversation" flexDirection="column" gap="xs">
            <Text size="footnote" weight="semibold" dimColor>
              Conversation
            </Text>
            {s.transcript
              .slice(-16)
              .reverse()
              .map(line => (
                <Text dimColor={line.who === 'system'} {...(line.who === 'system' ? { size: 'caption' as const } : {})}>
                  <Text bold={line.who !== 'system'} color={line.who === 'claude' ? CLAUDE : line.who === 'user' ? YOU : undefined}>
                    {WHO[line.who]}
                    {line.typed ? ' ⌨' : ''}
                  </Text>{' '}
                  {line.text}
                  {line.interrupted ? <Text dimColor> (interrupted)</Text> : ''}
                  {line.unclear ? <Text dimColor> (not clear, asked again)</Text> : ''}
                </Text>
              ))}
          </Box>
        )}

        {(s?.lastSession && s.sessionStartedAt === undefined) || s?.todayCostUsd !== undefined ? (
          <Box key="costs" flexDirection="column">
            {s?.sessionStartedAt === undefined && s?.lastSession && (
              <Text size="caption" dimColor>
                Last session: {minutes(s.lastSession.durationMs)} · est. {usd(s.lastSession.costUsd)} (speech {usd(s.lastSession.speechUsd)} ·
                transcription {usd(s.lastSession.transcriptionUsd)})
              </Text>
            )}
            {s?.todayCostUsd !== undefined && (
              <Text size="caption" dimColor>
                OpenAI est. today {usd(s.todayCostUsd)} · this month {usd(s.monthCostUsd ?? 0)}
              </Text>
            )}
          </Box>
        ) : (
          ''
        )}
      </Box>
    )
  })
}

/** The pane's model chips: what each model does, then its name. */
function modelChips(m: VoiceModels): [string, string][] {
  return [['Speaks', `${m.speech} · ${m.voice}`], ['Hears', m.transcription], ...(m.understanding ? [['Understands', m.understanding] as [string, string]] : [])]
}

// The status icon on graphical surfaces: SVG with SMIL animation, so it moves
// without redrawing the pane. Fixed colors, readable on light and dark.
const HEX = { claude: '#D97757', you: '#4C8DF6', listen: '#2EA56B', warn: '#D9A21B', muted: '#8A8F98', error: '#E5484D' }

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18" viewBox="0 0 24 18">${body}</svg>`
}

function bars(color: string): string {
  return svg(
    [0, 1, 2, 3, 4]
      .map(i => {
        const begin = `-${(i * 0.17).toFixed(2)}s`
        return `<rect x="${i * 5}" y="5" width="3" height="8" rx="1.5" fill="${color}"><animate attributeName="height" values="4;16;7;12;4" dur="1.1s" begin="${begin}" repeatCount="indefinite"/><animate attributeName="y" values="7;1;5.5;3;7" dur="1.1s" begin="${begin}" repeatCount="indefinite"/></rect>`
      })
      .join(''),
  )
}

function statusIcon(activity: VoiceActivity): string {
  switch (activity) {
    case 'speaking':
      return bars(HEX.claude)
    case 'hearing':
      return bars(HEX.you)
    case 'listening':
      return svg(
        `<circle cx="12" cy="9" r="4" fill="${HEX.listen}"/><circle cx="12" cy="9" r="4" fill="none" stroke="${HEX.listen}" stroke-width="1.5"><animate attributeName="r" values="4;8.5" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0" dur="1.4s" repeatCount="indefinite"/></circle>`,
      )
    case 'connecting':
      return svg(
        `<circle cx="12" cy="9" r="6" fill="none" stroke="${HEX.muted}" stroke-width="2" stroke-linecap="round" stroke-dasharray="22 16"><animateTransform attributeName="transform" type="rotate" from="0 12 9" to="360 12 9" dur="0.9s" repeatCount="indefinite"/></circle>`,
      )
    case 'idle':
      return svg(`<circle cx="12" cy="9" r="4" fill="${HEX.listen}" opacity="0.55"/>`)
    case 'muted':
      return svg(
        `<rect x="9" y="2" width="6" height="10" rx="3" fill="none" stroke="${HEX.warn}" stroke-width="1.6"/><path d="M6.5 9.5a5.5 5.5 0 0 0 11 0M12 15v2" fill="none" stroke="${HEX.warn}" stroke-width="1.6" stroke-linecap="round"/><path d="M5 2l14 14" stroke="${HEX.warn}" stroke-width="1.8" stroke-linecap="round"/>`,
      )
    case 'paused':
      return svg(`<rect x="7" y="3" width="3.5" height="12" rx="1.2" fill="${HEX.warn}"/><rect x="13.5" y="3" width="3.5" height="12" rx="1.2" fill="${HEX.warn}"/>`)
    case 'error':
      return svg(`<circle cx="12" cy="9" r="7" fill="${HEX.error}"/><path d="M9 6l6 6M15 6l-6 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`)
    case 'off':
      return svg(`<circle cx="12" cy="9" r="5" fill="none" stroke="${HEX.muted}" stroke-width="1.6"/>`)
  }
}

function parseState(result: McpToolResult): VoiceStateV1 | VoiceStateUnchanged | undefined {
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
