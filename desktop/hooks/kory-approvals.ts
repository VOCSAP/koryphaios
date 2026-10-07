import { APPROVAL_QUESTION_MAX, capVisibly } from '../../shared/approval.ts'
import { verdictOf } from './approval-verdict.ts'
import type { On, ProcessRunInit, ProcessRunResult, ToolCheckInput, ToolCheckResult } from './claude-code-types.ts'
import { summarizeToolInput } from './tool-summary.ts'

export const APPROVAL_MODULE_ENV = 'KORY_APPROVAL_MODULE'

export interface ApprovalHost {
  env: { get(name: string): Promise<string | undefined> }
  process: { run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> }
  plugin: { root: string }
  ui: { log(text: string, options?: { to: 'debug' }): void }
  clock: { now(): Promise<number> }
  session: { cwd(): Promise<string> }
}

export type ApprovalHelperOp = 'add' | 'wait' | 'withdraw'

const HELPER_TIMEOUT_MS = 30_000

/** Their native dialog stays open whatever tool.check returns, so the module never serves them. */
export const EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

export const VERDICT_WAIT_SEC = 25
export const VERDICT_CEILING_MS = 30 * 60_000

// Shown to the model and on the tile; never the operator's free text.
export const ALLOW_REASON = 'Allowed by the operator from Koryphaios'
export const DENY_REASON = 'Denied by the operator from Koryphaios'

// Bidi and other format characters reorder what the operator reads (CWE-451); such a call goes to the native menu, never stripped.
const FORMAT_CHARS = /[\p{Cf}\p{Zl}\p{Zp}]/u

// The display drops C0 controls the tool still executes, so a call carrying one is not served either.
const CONTROL_CHARS = /(?![\n\t])\p{Cc}/u

function hasControlChars(value: unknown): boolean {
  if (typeof value === 'string') return CONTROL_CHARS.test(value)
  if (Array.isArray(value)) return value.some(hasControlChars)
  if (isRecord(value)) return Object.entries(value).some(([k, v]) => CONTROL_CHARS.test(k) || hasControlChars(v))
  return false
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

// The engine's module loader takes only a string literal here, never APPROVAL_MODULE_ENV.
export async function approvalModuleEnabled($: ApprovalHost): Promise<boolean> {
  return (await $.env.get('KORY_APPROVAL_MODULE')) === '1'
}

/** The command first, verbatim: it is what the operator decides on, `cd X &&` included. */
export function permissionQuestion(input: unknown, dir: string): string {
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : ''
  const json = JSON.stringify(input) ?? ''
  const lines = [command, dir ? `Dir: ${dir}` : '', json ? `Input: ${json}` : '']
  return capVisibly(lines.filter(Boolean).join('\n'), APPROVAL_QUESTION_MAX)
}

/** The session's directory, following earlier `cd`s; '' when the host cannot say. */
async function sessionDir($: ApprovalHost): Promise<string> {
  try {
    const dir = await $.session.cwd()
    if (!/[\r\n]/.test(dir)) return dir
    $.ui.log('Kory approvals: session cwd spans lines, Dir omitted', { to: 'debug' })
    return ''
  } catch (err) {
    $.ui.log(`Kory approvals: no session cwd: ${errorText(err)}`, { to: 'debug' })
    return ''
  }
}

// The loader refuses $ passed to anything but a top-level function declaration: no observer list, no const arrow.
async function awaitPermissionVerdict(
  $: ApprovalHost,
  signal: AbortSignal,
  v: ToolCheckResult,
  id: string,
  secret: string,
): Promise<ToolCheckResult> {
  const deadline = (await $.clock.now()) + VERDICT_CEILING_MS
  while (!signal.aborted && (await $.clock.now()) < deadline) {
    const out = await callApprovalHelper($, 'wait', { id, producer_secret: secret, timeout_sec: VERDICT_WAIT_SEC })
    if (signal.aborted) break
    const verdict = verdictOf(id, out)
    if (verdict.kind === 'allow') return { decision: 'allow', reason: ALLOW_REASON }
    if (verdict.kind === 'deny') return { decision: 'deny', reason: DENY_REASON }
    if (verdict.kind === 'none') break
  }
  return withdrawOrLateVerdict($, v, id, secret, !signal.aborted)
}

/**
 * A failed withdraw may mean the operator answered just before it: read the
 * verdict once and apply it. Never after Escape, which cancelled the call.
 */
async function withdrawOrLateVerdict(
  $: ApprovalHost,
  v: ToolCheckResult,
  id: string,
  secret: string,
  readLate: boolean,
): Promise<ToolCheckResult> {
  const withdrawn = await callApprovalHelper($, 'withdraw', { id, producer_secret: secret })
  if (withdrawn || !readLate) return v
  const late = verdictOf(id, await callApprovalHelper($, 'wait', { id, producer_secret: secret, timeout_sec: 0 }))
  if (late.kind === 'allow') return { decision: 'allow', reason: ALLOW_REASON }
  if (late.kind === 'deny') return { decision: 'deny', reason: DENY_REASON }
  return v
}

/** Every path but an operator's allow or deny returns `v`, next's own verdict: the native menu then opens. */
async function servePermission(
  $: ApprovalHost,
  e: ToolCheckInput,
  v: ToolCheckResult,
  signal: AbortSignal,
): Promise<ToolCheckResult> {
  if (hasControlChars(e.input)) {
    $.ui.log('Kory approvals: control characters in the call, left to the native menu', { to: 'debug' })
    return v
  }
  const title = summarizeToolInput(e.tool, isRecord(e.input) ? e.input : undefined)
  const question = permissionQuestion(e.input, await sessionDir($))
  if (FORMAT_CHARS.test(title) || FORMAT_CHARS.test(question)) {
    $.ui.log('Kory approvals: format characters in the call, left to the native menu', { to: 'debug' })
    return v
  }
  const added = await callApprovalHelper($, 'add', { kind: 'permission', title, question, options: ['Allow', 'Deny'] })
  const id = typeof added?.id === 'string' ? added.id : ''
  if (!id || added?.reply_route !== 'hook') return v
  const secret = typeof added.producer_secret === 'string' ? added.producer_secret : ''
  try {
    return await awaitPermissionVerdict($, signal, v, id, secret)
  } catch (err) {
    $.ui.log(`Kory permission wait failed: ${errorText(err)}`, { to: 'debug' })
    return withdrawOrLateVerdict($, v, id, secret, !signal.aborted)
  }
}

export function register(on: On): void {
  on('tool.check', async ($, e, next) => {
    const v = await next(e)
    if (v.decision !== 'ask' || !e.tool_use_id || EXCLUDED_TOOLS.has(e.tool)) return v
    try {
      if (!(await approvalModuleEnabled($))) return v
      return await servePermission($, e, v, next.signal)
    } catch (err) {
      $.ui.log(`Kory approvals failed: ${errorText(err)}`, { to: 'debug' })
      return v
    }
  })

  on('tool.call', async (_$, e, next) => next(e))
}
