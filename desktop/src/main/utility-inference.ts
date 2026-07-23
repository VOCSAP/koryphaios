// One-shot utility inferences (lot A, EXPLORATION-multi-llm): the help
// assistant, the resume digest and the roadmap context wand generalized from
// `claude -p` to any ModelTarget of the unified catalog — frontier CLIs
// through the C24 adapters (read-only harness per CLI, context by FILE),
// local OpenAI-compatible endpoints over HTTP (C29).
//
// The system prompts stay CODE CONSTANTS composed by the callers (C8 rule);
// this module only routes { target, system, prompt } to the right executor.
// Node builtins only; both executors are injectable for tests.

import {
  buildAdapterCommand,
  GRAPH_INFER_TIMEOUT_MS,
  runHttpInference,
  writeContextFile,
  type HttpInferenceInput
} from './model-adapters'
import { runHelp } from './help-assistant'
import { markProviderUsed } from './usage-service'
import type { ModelTarget } from '../shared/graph'
import type { LocalProviderConfig } from '../shared/models'

/** The three utility flows; discriminates their context files on disk. */
export type UtilityKind = 'help' | 'wand' | 'digest'

export interface UtilityInferenceRequest {
  target: ModelTarget
  /** System side: code-constant prompt + app-generated context. */
  system: string
  /** Question side (short; rides the command line on the claude adapter). */
  prompt: string
  kind: UtilityKind
  /** Extra readable directory (claude --add-dir): the shipped reference docs. */
  addDir?: string
}

export interface UtilityDeps {
  /** App-state dir the context files are written under. */
  stateDir: string
  shell: string
  cwd: string
  /** Configured local endpoints, keys DECRYPTED (ipc passes decryptProviders). */
  localProviders?: LocalProviderConfig[]
  /** Injectable for tests; defaults to runHelp with the graph timeout. */
  run?: (command: string) => Promise<string>
  /**
   * PTY-backed runner for CLIs that misbehave without a TTY (antigravity —
   * agy#318/#76). Optional: absent (tests), those targets use `run`.
   */
  runTty?: (command: string) => Promise<string>
  /** Injectable for tests; defaults to runHttpInference. */
  http?: (input: HttpInferenceInput) => Promise<string>
}

/** Composed prompt for the stdin CLIs (codex/gemini — no system flag, D5). */
export function composeStdinPrompt(system: string, prompt: string): string {
  return `${system}\n\n## Operator's message (answer this)\n\n${prompt}`
}

/**
 * Run one utility inference against its configured target. Rejections carry
 * the executor's readable error (CLI stderr / HTTP status) — the callers
 * surface them to the operator, nothing is swallowed here.
 */
export async function runUtilityInference(
  deps: UtilityDeps,
  req: UtilityInferenceRequest
): Promise<string> {
  const { target } = req
  markProviderUsed(target.cli) // feed the amphora gauge
  if (target.cli === 'local') {
    const provider = (deps.localProviders ?? []).find((p) => p.id === target.providerId)
    if (!provider) throw new Error(`unknown local provider ${target.providerId ?? '?'}`)
    const http = deps.http ?? runHttpInference
    return http({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: target.model,
      system: req.system,
      prompt: req.prompt
    })
  }
  // claude keeps system and question separated (--append-system-prompt-file +
  // positional prompt); codex/gemini read one composed document from stdin.
  const content =
    target.cli === 'claude' ? req.system : composeStdinPrompt(req.system, req.prompt)
  const contextFile = writeContextFile(deps.stateDir, { nodeId: req.kind, cli: target.cli }, content)
  const command = buildAdapterCommand({
    promptText: req.prompt,
    contextFile,
    target,
    addDir: req.addDir
  })
  const run =
    deps.run ??
    ((cmd: string) =>
      runHelp({ command: cmd, shell: deps.shell, cwd: deps.cwd, timeoutMs: GRAPH_INFER_TIMEOUT_MS }))
  const exec = target.cli === 'antigravity' && deps.runTty ? deps.runTty : run
  return exec(command)
}
