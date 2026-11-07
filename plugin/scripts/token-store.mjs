// Where the Bitwarden access token lives on this computer, and how the OpenAI
// key is fetched with it. Shared by start-bridge.mjs and scripts/setup.mjs.
//
// macOS: the login Keychain, generic password, service "voice-wayfinder-bws".
// Windows: Credential Manager, generic credential, target "voice-wayfinder-bws".
//
// Nothing here writes the token or the key to disk, to stdout, or to a log.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const TOKEN_SERVICE = process.env.VOICE_WAYFINDER_KEYCHAIN_SERVICE || 'voice-wayfinder-bws'
export const IS_WINDOWS = process.platform === 'win32'
export const TOKEN_STORE = IS_WINDOWS ? 'Windows Credential Manager' : 'macOS Keychain'

/** Folders worth searching besides PATH: the bridge may be started with a short PATH. */
function extraBinDirs() {
  const home = homedir()
  if (IS_WINDOWS) {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(home, '.cargo', 'bin'), join(home, '.local', 'bin'), join(home, 'bin'), join(local, 'Programs', 'bws'), join(local, 'Microsoft', 'WinGet', 'Links')]
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.cargo', 'bin')]
}

/**
 * Full path of a program on PATH (or in the usual install folders), or undefined.
 * On Windows `exts` defaults to PATHEXT; pass ['.exe'] for something to spawn without a shell.
 */
export function findExecutable(name, exts) {
  const dirs = [...(process.env.PATH ?? process.env.Path ?? '').split(delimiter), ...extraBinDirs()].filter(Boolean)
  const suffixes = IS_WINDOWS ? (exts ?? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)) : ['']
  for (const dir of dirs) {
    for (const ext of suffixes) {
      const file = join(dir, name + ext)
      try {
        if (statSync(file).isFile()) return file
      } catch {}
    }
  }
  return undefined
}

export function findBws() {
  const own = process.env.VOICE_WAYFINDER_BWS
  if (own && existsSync(own)) return own
  return findExecutable('bws', IS_WINDOWS ? ['.exe'] : undefined)
}

/** The env var name the bridge reads the key from (a personal config may rename it). */
export function apiKeyEnv(pluginRoot) {
  const userConfig = process.env.VOICE_WAYFINDER_CONFIG ?? join(homedir(), '.config', 'voice-wayfinder', 'config.json')
  try {
    const own = JSON.parse(readFileSync(userConfig, 'utf8'))
    if (typeof own?.openai?.apiKeyEnv === 'string') return own.openai.apiKeyEnv
  } catch {}
  return JSON.parse(readFileSync(join(pluginRoot, 'config', 'defaults.json'), 'utf8')).openai.apiKeyEnv
}

// ---- Windows Credential Manager -------------------------------------------------
//
// Windows has no built-in command that prints a stored password, so a short
// PowerShell script calls CredReadW / CredWriteW in advapi32 directly. The
// target name and mode go in through environment variables, the token through
// stdin (never the command line), and a read comes back as base64 on stdout.

const CRED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace VoiceWayfinder -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags;
  public int Type;
  public string TargetName;
  public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize;
  public IntPtr CredentialBlob;
  public int Persist;
  public int AttributeCount;
  public IntPtr Attributes;
  public string TargetAlias;
  public string UserName;
}
[DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
[DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr buffer);
'@
$target = $env:VW_CRED_TARGET
if ($env:VW_CRED_MODE -eq 'write') {
  $token = [Console]::In.ReadToEnd().Trim()
  if (-not $token) { exit 4 }
  $c = New-Object -TypeName 'VoiceWayfinder.Cred+CREDENTIAL'
  $c.Type = 1          # CRED_TYPE_GENERIC
  $c.Persist = 2       # CRED_PERSIST_LOCAL_MACHINE: this user, this computer
  $c.TargetName = $target
  $c.UserName = $env:USERNAME
  $c.CredentialBlobSize = $token.Length * 2
  $c.CredentialBlob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($token)
  try {
    if (-not [VoiceWayfinder.Cred]::CredWrite([ref]$c, 0)) {
      [Console]::Error.Write('CredWrite failed, error ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
      exit 5
    }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($c.CredentialBlob)
  }
  exit 0
}
$p = [IntPtr]::Zero
if (-not [VoiceWayfinder.Cred]::CredRead($target, 1, 0, [ref]$p)) { exit 3 }
try {
  if ($env:VW_CRED_MODE -eq 'read') {
    $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type]'VoiceWayfinder.Cred+CREDENTIAL')
    $bytes = New-Object byte[] $c.CredentialBlobSize
    if ($c.CredentialBlobSize -gt 0) { [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize) }
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  }
} finally {
  [VoiceWayfinder.Cred]::CredFree($p)
}
exit 0
`

function powershell() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const builtIn = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(builtIn) ? builtIn : 'powershell.exe'
}

/** Runs CRED_SCRIPT; returns { code, out, err }. code 3 means "no such credential". */
export function credentialManager(mode, target, input) {
  const encoded = Buffer.from(CRED_SCRIPT, 'utf16le').toString('base64')
  const r = spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, VW_CRED_MODE: mode, VW_CRED_TARGET: target },
    input: input ?? '',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  return { code: r.error ? -1 : (r.status ?? -1), out: (r.stdout ?? '').trim(), err: String(r.error?.message ?? r.stderr ?? '').trim() }
}

/** A blob from CredWriteW, cmdkey or the Control Panel is UTF-16; one written by other tools may be UTF-8. */
export function decodeCredentialBlob(base64) {
  const bytes = Buffer.from(base64, 'base64')
  const utf16 = bytes.length >= 2 && bytes.length % 2 === 0 && bytes[1] === 0
  return (utf16 ? bytes.toString('utf16le') : bytes.toString('utf8')).replace(/\0+$/, '').trim()
}

// ---- both systems -------------------------------------------------------------

/** { token } or { problem } saying why there is none. */
export function readToken(service = TOKEN_SERVICE) {
  if (IS_WINDOWS) {
    const r = credentialManager('read', service)
    const token = r.code === 0 && r.out ? decodeCredentialBlob(r.out) : ''
    if (token) return { token }
    if (r.code === 0 || r.code === 3) return { problem: `no bws access token in Windows Credential Manager (target "${service}")` }
    return { problem: `could not read Windows Credential Manager: ${firstLine(r.err) || `exit ${r.code}`}` }
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8' })
    const token = (r.stdout ?? '').trim()
    if (r.status === 0 && token) return { token }
    return { problem: `no bws access token in the macOS Keychain (service "${service}")` }
  }
  return { problem: `no token store on ${process.platform}; put the key in the environment instead` }
}

export function hasToken(service = TOKEN_SERVICE) {
  if (IS_WINDOWS) return credentialManager('exists', service).code === 0
  return spawnSync('/usr/bin/security', ['find-generic-password', '-s', service]).status === 0
}

/** Windows only: stores the token in Credential Manager (macOS setup uses the `security` prompt). */
export function storeTokenWindows(token, service = TOKEN_SERVICE) {
  const r = credentialManager('write', service, token)
  return r.code === 0 ? { ok: true } : { ok: false, error: firstLine(r.err) || `exit ${r.code}` }
}

/**
 * Fetches one secret by name with `bws secret list`, matching names the way
 * `bws run` maps secrets to env vars, but hands back only that one value. The
 * token reaches bws through bws's own environment only.
 */
export function loadSecret({ token, name, projectId = process.env.VOICE_WAYFINDER_BWS_PROJECT_ID, bws = findBws() }) {
  if (!bws) return { problem: 'the Bitwarden Secrets Manager CLI (bws) was not found' }
  const r = spawnSync(bws, ['secret', 'list', ...(projectId ? [projectId] : []), '--output', 'json'], {
    env: { ...process.env, BWS_ACCESS_TOKEN: token },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) {
    return { problem: `Bitwarden refused the access token or could not be reached (${firstLine(r.error?.message ?? r.stderr) || `exit ${r.status}`})`, refused: true }
  }
  return pickSecret(r.stdout, name)
}

/** Picks one secret's value out of `bws secret list --output json`. */
export function pickSecret(json, name) {
  let secrets
  try {
    secrets = JSON.parse(json)
  } catch {
    return { problem: 'bws printed something that is not JSON' }
  }
  const hit = Array.isArray(secrets) ? secrets.find(s => s?.key === name && typeof s.value === 'string') : undefined
  if (!hit) return { problem: `no secret named ${name} that this machine account can read` }
  return { value: hit.value }
}

/** The first line that says something (bws prints "Error:" alone, then "   0: <reason>"). */
function firstLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map(l => l.trim().replace(/^\d+:\s*/, ''))
    .filter(l => l && l !== 'Error:')
  return lines[0] ?? ''
}
