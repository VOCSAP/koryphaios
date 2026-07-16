// Persistence layer for graph chat documents (EXPLORATION-graph-chat C23).
//
// Desktop-local by decision D7 (unlike the roadmap, which lives in the broker
// and is shared with the agents): one JSON file per PROJECT under the app
// state dir, keyed by the deck project_key (git-remote-normalized, so the
// same project across worktrees/clones shares its graphs).
//
// Node builtins + relative imports only (no electron), dir passed as a
// parameter: unit-testable under bun, like snippet-store/template-store.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGraphDoc, type GraphDoc } from '../shared/graph'

/** Defensive cap: a graphs file bigger than this is corrupt, not data. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

export function graphsDir(stateDir: string): string {
  return join(stateDir, 'graphs')
}

/** File-safe per-project bucket derived from the deck project_key. */
export function graphsFile(stateDir: string, projectKey: string): string {
  const hash = createHash('sha256').update(projectKey).digest('hex').slice(0, 16)
  return join(graphsDir(stateDir), `graphs-${hash}.json`)
}

/** All graphs of the project, newest first. Corrupt entries are dropped. */
export function loadGraphs(stateDir: string, projectKey: string): GraphDoc[] {
  const file = graphsFile(stateDir, projectKey)
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf-8')
    if (text.length > MAX_FILE_BYTES) return []
    const raw = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    return raw
      .map(parseGraphDoc)
      .filter((d): d is GraphDoc => !!d)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function saveGraphs(stateDir: string, projectKey: string, docs: GraphDoc[]): void {
  const dir = graphsDir(stateDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(graphsFile(stateDir, projectKey), JSON.stringify(docs, null, 2), 'utf-8')
}

/** Insert or replace one doc (matched by id), stamping updatedAt. */
export function upsertGraph(stateDir: string, projectKey: string, doc: GraphDoc): GraphDoc {
  const stamped = { ...doc, updatedAt: Date.now() }
  const rest = loadGraphs(stateDir, projectKey).filter((d) => d.id !== doc.id)
  saveGraphs(stateDir, projectKey, [stamped, ...rest])
  return stamped
}

export function deleteGraph(stateDir: string, projectKey: string, id: string): boolean {
  const docs = loadGraphs(stateDir, projectKey)
  const rest = docs.filter((d) => d.id !== id)
  if (rest.length === docs.length) return false
  saveGraphs(stateDir, projectKey, rest)
  return true
}
