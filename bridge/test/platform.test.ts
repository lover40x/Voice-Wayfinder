import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { helperPath } from '../src/audio.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = join(REPO, 'plugin', 'scripts')

// The launcher scripts are plain .mjs (no build step); load them untyped.
const load = (file: string): Promise<any> => import(join(SCRIPTS, file) as string)

test('the audio helper is vw-audio on macOS and vw-audio.exe on Windows, in the bridge and the build script alike', async () => {
  const build = await load('build-audio.mjs')
  for (const platform of ['darwin', 'win32'] as const) {
    assert.equal(helperPath('/p', platform), build.helperPath('/p', platform))
  }
  assert.match(helperPath('/p', 'darwin'), /native[/\\]vw-audio[/\\]vw-audio$/)
  assert.match(helperPath('/p', 'win32'), /native[/\\]vw-audio[/\\]vw-audio\.exe$/)
})

test('only the named secret is taken from bws secret list', async () => {
  const { pickSecret } = await load('token-store.mjs')
  const listed = JSON.stringify([
    { key: 'OTHER', value: 'nope' },
    { key: 'OPENAI_REALTIME_API_KEY', value: 'sk-test' },
  ])
  assert.deepEqual(pickSecret(listed, 'OPENAI_REALTIME_API_KEY'), { value: 'sk-test' })
  assert.match(pickSecret(listed, 'MISSING').problem, /no secret named MISSING/)
  assert.match(pickSecret('not json', 'X').problem, /not JSON/)
})

test('a Windows credential blob decodes whether it was stored as UTF-16 or UTF-8', async () => {
  const { decodeCredentialBlob } = await load('token-store.mjs')
  const token = '0.abc-123.def:XYZ=='
  assert.equal(decodeCredentialBlob(Buffer.from(token, 'utf16le').toString('base64')), token)
  assert.equal(decodeCredentialBlob(Buffer.from(token, 'utf8').toString('base64')), token)
})

test('the launcher runs the bridge in its own process and keeps stdout for MCP only', { timeout: 60_000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'vw-launch-'))
  const child = spawn(process.execPath, [join(SCRIPTS, 'start-bridge.mjs')], {
    // A key in the environment skips the token store, so this never touches the Keychain.
    env: { ...process.env, OPENAI_REALTIME_API_KEY: 'sk-test-not-real', CLAUDE_PLUGIN_DATA: data, VOICE_WAYFINDER_CONFIG: join(data, 'none.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    let out = ''
    const reply = new Promise<string>((done, fail) => {
      child.stdout.on('data', d => {
        out += d.toString()
        if (out.includes('\n')) done(out)
      })
      child.on('exit', code => fail(new Error(`launcher exited (${code}) before answering`)))
    })
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n',
    )
    const first = (await reply).split('\n')[0]!
    const msg = JSON.parse(first)
    assert.equal(msg.id, 1)
    assert.equal(msg.result.serverInfo.name, 'voice-wayfinder')
  } finally {
    child.kill()
    rmSync(data, { recursive: true, force: true })
  }
})
