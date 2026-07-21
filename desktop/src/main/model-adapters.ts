// Headless CLI adapters for graph chat inference (EXPLORATION-graph-chat C24).
//
// Generalization of the C9 skeleton (help-assistant): one stateless throwaway
// invocation per assistant node, run through runHelp's shell wrap + profile
// noise marker. Three adapters share one contract:
//
// - The compiled context ALWAYS travels by FILE, never on the command line
//   (decision D5 — a 50k-char context would blow Windows' ~32k limit):
//   * claude: constant system prompt + context in --append-system-prompt-file,
//     the (short) question as the positional prompt — the C9 pattern.
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
import { join } from 'node:path'
import { HELP_DISALLOWED_TOOLS } from './help-assistant'
import { quotePromptArg } from './session-command'
import type { GraphCli, ModelTarget } from '../shared/graph'

/** Per-inference timeout: long contexts + reasoning models outlive C9's 120 s. */
export const GRAPH_INFER_TIMEOUT_MS = 300_000

/** The question rides the command line (claude adapter): keep it bounded. */
export const MAX_PROMPT_ARG_CHARS = 8000

/**
 * `model` also rides the command line: allow only benign identifier chars
 * ('' = omit the flag, the CLI's default model applies).
 */
export function sanitizeModel(model: string): string {
  return /^[A-Za-z0-9._:-]{0,128}$/.test(model) ? model : ''
}

/** Windows-safe double-quoted path (paths come from the app, not the user). */
function quotedPath(p: string): string {
  return `"${p.replace(/"/g, '')}"`
}

/**
 * Cross-shell "feed this file to stdin" wrapper. POSIX shells support
 * redirection; PowerShell (the win32 shell wrap) needs a Get-Content pipe.
 */
export function stdinFromFile(command: string, file: string, plat: NodeJS.Platform): string {
  if (plat === 'win32') return `Get-Content -Raw ${quotedPath(file)} | ${command}`
  return `${command} < ${quotedPath(file)}`
}

export interface AdapterInput {
  /** Question / instruction of the node being inferred (short side). */
  promptText: string
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
  const prompt = input.promptText.slice(0, MAX_PROMPT_ARG_CHARS)
  switch (input.target.cli) {
    case 'claude': {
      const bin = input.bin?.trim() || 'claude'
      return (
        `${bin} -p ${quotePromptArg(prompt, plat)}` +
        ` --append-system-prompt-file ${quotedPath(input.contextFile)}` +
        (model ? ` --model ${model}` : '') +
        (input.addDir ? ` --add-dir ${quotedPath(input.addDir)}` : '') +
        ` --strict-mcp-config` +
        ` --disallowedTools "${HELP_DISALLOWED_TOOLS}"`
      )
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
