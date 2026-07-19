// C29 hardening: local-provider API keys encrypted at rest with Electron
// safeStorage (same SecretCipher surface as scope-secrets.ts, D8).
//
// Key lifecycle — three shapes of LocalProviderConfig, one per trust zone:
// - RENDERER -> MAIN (transient): `apiKey` is set ONLY when the operator just
//   typed a key ('' = explicit "forget the key"; absent = unchanged).
// - AT REST (config.json): `apiKeyEnc` = 'enc:<base64(safeStorage blob)>', or
//   'plain:<key>' when OS encryption is unavailable (Linux without a keyring —
//   the feature still works, the fallback is explicit in the stored value).
//   `apiKey` is NEVER stored.
// - MAIN -> RENDERER: `hasKey` marker only; neither `apiKey` nor `apiKeyEnc`
//   ever reaches the renderer.
//
// Pure: no electron import, cipher injected by index.ts — unit-testable under
// bun with a fake cipher (scope-secrets pattern).

import type { LocalProviderConfig } from '../shared/models'
import type { SecretCipher } from './scope-secrets'
import { reportError } from './log'

const ENC_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'

function encryptKey(cipher: SecretCipher, plain: string): string {
  if (cipher.isAvailable()) {
    return ENC_PREFIX + cipher.encrypt(plain).toString('base64')
  }
  return PLAIN_PREFIX + plain
}

function decryptKey(cipher: SecretCipher, stored: string): string | undefined {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return cipher.decrypt(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
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

/**
 * Merge a renderer-sent providers array into the stored shape: encrypt fresh
 * keys, honour explicit clears (''), carry the previous blob (matched by id)
 * when the field is untouched. Strips every transient/renderer-only field.
 */
export function applyProviderKeyPatch(
  prev: LocalProviderConfig[],
  next: LocalProviderConfig[],
  cipher: SecretCipher
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
        // Operator touched the field: '' clears, anything else re-encrypts.
        if (p.apiKey) stored.apiKeyEnc = encryptKey(cipher, p.apiKey)
      } else {
        const carried = prevById.get(p.id)?.apiKeyEnc
        if (carried) stored.apiKeyEnc = carried
      }
      return stored
    })
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
): LocalProviderConfig[] {
  return (providers ?? []).map((p) => {
    const apiKey = p.apiKeyEnc ? decryptKey(cipher, p.apiKeyEnc) : undefined
    const { apiKeyEnc: _enc, ...rest } = p
    return apiKey ? { ...rest, apiKey } : { ...rest }
  })
}
