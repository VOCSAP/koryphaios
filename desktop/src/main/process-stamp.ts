export interface MeasuredWindowsProcessStamp {
  platform: 'win32'
  pid: number
  creationUtc: string
}

export interface MeasuredPosixProcessStamp {
  platform: Exclude<NodeJS.Platform, 'win32'>
  pid: number
  startToken: string
  pgid: number
}

export type ProcessStamp = MeasuredWindowsProcessStamp | MeasuredPosixProcessStamp

export interface ProcessStampDeps {
  run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  readFile(path: string): string | null
  powershellPath?: string
}

/** `.ToString('o')` on a UTC DateTime emits up to seven fractional digits. */
export const CREATION_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z$/
const PS_MEASUREMENT_RE = /^\s*(\d+)\s+(\S.*)$/
/** Fields after the process name begin at field three. */
const PROC_PGRP_INDEX = 5 - 3
const PROC_STARTTIME_INDEX = 22 - 3

function requirePid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`process id must be a positive integer, got ${String(value)}`)
  }
  return value
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`process measurement must be a positive integer, got ${String(value)}`)
  }
  return value
}

function parseProcStat(pid: number, raw: string): Omit<MeasuredPosixProcessStamp, 'platform'> {
  const close = raw.lastIndexOf(')')
  if (close < 0) throw new Error(`Cannot read the group and start time of pid ${pid}: unexpected stat fields`)
  const fields = raw.slice(close + 1).trim().split(/\s+/)
  const pgidToken = fields[PROC_PGRP_INDEX]
  const startToken = fields[PROC_STARTTIME_INDEX]
  if (!pgidToken || !/^\d+$/.test(pgidToken) || !startToken || !/^\d+$/.test(startToken)) {
    throw new Error(`Cannot read the group and start time of pid ${pid}: unexpected stat fields`)
  }
  const pgid = Number(pgidToken)
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error(`Cannot read the group of pid ${pid}: ${pgidToken}`)
  }
  return { pid, startToken, pgid }
}

export async function measureWindowsProcessStamp(deps: ProcessStampDeps, pid: number): Promise<MeasuredWindowsProcessStamp> {
  const target = requirePid(pid)
  const { code, stdout, stderr } = await deps.run(deps.powershellPath ?? 'powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    `(Get-Process -Id ${target}).StartTime.ToUniversalTime().ToString('o')`
  ])
  const creationUtc = stdout.trim()
  if (code !== 0 || !CREATION_STAMP_RE.test(creationUtc)) {
    throw new Error(`Cannot measure the creation time of pid ${target} (exit ${code}): ${stderr.trim()}`)
  }
  return { platform: 'win32', pid: target, creationUtc }
}

export async function measurePosixProcessStamp(
  deps: ProcessStampDeps,
  platform: Exclude<NodeJS.Platform, 'win32'>,
  pid: number
): Promise<MeasuredPosixProcessStamp> {
  const target = requirePid(pid)
  if (platform === 'linux') {
    const raw = deps.readFile(`/proc/${target}/stat`)
    if (raw === null) throw new Error(`Cannot measure the start time of pid ${target}: no stat entry`)
    return { platform, ...parseProcStat(target, raw) }
  }
  const { code, stdout, stderr } = await deps.run('ps', ['-o', 'pgid=,lstart=', '-p', String(target)])
  const match = PS_MEASUREMENT_RE.exec(stdout.trim())
  if (code !== 0 || !match) {
    throw new Error(`Cannot measure the start time of pid ${target} (exit ${code}): ${stderr.trim()}`)
  }
  const pgid = requirePositiveInteger(Number(match[1]))
  /** Darwin `lstart` is locale-dependent; a mismatch refuses the signal. */
  return { platform, pid: target, pgid, startToken: match[2]!.replace(/\s+/g, ' ').trim() }
}

export function sameProcessStamp(expected: ProcessStamp, measured: ProcessStamp): boolean {
  if (expected.platform !== measured.platform || expected.pid !== measured.pid) return false
  if (expected.platform === 'win32' || measured.platform === 'win32') {
    return expected.platform === 'win32' && measured.platform === 'win32' && expected.creationUtc === measured.creationUtc
  }
  return expected.startToken === measured.startToken && expected.pgid === measured.pgid
}
