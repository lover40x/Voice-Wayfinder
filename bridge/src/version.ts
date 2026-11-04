import { execFile } from 'node:child_process'

export const MIN_CLAUDE_CODE = '2.1.287'

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

/** Resolves a warning when the installed Claude Code is older than the plugin needs. */
export function checkClaudeCodeVersion(): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
      const found = /(\d+\.\d+\.\d+)/.exec(stdout ?? '')?.[1]
      if (err || !found) return resolve(undefined)
      resolve(
        compareVersions(found, MIN_CLAUDE_CODE) < 0
          ? `Claude Code ${found} is older than ${MIN_CLAUDE_CODE}, which voice-wayfinder needs for its voice pane. Run: claude update`
          : undefined,
      )
    })
  })
}
