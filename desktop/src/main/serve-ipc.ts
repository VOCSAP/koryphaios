import type { ServeChannelStartResult, ServeChannelState, ServeStartRefusal } from '../shared/types'
import {
  resolveApprovedServeConfig,
  type ServeApprovalPrompt,
  type ServeConfigReadResult
} from './serve-config'
import type { ServeService } from './serve-service'

export interface ServeIpcDeps {
  /** Throws unless the directory is in the Deck's work-dir allow-set. */
  requireWorkDir(dir: unknown): Promise<string>
  sandboxEnabled(): boolean
  readServeConfig(dir: string): Promise<ServeConfigReadResult>
  projectKey(dir: string): string
  approvalsFile(): string
  confirm(prompt: ServeApprovalPrompt): boolean
  serve: Pick<ServeService, 'start' | 'stop' | 'state'>
  reportError(scope: string, message: string, error?: unknown): void
}

const SANDBOX_REFUSAL = 'starting a host server is refused in sandbox mode'

/**
 * The renderer only names a directory: the action is rebuilt here from the
 * serve.json on disk and approved again on every start, so no value from the
 * renderer reaches the spawn. A non-string directory is refused here because
 * the IPC requireWorkDir maps it to '', which resolves to the process cwd.
 */
export function createServeIpc(deps: ServeIpcDeps) {
  let servedDir: string | null = null

  const status = (): ServeChannelState => ({ ...deps.serve.state(), dir: servedDir })

  const refuse = (reason: ServeStartRefusal, message: string, error?: unknown): ServeChannelStartResult => {
    deps.reportError('serve', `serve start refused (${reason}): ${message}`, error)
    return { ok: false, reason, message, state: status() }
  }

  const start = async (requested: unknown): Promise<ServeChannelStartResult> => {
    if (typeof requested !== 'string' || requested === '') {
      return refuse('dir', 'the directory must be a non-empty string')
    }
    let dir: string
    try {
      dir = await deps.requireWorkDir(requested)
    } catch (error) {
      return refuse('dir', 'the directory is not one of this Deck project directories', error)
    }
    if (deps.sandboxEnabled()) return refuse('sandbox', SANDBOX_REFUSAL)
    const read = await deps.readServeConfig(dir)
    if ('error' in read) return refuse('config', `serve.json: ${read.error}`)
    const approval = resolveApprovedServeConfig({
      config: read.config,
      projectKey: deps.projectKey(dir),
      approvalsFile: deps.approvalsFile(),
      confirm: deps.confirm
    })
    if ('error' in approval) return refuse('refused', 'the operator refused this serve command')
    // The approval dialog can stay open while the operator turns the sandbox on.
    if (deps.sandboxEnabled()) return refuse('sandbox', SANDBOX_REFUSAL)
    const started = await deps.serve.start(approval.action)
    if (started.outcome === 'busy') return refuse('busy', 'a dev server is already running for this Deck')
    if (started.outcome === 'quitting') return refuse('quitting', 'the Deck is quitting')
    if (started.outcome === 'refused') return refuse('refused', 'the serve action was not approved')
    servedDir = dir
    if (started.state.status === 'failed') return refuse('failed', started.state.error ?? 'the dev server failed to start')
    return { ok: true, dir, state: { ...started.state, dir } }
  }

  const stop = async (): Promise<ServeChannelState> => {
    await deps.serve.stop()
    return status()
  }

  return { status, start, stop }
}
