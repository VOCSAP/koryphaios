// Which tile a claude.exe process belongs to, from the process table alone.
// A tile's claude.exe is not a direct child of its PTY shell (an npm install
// puts a node.exe and a cmd.exe between them) and a native install has another
// depth, so no depth is assumed: the parent chain is walked until it reaches
// the shell, and any other claude.exe on the way, such as a `claude -p` the
// model started, disqualifies the candidate.

import { win32 } from 'node:path'
import { runSocketOwnerHelper, type SocketOwnerDeps } from './avatar-socket-owner'
import { system32Dir } from './windows-system-root'

export const PROCESS_LIST_TIMEOUT_MS = 15_000
/** How much later than the connection a claude.exe may have been created, for clocks that disagree by a tick. */
export const CONNECTION_CLOCK_SLACK_MS = 1_000

const MAX_CHAIN_DEPTH = 64
const CLAUDE_IMAGE = 'claude.exe'

export interface ProcessRow {
  pid: number
  ppid: number
  name: string
  /** Epoch milliseconds. */
  createdAt: number
}

export type TileProcessRefusal =
  | 'unknown-process'
  | 'not-claude'
  | 'no-parent-chain'
  | 'foreign-claude'
  | 'created-before-parent'
  | 'created-after-connection'

export type TileProcessVerdict = { ok: true } | { ok: false; reason: TileProcessRefusal }

const isClaude = (row: ProcessRow): boolean => row.name.toLowerCase() === CLAUDE_IMAGE

/**
 * Whether process `claudePid` is the claude.exe of the tile whose PTY shell is
 * `shellPid`: named claude.exe, its parents reach the shell, none of those
 * parents, the shell included, is a claude.exe, and no link is older than its
 * parent (a parent pid is only a number the OS may have reused). A claude.exe
 * that is the PTY process itself is accepted. With `acceptedAt` (epoch ms of
 * the connection the pid was read from), a process created after that moment
 * cannot be the one that opened it: the pid was reused between the netstat read
 * and this listing.
 */
export function judgeTileClaude(
  processes: readonly ProcessRow[],
  claudePid: number,
  shellPid: number,
  acceptedAt?: number
): TileProcessVerdict {
  const byPid = new Map<number, ProcessRow>()
  for (const row of processes) byPid.set(row.pid, row)
  const candidate = byPid.get(claudePid)
  if (!candidate) return { ok: false, reason: 'unknown-process' }
  if (!isClaude(candidate)) return { ok: false, reason: 'not-claude' }
  if (acceptedAt !== undefined && candidate.createdAt > acceptedAt + CONNECTION_CLOCK_SLACK_MS) {
    return { ok: false, reason: 'created-after-connection' }
  }
  if (candidate.pid === shellPid) return { ok: true }

  const seen = new Set<number>([candidate.pid])
  let child = candidate
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const parent = byPid.get(child.ppid)
    if (!parent || seen.has(parent.pid)) return { ok: false, reason: 'no-parent-chain' }
    if (child.createdAt < parent.createdAt) return { ok: false, reason: 'created-before-parent' }
    if (isClaude(parent)) return { ok: false, reason: 'foreign-claude' }
    if (parent.pid === shellPid) return { ok: true }
    seen.add(parent.pid)
    child = parent
  }
  return { ok: false, reason: 'no-parent-chain' }
}

export interface TilePty {
  id: string
  /** The pid of the PTY shell of the tile. */
  ptyPid: number
}

/** The id of the one tile whose PTY the process belongs to; null when none or several accept it. */
export function tileOfClaude(
  processes: readonly ProcessRow[],
  claudePid: number,
  tiles: readonly TilePty[],
  acceptedAt?: number
): string | null {
  const owners = tiles.filter((tile) => judgeTileClaude(processes, claudePid, tile.ptyPid, acceptedAt).ok)
  return owners.length === 1 ? owners[0]!.id : null
}

const ROW = /^(\d+)\|(\d+)\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|(.+)$/

/** Parses the listing of `listWin32Processes`; throws on any line it cannot read, so a listing is whole or refused. */
export function parseProcessListing(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const match = ROW.exec(line)
    const createdAt = match ? Date.parse(match[3]!.replace(/(\.\d{3})\d*Z$/, '$1Z')) : Number.NaN
    const pid = match ? Number(match[1]) : Number.NaN
    const ppid = match ? Number(match[2]) : Number.NaN
    if (!match || Number.isNaN(createdAt) || !Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) {
      throw new Error(`unreadable process listing line (${line.length} characters)`)
    }
    rows.push({ pid, ppid, name: match[4]!, createdAt })
  }
  return rows
}

const LIST_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { ' +
  '"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToUniversalTime().ToString(\'o\'))|$($_.Name)" } }'

/** Throws when SystemRoot cannot name PowerShell safely or when it fails, times out or prints a line it cannot read. */
export async function listWin32Processes(deps: SocketOwnerDeps = { env: process.env, run: runSocketOwnerHelper }): Promise<ProcessRow[]> {
  const systemRoot = deps.env.SystemRoot
  const system32 = system32Dir(systemRoot)
  if (!system32.ok || !systemRoot) {
    throw new Error(`refused to start powershell: SystemRoot is not an absolute path (${String(systemRoot)})`)
  }
  const output = await deps.run(
    win32.join(system32.dir, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT],
    {
      cwd: system32.dir,
      env: { SystemRoot: systemRoot, PSModulePath: win32.join(system32.dir, 'WindowsPowerShell', 'v1.0', 'Modules') },
      timeout: PROCESS_LIST_TIMEOUT_MS,
      windowsHide: true
    }
  )
  return parseProcessListing(output)
}
