// PTY-backed one-shot command runner. Some CLIs misbehave without a TTY —
// Antigravity's `agy -p` hangs in non-TTY contexts (agy#318) and silently
// drops stdout when piped (agy#76) — so their headless invocations run under
// a real pseudo-terminal (node-pty, same native module as the session tiles)
// instead of runHelp's execFile pipe. Same contract as runHelp: login-shell
// wrap, profile-noise marker, resolves the trimmed output past the marker.
//
// Electron-main only (node-pty is a native module rebuilt for Electron):
// graph-engine / utility-inference take this as an INJECTED dep and stay
// bun-testable without it.

import { randomBytes } from 'node:crypto'
import * as pty from 'node-pty'
import { buildShellInvocation } from './shell-command'
import { stripAnsi } from './quota'

export function runPtyCommand(opts: {
  command: string
  shell: string
  cwd: string
  timeoutMs: number
}): Promise<string> {
  const marker = `__CP_PTY_START_${randomBytes(6).toString('hex')}__`
  const inv = buildShellInvocation({
    command: `echo '${marker}'; ${opts.command}`,
    shell: opts.shell,
    interactive: false
  })
  return new Promise((resolve, reject) => {
    let out = ''
    let settled = false
    const proc = pty.spawn(inv.file, inv.args, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: opts.cwd,
      env: process.env as Record<string, string>
    })
    const finish = (err: Error | null, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value ?? '')
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already dead — the timeout rejection below still fires
      }
      finish(new Error('pty command timeout'))
    }, opts.timeoutMs)
    proc.onData((data) => {
      out += data
      // 8 MB cap, like runHelp's maxBuffer: a runaway TUI redraw must not
      // grow the buffer unbounded.
      if (out.length > 8 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024)
    })
    proc.onExit(({ exitCode }) => {
      // PTY output: CRLF line ends + ANSI control sequences — normalize both.
      const clean = stripAnsi(out).replace(/\r\n?/g, '\n')
      const idx = clean.indexOf(marker)
      const text = (idx === -1 ? clean : clean.slice(idx + marker.length)).trim()
      if (exitCode !== 0) {
        finish(new Error(text.slice(-500) || `pty command exited ${exitCode}`))
      } else {
        finish(null, text)
      }
    })
  })
}
