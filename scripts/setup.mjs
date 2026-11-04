#!/usr/bin/env node
// One-command setup for voice-wayfinder on this Mac.
//
//   npm run setup           check, build, store the Bitwarden token, install, allow the voice tools
//   npm run setup -- --check  only report what is set up and what is missing; change nothing
//   npm run setup -- --yes    answer yes to every question
//
// Safe to run again: each step looks first and only does what is missing.
// It never prints the Bitwarden token or the OpenAI key.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')
const YES = process.argv.includes('--yes')

const KEYCHAIN_SERVICE = 'voice-wayfinder-bws'
const PLUGIN = 'voice-wayfinder@voice-wayfinder-dev'
const RULE = 'mcp__plugin_voice-wayfinder_voice'
const MIN_NODE = '22.18.0'
const MIN_CLAUDE = '2.1.287'
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const USER_CONFIG = process.env.VOICE_WAYFINDER_CONFIG ?? join(homedir(), '.config', 'voice-wayfinder', 'config.json')

const todo = []

const say = {
  step: (n, title) => console.log(`\n${n}. ${title}`),
  ok: text => console.log(`   ✓ ${text}`),
  info: text => console.log(`   · ${text}`),
  todo: (text, fix) => {
    console.log(`   ✗ ${text}`)
    if (fix) console.log(`     → ${fix}`)
    todo.push(text)
  },
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.error ? -1 : (r.status ?? 0), out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const has = cmd => run('/usr/bin/which', [cmd]).code === 0

function atLeast(found, min) {
  const a = found.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

async function ask(question) {
  if (YES) return true
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`   ? ${question} [Y/n] `)).trim().toLowerCase()
  rl.close()
  return answer === '' || answer === 'y' || answer === 'yes'
}

/** The env var the bridge reads the key from (a personal config may rename it). */
function apiKeyEnv() {
  try {
    const own = JSON.parse(readFileSync(USER_CONFIG, 'utf8'))
    if (typeof own?.openai?.apiKeyEnv === 'string') return own.openai.apiKeyEnv
  } catch {}
  return JSON.parse(readFileSync(join(ROOT, 'plugin', 'config', 'defaults.json'), 'utf8')).openai.apiKeyEnv
}

console.log(`voice-wayfinder setup${CHECK_ONLY ? ' (check only: nothing will be changed)' : ''}`)

// 1 -----------------------------------------------------------------------------
say.step(1, 'This Mac')
if (platform() !== 'darwin') {
  say.todo('macOS is required (the audio helper uses macOS voice processing).')
  process.exit(1)
}
say.ok('macOS')
const nodeVersion = process.versions.node
if (atLeast(nodeVersion, MIN_NODE)) say.ok(`Node ${nodeVersion}`)
else say.todo(`Node ${nodeVersion} is older than ${MIN_NODE}`, 'install a newer Node, e.g. from https://nodejs.org')
const claude = run('claude', ['--version'])
const claudeVersion = /(\d+\.\d+\.\d+)/.exec(claude.out)?.[1]
if (!claudeVersion) say.todo('Claude Code CLI not found', 'install it: https://claude.com/claude-code')
else if (atLeast(claudeVersion, MIN_CLAUDE)) say.ok(`Claude Code ${claudeVersion}`)
else say.todo(`Claude Code ${claudeVersion} is older than ${MIN_CLAUDE}`, 'run: claude update')
if (run('xcrun', ['--find', 'swiftc']).code === 0) say.ok('Swift compiler (Xcode command line tools)')
else say.todo('Swift compiler not found', 'run: xcode-select --install')
if (has('bws')) say.ok('Bitwarden Secrets Manager CLI (bws)')
else say.todo('bws not found', 'install it: https://bitwarden.com/help/secrets-manager-cli/')
if (todo.length && !CHECK_ONLY) {
  console.log('\nFix the items above, then run npm run setup again.')
  process.exit(1)
}

// 2 -----------------------------------------------------------------------------
say.step(2, 'Build')
const built = existsSync(join(ROOT, 'plugin', 'server', 'bridge.mjs')) && existsSync(join(ROOT, 'plugin', 'native', 'vw-audio', 'vw-audio'))
if (CHECK_ONLY) {
  if (built) say.ok('bridge and audio helper are built')
  else say.todo('not built yet', 'run: npm run setup')
} else {
  if (!existsSync(join(ROOT, 'node_modules'))) {
    say.info('installing dependencies (npm install)…')
    if (run('npm', ['install', '--no-fund', '--no-audit'], { cwd: ROOT, stdio: 'inherit' }).code !== 0) {
      say.todo('npm install failed')
      process.exit(1)
    }
  }
  say.info('building the bridge and the audio helper…')
  if (run('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }).code !== 0) {
    say.todo('build failed', 'run npm run build to see why')
    process.exit(1)
  }
  say.ok('built')
}

// 3 -----------------------------------------------------------------------------
say.step(3, 'Bitwarden access token (macOS Keychain)')
let hasToken = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE]).code === 0
if (hasToken) say.ok(`token stored in the Keychain (service "${KEYCHAIN_SERVICE}")`)
else if (CHECK_ONLY) say.todo('no token in the Keychain', 'run: npm run setup')
else {
  say.info('Paste the access token of your Bitwarden machine account when asked (twice). It is not shown as you paste.')
  hasToken = run('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', userInfo().username, '-w'], { stdio: 'inherit' }).code === 0
  if (hasToken) say.ok('token stored')
  else say.todo('the token was not stored')
}
if (hasToken && has('bws')) {
  const envName = apiKeyEnv()
  const token = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']).out
  const probe = run('bws', ['run', '--', `test -n "$${envName}" && echo loaded || echo missing`], { env: { ...process.env, BWS_ACCESS_TOKEN: token } })
  if (probe.out.endsWith('loaded')) say.ok(`Bitwarden hands over ${envName}`)
  else if (probe.code !== 0) say.todo('Bitwarden refused the token', 'check the token, or store a new one: security add-generic-password -U -s voice-wayfinder-bws -a "$USER" -w')
  else say.todo(`no secret named ${envName} reached the bridge`, `name the secret ${envName} in Bitwarden, and give the machine account read access to its project`)
}

// 4 -----------------------------------------------------------------------------
say.step(4, 'Claude Code plugin')
const listed = run('claude', ['plugin', 'list']).out
const block = listed.split(/\n\s*❯ /).find(b => b.startsWith(PLUGIN) || b.includes(`❯ ${PLUGIN}`))
const installed = block !== undefined && /enabled/.test(block) && !/disabled/.test(block)
if (installed) say.ok(`${PLUGIN} is installed and enabled`)
else if (CHECK_ONLY) say.todo('the plugin is not installed', 'run: npm run setup')
else {
  run('claude', ['plugin', 'marketplace', 'add', ROOT])
  const r = run('claude', ['plugin', 'install', PLUGIN])
  if (r.code === 0) say.ok(`installed ${PLUGIN} for your user (every project)`)
  else say.todo('plugin install failed', `${r.err || r.out}`.split('\n')[0])
}

// 5 -----------------------------------------------------------------------------
say.step(5, 'Permission for the voice tools')
let settings
try {
  settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {}
} catch {
  settings = undefined
}
if (!settings) {
  say.todo(`${SETTINGS} is not valid JSON, so it was left alone`, `add "${RULE}" to permissions.allow by hand`)
} else if (settings.permissions?.allow?.includes(RULE)) {
  say.ok(`"${RULE}" is allowed in ~/.claude/settings.json`)
} else if (CHECK_ONLY) {
  say.todo(`"${RULE}" is not allowed yet`, 'run: npm run setup')
} else {
  say.info('Without it, auto mode blocks the pane buttons and typed answers, and every voice turn waits on a permission check.')
  if (await ask(`Add "${RULE}" to permissions.allow in ~/.claude/settings.json?`)) {
    if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.bak-voice-wayfinder`)
    settings.permissions ??= {}
    settings.permissions.allow ??= []
    settings.permissions.allow.push(RULE)
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
    say.ok(`added (your previous file is saved as settings.json.bak-voice-wayfinder)`)
  } else {
    say.todo(`"${RULE}" not added`, 'the voice pane buttons and typed answers may be blocked in auto mode')
  }
}

// -------------------------------------------------------------------------------
console.log('')
if (todo.length) {
  console.log(`${todo.length} thing(s) left to do (see ✗ above).`)
  process.exit(CHECK_ONLY ? 0 : 1)
}
console.log('All set. Start a new Claude Code session in the repo you plan in, then type:')
console.log('   /voice-wayfinder:voice-mode')
console.log('   /wayfinder <your idea, or the map issue URL>')
console.log('macOS asks for microphone access the first time: allow it.')
