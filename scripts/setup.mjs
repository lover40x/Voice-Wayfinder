#!/usr/bin/env node
// One-command setup for voice-wayfinder on this Mac or Windows PC.
//
//   npm run setup                 check, build, store the Bitwarden token, install, allow the voice tools
//   npm run setup -- --check      only report what is set up and what is missing; change nothing
//   npm run setup -- --yes        answer yes to every question
//   npm run setup -- --new-token  replace the stored Bitwarden token (a new or rotated one)
//
// Safe to run again: each step looks first and only does what is missing.
// It never prints the Bitwarden token or the OpenAI key.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { helperPath, toolchain } from '../plugin/scripts/build-audio.mjs'
import { apiKeyEnv, findBws, hasToken, IS_WINDOWS, loadSecret, readToken, storeTokenWindows, TOKEN_SERVICE, TOKEN_STORE } from '../plugin/scripts/token-store.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ROOT = join(ROOT, 'plugin')
const CHECK_ONLY = process.argv.includes('--check')
const YES = process.argv.includes('--yes')
const NEW_TOKEN = process.argv.includes('--new-token')

const PLUGIN = 'voice-wayfinder@voice-wayfinder-dev'
const RULE = 'mcp__plugin_voice-wayfinder_voice'
const MIN_NODE = '22.18.0'
const MIN_CLAUDE = '2.1.287'
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const RESTORE_TOKEN = IS_WINDOWS ? 'npm run setup -- --new-token' : `security add-generic-password -U -s ${TOKEN_SERVICE} -a "$USER" -w`

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

/** Quotes one argument for cmd.exe (Windows runs claude and npm through it: they may be .cmd files). */
const winQuote = a => (/^[\w@.:\/\\=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`)

function run(cmd, args, opts = {}) {
  const viaShell = IS_WINDOWS && !/\.exe$/i.test(cmd)
  const r = viaShell
    ? spawnSync([cmd, ...args].map(winQuote).join(' '), { shell: true, encoding: 'utf8', windowsHide: true, ...opts })
    : spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
  return { code: r.error ? -1 : (r.status ?? 0), out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/** npm through the npm that started this script, so no shell lookup is needed. */
function npm(args, opts = {}) {
  const cli = process.env.npm_execpath
  if (cli && /\.[cm]?js$/.test(cli)) return run(process.execPath, [cli, ...args], opts)
  return run('npm', args, opts)
}

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

/** Reads a line without echoing it (for the token on Windows; macOS uses `security`'s own prompt). */
function askHidden(question) {
  return new Promise(done => {
    const stdin = process.stdin
    if (!stdin.isTTY) return done('')
    process.stdout.write(question)
    let value = ''
    const finish = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      done(value.trim())
    }
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  })
}

console.log(`voice-wayfinder setup${CHECK_ONLY ? ' (check only: nothing will be changed)' : ''}`)

// 1 -----------------------------------------------------------------------------
say.step(1, IS_WINDOWS ? 'This PC' : 'This Mac')
if (platform() === 'darwin') say.ok('macOS')
else if (IS_WINDOWS) say.ok('Windows')
else {
  say.todo(`${platform()} is not supported: voice-wayfinder runs on macOS and Windows (its audio helper uses each one's echo cancellation).`)
  process.exit(1)
}
const nodeVersion = process.versions.node
if (atLeast(nodeVersion, MIN_NODE)) say.ok(`Node ${nodeVersion}`)
else say.todo(`Node ${nodeVersion} is older than ${MIN_NODE}`, 'install a newer Node, e.g. from https://nodejs.org')
const claude = run('claude', ['--version'])
const claudeVersion = /(\d+\.\d+\.\d+)/.exec(claude.out)?.[1]
if (!claudeVersion) say.todo('Claude Code CLI not found', 'install it: https://claude.com/claude-code')
else if (atLeast(claudeVersion, MIN_CLAUDE)) say.ok(`Claude Code ${claudeVersion}`)
else say.todo(`Claude Code ${claudeVersion} is older than ${MIN_CLAUDE}`, 'run: claude update')
const tools = toolchain()
if (tools.ok) say.ok(tools.name)
else say.todo(`${tools.name} not found`, tools.fix)
if (findBws()) say.ok('Bitwarden Secrets Manager CLI (bws)')
else say.todo('bws not found', `install it: https://bitwarden.com/help/secrets-manager-cli/${IS_WINDOWS ? ' (put bws.exe in a folder on PATH)' : ''}`)
if (todo.length && !CHECK_ONLY) {
  console.log('\nFix the items above, then run npm run setup again.')
  process.exit(1)
}

// 2 -----------------------------------------------------------------------------
say.step(2, 'Build')
const built = existsSync(join(PLUGIN_ROOT, 'server', 'bridge.mjs')) && existsSync(helperPath(PLUGIN_ROOT))
if (CHECK_ONLY) {
  if (built) say.ok('bridge and audio helper are built')
  else say.todo('not built yet', 'run: npm run setup')
} else {
  if (!existsSync(join(ROOT, 'node_modules'))) {
    say.info('installing dependencies (npm install)…')
    if (npm(['install', '--no-fund', '--no-audit'], { cwd: ROOT, stdio: 'inherit' }).code !== 0) {
      say.todo('npm install failed')
      process.exit(1)
    }
  }
  say.info('building the bridge and the audio helper…')
  if (npm(['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }).code !== 0) {
    say.todo('build failed', 'run npm run build to see why')
    process.exit(1)
  }
  say.ok('built')
}

// 3 -----------------------------------------------------------------------------
say.step(3, `Bitwarden access token (${TOKEN_STORE})`)
let stored = hasToken() && !NEW_TOKEN
if (stored) say.ok(`token stored in the ${TOKEN_STORE} (${IS_WINDOWS ? 'target' : 'service'} "${TOKEN_SERVICE}")`)
else if (CHECK_ONLY) say.todo(`no token in the ${TOKEN_STORE}`, 'run: npm run setup')
else if (IS_WINDOWS) {
  say.info('Paste the access token of your Bitwarden machine account when asked (twice). It is not shown as you paste.')
  const first = await askHidden('   token: ')
  const again = first ? await askHidden('   again: ') : ''
  if (!first) say.todo('no token entered')
  else if (first !== again) say.todo('the two tokens differ; nothing was stored', 'run npm run setup again')
  else {
    const r = storeTokenWindows(first)
    stored = r.ok
    if (stored) say.ok(`token stored in Windows Credential Manager (target "${TOKEN_SERVICE}")`)
    else say.todo(`the token was not stored: ${r.error}`)
  }
} else {
  say.info('Paste the access token of your Bitwarden machine account when asked (twice). It is not shown as you paste.')
  const args = ['add-generic-password', ...(NEW_TOKEN ? ['-U'] : []), '-s', TOKEN_SERVICE, '-a', userInfo().username, '-w']
  stored = run('/usr/bin/security', args, { stdio: 'inherit' }).code === 0
  if (stored) say.ok('token stored')
  else say.todo('the token was not stored')
}
if (stored && findBws()) {
  const envName = apiKeyEnv(PLUGIN_ROOT)
  const read = readToken()
  const fetched = read.token ? loadSecret({ token: read.token, name: envName }) : read
  if (fetched.value) say.ok(`Bitwarden hands over ${envName}`)
  else if (fetched.refused) say.todo(fetched.problem, `check the token, or store a new one: ${RESTORE_TOKEN}`)
  else if (read.problem) say.todo(read.problem)
  else say.todo(fetched.problem, `name the secret ${envName} in Bitwarden, and give the machine account read access to its project`)
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
if (IS_WINDOWS) console.log('If Claude cannot hear you, turn on Settings > Privacy & security > Microphone > "Let desktop apps access your microphone".')
else console.log('macOS asks for microphone access the first time: allow it.')
