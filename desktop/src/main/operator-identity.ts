// operator_id names a person, not a host, cwd, group, or peer_id: two OS
// accounts on one machine share hostname(), so routing notifications by host
// would send one account's approvals to the other.
// The broker only ever receives the Ed25519 public half; operator_id is its
// digest, so the binding is self-certifying and a leak of the broker database
// grants nobody the ability to act as this operator.
// The private half is encrypted at rest with the injected cipher, falling back
// to clear text when the OS keychain is missing so the feature never simply
// breaks.
// Enrolling a second machine copies the credential rather than minting a new
// one, since an operator is a person, not a device.

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { generateCredential, deriveOperatorId, type ApprovalCredential } from './approval-auth'
import type { SecretCipher } from './scope-secrets'
import { writeFileAtomic } from './atomic-write'
import { reportError } from './log'

const FILE = 'operator.json'
const ENC_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'

interface StoredIdentity {
  /** base64 SPKI DER — safe in the clear. */
  publicKey: string
  /** 'enc:<base64>' or 'plain:<base64>' — the private half. */
  privateKeyEnc: string
  /** Random per-identity salt so the OS username never travels, even hashed. */
  userSalt: string
  createdAt: string
}

export interface OperatorIdentity {
  operatorId: string
  publicKey: string
  privateKey: string
  /** Salted hash of host+username: labels an origin without leaking the login. */
  osUserHash: string
}

function identityPath(dir: string): string {
  return join(dir, FILE)
}

/**
 * A backup path guaranteed free, not merely unlikely to collide (card
 * 469f3176 review, D1): a millisecond timestamp alone can repeat across two
 * restarts close together, and this repo has already paid for a sort key
 * that lost rows on exactly that kind of tie. Probing existsSync and
 * incrementing a suffix until a free name is found makes a second backup
 * from the same millisecond land NEXT TO the first one, never over it.
 */
function uniqueBackupPath(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let candidate = `${file}.bak-${stamp}`
  for (let n = 1; existsSync(candidate); n++) {
    candidate = `${file}.bak-${stamp}-${n}`
  }
  return candidate
}

function encrypt(cipher: SecretCipher, plain: string): string {
  if (cipher.isAvailable()) return ENC_PREFIX + cipher.encrypt(plain).toString('base64')
  return PLAIN_PREFIX + plain
}

function decrypt(cipher: SecretCipher, stored: string): string | null {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return cipher.decrypt(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch (e) {
      // Keychain changed or another OS profile: the identity is unusable. Trace
      // it — silently minting a NEW identity would orphan the operator's phone
      // pairing, which is a nightmare to diagnose from the symptom.
      reportError('approvals', 'operator identity could not be decrypted (keychain changed?)', e)
      return null
    }
  }
  return null
}

function computeOsUserHash(salt: string): string {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    // Some sandboxes have no passwd entry; the host alone still separates
    // machines, and the salt still separates identities.
    user = ''
  }
  return createHash('sha256')
    .update(salt, 'utf-8')
    .update('\0')
    .update(hostname(), 'utf-8')
    .update('\0')
    .update(user, 'utf-8')
    .digest('hex')
    .slice(0, 32)
}

/**
 * A null return means the identity file exists but could not be decrypted — not
 * proof the identity is gone, since this is equally likely to mean the OS
 * keychain is merely unavailable right now (locked, mid migration) as real
 * corruption.
 * Every caller except ApprovalRuntime.arm() must treat a null return
 * conservatively: surface a re-enrolment prompt, never silently start a new
 * identity. arm() self-heals on genuine corruption only because it's gated on
 * cipher.isAvailable(), so a transient outage never reaches it.
 */
export function loadOperatorIdentity(dir: string, cipher: SecretCipher): OperatorIdentity | null {
  const file = identityPath(dir)
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredIdentity
      const privateKey = decrypt(cipher, stored.privateKeyEnc ?? '')
      if (!privateKey || !stored.publicKey) return null
      return {
        operatorId: deriveOperatorId(stored.publicKey),
        publicKey: stored.publicKey,
        privateKey,
        osUserHash: computeOsUserHash(stored.userSalt ?? '')
      }
    } catch (e) {
      reportError('approvals', 'operator identity unreadable', e)
      return null
    }
  }
  return createOperatorIdentity(dir, cipher, generateCredential())
}

/**
 * Write a credential to app-state and return the resolved identity.
 *
 * NEVER OVERWRITES an existing identity file in place (card 469f3176 review
 * finding, mutation Q1): a caller that reaches here to self-heal after a
 * decrypt failure may be looking at a merely UNAVAILABLE keychain rather than
 * a genuinely corrupt identity (see arm()'s cipher.isAvailable() check in
 * approval-runtime.ts). If that call is wrong, or a caller with no such guard
 * arrives here anyway, the old private key must still be recoverable rather
 * than destroyed: an existing file is renamed to a timestamped `.bak-*`
 * sibling before the new one is written, never deleted, never merged.
 */
export function createOperatorIdentity(
  dir: string,
  cipher: SecretCipher,
  cred: ApprovalCredential,
  salt = randomBytes(16).toString('base64url')
): OperatorIdentity {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = identityPath(dir)
  if (existsSync(file)) renameSync(file, uniqueBackupPath(file))
  const stored: StoredIdentity = {
    publicKey: cred.publicKey,
    privateKeyEnc: encrypt(cipher, cred.privateKey),
    userSalt: salt,
    createdAt: new Date().toISOString()
  }
  writeFileAtomic(identityPath(dir), JSON.stringify(stored, null, 2), { mode: 0o600 })
  return {
    operatorId: deriveOperatorId(cred.publicKey),
    publicKey: cred.publicKey,
    privateKey: cred.privateKey,
    osUserHash: computeOsUserHash(salt)
  }
}

/**
 * Payload of the "link this PC to my identity" QR shown by an already-enrolled
 * machine. It carries the PRIVATE half, so it is one-shot and short-lived by
 * contract: the caller (the enrolment dialog) must not persist or display it
 * beyond the pairing window.
 */
export interface EnrolmentPayload {
  v: 1
  privateKey: string
  publicKey: string
  userSalt: string
}

export function exportEnrolment(dir: string, cipher: SecretCipher): EnrolmentPayload | null {
  const file = identityPath(dir)
  if (!existsSync(file)) return null
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredIdentity
    const privateKey = decrypt(cipher, stored.privateKeyEnc ?? '')
    if (!privateKey) return null
    return { v: 1, privateKey, publicKey: stored.publicKey, userSalt: stored.userSalt ?? '' }
  } catch (e) {
    reportError('approvals', 'enrolment export failed', e)
    return null
  }
}

/**
 * Adopt an identity exported by another machine.
 *
 * The payload is treated as OPAQUE KEY MATERIAL: it is validated as a working
 * keypair and nothing else. It never becomes a path, a command or a directory
 * (hostile input #3) — the enrolment channel must not be able to widen into
 * filesystem access.
 */
export function applyEnrolment(
  dir: string,
  cipher: SecretCipher,
  payload: unknown
): OperatorIdentity | null {
  const p = payload as Partial<EnrolmentPayload> | null
  if (!p || typeof p !== 'object') return null
  if (typeof p.privateKey !== 'string' || typeof p.publicKey !== 'string') return null
  if (!p.privateKey || !p.publicKey) return null
  const salt = typeof p.userSalt === 'string' && p.userSalt ? p.userSalt : undefined
  try {
    // Round-trip the pair before persisting: a malformed key must fail here,
    // not at the first approval when the operator is away from the machine.
    const probe = { privateKey: p.privateKey, publicKey: p.publicKey }
    if (!credentialWorks(probe)) return null
    return createOperatorIdentity(dir, cipher, probe, salt)
  } catch (e) {
    reportError('approvals', 'enrolment payload rejected', e)
    return null
  }
}

/** Sign-then-verify probe: proves the two halves belong together. */
export function credentialWorks(cred: ApprovalCredential): boolean {
  try {
    const proof = buildAuthProofLocal(cred.privateKey)
    return verifyAuthProofLocal(cred.publicKey, proof)
  } catch {
    return false
  }
}

// Tiny local probe helpers: a fixed payload signed and verified once.
import { buildAuthProof, verifyAuthProof } from './approval-auth'

const PROBE_PAYLOAD = { probe: 'koryphaios' }

function buildAuthProofLocal(privateKey: string): ReturnType<typeof buildAuthProof> {
  return buildAuthProof(privateKey, PROBE_PAYLOAD, { kind: 'operator', operator_id: 'probe' })
}

function verifyAuthProofLocal(
  publicKey: string,
  proof: ReturnType<typeof buildAuthProof>
): boolean {
  return verifyAuthProof(publicKey, PROBE_PAYLOAD, proof).ok
}
