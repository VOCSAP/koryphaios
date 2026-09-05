// clodex is a PROVIDER, not a CLI: its `clodex-claude` wrapper launches the
// operator's real `claude` binary against a local proxy, so an OpenAI model
// reaches a session as `--model clodex:<provider>:<model>` on a Claude Code
// command line. Offering that section means answering four questions: is the
// wrapper on PATH, is the proxy up, which models does the current clodex
// config resolve to, and does the patched binary still match the installed
// claude. All IO is injected so the decisions are exercised under `bun test`
// without electron and without spawning anything.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reportError } from './log'
import { buildDetectCommand } from './model-registry'
import { CLODEX_WRAPPER_BIN } from './session-kind'
import { buildShellInvocation } from './shell-command'
import type { BridgeState, ModelEntry } from '../shared/models'

/** Error scope of every trace emitted by this module. */
const SCOPE = 'clodex'

/** clodex's own CLI, which owns the resolved model list. */
const CLODEX_BIN = 'clodex'
/** The binary the wrapper patches; its version decides the patch freshness. */
const CLAUDE_BIN = 'claude'

/** Same allow-list as sanitizeFlagValue: an id ends up on a shell command line. */
export const CLODEX_MODEL_ID_RE = /^[A-Za-z0-9._:@/[\]-]{1,128}$/

/** A picker section stays scannable; a runaway config cannot flood it. */
export const MAX_CLODEX_MODELS = 20

const SEMVER_RE = /\d+\.\d+\.\d+/

const PROBE_TIMEOUT_MS = 15_000

export interface ClodexProbeResult {
  state: BridgeState
  models: ModelEntry[]
}

/** Injected IO: every subprocess, file read and trace of the probe. */
export interface ClodexDeps {
  /** Is `bin` on the operator's PATH (login shell, like the CLI detection)? */
  probeBin(bin: string): Promise<boolean>
  /** Run a fixed command with fixed args; never rejects for a non-zero exit. */
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>
  /** File content, or null when the file does not exist. Throws on any other failure. */
  readFile(path: string): string | null
  env: NodeJS.ProcessEnv
  onError(scope: string, message: string, err?: unknown): void
}

/**
 * Wrapper absent, or the probe itself unusable: the section is not offered.
 * The patch state stays 'unknown' rather than 'none' — nothing was read.
 */
export function absentBridge(): ClodexProbeResult {
  return { state: { installed: false, serverUp: false, patch: 'unknown' }, models: [] }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * clodex's own home resolution, so the Deck reads the same manifest the
 * wrapper wrote: `$CLODEX_HOME` when set, else `~/.clodex`.
 */
export function clodexHome(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.CLODEX_HOME) ?? join(homedir(), '.clodex')
}

/** Manifest written by `clodex patch`, holding the patched claude version. */
export function clodexManifestPath(env: NodeJS.ProcessEnv): string {
  return join(clodexHome(env), 'patch-state.json')
}

/**
 * Parse one `clodex models --json` line (an array of resolved model metadata)
 * into picker entries. The id is what reaches `--model`, so an entry whose id
 * is missing, mistyped or outside the flag allow-list is DROPPED rather than
 * shown: picking it would silently produce a command line without a model.
 * An unparseable or non-array payload throws — the caller traces it.
 */
export function parseClodexModels(raw: string): ModelEntry[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('clodex models --json did not return a JSON array')
  }
  const out: ModelEntry[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (out.length >= MAX_CLODEX_MODELS) break
    if (!item || typeof item !== 'object') continue
    const entry = item as {
      id?: unknown
      alias?: unknown
      displayName?: unknown
      modelId?: unknown
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!CLODEX_MODEL_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    const alias = nonEmpty(entry.alias)
    const displayName = nonEmpty(entry.displayName)
    const label = alias
      ? `${alias} · ${displayName ?? nonEmpty(entry.modelId) ?? id}`
      : (displayName ?? id)
    out.push({ id, label })
  }
  return out
}

/**
 * Compare the claude version recorded by `clodex patch` with the installed
 * one. 'none' = never patched, 'unknown' = one of the two could not be read
 * (the caller traces that case; the operator sees an inconclusive badge, never
 * a false 'fresh').
 */
export function patchStateFor(
  manifestJson: string | null,
  claudeVersionOutput: string | null
): BridgeState['patch'] {
  if (manifestJson === null) return 'none'
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestJson)
  } catch {
    // A truncated or hand-edited manifest decides nothing; the caller traces it.
    return 'unknown'
  }
  const recorded =
    manifest && typeof manifest === 'object'
      ? (manifest as { claudeVersion?: unknown }).claudeVersion
      : undefined
  if (typeof recorded !== 'string') return 'unknown'
  const patched = SEMVER_RE.exec(recorded)?.[0]
  const installed =
    typeof claudeVersionOutput === 'string' ? SEMVER_RE.exec(claudeVersionOutput)?.[0] : undefined
  if (!patched || !installed) return 'unknown'
  return patched === installed ? 'fresh' : 'stale'
}

async function probePatchState(deps: ClodexDeps): Promise<BridgeState['patch']> {
  const path = clodexManifestPath(deps.env)
  let manifest: string | null
  try {
    manifest = deps.readFile(path)
  } catch (err) {
    deps.onError(SCOPE, `patch manifest ${path} could not be read`, err)
    return 'unknown'
  }
  if (manifest === null) return 'none'

  let version: string | null = null
  try {
    const result = await deps.run(CLAUDE_BIN, ['--version'])
    if (result.code === 0) version = result.stdout
    else deps.onError(SCOPE, `\`claude --version\` exited with code ${result.code}`)
  } catch (err) {
    deps.onError(SCOPE, '`claude --version` could not be run', err)
  }

  const state = patchStateFor(manifest, version)
  if (state === 'unknown') {
    deps.onError(SCOPE, `patch freshness undecidable from ${path} and \`claude --version\``)
  }
  return state
}

/**
 * Full bridge probe. An absent wrapper short-circuits (nothing else is worth
 * spawning); every later step degrades on its own — a dead proxy still lists
 * models, an unreadable model list still reports the proxy — and each failure
 * leaves a trace, so a silently empty section never passes for "no models".
 */
export async function probeClodex(deps: ClodexDeps): Promise<ClodexProbeResult> {
  let installed = false
  try {
    installed = await deps.probeBin(CLODEX_WRAPPER_BIN)
  } catch (err) {
    deps.onError(SCOPE, `PATH probe for \`${CLODEX_WRAPPER_BIN}\` failed`, err)
  }
  if (!installed) return absentBridge()

  let serverUp = false
  try {
    const check = await deps.run(CLODEX_WRAPPER_BIN, ['--check'])
    serverUp = check.code === 0
  } catch (err) {
    deps.onError(SCOPE, `\`${CLODEX_WRAPPER_BIN} --check\` could not be run`, err)
  }

  let models: ModelEntry[] = []
  try {
    const listed = await deps.run(CLODEX_BIN, ['models', '--json'])
    if (listed.code === 0) models = parseClodexModels(listed.stdout)
    else deps.onError(SCOPE, `\`clodex models --json\` exited with code ${listed.code}`)
  } catch (err) {
    deps.onError(SCOPE, '`clodex models --json` returned an unusable payload', err)
    models = []
  }

  const patch = await probePatchState(deps)
  return { state: { installed, serverUp, patch }, models }
}

/**
 * Production IO: login-shell subprocesses, same PATH resolution as the
 * frontier CLI detection (a GUI app inherits none of the operator's shell
 * PATH). Command lines are built from module constants only — nothing
 * operator-, repo- or agent-supplied is interpolated into them.
 */
export function defaultClodexDeps(shell: string): ClodexDeps {
  const runLine = (command: string): Promise<{ code: number; stdout: string }> => {
    const inv = buildShellInvocation({ command, shell, interactive: false })
    return new Promise((resolve) => {
      execFile(inv.file, inv.args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
        const code = (err as { code?: unknown } | null)?.code
        resolve({ code: err ? (typeof code === 'number' ? code : 1) : 0, stdout: stdout ?? '' })
      })
    })
  }
  return {
    probeBin: async (bin) => (await runLine(buildDetectCommand(bin))).code === 0,
    run: (cmd, args) => runLine([cmd, ...args].join(' ')),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf-8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    env: process.env,
    onError: reportError
  }
}
