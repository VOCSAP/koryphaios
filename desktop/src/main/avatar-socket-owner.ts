// Which process owns a loopback TCP connection, read from `netstat -ano -p TCP`:
// ~15-100 ms, where a cold PowerShell Get-NetTCPConnection costs about a second
// of the focus budget. Rows are matched on the local and remote endpoints only:
// the state column is localized.

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { system32Dir } from './windows-system-root'

export const SOCKET_OWNER_TIMEOUT_MS = 1_000

export interface TcpEndpoint {
  address: string
  port: number
}

export interface SocketOwnerRunOptions {
  cwd: string
  env: Record<string, string>
  timeout: number
  windowsHide: true
}

export interface SocketOwnerDeps {
  env: Record<string, string | undefined>
  run(command: string, args: string[], options: SocketOwnerRunOptions): Promise<string>
}

export function runSocketOwnerHelper(command: string, args: string[], options: SocketOwnerRunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  })
}

/**
 * The pid owning the connection whose local end is `local` and remote end is
 * `remote`, or null when no row names it or when its rows disagree. Rows with
 * pid 0 (a closed connection lingering in TIME_WAIT) are no owner.
 */
export function parseNetstatOwner(output: string, local: TcpEndpoint, remote: TcpEndpoint): number | null {
  const localText = `${local.address}:${local.port}`
  const remoteText = `${remote.address}:${remote.port}`
  const owners = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 4 || columns[0]?.toUpperCase() !== 'TCP') continue
    if (columns[1] !== localText || columns[2] !== remoteText) continue
    const pid = columns[columns.length - 1]!
    if (!/^\d+$/.test(pid)) return null
    if (pid !== '0') owners.add(pid)
  }
  if (owners.size !== 1) return null
  const pid = Number([...owners][0])
  return Number.isSafeInteger(pid) ? pid : null
}

/** Throws when SystemRoot cannot name netstat safely or when netstat fails or times out. */
export async function loopbackSocketOwner(local: TcpEndpoint, remote: TcpEndpoint, deps: SocketOwnerDeps): Promise<number | null> {
  const systemRoot = deps.env.SystemRoot
  const system32 = system32Dir(systemRoot)
  if (!system32.ok || !systemRoot) {
    throw new Error(`refused to start netstat: SystemRoot is not an absolute path (${String(systemRoot)})`)
  }
  const output = await deps.run(win32.join(system32.dir, 'NETSTAT.EXE'), ['-ano', '-p', 'TCP'], {
    cwd: system32.dir,
    env: { SystemRoot: systemRoot },
    timeout: SOCKET_OWNER_TIMEOUT_MS,
    windowsHide: true
  })
  return parseNetstatOwner(output, local, remote)
}
