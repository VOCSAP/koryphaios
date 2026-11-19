// Local-provider API keys are encrypted at rest with Electron safeStorage.
// Renderer to main: apiKey is set only when the operator just typed a key (''
// means explicitly forget it, absent means unchanged).
// At rest: apiKeyEnc is 'enc:<base64 blob>', or 'plain:<key>' when OS
// encryption is unavailable (Linux without a keyring) — apiKey itself is never
// stored.
// Main to renderer exposes only a hasKey marker; neither apiKey nor apiKeyEnc
// ever reaches the renderer.

import type { LocalProviderConfig } from '../shared/models'
import type { SecretCipher } from './scope-secrets'
import { reportError } from './log'

const ENC_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'

async function encryptKey(cipher: SecretCipher, plain: string): Promise<string> {
  if (await cipher.isAvailableAsync()) {
    return ENC_PREFIX + (await cipher.encryptAsync(plain)).toString('base64')
  }
  return PLAIN_PREFIX + plain
}

async function decryptKey(cipher: SecretCipher, stored: string): Promise<string | undefined> {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return await cipher.decryptAsync(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch (e) {
      // OS key changed / other user profile: behave as "no key stored", but
      // leave a trace (O6) -- downstream this looks like an unauthenticated
      // provider call, which is otherwise a nightmare to diagnose.
      reportError('secrets', 'stored provider key could not be decrypted (keychain changed?)', e)
      return undefined
    }
  }
  return undefined
}

/** Encrypts the keys the operator just typed, by provider object; the only async step of a provider patch. */
export async function sealProviderKeys(
  next: LocalProviderConfig[],
  cipher: SecretCipher
): Promise<ReadonlyMap<LocalProviderConfig, string>> {
  const fresh = next.filter((p) => p && typeof p === 'object' && p.id && typeof p.apiKey === 'string' && p.apiKey)
  const sealed = await Promise.all(fresh.map((p) => encryptKey(cipher, p.apiKey!)))
  return new Map(fresh.map((p, i) => [p, sealed[i]!]))
}

/**
 * Merge a renderer-sent providers array into the stored shape: take the sealed
 * fresh keys, honour explicit clears (''), carry the previous blob (matched by
 * id) when the field is untouched. Strips every transient/renderer-only field.
 * Synchronous on purpose: the caller reads `prev` and applies the result with
 * no await in between.
 */
export function mergeProviderPatch(
  prev: LocalProviderConfig[],
  next: LocalProviderConfig[],
  sealed: ReadonlyMap<LocalProviderConfig, string>
): LocalProviderConfig[] {
  const prevById = new Map(prev.map((p) => [p.id, p]))
  return next
    .filter((p) => p && typeof p === 'object' && p.id)
    .map((p) => {
      const stored: LocalProviderConfig = {
        id: p.id,
        name: typeof p.name === 'string' ? p.name : '',
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : ''
      }
      if (typeof p.apiKey === 'string') {
        // Operator touched the field: '' clears, anything else carries the sealed key.
        const fresh = sealed.get(p)
        if (fresh) stored.apiKeyEnc = fresh
      } else {
        const carried = prevById.get(p.id)?.apiKeyEnc
        if (carried) stored.apiKeyEnc = carried
      }
      return stored
    })
}

export async function applyProviderKeyPatch(
  prev: LocalProviderConfig[],
  next: LocalProviderConfig[],
  cipher: SecretCipher
): Promise<LocalProviderConfig[]> {
  return mergeProviderPatch(prev, next, await sealProviderKeys(next, cipher))
}

/** True when a provider still carries a transient `apiKey`: such a patch was never sealed. */
export function hasPlainProviderKey(providers: readonly LocalProviderConfig[]): boolean {
  return providers.some((p) => !!p && typeof p === 'object' && 'apiKey' in p)
}

/**
 * A config patch with its provider keys sealed, then applied. The stored providers
 * are read and `apply` runs in the same synchronous step, after the only await:
 * two concurrent patches cannot carry a stale blob over each other's new key.
 */
export async function applySealedProviderPatch<T extends { localProviders?: LocalProviderConfig[] }, R>(
  patch: T,
  cipher: SecretCipher,
  readCurrent: () => LocalProviderConfig[],
  apply: (patch: T) => R
): Promise<R> {
  const incoming = patch.localProviders
  if (!incoming) return apply(patch)
  const sealed = await sealProviderKeys(incoming, cipher)
  return apply({ ...patch, localProviders: mergeProviderPatch(readCurrent(), incoming, sealed) })
}

/** Renderer-facing copy: secrets stripped, presence exposed as `hasKey`. */
export function sanitizeProviders(providers: LocalProviderConfig[]): LocalProviderConfig[] {
  return (providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    hasKey: !!p.apiKeyEnc
  }))
}

/** Main-side use (discovery, inference): plaintext keys restored in memory. */
export function decryptProviders(
  providers: LocalProviderConfig[],
  cipher: SecretCipher
): Promise<LocalProviderConfig[]> {
  return Promise.all(
    (providers ?? []).map(async (p) => {
      const apiKey = p.apiKeyEnc ? await decryptKey(cipher, p.apiKeyEnc) : undefined
      const { apiKeyEnc: _enc, ...rest } = p
      return apiKey ? { ...rest, apiKey } : { ...rest }
    })
  )
}
