#!/usr/bin/env node
// Starts the voice bridge MCP server, on macOS and on Windows. plugin.json runs
// it with `node` on both.
//
// The OpenAI key is never stored on disk. The Bitwarden access token comes from
// the macOS Keychain or Windows Credential Manager, `bws` hands over the one
// secret the bridge needs, and the bridge then runs inside this same process:
// the key lives only in its memory (the bridge drops it from its environment
// at once). Without a token the bridge still starts, so its tools can tell
// Claude (and you) what is missing instead of the server silently failing.
//
// stdout is the MCP channel: nothing here may write to it.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { helperPath } from './build-audio.mjs'
import { apiKeyEnv, loadSecret, readToken } from './token-store.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const warn = text => process.stderr.write(`voice-wayfinder: ${text}\n`)

if (!existsSync(helperPath(ROOT))) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-audio.mjs')], { stdio: ['ignore', 2, 2], windowsHide: true })
  if (r.status !== 0) warn('audio helper build failed; run npm run build in the plugin folder')
}

// A key already in the environment wins (CI, or a one-off test).
const envName = apiKeyEnv(ROOT)
if (!process.env[envName]) {
  const stored = readToken()
  const fetched = stored.token ? loadSecret({ token: stored.token, name: envName }) : stored
  if (fetched.value) process.env[envName] = fetched.value
  else process.env.VOICE_WAYFINDER_SECRET_PROBLEM = fetched.problem
}

await import(pathToFileURL(join(ROOT, 'server', 'bridge.mjs')).href)
