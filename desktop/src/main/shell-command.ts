// Pure shell-invocation builder, kept free of node-pty so it is unit-testable under bun without the native addon.
//
// Default = a *login, non-interactive* shell (Unix `-l -c`, Windows
// `-NoProfile`). The login shell sets PATH; we deliberately avoid the
// interactive shell (`-i` / a loaded profile) because rc files (oh-my-zsh, NVM,
// conda, pyenv, PowerShell profile banners) spew noise into the PTY (DESIGN §7).
//
// Interactive mode is opt-in for users whose launch command is a shell alias
// that only resolves with rc loaded. To hide the rc noise we prepend a unique
// *start marker* and PtyManager strips everything up to and including it.

import { randomBytes } from 'node:crypto'
import { platform } from 'node:os'

export const JOB_PREAMBLE_PS =
  "Add-Type -ErrorAction Stop -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class KoryJob { [DllImport(\"kernel32.dll\", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, IntPtr n); [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, byte[] i, uint l); [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p); [DllImport(\"kernel32.dll\")] static extern IntPtr GetCurrentProcess(); public static IntPtr Handle; public static bool Enter() { Handle = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero); byte[] info = new byte[144]; BitConverter.GetBytes((uint)0x2000).CopyTo(info, 16); return Handle != IntPtr.Zero && SetInformationJobObject(Handle, 9, info, 144) && AssignProcessToJobObject(Handle, GetCurrentProcess()); } }'\n" +
  "if (-not [KoryJob]::Enter()) { throw 'job setup returned false' }\n" +
  '$global:KoryJobOk = $true'

export interface SpawnOpts {
  /** Full command line to run (already includes --session-id etc.). */
  command: string
  /** Shell override; empty => OS default ($SHELL / bash on Unix, powershell on Windows). */
  shell: string
  /** Load the interactive shell / profile (alias resolution) with marker stripping. */
  interactive: boolean
  killTreeOnClose?: boolean
}

export interface ShellInvocation {
  file: string
  args: string[]
  /** Start marker to strip from PTY output, or null when not interactive. */
  marker: string | null
}

function makeMarker(): string {
  return `__CLAUDE_PEERS_START_${randomBytes(6).toString('hex')}__`
}

export function buildShellInvocation(
  opts: SpawnOpts,
  plat: NodeJS.Platform = platform()
): ShellInvocation {
  const marker = opts.interactive ? makeMarker() : null

  if (plat === 'win32') {
    const file = opts.shell || 'powershell.exe'
    // Keep the Job Object source out of -Command so AMSI can fail open to the requested command.
    const jobPreamble = opts.killTreeOnClose
      ? "$global:KoryJobOk = $false; try { & ([ScriptBlock]::Create($env:KORY_JOB_PS)); if (-not $global:KoryJobOk) { throw 'job not entered' } } catch { Write-Warning ('kory-job: tree kill disabled: ' + $_.FullyQualifiedErrorId) }; "
      : ''
    const command = marker ? `Write-Output '${marker}'; ${jobPreamble}${opts.command}` : `${jobPreamble}${opts.command}`
    // PowerShell has no `-i`; the profile loads by default. -NoProfile is the
    // non-interactive (clean) path; interactive lets the profile (aliases) load.
    const args = opts.interactive
      ? ['-NoLogo', '-Command', command]
      : ['-NoLogo', '-NoProfile', '-Command', command]
    return { file, args, marker }
  }

  const shell = opts.shell || process.env.SHELL || '/bin/bash'
  const command = marker ? `echo '${marker}'; ${opts.command}` : opts.command
  const args = opts.interactive ? ['-l', '-i', '-c', command] : ['-l', '-c', command]
  return { file: shell, args, marker }
}

export interface SpawnPlan {
  invocation: ShellInvocation
  env: Record<string, string | undefined>
}

export function buildSpawnPlan(
  opts: SpawnOpts,
  extraEnv: Record<string, string> | undefined,
  plat: NodeJS.Platform
): SpawnPlan {
  const invocation = buildShellInvocation({ ...opts, killTreeOnClose: true }, plat)
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Populate the status-line peer_id cache so the Deck can show peer_id.
    CLAUDE_PEERS_STATUS_LINE_CACHE: '1',
    TERM: 'xterm-256color',
    ...extraEnv
  }
  if (plat === 'win32') env.KORY_JOB_PS = JOB_PREAMBLE_PS
  return { invocation, env }
}
