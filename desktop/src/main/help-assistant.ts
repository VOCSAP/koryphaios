// Floating "?" help assistant (PLAN C9): each question is a throwaway
// headless invocation with an app-generated system prompt describing the
// active view and a snapshot of its data. No supervisor context involved.
// Since lot A (EXPLORATION-multi-llm) the target is configurable
// (config.helpTarget) and the command/HTTP routing lives in
// utility-inference.ts over the C24 adapters; this module keeps the help
// prompts, the transcript replay, and the shell executor (runHelp).
//
// Security model (consistent with the C8 locked-harness decision):
// - The system prompt is a CODE CONSTANT (+ app-generated context), never an
//   operator/repo template.
// - The assistant is TECHNICALLY read-only, not just prompt-constrained:
//   `--strict-mcp-config` with no MCP config loads NO MCP servers (no
//   claude-peers, no deck-control), and `--disallowedTools` denies every
//   mutating tool (codex: --sandbox read-only; gemini: --approval-mode
//   plan). Read/Grep/Glob stay available so claude can ground answers in
//   the project files.
//
// Node builtins only; the pure builders are unit-testable under bun, and
// runHelp accepts an injectable command for tests.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { buildShellInvocation } from './shell-command'

/** Mutating tools denied to the assistant (defense in depth over the prompt). */
export const HELP_DISALLOWED_TOOLS =
  'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,KillShell'

export const HELP_SYSTEM_PROMPT = [
  'You are the built-in HELP ASSISTANT of Koryphaios, a desktop app that docks multiple Claude Code sessions ("agents") into one window.',
  'App overview: a navigation rail with Home (a supervisor session that can pilot the app), Agents (session tiles: real Claude Code terminals sharing an isolated peer group, able to message each other), and Roadmap (a persistent per-project backlog of features/bugs/debt/ideas with MoSCoW priorities, shared with the agents through their roadmap_* tools). Sessions can run in dedicated git worktrees (one branch each). Workspaces save/restore session sets; templates are reusable session recipes.',
  'Your job: help the operator understand the app and reason about its current state. A context snapshot is provided below with the active view plus the full app state: roadmap_items (the shared backlog), sessions (the tiles and their status), git_worktrees (path/branch/main; a worktree with no session running in it is a leftover the operator may want to resume or clean up). Ground your answers in it -- recommend, compare, explain, prioritize. When the snapshot carries a code_selection (a snippet the operator selected in the Files view: file, line range, text), the question is about that exact code -- ground your answer in it (and in the surrounding file when the reading tools are available).',
  'You are STRICTLY an advisor and technically read-only: no MCP tools are loaded and mutating tools are disabled. You cannot spawn sessions, edit the roadmap, modify files or run commands. If asked to DO something, say you cannot, and explain how the operator can do it in the UI or delegate it to the supervisor (Home view).',
  'Answer concisely, in the language of the question.'
].join('\n\n')

export interface HelpContext {
  /** Active rail view when the question was asked. */
  view: string
  /** App-composed snapshot of what the view shows (kept compact). */
  data: unknown
  /**
   * Absolute path of the shipped reference-documentation directory
   * (desktop/docs, resolved by the caller: resourcesPath when packaged, app
   * dir in dev). Empty/undefined when the docs are missing — the section is
   * then omitted and the assistant falls back to the snapshot alone.
   */
  docsDir?: string
}

/** Cap the generated system prompt (a huge roadmap must not blow the call). */
const MAX_SYSTEM_PROMPT_CHARS = 60_000

/** App-generated docs pointer (the path is computed by the app, never operator input). */
export function buildDocsSection(docsDir: string): string {
  return [
    '## Reference documentation',
    `The app ships its full reference documentation (features, views, configurable options, how-tos, FAQ) as markdown files in: ${docsDir}`,
    'When the question is about the app itself -- what a feature does, where an option lives, how to accomplish something -- and file-reading tools (Read/Grep/Glob) are available, ground your answer in these files: start with README.md (the index) and open the relevant page. Prefer the documentation over recalling from this prompt alone; the context snapshot below reflects live state, the documentation explains the features and options.'
  ].join('\n')
}

export function buildHelpSystemPrompt(ctx: HelpContext): string {
  const snapshot = JSON.stringify(ctx.data, null, 2) ?? 'null'
  const text = [
    HELP_SYSTEM_PROMPT,
    ...(ctx.docsDir ? [buildDocsSection(ctx.docsDir)] : []),
    '## Current app context',
    `Active view: ${ctx.view}`,
    `Data snapshot:\n${snapshot}`
  ].join('\n\n')
  return text.length > MAX_SYSTEM_PROMPT_CHARS
    ? `${text.slice(0, MAX_SYSTEM_PROMPT_CHARS)}\n[snapshot truncated]`
    : text
}

export interface HelpExchange {
  question: string
  answer: string
}

/** Cap on the selection text injected into the snapshot (PLAN GX7). */
export const HELP_SELECTION_TEXT_MAX = 20_000

/**
 * Validate + cap a Files-view selection crossing the renderer boundary
 * (PLAN GX7). Returns the snake_case shape injected as `code_selection`
 * in the snapshot, or null when the payload is absent/malformed.
 */
export function sanitizeHelpSelection(raw: unknown): {
  file: string
  start_line: number
  end_line: number
  text: string
} | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.file !== 'string' || typeof s.text !== 'string' || !s.text.trim()) return null
  const start = Number(s.startLine)
  const end = Number(s.endLine)
  return {
    file: s.file.slice(0, 1024),
    start_line: Number.isFinite(start) ? Math.max(1, Math.round(start)) : 1,
    end_line: Number.isFinite(end) ? Math.max(1, Math.round(end)) : 1,
    text: s.text.slice(0, HELP_SELECTION_TEXT_MAX)
  }
}

/** Exchanges replayed into the (stateless) prompt for popup continuity. */
const MAX_TRANSCRIPT_EXCHANGES = 4

export function buildHelpPrompt(question: string, transcript: HelpExchange[] = []): string {
  const recent = transcript.slice(-MAX_TRANSCRIPT_EXCHANGES)
  if (recent.length === 0) return question
  const history = recent
    .map((e) => `Operator: ${e.question}\nAssistant: ${e.answer}`)
    .join('\n\n')
  return `Earlier in this help conversation:\n\n${history}\n\nOperator's new question: ${question}`
}

const HELP_TIMEOUT_MS = 120_000

/**
 * Run one help invocation through the same shell wrap as session spawns
 * (login, non-interactive) and return the printed answer. A start marker is
 * echoed before the command and everything up to it is stripped: login
 * profiles (nvm, conda...) can print noise to stdout, which would otherwise
 * corrupt the captured answer (`echo '...'` works in POSIX shells AND
 * PowerShell, where it aliases Write-Output).
 */
export function runHelp(opts: {
  command: string
  shell: string
  cwd: string
  /** Override for slower callers (graph inference, C24). Default: 120 s. */
  timeoutMs?: number
}): Promise<string> {
  const marker = `__CP_HELP_START_${randomBytes(6).toString('hex')}__`
  const inv = buildShellInvocation({
    command: `echo '${marker}'; ${opts.command}`,
    shell: opts.shell,
    interactive: false
  })
  return new Promise((resolve, reject) => {
    execFile(
      inv.file,
      inv.args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? HELP_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf-8'
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').trim().slice(0, 500)
          reject(new Error(detail || 'help invocation failed'))
        } else {
          const idx = stdout.indexOf(marker)
          resolve((idx === -1 ? stdout : stdout.slice(idx + marker.length)).trim())
        }
      }
    )
  })
}
