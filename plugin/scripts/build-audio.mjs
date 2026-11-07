#!/usr/bin/env node
// Builds the native audio helper for this computer.
//
//   macOS:   native/vw-audio/main.swift -> native/vw-audio/vw-audio      (Xcode command line tools)
//   Windows: native/vw-audio/main.cpp   -> native/vw-audio/vw-audio.exe  (Visual Studio Build Tools, C++)
//
// Progress goes to stderr only: start-bridge.mjs runs this while stdout is the MCP channel.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(PLUGIN_ROOT, 'native', 'vw-audio')

/** Where the helper for this OS lives (the bridge has the same rule in bridge/src/audio.ts). */
export function helperPath(pluginRoot = PLUGIN_ROOT, platform = process.platform) {
  return join(pluginRoot, 'native', 'vw-audio', platform === 'win32' ? 'vw-audio.exe' : 'vw-audio')
}

/** The Visual Studio install that has the C++ tools, via vswhere (installed with every VS 2017+). */
export function findMsvc() {
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return undefined
  const arm = process.arch === 'arm64'
  const tries = arm ? [['arm64', 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'], ['x64', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64']] : [['x64', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64']]
  for (const [target, component] of tries) {
    const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', component, '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true })
    const install = (r.stdout ?? '').trim().split(/\r?\n/)[0]
    if (!install) continue
    const vcvarsall = join(install, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
    if (!existsSync(vcvarsall)) continue
    // vcvarsall takes host_target; an x64 host building for arm64 and the reverse both work.
    const hostArch = arm ? 'arm64' : 'x64'
    return { vcvarsall, arch: hostArch === target ? target : `${hostArch}_${target}`, install }
  }
  return undefined
}

/** What this computer would build with, or why it can't. */
export function toolchain() {
  if (process.platform === 'darwin') {
    const ok = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0
    return ok ? { ok: true, name: 'Swift compiler (Xcode command line tools)' } : { ok: false, name: 'Swift compiler', fix: 'run: xcode-select --install' }
  }
  if (process.platform === 'win32') {
    const msvc = findMsvc()
    return msvc
      ? { ok: true, name: `MSVC C++ compiler (${msvc.install})` }
      : {
          ok: false,
          name: 'MSVC C++ compiler',
          fix: 'install Visual Studio 2022 Build Tools with "Desktop development with C++": winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
        }
  }
  return { ok: false, name: `a supported OS (this is ${process.platform})`, fix: 'voice-wayfinder runs on macOS and Windows' }
}

/** Quotes one argument for cmd.exe inside a /s /c "..." line. */
const q = s => `"${s}"`

export function build() {
  const out = helperPath()
  if (process.platform === 'darwin') {
    const r = spawnSync('xcrun', ['swiftc', '-O', '-swift-version', '5', join(SRC_DIR, 'main.swift'), '-o', out], { stdio: ['ignore', 2, 2] })
    if (r.status !== 0) return false
  } else if (process.platform === 'win32') {
    const msvc = findMsvc()
    if (!msvc) {
      process.stderr.write(`no MSVC C++ compiler found. ${toolchain().fix}\n`)
      return false
    }
    // Objects go to a temp folder, so a failed build leaves nothing behind in the plugin.
    const work = mkdtempSync(join(tmpdir(), 'vw-audio-'))
    try {
      const cl = [
        'cl /nologo /O2 /EHsc /W3 /std:c++17 /utf-8 /DUNICODE /D_UNICODE',
        q(join(SRC_DIR, 'main.cpp')),
        `/Fe${q(out)}`,
        '/link /SUBSYSTEM:CONSOLE',
      ].join(' ')
      const line = `call ${q(msvc.vcvarsall)} ${msvc.arch} >nul && ${cl}`
      const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', q(line)], {
        cwd: work,
        stdio: ['ignore', 2, 2],
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
      if (r.status !== 0) return false
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  } else {
    process.stderr.write(`voice-wayfinder: no audio helper for ${process.platform} (macOS and Windows only)\n`)
    return false
  }
  process.stderr.write(`built ${out}\n`)
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(build() ? 0 : 1)
}
