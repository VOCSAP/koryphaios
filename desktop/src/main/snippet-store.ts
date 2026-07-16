// Filesystem layer for reusable prompts ("snippets", PLAN C22). One .md file
// per snippet in two locations, project shadowing global on a name collision:
//   - global: <globalConfigDir>/snippets  (e.g. %APPDATA%/koryphaios/snippets)
//   - local:  <projectDir>/.claude/claude-peers/snippets
//
// File name (minus .md) = snippet name, file content = the prompt text.
// Plain markdown on purpose: hand-editable, diffable, and project snippets
// are shareable through git. Snippets are only ever INSERTED into a session's
// input field (fill-not-send, TerminalTile) -- the app never executes them.
//
// Node builtins + relative imports only (no electron) so it stays
// unit-testable under bun, like template-store.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { globalConfigDir } from './launch-config'
import type { SnippetSummary } from '../shared/types'

export type { SnippetSummary }

/** A "snippet" bigger than this is not a snippet -- skip it defensively. */
export const MAX_SNIPPET_BYTES = 64 * 1024

export function globalSnippetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), 'snippets')
}

export function localSnippetsDir(projectDir: string): string {
  return join(projectDir, '.claude', 'claude-peers', 'snippets')
}

function listDir(dir: string, source: 'global' | 'local'): SnippetSummary[] {
  try {
    if (!existsSync(dir)) return []
    const out: SnippetSummary[] = []
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.md')) continue
      const path = join(dir, f)
      try {
        if (statSync(path).size > MAX_SNIPPET_BYTES) continue
        const text = readFileSync(path, 'utf-8')
        if (!text.trim()) continue // an empty file has nothing to insert
        out.push({ path, name: f.replace(/\.md$/i, ''), source, text })
      } catch {
        /* unreadable file: skip */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/**
 * All snippets, project-local first then global, with local shadowing a
 * global snippet of the same name (scope resolution: project > global).
 */
export function listSnippets(projectDir: string, env: NodeJS.ProcessEnv = process.env): SnippetSummary[] {
  const local = listDir(localSnippetsDir(projectDir), 'local')
  const localNames = new Set(local.map((s) => s.name))
  const global = listDir(globalSnippetsDir(env), 'global').filter((s) => !localNames.has(s.name))
  return [...local, ...global]
}

/** Sanitize a label into a safe, predictable file base name (template-store rule). */
function safeBase(name: string): string {
  const b = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return b || 'snippet'
}

/** Write `text` as `<safeName>.md` into `dir` (created on demand). Returns the path. */
export function writeSnippet(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${safeBase(name)}.md`)
  writeFileSync(file, text, 'utf-8')
  return file
}

/**
 * Delete a snippet .md file. Guarded like deleteTemplate: the path must be a
 * `.md` living directly in the global or project-local snippets dir (defends
 * against an arbitrary path passed through the IPC). Returns true if removed.
 */
export function deleteSnippet(
  path: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    if (!path.toLowerCase().endsWith('.md')) return false
    const allowedDirs = [
      resolve(globalSnippetsDir(env)),
      resolve(localSnippetsDir(projectDir))
    ]
    if (!allowedDirs.includes(resolve(dirname(path)))) return false
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}
