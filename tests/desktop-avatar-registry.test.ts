import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { execFileSync } from 'node:child_process'
import { system32Dir } from '../desktop/src/main/windows-system-root.ts'
import {
  AVATAR_REGISTRY_FILE,
  AVATAR_REGISTRY_VERSION,
  claimAvatarRegistry,
  readAvatarRegistry,
  type AvatarRegistryDeps,
  type AvatarRendezvous
} from '../desktop/src/main/avatar-registry.ts'
import {
  avatarPrivateDir,
  ensureAvatarPrivateDir,
  hasPrivateAvatarAcl,
  type WindowsAclSnapshot
} from '../desktop/src/main/avatar-private-dir.ts'
import type { AvatarLifetimeLease } from '../desktop/src/main/avatar-lifetime.ts'
import { onDeckError } from '../desktop/src/main/log.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-avatar-registry-'))
  dirs.push(dir)
  return dir
}

function rendezvous(avatarRunId = 'avatar-run-1', pid = 4242): AvatarRendezvous {
  return {
    version: AVATAR_REGISTRY_VERSION,
    avatarRunId,
    pid,
    port: 43123,
    certPem: 'avatar-test-certificate',
    token: 'avatar-test-token'
  }
}

function lifetime(onRelease?: () => void): { lease: AvatarLifetimeLease; released(): boolean } {
  let wasReleased = false
  return {
    lease: {
      release() {
        wasReleased = true
        onRelease?.()
      }
    },
    released: () => wasReleased
  }
}

function deps(livePids: readonly number[]): AvatarRegistryDeps {
  return {
    isAlive: (pid) => livePids.includes(pid),
    ensurePrivateDir: (dir) => {
      const privateDir = avatarPrivateDir(dir)
      mkdirSync(privateDir, { recursive: true })
      return privateDir
    },
    writeAtomic: (file, data) => writeFileSync(file, data, { mode: 0o600 })
  }
}

function registryFile(dir: string): string {
  return join(avatarPrivateDir(dir), AVATAR_REGISTRY_FILE)
}

function writeRegistry(dir: string, record: AvatarRendezvous | string): void {
  mkdirSync(avatarPrivateDir(dir), { recursive: true })
  writeFileSync(registryFile(dir), typeof record === 'string' ? record : JSON.stringify(record))
}

test('claims a complete generation only after the private directory is ready', () => {
  const dir = freshDir()
  const own = rendezvous()
  const ownerLifetime = lifetime()
  let privateDirReady = false
  let created = false

  const result = claimAvatarRegistry(
    dir,
    () => {
      created = true
      expect(privateDirReady).toBe(true)
      return own
    },
    ownerLifetime.lease,
    {
      ...deps([]),
      ensurePrivateDir: (stateDir) => {
        privateDirReady = true
        const privateDir = avatarPrivateDir(stateDir)
        mkdirSync(privateDir, { recursive: true })
        return privateDir
      }
    }
  )

  expect(created).toBe(true)
  expect(result.kind).toBe('claimed')
  if (result.kind !== 'claimed') throw new Error('expected claimed Avatar registry')
  expect(JSON.parse(readFileSync(registryFile(dir), 'utf8'))).toEqual(own)
  expect(result.owner.rendezvous).toEqual(own)
})

test('publishes only the rendezvous schema fields', () => {
  const dir = freshDir()
  const own = { ...rendezvous(), keyPem: 'unpublished-private-key' }
  const result = claimAvatarRegistry(dir, () => own, lifetime().lease, deps([]))
  if (result.kind !== 'claimed') throw new Error('expected claimed Avatar registry')

  const publication = JSON.parse(readFileSync(registryFile(dir), 'utf8')) as Record<string, unknown>
  expect(publication as object).toEqual(rendezvous())
  expect(publication.keyPem).toBeUndefined()
})

test('returns the live owner publication when the lifetime singleton is unavailable', () => {
  const dir = freshDir()
  const existing = rendezvous('avatar-run-existing', 9001)
  writeRegistry(dir, existing)
  let created = false

  expect(claimAvatarRegistry(dir, () => {
    created = true
    return rendezvous('avatar-run-own', 9002)
  }, null, deps([existing.pid]))).toEqual({ kind: 'existing', rendezvous: existing })
  expect(created).toBe(false)
})

test('does not generate a second publication while the lifetime singleton is unavailable', () => {
  const dir = freshDir()
  let created = false

  expect(claimAvatarRegistry(dir, () => {
    created = true
    return rendezvous()
  }, null, deps([]))).toEqual({ kind: 'busy' })
  expect(created).toBe(false)
})

test('does not return the publication of a dead Avatar process', () => {
  const dir = freshDir()
  const stale = rendezvous('avatar-run-stale', 9001)
  writeRegistry(dir, stale)

  expect(readAvatarRegistry(dir, deps([]))).toBeNull()
  expect(JSON.parse(readFileSync(registryFile(dir), 'utf8'))).toEqual(stale)
})

test('readers leave an invalid registry record in place', () => {
  const dir = freshDir()
  writeRegistry(dir, '{')

  expect(readAvatarRegistry(dir, deps([]))).toBeNull()
  expect(readFileSync(registryFile(dir), 'utf8')).toBe('{')
})

test('redacts a parser-controlled fragment from invalid registry reporting', () => {
  const dir = freshDir()
  const parserFragment = 'avatar-registry-token-fragment'
  let reported = ''
  const originalParse = JSON.parse
  writeRegistry(dir, '{')
  onDeckError((_scope, text) => { reported = text })
  JSON.parse = () => { throw new SyntaxError(parserFragment) }

  try {
    expect(readAvatarRegistry(dir, deps([]))).toBeNull()
  } finally {
    JSON.parse = originalParse
    onDeckError(() => {})
  }

  expect(reported).toContain('SyntaxError')
  expect(reported).not.toContain(parserFragment)
})

test('refuses private-directory failure before it generates a secret', () => {
  const dir = freshDir()
  const ownerLifetime = lifetime()
  let created = false

  expect(() => claimAvatarRegistry(
    dir,
    () => {
      created = true
      return rendezvous()
    },
    ownerLifetime.lease,
    { ...deps([]), ensurePrivateDir: () => { throw new Error('private DACL rejected') } }
  )).toThrow(/private DACL rejected/)
  expect(created).toBe(false)
  expect(ownerLifetime.released()).toBe(true)
})

test('owner release deletes only its matching generation before releasing the lifetime singleton', () => {
  const dir = freshDir()
  const own = rendezvous('avatar-run-own', 9001)
  const ownerLifetime = lifetime()
  const result = claimAvatarRegistry(dir, () => own, ownerLifetime.lease, deps([]))
  if (result.kind !== 'claimed') throw new Error('expected claimed Avatar registry')

  writeRegistry(dir, rendezvous('avatar-run-replacement', 9002))
  result.owner.release()
  expect(JSON.parse(readFileSync(registryFile(dir), 'utf8')).avatarRunId).toBe('avatar-run-replacement')
  expect(ownerLifetime.released()).toBe(true)
})

test('owner release removes its own generation', () => {
  const dir = freshDir()
  let registryPresentAtRelease = true
  const ownerLifetime = lifetime(() => {
    registryPresentAtRelease = existsSync(registryFile(dir))
  })
  const result = claimAvatarRegistry(dir, () => rendezvous(), ownerLifetime.lease, deps([]))
  if (result.kind !== 'claimed') throw new Error('expected claimed Avatar registry')

  result.owner.release()
  expect(existsSync(registryFile(dir))).toBe(false)
  expect(registryPresentAtRelease).toBe(false)
  expect(ownerLifetime.released()).toBe(true)
})

const CURRENT_TEST_SID = 'S-1-5-21-111-222-333-1001'

function windowsBinary(name: string): string {
  const system32 = system32Dir(process.env.SystemRoot)
  if (!system32.ok) throw new Error(`the real icacls test needs an absolute SystemRoot, got ${String(process.env.SystemRoot)}`)
  return win32.join(system32.dir, name)
}

function currentWindowsSid(): string {
  const output = execFileSync(windowsBinary('whoami.exe'), ['/user'], { encoding: 'utf8' })
  const sid = output.match(/\bS-\d-(?:\d+-)*\d+\b/i)?.[0]
  if (sid === undefined) throw new Error('expected whoami /user to return a SID')
  return sid.toUpperCase()
}

function savedWindowsAcl(dir: string): WindowsAclSnapshot {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kory-avatar-acl-test-'))
  const savedAcl = join(snapshotDir, 'avatar.acl')
  try {
    const display = execFileSync(windowsBinary('icacls.exe'), [dir], { encoding: 'utf8' })
    execFileSync(windowsBinary('icacls.exe'), [dir, '/save', savedAcl], { stdio: 'ignore' })
    return { display, sddl: readFileSync(savedAcl, 'utf16le') }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true })
  }
}

function describeWindowsAcl(dir: string): string {
  const parts: string[] = []
  try {
    parts.push(`whoami /user:\n${execFileSync(windowsBinary('whoami.exe'), ['/user'], { encoding: 'utf8' })}`)
  } catch (error) {
    parts.push(`whoami /user failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const acl = savedWindowsAcl(dir)
    let sid = 'unresolved'
    try {
      sid = currentWindowsSid()
    } catch (error) {
      parts.push(`current SID unresolved: ${error instanceof Error ? error.message : String(error)}`)
    }
    parts.push(`icacls display:\n${acl.display}`, `saved SDDL:\n${acl.sddl}`, `hasPrivateAvatarAcl for ${sid}: ${String(sid !== 'unresolved' && hasPrivateAvatarAcl(acl, sid))}`)
  } catch (error) {
    parts.push(`ACL of ${dir} unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parts.join('\n')
}

function privateAcl(sddl: string, display = 'C:\\state\\avatar'): WindowsAclSnapshot {
  return { display, sddl }
}

test('requires a protected SID-only ACL and configures it before publishing secrets', () => {
  const dir = freshDir()
  let grantedSid = ''
  const result = ensureAvatarPrivateDir(dir, {
    platform: 'win32',
    currentUserSid: () => CURRENT_TEST_SID,
    setWindowsAcl: (_dir, sid) => { grantedSid = sid },
    readWindowsAcl: () => privateAcl(`avatar\nD:PAI(A;OICI;FA;;;${CURRENT_TEST_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`)
  })

  expect(result).toBe(avatarPrivateDir(dir))
  expect(grantedSid).toBe(CURRENT_TEST_SID)
  expect(hasPrivateAvatarAcl(privateAcl(`avatar\nD:PAI(A;OICI;FA;;;${CURRENT_TEST_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`), CURRENT_TEST_SID)).toBe(true)
  const inheritedAcl = privateAcl(
    `avatar\nD:PAI(A;OICI;FA;;;${CURRENT_TEST_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
    'C:\\state\\avatar Tout le monde:(I)(RX)'
  )
  const everyoneAcl = privateAcl(`avatar\nD:PAI(A;OICI;FA;;;${CURRENT_TEST_SID})(A;OICI;FA;;;WD)`)
  const unprotectedAcl = privateAcl(`avatar\nD:AI(A;OICI;FA;;;${CURRENT_TEST_SID})`)
  expect(hasPrivateAvatarAcl(inheritedAcl, CURRENT_TEST_SID)).toBe(false)
  expect(hasPrivateAvatarAcl(everyoneAcl, CURRENT_TEST_SID)).toBe(false)
  expect(hasPrivateAvatarAcl(unprotectedAcl, CURRENT_TEST_SID)).toBe(false)
  for (const acl of [inheritedAcl, everyoneAcl, unprotectedAcl]) {
    expect(() => ensureAvatarPrivateDir(dir, {
      platform: 'win32',
      currentUserSid: () => CURRENT_TEST_SID,
      setWindowsAcl: () => {},
      readWindowsAcl: () => acl
    })).toThrow('Avatar private directory could not be established')
  }
})

test('a SystemRoot the working directory could complete stops the private directory before anything is spawned', () => {
  for (const systemRoot of [undefined, '', 'rel', 'C:\\Windows\\..\\rel']) {
    const reported: string[] = []
    onDeckError((_scope, text) => reported.push(text))
    try {
      expect(() => ensureAvatarPrivateDir(freshDir(), { platform: 'win32', env: { SystemRoot: systemRoot } })).toThrow(
        'Avatar private directory could not be established'
      )
    } finally {
      onDeckError(() => {})
    }
    expect(reported, String(systemRoot)).toEqual([
      `cannot establish the Avatar private directory: refused to start whoami.exe: SystemRoot is not an absolute path (${String(systemRoot)})`
    ])
  }
})

test.skipIf(process.platform !== 'win32')('a whoami.exe planted under a relative SystemRoot is never executed', () => {
  const cwd = freshDir()
  mkdirSync(join(cwd, 'rel', 'System32'), { recursive: true })
  copyFileSync(windowsBinary('whoami.exe'), join(cwd, 'rel', 'System32', 'whoami.exe'))
  const reported: string[] = []
  const previousCwd = process.cwd()
  process.chdir(cwd)
  onDeckError((_scope, text) => reported.push(text))
  try {
    expect(() => ensureAvatarPrivateDir(freshDir(), { env: { SystemRoot: 'rel' } })).toThrow()
  } finally {
    onDeckError(() => {})
    process.chdir(previousCwd)
  }
  expect(reported.join('\n'), 'the planted whoami ran: the failure moved on to icacls').not.toContain('icacls')
  expect(reported.join('\n')).toContain('refused to start whoami.exe')
})

test.skipIf(process.platform !== 'win32')('creates a protected Avatar directory verified by real icacls output', () => {
  const dir = freshDir()
  let privateDir = ''
  try {
    privateDir = ensureAvatarPrivateDir(dir)
  } catch (error) {
    throw new Error(
      `ensureAvatarPrivateDir rejected the directory it just configured: ${error instanceof Error ? error.message : String(error)}\n${describeWindowsAcl(avatarPrivateDir(dir))}`,
      { cause: error }
    )
  }
  const acl = savedWindowsAcl(privateDir)
  const sid = currentWindowsSid()

  expect(acl.display).toContain(privateDir)
  expect(
    hasPrivateAvatarAcl(acl, sid),
    `the private Avatar ACL was rejected for SID ${sid}\nicacls display:\n${acl.display}\nsaved SDDL:\n${acl.sddl}`
  ).toBe(true)
})
