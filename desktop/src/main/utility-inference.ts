import {
  buildAdapterCommand,
  buildClaudeAuthStatusCommand,
  buildClaudeHeadlessEnv,
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
  /** Question side. */
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
  run?: (command: string, env?: NodeJS.ProcessEnv) => Promise<string>
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
  // Claude receives the question on stdin rather than argv; codex and Gemini receive one stdin document.
  const content =
    target.cli === 'claude' ? req.system : composeStdinPrompt(req.system, req.prompt)
  const contextFile = writeContextFile(deps.stateDir, { nodeId: req.kind, cli: target.cli }, content)
  const promptFile =
    target.cli === 'claude'
      ? writeContextFile(deps.stateDir, { nodeId: `${req.kind}-prompt`, cli: target.cli }, req.prompt)
      : undefined
  const command = buildAdapterCommand({
    contextFile,
    promptFile,
    target,
    addDir: req.addDir,
    tools: req.kind === 'digest' ? 'none' : 'read-only'
  })
  const run =
    deps.run ??
    ((cmd: string, env?: NodeJS.ProcessEnv) =>
      runHelp({ command: cmd, shell: deps.shell, cwd: deps.cwd, timeoutMs: GRAPH_INFER_TIMEOUT_MS, env }))
  if (target.cli === 'claude') {
    const env = buildClaudeHeadlessEnv()
    try {
      await run(buildClaudeAuthStatusCommand(), env)
    } catch (err) {
      const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
      throw new Error(`Claude authentication check failed. Run \`claude auth login\` and try again${detail}`)
    }
    return run(command, env)
  }
  const exec = target.cli === 'antigravity' && deps.runTty ? deps.runTty : run
  return exec(command)
}
