import {
  resolveApprovedServeConfig,
  type ServeApprovalPrompt,
  type ServeConfigReadResult
} from './serve-config'
import type { ServeService, ServeState } from './serve-service'

export type ServeStartRefusal = 'dir' | 'sandbox' | 'config' | 'refused' | 'busy' | 'quitting' | 'failed'

export type ServeIpcStartResult =
  | { ok: true; dir: string; state: ServeState }
  | { ok: false; reason: ServeStartRefusal; message: string; state: ServeState }

export interface ServeIpcStatus extends ServeState {
  /** The directory of the last run this Deck started, null before the first. */
  dir: string | null
}

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

/**
 * The renderer only names a directory: the action is rebuilt here from the
 * serve.json on disk and approved again on every start, so no value from the
 * renderer reaches the spawn. A non-string directory is refused here because
 * the IPC requireWorkDir maps it to '', which resolves to the process cwd.
 */
export function createServeIpc(deps: ServeIpcDeps) {
  let servedDir: string | null = null

  const status = (): ServeIpcStatus => ({ ...deps.serve.state(), dir: servedDir })

  const refuse = (reason: ServeStartRefusal, message: string, error?: unknown): ServeIpcStartResult => {
    deps.reportError('serve', `serve start refused (${reason}): ${message}`, error)
    return { ok: false, reason, message, state: deps.serve.state() }
  }

  const start = async (requested: unknown): Promise<ServeIpcStartResult> => {
    if (typeof requested !== 'string' || requested === '') {
      return refuse('dir', 'the directory must be a non-empty string')
    }
    let dir: string
    try {
      dir = await deps.requireWorkDir(requested)
    } catch (error) {
      return refuse('dir', 'the directory is not one of this Deck project directories', error)
    }
    if (deps.sandboxEnabled()) return refuse('sandbox', 'starting a host server is refused in sandbox mode')
    const read = await deps.readServeConfig(dir)
    if ('error' in read) return refuse('config', `serve.json: ${read.error}`)
    const approval = resolveApprovedServeConfig({
      config: read.config,
      projectKey: deps.projectKey(dir),
      approvalsFile: deps.approvalsFile(),
      confirm: deps.confirm
    })
    if ('error' in approval) return refuse('refused', 'the operator refused this serve command')
    const started = await deps.serve.start(approval.action)
    if (started.outcome === 'busy') return refuse('busy', 'a dev server is already running for this Deck')
    if (started.outcome === 'quitting') return refuse('quitting', 'the Deck is quitting')
    if (started.outcome === 'refused') return refuse('refused', 'the serve action was not approved')
    servedDir = dir
    if (started.state.status === 'failed') return refuse('failed', started.state.error ?? 'the dev server failed to start')
    return { ok: true, dir, state: started.state }
  }

  const stop = async (): Promise<ServeIpcStatus> => {
    await deps.serve.stop()
    return status()
  }

  return { status, start, stop }
}
