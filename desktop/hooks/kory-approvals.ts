import type { On, ProcessRunInit, ProcessRunResult } from './claude-code-types.ts'

export const APPROVAL_MODULE_ENV = 'KORY_APPROVAL_MODULE'

export interface ApprovalHost {
  env: { get(name: string): Promise<string | undefined> }
  process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
  plugin: { root: string }
  ui: { log(text: string, options?: { to: 'debug' }): void }
}

export const EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function approvalModuleEnabled($: ApprovalHost): Promise<boolean> {
  return (await $.env.get('KORY_APPROVAL_MODULE')) === '1'
}

export function register(on: On): void {
  on('tool.check', async ($, e, next) => {
    const v = await next(e)
    if (v.decision === 'ask' && e.tool_use_id && !EXCLUDED_TOOLS.has(e.tool)) {
      try {
        if (await approvalModuleEnabled($)) {
          $.ui.log('Kory approvals: permission deferred to PermissionRequest hook', { to: 'debug' })
        }
      } catch (err) {
        $.ui.log(`Kory approvals: permission defer failed: ${errorText(err)}`, { to: 'debug' })
      }
    }
    return v
  })

  on('tool.call', async (_$, e, next) => next(e))
}
