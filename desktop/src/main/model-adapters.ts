// Headless CLI adapters for graph chat inference (EXPLORATION-graph-chat C24).
//
// Generalization of the C9 skeleton (help-assistant): one stateless throwaway
// invocation per assistant node, run through runHelp's shell wrap + profile
// noise marker. Three adapters share one contract:
//
// - The compiled context ALWAYS travels by FILE, never on the command line
//   (decision D5 — a 50k-char context would blow Windows' ~32k limit):
//   * claude: constant system prompt + context in --append-system-prompt-file,
//     the operator's question fed via stdin from a second file (D5 extended
//     to the prompt, roadmap 07dc42c0: the question used to ride the command
//     line as a quoted positional arg, but on win32 the PowerShell shell wrap
//     re-invokes the native claude.exe in legacy argument-passing mode, which
//     does NOT re-escape embedded double quotes — CommandLineToArgvW then
//     re-parses one as an argument terminator and truncates the operator's
//     message mid-sentence, invisibly to the graph inspector which shows the
//     pre-mangling file side). `claude -p` reads the prompt from stdin when
//     no positional argument is given, so this reuses the same stdinFromFile
//     wrapper as codex/gemini below.
//   * codex / gemini: the full composed prompt (system + context + question)
//     written to a file fed through stdin (`< "file"` POSIX,
//     `Get-Content -Raw "file" |` PowerShell).
// - Read-only harness per CLI (decision D6, revised lot A): claude
//   --strict-mcp-config + --disallowedTools (Read/Grep/Glob stay); codex
//   --sandbox read-only; gemini --approval-mode plan (documented read-only
//   mode — supersedes the C24-era "no reliable equivalent" note).
//
// Node builtins only; every builder is pure and unit-testable under bun.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HELP_DISALLOWED_TOOLS } from './help-assistant'
import { quotePromptArg } from './session-command'
import type { GraphCli, ModelTarget } from '../shared/graph'

/** Per-inference timeout: long contexts + reasoning models outlive C9's 120 s. */
export const GRAPH_INFER_TIMEOUT_MS = 300_000

/**
 * `model` also rides the command line: allow only benign identifier chars
 * ('' = omit the flag, the CLI's default model applies).
 */
export function sanitizeModel(model: string): string {
  return /^[A-Za-z0-9._:-]{0,128}$/.test(model) ? model : ''
}

/**
 * Antigravity variant: `agy --model` takes the DISPLAY name with the effort
 * suffix ("Gemini 3 Pro (High)"), so spaces and parens are legal — but the
 * value is double-quoted on the command line, so quotes/backslashes/`$` stay
 * forbidden ('' = omit the flag).
 */
export function sanitizeAntigravityModel(model: string): string {
  return /^[A-Za-z0-9 ().+_:.-]{0,64}$/.test(model) ? model : ''
}

/** Windows-safe double-quoted path (paths come from the app, not the user). */
function quotedPath(p: string): string {
  return `"${p.replace(/"/g, '')}"`
}

/**
 * Cross-shell "feed this file to stdin" wrapper. POSIX shells support
 * redirection; PowerShell (the win32 shell wrap, shell-command.ts spawns the
 * legacy `powershell.exe`, not `pwsh`) needs a Get-Content pipe — with the
 * encoding forced at BOTH stages, or non-ASCII operator text (accents,
 * non-Latin-1) survives the truncation fix only to get mangled a different
 * way (reviewer catch, 07dc42c0): (a) `writeContextFile` writes UTF-8
 * without a BOM, and WinPS 5.1's `Get-Content` without `-Encoding` reads a
 * BOM-less file as the system ANSI codepage ("é" -> "Ã©"); (b) WinPS 5.1
 * pipes to a native child through `$OutputEncoding`, which defaults to
 * ASCII, replacing every non-ASCII byte with a literal `?`.
 */
export function stdinFromFile(command: string, file: string, plat: NodeJS.Platform): string {
  if (plat === 'win32') {
    return (
      `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
      `Get-Content -Raw -Encoding UTF8 ${quotedPath(file)} | ${command}`
    )
  }
  return `${command} < ${quotedPath(file)}`
}

export interface AdapterInput {
  /**
   * File carrying the operator's question / instruction, fed to the claude
   * adapter via stdin (D5 extended to the prompt — see the header comment).
   * Required when `target.cli === 'claude'`; unused by the other adapters
   * (codex/gemini already read the fully composed prompt from contextFile via
   * stdin, antigravity's positional instruction is a fixed non-operator
   * string).
   */
  promptFile?: string
  /** File carrying the compiled context (role depends on the CLI, see D5). */
  contextFile: string
  target: ModelTarget
  platform?: NodeJS.Platform
  /** Test hook: alternate binary path. */
  bin?: string
  /**
   * Extra directory the read-only tools may access (claude `--add-dir`), used
   * to open the shipped reference docs from outside the project cwd. The path
   * comes from the app, never from operator input. claude-only: codex's
   * read-only sandbox already reads the whole disk, gemini's plan mode has no
   * equivalent flag.
   */
  addDir?: string
}

/** Full command line for one target; parsed by the login shell like C9. */
export function buildAdapterCommand(input: AdapterInput): string {
  const plat = input.platform ?? process.platform
  const model = sanitizeModel(input.target.model)
  switch (input.target.cli) {
    case 'claude': {
      if (!input.promptFile) {
        throw new Error('claude adapter requires promptFile (D5: operator text never rides argv)')
      }
      const bin = input.bin?.trim() || 'claude'
      const cmd =
        `${bin} -p` +
        ` --append-system-prompt-file ${quotedPath(input.contextFile)}` +
        (model ? ` --model ${model}` : '') +
        (input.addDir ? ` --add-dir ${quotedPath(input.addDir)}` : '') +
        ` --strict-mcp-config` +
        ` --disallowedTools "${HELP_DISALLOWED_TOOLS}"`
      return stdinFromFile(cmd, input.promptFile, plat)
    }
    case 'codex': {
      const bin = input.bin?.trim() || 'codex'
      const cmd = `${bin} exec --sandbox read-only${model ? ` -m ${model}` : ''} -`
      return stdinFromFile(cmd, input.contextFile, plat)
    }
    case 'gemini': {
      const bin = input.bin?.trim() || 'gemini'
      const cmd = `${bin}${model ? ` -m ${model}` : ''} --approval-mode plan`
      return stdinFromFile(cmd, input.contextFile, plat)
    }
    case 'antigravity': {
      // `agy` (Codeium-derived, NOT gemini-cli): no system flag, stdin
      // behaviour undocumented — the context travels by FILE anyway (D5) via
      // a constant "read this file" instruction + `--add-dir` on the context
      // dir so the agent's read tool can open it. `--print-timeout` bounds
      // the known non-TTY hang (agy#318) under GRAPH_INFER_TIMEOUT_MS; the
      // stdout-drop bug (agy#76) is countered by running agy under a PTY
      // (runPtyCommand — see graph-engine/utility-inference routing).
      const bin = input.bin?.trim() || 'agy'
      const model = sanitizeAntigravityModel(input.target.model)
      const instruction =
        `Read the file "${input.contextFile.replace(/"/g, '')}" and follow the ` +
        `instructions it contains. Reply with the answer only, no preamble.`
      return (
        `${bin} -p ${quotePromptArg(instruction, plat)}` +
        ` --add-dir ${quotedPath(dirname(input.contextFile))}` +
        (model ? ` --model "${model}"` : '') +
        ` --print-timeout 4m`
      )
    }
    case 'local':
      // Local providers run over HTTP (runHttpInference), never a shell command.
      throw new Error('local targets are not shell commands')
  }
}

// ---------------------------------------------------------------------------
// Local providers (C29): direct OpenAI-compatible chat completion — covers
// Ollama (/v1), LiteLLM, vLLM, OpenRouter-style proxies. Pure request builder
// + an executor with injectable fetch, mirroring the shell adapters' split.

/** POST target for a configured base URL ('…/v1' respected). */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

export interface HttpInferenceInput {
  baseUrl: string
  apiKey?: string
  model: string
  system: string
  prompt: string
}

export function buildChatCompletionRequest(input: HttpInferenceInput): {
  url: string
  init: RequestInit
} {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
  return {
    url: chatCompletionsUrl(input.baseUrl),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        stream: false,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.prompt }
        ]
      })
    }
  }
}

/** One local chat completion; throws a bounded, readable error on failure. */
export async function runHttpInference(
  input: HttpInferenceInput,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const { url, init } = buildChatCompletionRequest(input)
  const res = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(GRAPH_INFER_TIMEOUT_MS)
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`${url} -> HTTP ${res.status}${body ? `: ${body}` : ''}`)
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[]
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content) {
    throw new Error(`${url} -> empty completion`)
  }
  return content.trim()
}

/**
 * Write the context file for one target under the app-state dir. claude gets
 * the system+context side only (the question is the positional prompt);
 * codex/gemini get the fully composed prompt (they read stdin, no system
 * flag). The nodeId+cli suffix keeps parallel fan-out targets from clobbering
 * each other.
 */
export function writeContextFile(
  dir: string,
  key: { nodeId: string; cli: GraphCli },
  content: string
): string {
  mkdirSync(dir, { recursive: true })
  const safe = key.nodeId.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64)
  const file = join(dir, `graph-context-${safe}-${key.cli}.md`)
  writeFileSync(file, content, 'utf-8')
  return file
}
