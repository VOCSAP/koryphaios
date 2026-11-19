// Desktop-local rather than broker-shared: graph chat documents are
// operator-personal, unlike the roadmap.
// One JSON file per project, keyed by the git-remote-normalized project_key, so
// the same project shares its graphs across worktrees/clones.
// Encrypted at rest via Electron safeStorage when available; falls back to
// clear text when the OS keychain is unavailable (e.g. Linux without a keyring)
// rather than losing the feature.
// A legacy clear file keeps loading and gets re-encrypted on the next list or
// save.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { reportError } from './log'
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
export async function loadGraphs(
  stateDir: string,
  projectKey: string,
  cipher?: SecretCipher
): Promise<GraphDoc[]> {
  const file = graphsFile(stateDir, projectKey)
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf-8')
    if (text.length > MAX_FILE_BYTES) return []
    const raw = JSON.parse(text)
    if (isEnvelope(raw)) {
      if (!cipher || !(await cipher.isAvailableAsync())) return []
      return parseDocs(JSON.parse(await cipher.decryptAsync(Buffer.from(raw.payload, 'base64'))))
    }
    // Legacy clear array (pre-K8): still readable, re-encrypted on next save.
    return parseDocs(raw)
  } catch {
    return []
  }
}

export async function saveGraphs(
  stateDir: string,
  projectKey: string,
  docs: GraphDoc[],
  cipher?: SecretCipher
): Promise<void> {
  const dir = graphsDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(docs, null, 2)
  const body =
    cipher && (await cipher.isAvailableAsync())
      ? JSON.stringify({
          v: 1,
          cipher: 'safeStorage',
          payload: (await cipher.encryptAsync(json)).toString('base64')
        } satisfies EncryptedEnvelope)
      : json
  // Atomic (temp + rename): a torn write would drop every graph conversation.
  writeFileAtomic(graphsFile(stateDir, projectKey), body)
}

// Load-then-save of one file must not interleave with another one: the async cipher yields between the two.
const fileQueues = new Map<string, Promise<unknown>>()

function serialized<T>(file: string, run: () => Promise<T>): Promise<T> {
  const next = (fileQueues.get(file) ?? Promise.resolve()).then(run, run)
  const tail = next.then(
    () => undefined,
    () => undefined
  )
  fileQueues.set(file, tail)
  void tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file)
  })
  return next
}

/**
 * One-shot at-rest migration (K8): a legacy CLEAR file is rewritten encrypted
 * as soon as a cipher is available. Cheap no-op otherwise (already encrypted,
 * no file, or no keychain). Returns true when a rewrite happened.
 */
export async function migrateGraphsAtRest(
  stateDir: string,
  projectKey: string,
  cipher: SecretCipher
): Promise<boolean> {
  if (!(await cipher.isAvailableAsync())) return false
  const file = graphsFile(stateDir, projectKey)
  return serialized(file, async () => {
    try {
      if (!existsSync(file)) return false
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      if (!Array.isArray(raw)) return false // already an envelope (or corrupt)
      await saveGraphs(stateDir, projectKey, parseDocs(raw), cipher)
      return true
    } catch (e) {
      reportError('graph', 'could not migrate the graphs at rest', e instanceof Error ? e.name : typeof e)
      return false
    }
  })
}

/** Insert or replace one doc (matched by id), stamping updatedAt. */
export function upsertGraph(
  stateDir: string,
  projectKey: string,
  doc: GraphDoc,
  cipher?: SecretCipher
): Promise<GraphDoc> {
  return serialized(graphsFile(stateDir, projectKey), async () => {
    const stamped = { ...doc, updatedAt: Date.now() }
    const rest = (await loadGraphs(stateDir, projectKey, cipher)).filter((d) => d.id !== doc.id)
    await saveGraphs(stateDir, projectKey, [stamped, ...rest], cipher)
    return stamped
  })
}

export function deleteGraph(
  stateDir: string,
  projectKey: string,
  id: string,
  cipher?: SecretCipher
): Promise<boolean> {
  return serialized(graphsFile(stateDir, projectKey), async () => {
    const docs = await loadGraphs(stateDir, projectKey, cipher)
    const rest = docs.filter((d) => d.id !== id)
    if (rest.length === docs.length) return false
    await saveGraphs(stateDir, projectKey, rest, cipher)
    return true
  })
}
