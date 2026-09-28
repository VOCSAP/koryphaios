import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { avatarPrivateDir, ensureAvatarPrivateDir } from './avatar-private-dir'
import type { AvatarLifetimeLease } from './avatar-lifetime'
import { reportError } from './log'

export const AVATAR_REGISTRY_FILE = 'avatar.json'
export const AVATAR_REGISTRY_VERSION = 1

export interface AvatarRendezvous {
  version: typeof AVATAR_REGISTRY_VERSION
  avatarRunId: string
  pid: number
  port: number
  certPem: string
  token: string
}

export interface AvatarRegistryDeps {
  isAlive(pid: number): boolean
  ensurePrivateDir(stateDir: string): string
  writeAtomic(file: string, data: string, options: { mode: number }): void
}

export interface AvatarRegistryOwner {
  rendezvous: AvatarRendezvous
  release(): void
}

export type AvatarRegistryClaim =
  | { kind: 'claimed'; owner: AvatarRegistryOwner }
  | { kind: 'existing'; rendezvous: AvatarRendezvous }
  | { kind: 'busy' }

type RegistryRead =
  | { kind: 'missing' }
  | { kind: 'valid'; rendezvous: AvatarRendezvous }
  | { kind: 'invalid' }

function registryPath(stateDir: string): string {
  return join(avatarPrivateDir(stateDir), AVATAR_REGISTRY_FILE)
}

function isRendezvous(value: unknown): value is AvatarRendezvous {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === AVATAR_REGISTRY_VERSION &&
    typeof record.avatarRunId === 'string' &&
    record.avatarRunId.length > 0 &&
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.port === 'number' &&
    Number.isInteger(record.port) &&
    record.port > 0 &&
    record.port <= 65535 &&
    typeof record.certPem === 'string' &&
    record.certPem.length > 0 &&
    typeof record.token === 'string' &&
    record.token.length > 0
  )
}

function readRegistry(file: string): RegistryRead {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    reportError('avatar-registry', `cannot read ${file}`, error)
    throw new Error('Avatar registry could not be read')
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (isRendezvous(parsed)) return { kind: 'valid', rendezvous: parsed }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error'
    reportError('avatar-registry', `${file} is not valid JSON (${errorName})`, new Error(errorName))
    return { kind: 'invalid' }
  }

  reportError('avatar-registry', `${file} has an invalid rendezvous record`)
  return { kind: 'invalid' }
}

function defaultDeps(overrides: Partial<AvatarRegistryDeps>): AvatarRegistryDeps {
  return {
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    ensurePrivateDir: ensureAvatarPrivateDir,
    writeAtomic: writeFileAtomic,
    ...overrides
  }
}

function assertRendezvous(value: AvatarRendezvous): void {
  if (!isRendezvous(value)) throw new Error('Avatar rendezvous is invalid')
}

function releaseRegistry(file: string, avatarRunId: string): void {
  const read = readRegistry(file)
  if (read.kind !== 'valid' || read.rendezvous.avatarRunId !== avatarRunId) return

  try {
    rmSync(file)
  } catch (error) {
    reportError('avatar-registry', `cannot release ${file}`, error)
  }
}

export function readAvatarRegistry(
  stateDir: string,
  overrides: Partial<AvatarRegistryDeps> = {}
): AvatarRendezvous | null {
  const read = readRegistry(registryPath(stateDir))
  if (read.kind !== 'valid') return null
  return defaultDeps(overrides).isAlive(read.rendezvous.pid) ? read.rendezvous : null
}

export function claimAvatarRegistry(
  stateDir: string,
  createRendezvous: () => AvatarRendezvous,
  lifetime: AvatarLifetimeLease | null,
  overrides: Partial<AvatarRegistryDeps> = {}
): AvatarRegistryClaim {
  const deps = defaultDeps(overrides)
  let privateDir: string
  try {
    privateDir = deps.ensurePrivateDir(stateDir)
  } catch (error) {
    lifetime?.release()
    throw error
  }

  if (!lifetime) {
    const existing = readAvatarRegistry(stateDir, deps)
    return existing ? { kind: 'existing', rendezvous: existing } : { kind: 'busy' }
  }

  try {
    const rendezvous = createRendezvous()
    assertRendezvous(rendezvous)
    const file = join(privateDir, AVATAR_REGISTRY_FILE)
    const publication = {
      version: rendezvous.version,
      avatarRunId: rendezvous.avatarRunId,
      pid: rendezvous.pid,
      port: rendezvous.port,
      certPem: rendezvous.certPem,
      token: rendezvous.token
    }
    deps.writeAtomic(file, `${JSON.stringify(publication)}\n`, { mode: 0o600 })

    return {
      kind: 'claimed',
      owner: {
        rendezvous,
        release: () => {
          try {
            releaseRegistry(file, rendezvous.avatarRunId)
          } finally {
            lifetime.release()
          }
        }
      }
    }
  } catch (error) {
    lifetime.release()
    throw error
  }
}
