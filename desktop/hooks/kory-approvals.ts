import type { On, ProcessRunInit, ProcessRunResult } from './claude-code-types.ts'

export const APPROVAL_MODULE_ENV = 'KORY_APPROVAL_MODULE'

export interface ApprovalHost {
  env: { get(name: string): Promise<string | undefined> }
  process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
  plugin: { root: string }
  ui: { log(text: string, options?: { to: 'debug' }): void }
}

export type AskedCall = { tool: string; tool_use_id: string }

/** Runs after the engine settled on `ask`, before the dialog opens; it cannot change the verdict. */
export type AskObserver = ($: ApprovalHost, call: AskedCall) => Promise<void>

export type ApprovalHelperOp = 'add' | 'wait' | 'withdraw'

const HELPER_TIMEOUT_MS = 30_000

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function approvalHelperPath(pluginRoot: string): string {
  return `${pluginRoot.replace(/[\\/]$/, '')}/hooks/approval-client.mjs`
}

/** Any failure (spawn, exit code, non-JSON, `ok: false`) is null: no verdict, never a refusal. */
export async function callApprovalHelper(
  $: ApprovalHost,
  op: ApprovalHelperOp,
  request: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const run = await $.process.run(['bun', approvalHelperPath($.plugin.root), op], {
      stdin: JSON.stringify(request),
      timeoutMs: HELPER_TIMEOUT_MS,
    })
    if (run.exitCode !== 0) {
      $.ui.log(`Kory approval helper ${op} exited ${run.exitCode}`, { to: 'debug' })
      return null
    }
    const output = JSON.parse(run.stdout) as unknown
    if (!output || typeof output !== 'object' || (output as { ok?: unknown }).ok !== true) {
      const error = (output as { error?: unknown } | null)?.error
      $.ui.log(`Kory approval helper ${op} failed: ${typeof error === 'string' ? error : 'no ok'}`, { to: 'debug' })
      return null
    }
    return output as Record<string, unknown>
  } catch (err) {
    $.ui.log(`Kory approval helper ${op} failed: ${errorText(err)}`, { to: 'debug' })
    return null
  }
}

export async function approvalModuleEnabled($: ApprovalHost): Promise<boolean> {
  return (await $.env.get(APPROVAL_MODULE_ENV)) === '1'
}

const logAsk: AskObserver = async ($, call) => {
  if (await approvalModuleEnabled($)) $.ui.log(`Kory approvals: ask for ${call.tool} ${call.tool_use_id}`, { to: 'debug' })
}

export function register(on: On, askObservers: readonly AskObserver[] = []): void {
  const observers = [logAsk, ...askObservers]

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || !e.tool_use_id) return verdict
    const call = { tool: e.tool, tool_use_id: e.tool_use_id }
    for (const observe of observers) {
      try {
        await observe($, call)
      } catch (err) {
        $.ui.log(`Kory ask observer failed: ${errorText(err)}`, { to: 'debug' })
      }
    }
    return verdict
  })

  on('tool.call', async (_$, e, next) => next(e))
}
