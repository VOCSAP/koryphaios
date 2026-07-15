// Resume digest (PLAN C17): a one-shot `claude -p` briefing for the operator
// coming back to a project — what moved, what is running, what is next.
// Reuses the C9 help machinery (read-only invocation, code-constant prompt).
//
// SECURITY (C8/C17 rule): digest sources (files/globs + commands) come from
// the GLOBAL Deck config ONLY — never from a project-local config. A
// repo-carried command list would mean arbitrary command execution the moment
// a cloned project is opened. Commands still RUN with cwd = projectDir, so a
// generic global source like `git log --oneline -15` adapts to any project.
//
// Node builtins only; pure builders are unit-testable under bun.

import { exec } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { globalConfigPath } from './launch-config'

/** One digest source: exactly one of `file` (path/glob) or `command`. */
export interface DigestSource {
  /** File path or glob (single `*` wildcards, last segment only), resolved from projectDir. */
  file?: string
  /** Shell command run with cwd = projectDir. */
  command?: string
}

export interface DigestConfig {
  sources: DigestSource[]
  /** Per-project overrides, keyed by project_key (replaces `sources` entirely). */
  perProject: Record<string, DigestSource[]>
}

/** Default sources when the global config defines none: the plan files. */
export const DEFAULT_DIGEST_SOURCES: DigestSource[] = [
  { file: 'PLAN*.md' },
  { command: 'git log --oneline -15' }
]

/** Cap per collected source (chars) — a huge plan must not blow the call. */
export const DIGEST_SOURCE_CAP = 20_000
/** Max files a single glob source may expand to. */
export const DIGEST_GLOB_CAP = 10
export const DIGEST_COMMAND_TIMEOUT_MS = 15_000

function isSource(s: unknown): s is DigestSource {
  if (!s || typeof s !== 'object') return false
  const src = s as DigestSource
  const hasFile = typeof src.file === 'string' && src.file.trim() !== ''
  const hasCommand = typeof src.command === 'string' && src.command.trim() !== ''
  // Exactly one of the two shapes.
  return (hasFile || hasCommand) && !(hasFile && hasCommand)
}

/**
 * Read the digest config from the GLOBAL config file only. There is
 * deliberately NO projectDir parameter: project-local configs are never
 * consulted (see the security note above).
 */
export function readDigestConfig(
  env: NodeJS.ProcessEnv = process.env,
  path: string = globalConfigPath(env)
): DigestConfig {
  const out: DigestConfig = { sources: [...DEFAULT_DIGEST_SOURCES], perProject: {} }
  try {
    if (!existsSync(path)) return out
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      digest?: { sources?: unknown; perProject?: Record<string, unknown> }
    }
    const digest = raw?.digest
    if (!digest || typeof digest !== 'object') return out
    if (Array.isArray(digest.sources)) {
      const clean = digest.sources.filter(isSource)
      if (clean.length > 0) out.sources = clean
    }
    if (digest.perProject && typeof digest.perProject === 'object') {
      for (const [key, list] of Object.entries(digest.perProject)) {
        if (!Array.isArray(list)) continue
        const clean = list.filter(isSource)
        if (clean.length > 0) out.perProject[key] = clean
      }
    }
  } catch {
    // Malformed global config: fall back to the defaults.
  }
  return out
}

/** Effective sources for a project: per-project override, else the base list. */
export function sourcesForProject(cfg: DigestConfig, projectKey: string): DigestSource[] {
  return cfg.perProject[projectKey] ?? cfg.sources
}

/**
 * Expand a file pattern from projectDir. Minimal glob: `*` wildcards in the
 * LAST path segment only (PLAN*.md, docs/*.md); no `**`. Missing dir/file
 * expands to []. Results sorted, capped at DIGEST_GLOB_CAP.
 */
export function expandFilePattern(projectDir: string, pattern: string): string[] {
  const clean = pattern.replace(/\\/g, '/').trim()
  const slash = clean.lastIndexOf('/')
  const dir = slash === -1 ? '' : clean.slice(0, slash)
  const base = slash === -1 ? clean : clean.slice(slash + 1)
  const absDir = resolve(projectDir, dir)
  if (!base.includes('*')) {
    const p = join(absDir, base)
    return existsSync(p) ? [p] : []
  }
  const escaped = base
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  const rx = new RegExp(`^${escaped}$`)
  try {
    return readdirSync(absDir)
      .filter((f) => rx.test(f))
      .sort()
      .slice(0, DIGEST_GLOB_CAP)
      .map((f) => join(absDir, f))
  } catch {
    return []
  }
}

export interface CollectedSource {
  /** Display name (relative file path or the command line). */
  name: string
  content: string
  truncated: boolean
  /** Set instead of content when the source failed (missing, exec error). */
  error?: string
}

function capContent(raw: string, cap: number): { content: string; truncated: boolean } {
  const truncated = raw.length > cap
  return { content: truncated ? raw.slice(0, cap) : raw, truncated }
}

function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    exec(
      command,
      { cwd, timeout: DIGEST_COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (err) rej(new Error((stderr || err.message).trim().slice(0, 300)))
        else res(stdout)
      }
    )
  })
}

/**
 * Materialize every source. Each entry degrades to an `error` note instead of
 * failing the digest; content is capped per source.
 */
export async function collectSources(
  sources: DigestSource[],
  projectDir: string,
  cap: number = DIGEST_SOURCE_CAP
): Promise<CollectedSource[]> {
  const out: CollectedSource[] = []
  for (const src of sources) {
    if (src.file) {
      const files = expandFilePattern(projectDir, src.file)
      if (files.length === 0) {
        out.push({ name: src.file, content: '', truncated: false, error: 'no matching file' })
        continue
      }
      for (const f of files) {
        try {
          const { content, truncated } = capContent(readFileSync(f, 'utf-8'), cap)
          out.push({ name: f, content, truncated })
        } catch (e) {
          out.push({
            name: f,
            content: '',
            truncated: false,
            error: e instanceof Error ? e.message : String(e)
          })
        }
      }
    } else if (src.command) {
      try {
        const { content, truncated } = capContent(await runCommand(src.command, projectDir), cap)
        out.push({ name: `$ ${src.command}`, content, truncated })
      } catch (e) {
        out.push({
          name: `$ ${src.command}`,
          content: '',
          truncated: false,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
  }
  return out
}

/** The fixed operator question a digest invocation answers (CODE CONSTANT). */
export const DIGEST_PROMPT =
  'Give me the resume digest for this project: where things stand and what to do next.'

export const DIGEST_SYSTEM_PROMPT = [
  'You are the RESUME DIGEST generator of Claude Peers Deck: the operator is coming back to this project and needs a short briefing to resume work.',
  'You receive the live app state (roadmap backlog, sessions, worktrees) and excerpts of the configured project sources (plan files, git log, ...). Cross-reference them.',
  'Produce a compact briefing with exactly these sections: 1) Where we are (recent progress, running/left-over sessions and worktrees worth attention), 2) In flight (in_progress roadmap items and dirty worktrees), 3) Next (what the plans and the roadmap queue say should happen now, concrete first actions).',
  'Be specific (titles, branch names, item ids) and brief — the whole digest under ~300 words. If a source errored, ignore it silently unless nothing else is available.',
  'You are technically read-only: no MCP tools, no mutating tools. Never claim you did something.'
].join('\n\n')

/** Cap on the digest system prompt as a whole. */
const MAX_DIGEST_SYSTEM_CHARS = 100_000

export function buildDigestSystemPrompt(ctx: {
  /** 'fr' | 'en' — answer language for the briefing. */
  locale: string
  /** Same multi-view snapshot the help assistant receives. */
  data: unknown
  sources: CollectedSource[]
}): string {
  const parts = [
    DIGEST_SYSTEM_PROMPT,
    `Answer in ${ctx.locale.toLowerCase().startsWith('fr') ? 'French' : 'English'}.`,
    '## Live app state',
    JSON.stringify(ctx.data, null, 2) ?? 'null',
    '## Project sources'
  ]
  for (const s of ctx.sources) {
    parts.push(
      s.error
        ? `### ${s.name}\n[unavailable: ${s.error}]`
        : `### ${s.name}${s.truncated ? ' (truncated)' : ''}\n${s.content}`
    )
  }
  const text = parts.join('\n\n')
  return text.length > MAX_DIGEST_SYSTEM_CHARS
    ? `${text.slice(0, MAX_DIGEST_SYSTEM_CHARS)}\n[truncated]`
    : text
}
