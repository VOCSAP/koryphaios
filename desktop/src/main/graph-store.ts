// Persistence layer for graph chat documents (EXPLORATION-graph-chat C23).
//
// Desktop-local by decision D7 (unlike the roadmap, which lives in the broker
// and is shared with the agents): one JSON file per PROJECT under the app
// state dir, keyed by the deck project_key (git-remote-normalized, so the
// same project across worktrees/clones shares its graphs).
//
// Encrypted at rest (PLAN K8): conversations are operator-personal, so when a
// SecretCipher (Electron safeStorage, injected by ipc.ts like the C29 provider
// keys) is available, the file is an envelope { v, cipher: 'safeStorage',
// payload: base64(encrypt(json)) } instead of the clear doc array. Reading
// accepts both shapes -- a legacy clear file keeps loading and is re-encrypted
// by migrateGraphsAtRest (called before each list) or the next save. When the
// OS keychain is unavailable (e.g. Linux without a keyring) the store falls
// back to clear text rather than losing the feature, mirroring scope-secrets.
//
// Node builtins + relative imports only (no electron), dir + cipher passed as
// parameters: unit-testable under bun, like snippet-store/template-store.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { join } from 'node:path'
import { parseGraphDoc, type GraphDoc } from '../shared/graph'
import type { SecretCipher } from './scope-secrets'

/** Defensive cap: a graphs file bigger than this is corrupt, not data. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

/** Envelope marker for the encrypted file shape (K8). */
interface EncryptedEnvelope {
  v: 1
  cipher: 'safeStorage'
  payload: string
}

function isEnvelope(raw: unknown): raw is EncryptedEnvelope {
  return (
    !!raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as EncryptedEnvelope).cipher === 'safeStorage' &&
    typeof (raw as EncryptedEnvelope).payload === 'string'
  )
}

export function graphsDir(stateDir: string): string {
  return join(stateDir, 'graphs')
}

/** File-safe per-project bucket derived from the deck project_key. */
export function graphsFile(stateDir: string, projectKey: string): string {
  const hash = createHash('sha256').update(projectKey).digest('hex').slice(0, 16)
  return join(graphsDir(stateDir), `graphs-${hash}.json`)
}

function parseDocs(raw: unknown): GraphDoc[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(parseGraphDoc)
    .filter((d): d is GraphDoc => !!d)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * All graphs of the project, newest first. Corrupt entries are dropped; an
 * encrypted file that cannot be decrypted (no cipher, OS key changed) yields
 * [] rather than throwing -- the operator sees an empty list, not a crash.
 */
export function loadGraphs(
  stateDir: string,
  projectKey: string,
  cipher?: SecretCipher
): GraphDoc[] {
  const file = graphsFile(stateDir, projectKey)
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf-8')
    if (text.length > MAX_FILE_BYTES) return []
    const raw = JSON.parse(text)
    if (isEnvelope(raw)) {
      if (!cipher?.isAvailable()) return []
      return parseDocs(JSON.parse(cipher.decrypt(Buffer.from(raw.payload, 'base64'))))
    }
    // Legacy clear array (pre-K8): still readable, re-encrypted on next save.
    return parseDocs(raw)
  } catch {
    return []
  }
}

export function saveGraphs(
  stateDir: string,
  projectKey: string,
  docs: GraphDoc[],
  cipher?: SecretCipher
): void {
  const dir = graphsDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(docs, null, 2)
  const body = cipher?.isAvailable()
    ? JSON.stringify({
        v: 1,
        cipher: 'safeStorage',
        payload: cipher.encrypt(json).toString('base64')
      } satisfies EncryptedEnvelope)
    : json
  // Atomic (temp + rename): a torn write would drop every graph conversation.
  writeFileAtomic(graphsFile(stateDir, projectKey), body)
}

/**
 * One-shot at-rest migration (K8): a legacy CLEAR file is rewritten encrypted
 * as soon as a cipher is available. Cheap no-op otherwise (already encrypted,
 * no file, or no keychain). Returns true when a rewrite happened.
 */
export function migrateGraphsAtRest(
  stateDir: string,
  projectKey: string,
  cipher: SecretCipher
): boolean {
  if (!cipher.isAvailable()) return false
  const file = graphsFile(stateDir, projectKey)
  try {
    if (!existsSync(file)) return false
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(raw)) return false // already an envelope (or corrupt)
    saveGraphs(stateDir, projectKey, parseDocs(raw), cipher)
    return true
  } catch {
    return false
  }
}

/** Insert or replace one doc (matched by id), stamping updatedAt. */
export function upsertGraph(
  stateDir: string,
  projectKey: string,
  doc: GraphDoc,
  cipher?: SecretCipher
): GraphDoc {
  const stamped = { ...doc, updatedAt: Date.now() }
  const rest = loadGraphs(stateDir, projectKey, cipher).filter((d) => d.id !== doc.id)
  saveGraphs(stateDir, projectKey, [stamped, ...rest], cipher)
  return stamped
}

export function deleteGraph(
  stateDir: string,
  projectKey: string,
  id: string,
  cipher?: SecretCipher
): boolean {
  const docs = loadGraphs(stateDir, projectKey, cipher)
  const rest = docs.filter((d) => d.id !== id)
  if (rest.length === docs.length) return false
  saveGraphs(stateDir, projectKey, rest, cipher)
  return true
}
