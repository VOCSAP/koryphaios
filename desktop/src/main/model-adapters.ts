import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HELP_DISALLOWED_TOOLS } from './help-assistant'
import { quotePromptArg } from './session-command'
import type { GraphCli, ModelTarget } from '../shared/graph'

/** Per-inference timeout: long contexts + reasoning models outlive C9's 120 s. */
export const GRAPH_INFER_TIMEOUT_MS = 300_000

const CLAUDE_HEADLESS_ENV_ALLOW = new Set([
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH'
])

const CLAUDE_HEADLESS_ENV_PREFIX_ALLOW = ['AWS_', 'GOOGLE_', 'CLOUD_']

/** Preserve only approved runtime, authentication, network and cloud-provider settings. */
export function buildClaudeHeadlessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    const upperKey = key.toUpperCase()
    if (
      value !== undefined &&
      (CLAUDE_HEADLESS_ENV_ALLOW.has(upperKey) || CLAUDE_HEADLESS_ENV_PREFIX_ALLOW.some((prefix) => upperKey.startsWith(prefix)))
    ) {
      env[key] = value
    }
  }
  env.NoDefaultCurrentDirectoryInExePath = '1'
  return env
}

export function buildClaudeAuthStatusCommand(bin = 'claude'): string {
  return `${bin.trim() || 'claude'} --safe-mode --setting-sources= auth status`
}

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

// PowerShell must force UTF-8 for both file decoding and native-child stdin.
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
   * File carrying the operator's question, fed to Claude via stdin instead of argv.
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
  /** Read-only tools permit project inspection without mutation. */
  tools?: 'none' | 'read-only'
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
      const tools = input.tools ?? 'none'
      const cmd =
        `${bin} -p` +
        ` --append-system-prompt-file ${quotedPath(input.contextFile)}` +
        (model ? ` --model ${model}` : '') +
        (input.addDir ? ` --add-dir ${quotedPath(input.addDir)}` : '') +
        (tools === 'read-only' ? ` --disallowedTools "${HELP_DISALLOWED_TOOLS}"` : ` --tools=`) +
        ` --strict-mcp-config --safe-mode --setting-sources=`
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
