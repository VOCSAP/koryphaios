// Floating "?" help assistant (PLAN C9): each question is a throwaway
// `claude -p` invocation with an app-generated system prompt describing the
// active view and a snapshot of its data. No supervisor context involved.
//
// Security model (consistent with the C8 locked-harness decision):
// - The system prompt is a CODE CONSTANT (+ app-generated context), never an
//   operator/repo template.
// - The assistant is TECHNICALLY read-only, not just prompt-constrained:
//   `--strict-mcp-config` with no MCP config loads NO MCP servers (no
//   claude-peers, no deck-control), and `--disallowedTools` denies every
//   mutating tool. Read/Grep/Glob stay available so it can ground answers in
//   the project files.
//
// Node builtins only; the pure builders are unit-testable under bun, and
// runHelp accepts an injectable binary for tests.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildShellInvocation } from './shell-command'
import { quotePromptArg } from './session-command'

/** Model choices offered for the assistant (Haiku default: cheap + fast). */
export const HELP_MODELS = ['haiku', 'sonnet', 'opus'] as const
export const DEFAULT_HELP_MODEL = 'haiku'

/** Mutating tools denied to the assistant (defense in depth over the prompt). */
export const HELP_DISALLOWED_TOOLS =
  'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,KillShell'

export const HELP_SYSTEM_PROMPT = [
  'You are the built-in HELP ASSISTANT of Claude Peers Deck, a desktop app that docks multiple Claude Code sessions ("agents") into one window.',
  'App overview: a navigation rail with Home (a supervisor session that can pilot the app), Agents (session tiles: real Claude Code terminals sharing an isolated peer group, able to message each other), and Roadmap (a persistent per-project backlog of features/bugs/debt/ideas with MoSCoW priorities, shared with the agents through their roadmap_* tools). Sessions can run in dedicated git worktrees (one branch each). Workspaces save/restore session sets; templates are reusable session recipes.',
  'Your job: help the operator understand the app and reason about its current state. A context snapshot is provided below with the active view plus the full app state: roadmap_items (the shared backlog), sessions (the tiles and their status), git_worktrees (path/branch/main; a worktree with no session running in it is a leftover the operator may want to resume or clean up). Ground your answers in it -- recommend, compare, explain, prioritize.',
  'You are STRICTLY an advisor and technically read-only: no MCP tools are loaded and mutating tools are disabled. You cannot spawn sessions, edit the roadmap, modify files or run commands. If asked to DO something, say you cannot, and explain how the operator can do it in the UI or delegate it to the supervisor (Home view).',
  'Answer concisely, in the language of the question.'
].join('\n\n')

export interface HelpContext {
  /** Active rail view when the question was asked. */
  view: string
  /** App-composed snapshot of what the view shows (kept compact). */
  data: unknown
}

/** Cap the generated system prompt (a huge roadmap must not blow the call). */
const MAX_SYSTEM_PROMPT_CHARS = 60_000

export function buildHelpSystemPrompt(ctx: HelpContext): string {
  const snapshot = JSON.stringify(ctx.data, null, 2) ?? 'null'
  const text = [
    HELP_SYSTEM_PROMPT,
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

/**
 * Compose the full `claude -p` command string (parsed by the login shell,
 * like session spawns, so the `claude` binary resolves from the user PATH).
 */
export function buildHelpCommand(opts: {
  promptText: string
  systemPromptFile: string
  model: string
  /** Test hook: alternate binary path. */
  claudeBin?: string
  /** Test hook: shell-quoting flavour. */
  platform?: NodeJS.Platform
}): string {
  const bin = opts.claudeBin?.trim() || 'claude'
  const model = (HELP_MODELS as readonly string[]).includes(opts.model)
    ? opts.model
    : DEFAULT_HELP_MODEL
  return (
    `${bin} -p ${quotePromptArg(opts.promptText, opts.platform)}` +
    ` --append-system-prompt-file "${opts.systemPromptFile}"` +
    ` --model ${model}` +
    ` --strict-mcp-config` +
    ` --disallowedTools "${HELP_DISALLOWED_TOOLS}"`
  )
}

/** Write the per-question system prompt into the app-state dir. */
export function writeHelpSystemPrompt(dir: string, ctx: HelpContext): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'help-system-prompt.md')
  writeFileSync(file, buildHelpSystemPrompt(ctx), 'utf-8')
  return file
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
      { cwd: opts.cwd, timeout: HELP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf-8' },
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
