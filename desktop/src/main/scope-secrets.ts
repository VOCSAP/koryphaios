// D8: remember a custom (shared) scope's secret on this machine, encrypted, so
// restoring a custom-scope workspace rejoins the same group without re-supplying
// the secret via the launch arg. The plaintext secret never lands on disk: only
// the encrypted blob (base64) is stored, keyed by groupId, in a userData file.
//
// Pure: node fs/path only, no electron import. The cipher (Electron safeStorage)
// and the storage dir (userData) are injected by the caller (index.ts), which
// keeps this module unit-testable under bun with a fake cipher + temp dir.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { join } from 'node:path'

/**
 * Minimal encrypt/decrypt surface, satisfied by Electron's `safeStorage`
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux). `isAvailable`
 * gates every operation: when false (e.g. Linux without a keyring) the store
 * is a no-op and callers fall back to the launch-arg behaviour.
 */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(buf: Buffer): string
}

/** `<dir>/scope-secrets.json` = { [groupId]: base64(encryptedBuffer) }. */
function storePath(dir: string): string {
  return join(dir, 'scope-secrets.json')
}

function readMap(dir: string): Record<string, string> {
  const file = storePath(dir)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    // Corrupt / unreadable -> treat as empty, never throw.
    return {}
  }
}

function writeMap(dir: string, map: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  // Atomic (temp + rename): a torn write would drop the remembered scope secrets.
  writeFileAtomic(storePath(dir), JSON.stringify(map, null, 2))
}

/**
 * Encrypt + persist `secret` under `groupId`. Returns false (and writes
 * nothing) when encryption is unavailable. Best-effort: an FS error propagates
 * so the caller can log, but the caller treats D8 as optional.
 */
export function rememberScopeSecret(
  dir: string,
  cipher: SecretCipher,
  groupId: string,
  secret: string
): boolean {
  if (!cipher.isAvailable()) return false
  const map = readMap(dir)
  map[groupId] = cipher.encrypt(secret).toString('base64')
  writeMap(dir, map)
  return true
}

/**
 * Recall + decrypt the secret stored for `groupId`, or null when encryption is
 * unavailable, nothing is stored, or decryption fails (e.g. the OS key changed).
 */
export function recallScopeSecret(
  dir: string,
  cipher: SecretCipher,
  groupId: string
): string | null {
  if (!cipher.isAvailable()) return null
  const enc = readMap(dir)[groupId]
  if (!enc) return null
  try {
    return cipher.decrypt(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

/** Drop the stored secret for `groupId` (no-op if absent). */
export function forgetScopeSecret(dir: string, groupId: string): void {
  const map = readMap(dir)
  if (groupId in map) {
    delete map[groupId]
    writeMap(dir, map)
  }
}
