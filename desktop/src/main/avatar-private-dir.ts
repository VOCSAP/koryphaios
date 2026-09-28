import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { reportError } from './log'

export const AVATAR_PRIVATE_DIR = 'avatar'

export interface WindowsAclSnapshot {
  display: string
  sddl: string
}

export interface AvatarPrivateDirDeps {
  platform: NodeJS.Platform
  currentUserSid(): string
  setWindowsAcl(dir: string, sid: string): void
  readWindowsAcl(dir: string): WindowsAclSnapshot
}

const SID_RE = /\bS-\d-(?:\d+-)*\d+\b/i
const ALLOWED_WINDOWS_ACL_SIDS = new Set(['SY', 'BA'])

function windowsBinary(name: string): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
}

function currentWindowsUserSid(): string {
  const output = execFileSync(windowsBinary('whoami.exe'), ['/user'], { encoding: 'utf8' })
  const sid = output.match(SID_RE)?.[0]
  if (!sid) throw new Error('Could not resolve the current Windows SID')
  return sid.toUpperCase()
}

function readWindowsAclSnapshot(dir: string): WindowsAclSnapshot {
  const tempDir = mkdtempSync(join(tmpdir(), 'kory-avatar-acl-'))
  const savedAcl = join(tempDir, 'avatar.acl')
  try {
    const display = execFileSync(windowsBinary('icacls.exe'), [dir], { encoding: 'utf8' })
    execFileSync(windowsBinary('icacls.exe'), [dir, '/save', savedAcl], { stdio: 'ignore' })
    return { display, sddl: readFileSync(savedAcl, 'utf16le') }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function defaultDeps(overrides: Partial<AvatarPrivateDirDeps>): AvatarPrivateDirDeps {
  return {
    platform: process.platform,
    currentUserSid: currentWindowsUserSid,
    setWindowsAcl: (dir, sid) => {
      execFileSync(windowsBinary('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], {
        stdio: 'ignore'
      })
    },
    readWindowsAcl: readWindowsAclSnapshot,
    ...overrides
  }
}

export function avatarPrivateDir(stateDir: string): string {
  return join(stateDir, AVATAR_PRIVATE_DIR)
}

export function hasPrivateAvatarAcl(acl: WindowsAclSnapshot, userSid: string): boolean {
  if (/\(I\)/.test(acl.display)) return false
  const dacl = acl.sddl.match(/(?:^|\r?\n)D:([A-Z]*)([^\r\n]*)/i)
  if (!dacl || !dacl[1]?.includes('P')) return false

  const aceText = dacl[2]
  if (aceText === undefined) return false
  const allowedSids = new Set([...ALLOWED_WINDOWS_ACL_SIDS, userSid.toUpperCase()])
  const aces = [...aceText.matchAll(/\(([^()]*)\)/g)]
  if (aces.length === 0) return false

  let hasCurrentUser = false
  for (const ace of aces) {
    const fields = ace[1]!.split(';')
    const sid = fields[5]?.toUpperCase()
    if (fields.length !== 6 || fields[0] !== 'A' || sid === undefined || !allowedSids.has(sid)) return false
    hasCurrentUser ||= sid === userSid.toUpperCase()
  }
  return hasCurrentUser
}

export function ensureAvatarPrivateDir(
  stateDir: string,
  overrides: Partial<AvatarPrivateDirDeps> = {}
): string {
  const deps = defaultDeps(overrides)
  const dir = avatarPrivateDir(stateDir)

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (deps.platform === 'win32') {
      const sid = deps.currentUserSid()
      deps.setWindowsAcl(dir, sid)
      if (!hasPrivateAvatarAcl(deps.readWindowsAcl(dir), sid)) {
        throw new Error('Avatar private directory ACL is not private')
      }
    } else {
      chmodSync(dir, 0o700)
    }
    return dir
  } catch (error) {
    reportError('avatar-registry', 'cannot establish the Avatar private directory', error)
    throw new Error('Avatar private directory could not be established')
  }
}
