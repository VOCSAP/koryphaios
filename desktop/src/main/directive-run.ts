import type { DirectiveDispatch, SessionRuntime, UnreachedDirectiveTarget } from '../shared/types'
import type { OperatorTrustStatus } from './approval-service'
import type { MagicCompactMode } from './launch-config'
import type { DirectiveOutcome } from './session-service'
import {
  DIRECTIVE_ACCEPTS_PROMPT,
  directiveCommands,
  directiveKeys,
  isDirectiveCommand,
  isRoadmapDirectiveCommand,
  type DeckDirective,
  PEER_ID_RE,
  resolveDirectiveTargets
} from './directive'
import { ContextResumeUnsupportedError, type ContextResumeDelivery } from './broker-client'
import { unreachedTargets, unreachedTargetsText } from './directive-journal'
import { isDepositIdShape } from '../../../shared/context-deposit-id'
import { CONTEXT_CLEAR_IDLE_WAIT_MS } from '../../../shared/context-timing'

export const DIRECTIVE_PROMPT_MAX = 500
export const DIRECTIVE_MAX_TARGETS = 16
export const CLEAR_RELOAD_WORKSTREAM_MAX = 64
export const CLEAR_RELOAD_WORKSTREAM_RE = /^[a-z0-9-]{1,64}$/
/**
 * How long deck_run_directive waits for injection outcomes before reporting a
 * target pending. Far below the 120 s idle wait on purpose: a caller targeting
 * its own tile keeps it busy for as long as the tool call lasts.
 */
export const DIRECTIVE_REPORT_WAIT_MS = 5_000
/** How long injectCommand waits for a busy tile to fall idle before 'busy-timeout'. */
export const DIRECTIVE_IDLE_WAIT_MS = CONTEXT_CLEAR_IDLE_WAIT_MS

export interface DirectiveRunDeps {
  listSessions(): SessionRuntime[]
  injectCommand(tileId: string, keys: string): Promise<DirectiveOutcome>
  /** Resolves with the outcome of the command that ends the sequence. */
  runMagicCompact(tileId: string, peerId: string, useMagic: boolean, mode: MagicCompactMode): Promise<DirectiveOutcome>
  runClearReload(tileId: string, peerId: string, workstream: string, contextDepositId?: string): Promise<DirectiveOutcome>
  /** Called once per run, and only for magic_compact. */
  resolveMagic(): { useMagic: boolean; mode: MagicCompactMode }
  journal(line: string): void
  reportError(message: string, error?: unknown): void
}

export interface ClearReloadHost {
  serializeTile<T>(id: string, fn: (inject: (keys: string) => Promise<DirectiveOutcome>) => Promise<T>): Promise<T>
  currentSessionId?(tileId: string): string
  /** Asked afresh on every context clear: the broker answering now may not be the one checked at startup. */
  checkOperatorTrust?(): Promise<OperatorTrustStatus>
  /** Throws unless the broker answering now serves context resume; asked afresh before every reservation. */
  checkContextResumeSupport?(): Promise<void>
  reserveContextDeposit?(depositId: string, targetPeerId: string): Promise<string>
  readClearBackchannelBaseline?(tileId: string): string | null
  waitForClearBackchannel?(tileId: string, currentSessionId: string, baselineSessionId: string | null): Promise<void>
  /** `cleared` is true only once the new clear rotation has been observed. */
  releaseContextDeposit?(depositId: string, attemptId: string, cleared: boolean): Promise<ContextResumeDelivery | void>
  reportError?(message: string, error?: unknown): void
}

interface ClearReloadOptions {
  contextDepositId?: string
}

export function runClearReloadInTurn(
  host: ClearReloadHost,
  journal: (line: string) => void,
  tileId: string,
  peerId: string,
  workstream: string,
  announceFailure?: (peerId: string, outcome: Exclude<DirectiveOutcome, 'written'>) => void,
  options: ClearReloadOptions = {}
): Promise<DirectiveOutcome> {
  return host.serializeTile(tileId, async (inject) => {
    if (!options.contextDepositId) {
      const cleared = await inject('/clear')
      if (cleared !== 'written') {
        journal(`clear_reload -> "${peerId}": /clear not injected (${cleared})`)
        announceFailure?.(peerId, cleared)
        return cleared
      }
      const reloaded = await inject(
        `Reprends le workstream "${workstream}". D’abord, appelle handoffs_latest(project, workstream) avec project et workstream="${workstream}". Ensuite, appelle check_messages et lis tous les messages reçus. Seulement après ces deux étapes, appelle send_message. Retrouve dans le handoff la prochaine tâche puis exécute-la.`
      )
      journal(`clear_reload -> "${peerId}": ${reloaded}`)
      return reloaded
    }

    const readClearBackchannelBaseline = host.readClearBackchannelBaseline
    if (
      !host.currentSessionId ||
      !host.checkOperatorTrust ||
      !host.checkContextResumeSupport ||
      !host.reserveContextDeposit ||
      !readClearBackchannelBaseline ||
      !host.waitForClearBackchannel ||
      !host.releaseContextDeposit
    ) {
      throw new Error('context clear host is incomplete')
    }
    let attemptId: string | undefined
    let rotationObserved = false
    try {
      const trust = await host.checkOperatorTrust()
      if (trust !== 'compatible') throw new Error(`operator trust is ${trust}; context clear refused`)
      await host.checkContextResumeSupport()
      const currentSessionId = host.currentSessionId(tileId)
      attemptId = await host.reserveContextDeposit(options.contextDepositId, peerId)
      const baselineSessionId = readClearBackchannelBaseline(tileId)
      const cleared = await inject('/clear')
      if (cleared !== 'written') {
        const error = new Error(`/clear not injected (${cleared})`)
        journal(`clear_reload -> "${peerId}": /clear not injected (${cleared})`)
        host.reportError?.(`context clear failed for "${peerId}": ${error.message}`, error)
        announceFailure?.(peerId, cleared)
        return cleared
      }
      await host.waitForClearBackchannel(tileId, currentSessionId, baselineSessionId)
      rotationObserved = true
      return 'written'
    } catch (error) {
      host.reportError?.(`context clear failed for "${peerId}"`, error)
      throw error
    } finally {
      if (attemptId) {
        try {
          const resumeDelivery = await host.releaseContextDeposit(options.contextDepositId, attemptId, rotationObserved)
          if (rotationObserved && resumeDelivery === 'pending') {
            journal(`clear_reload -> "${peerId}": resume delivery pending until WebSocket reconnects`)
            host.reportError?.(`context resume for "${peerId}" is pending until WebSocket reconnects`)
          } else if (rotationObserved && resumeDelivery === 'sent') {
            journal(`clear_reload -> "${peerId}": written`)
          } else if (rotationObserved) {
            const error = new Error('context resume status unknown')
            host.reportError?.(`context resume status unknown for "${peerId}"`, error)
          }
        } catch (error) {
          host.reportError?.(
            rotationObserved ? `context resume status unknown for "${peerId}"` : `context clear failed for "${peerId}"`,
            error
          )
          throw error
        }
      }
    }
  })
}

type DirectiveTarget = { tileId: string; peerId: string }

/**
 * 'refused-modal' also covers needsAttention and rateLimited; 'error' is a rejected injection;
 * 'context_resume_unsupported' is a context clear the broker or the target's server cannot resume.
 */
export type DirectiveRefusalReason = Exclude<DirectiveOutcome, 'written'> | 'error' | 'context_resume_unsupported'

type SettledOutcome = DirectiveOutcome | 'error' | 'context_resume_unsupported'

/**
 * deck_run_directive's result: `injected` holds only targets whose command was
 * written; `pending` did not settle within DIRECTIVE_REPORT_WAIT_MS and is
 * still queued behind the tile's idle wait or turn.
 */
export interface DeckDirectiveRunResult {
  injected: DirectiveTarget[]
  refused: (DirectiveTarget & { reason: DirectiveRefusalReason })[]
  pending: DirectiveTarget[]
  unreached: UnreachedDirectiveTarget[]
  error?: 'directive execution failed'
}

interface DirectiveLaunch {
  launched: (DirectiveTarget & { outcome: Promise<SettledOutcome> })[]
  unreached: UnreachedDirectiveTarget[]
  error?: 'directive execution failed'
}

interface DirectiveRunOptions {
  reportWaitMs?: number
  contextDepositId?: string
}

const LINE_BREAKS = new Set([0x0a, 0x0d, 0x09, 0x2028, 0x2029])
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x115f],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0x3164, 0x3164],
  [0xe0000, 0xe007f],
  [0xfeff, 0xfeff]
]

/**
 * One line of plain text: line breaks and tabs become one space each (a CRLF
 * pair counts once), every other C0/C1 control, bidi control and zero-width
 * character is dropped, and the result is trimmed.
 */
export function sanitizeDirectivePrompt(raw: string): string {
  let out = ''
  let previous = -1
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0
    if (LINE_BREAKS.has(cp)) {
      if (!(cp === 0x0a && previous === 0x0d)) out += ' '
    } else if (!STRIPPED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) {
      out += ch
    }
    previous = cp
  }
  return out.trim()
}

export interface RunDirectiveArgs {
  directive: DeckDirective
  peerIds: string[]
  prompt: string | undefined
  workstream: string | undefined
  contextDepositId?: string
}

const CONTEXT_DEPOSIT_ALIASES = ['contextDepositId', 'deposit_id'] as const

/** Validates deck_run_directive's raw arguments; throws a message meant for the calling agent. */
export function parseRunDirectiveArgs(args: Record<string, unknown>): RunDirectiveArgs {
  for (const alias of CONTEXT_DEPOSIT_ALIASES) {
    if (alias in args) throw new Error(`${alias} is not accepted; use context_deposit_id`)
  }
  const directive = args['directive']
  if (!isDirectiveCommand(directive)) {
    throw new Error(`directive must be one of: ${directiveCommands().join(', ')}`)
  }
  const peerIds = args['peer_ids']
  if (
    !Array.isArray(peerIds) ||
    peerIds.length === 0 ||
    peerIds.length > DIRECTIVE_MAX_TARGETS ||
    !peerIds.every((p): p is string => typeof p === 'string')
  ) {
    throw new Error(`peer_ids must be a non-empty array of at most ${DIRECTIVE_MAX_TARGETS} peer_id strings`)
  }
  const normalizedPeerIds = peerIds.map((peerId) => peerId.trim())
  if (
    normalizedPeerIds.some((peerId) => !PEER_ID_RE.test(peerId)) ||
    new Set(normalizedPeerIds).size !== normalizedPeerIds.length
  ) {
    throw new Error('peer_ids must contain unique valid peer_id strings')
  }
  const rawDepositId = args['context_deposit_id']
  let contextDepositId: string | undefined
  if (rawDepositId !== undefined) {
    if (directive !== 'clear_reload') throw new Error('context_deposit_id is only valid for clear_reload')
    if (normalizedPeerIds.length !== 1) throw new Error('context_deposit_id requires exactly one peer_id')
    if (!isDepositIdShape(rawDepositId)) throw new Error('context_deposit_id is not a valid deposit id')
    contextDepositId = rawDepositId
  }
  const rawPrompt = args['prompt']
  const rawWorkstream = args['workstream']
  if (directive === 'clear_reload') {
    if (rawPrompt !== undefined && rawPrompt !== null) {
      throw new Error(`directive "${directive}" does not accept a prompt`)
    }
    if (typeof rawWorkstream !== 'string' || !CLEAR_RELOAD_WORKSTREAM_RE.test(rawWorkstream)) {
      throw new Error(
        `workstream must be 1 to ${CLEAR_RELOAD_WORKSTREAM_MAX} lowercase letters, digits, or hyphens`
      )
    }
    return {
      directive,
      peerIds: normalizedPeerIds,
      prompt: undefined,
      workstream: rawWorkstream,
      ...(contextDepositId ? { contextDepositId } : {})
    }
  }
  if (rawWorkstream !== undefined && rawWorkstream !== null) {
    throw new Error('workstream is only valid for clear_reload')
  }
  if (rawPrompt !== undefined && rawPrompt !== null && typeof rawPrompt !== 'string') {
    throw new Error('prompt must be a string')
  }
  const prompt = typeof rawPrompt === 'string' ? sanitizeDirectivePrompt(rawPrompt) : ''
  if (!prompt) return { directive, peerIds: normalizedPeerIds, prompt: undefined, workstream: undefined }
  if (!DIRECTIVE_ACCEPTS_PROMPT[directive]) {
    throw new Error(`directive "${directive}" does not accept a prompt`)
  }
  const promptLength = [...prompt].length
  if (promptLength > DIRECTIVE_PROMPT_MAX) {
    throw new Error(`prompt is ${promptLength} characters, the limit is ${DIRECTIVE_PROMPT_MAX}`)
  }
  return { directive, peerIds: normalizedPeerIds, prompt, workstream: undefined }
}

function reportDirectiveError(deps: DirectiveRunDeps, message: string, error: unknown): void {
  deps.reportError(message, error)
}

function failedDeckDirectiveRun(deps: DirectiveRunDeps, error: unknown): DeckDirectiveRunResult {
  reportDirectiveError(deps, 'directive execution failed', error)
  return { injected: [], refused: [], pending: [], unreached: [], error: 'directive execution failed' }
}

function launchDirective(
  cmd: DeckDirective,
  peerIds: string[],
  prompt: string | undefined,
  label: string,
  deps: DirectiveRunDeps,
  options: DirectiveRunOptions
): DirectiveLaunch {
  const launched: DirectiveLaunch['launched'] = []
  try {
    const keys = directiveKeys(cmd)
    const clearReloadWorkstream = cmd === 'clear_reload' ? prompt : undefined
    if (cmd === 'clear_reload' && !clearReloadWorkstream) {
      throw new Error('clear_reload requires a workstream')
    }
    const typed = prompt ? `${keys} ${prompt}` : keys
    const { matched, missing, ambiguous } = resolveDirectiveTargets(peerIds, deps.listSessions())
    if (matched.length === 0) {
      const detail = unreachedTargetsText(missing, ambiguous) || `requested: ${peerIds.join(', ') || 'none'}`
      deps.journal(`directive ${keys} "${label}": ${detail}`)
      return { launched: [], unreached: unreachedTargets(missing, ambiguous) }
    }
    const magic = cmd === 'magic_compact' ? deps.resolveMagic() : null
    for (const t of matched) {
      if (magic) {
        const outcome = deps.runMagicCompact(t.id, t.peerId, magic.useMagic, magic.mode).catch((e): 'error' => {
          reportDirectiveError(deps, `magic_compact failed for "${t.peerId}"`, e)
          return 'error'
        })
        launched.push({ tileId: t.id, peerId: t.peerId, outcome })
      } else if (clearReloadWorkstream) {
        const outcome = deps.runClearReload(t.id, t.peerId, clearReloadWorkstream, options.contextDepositId).catch((e): SettledOutcome => {
          reportDirectiveError(deps, `clear_reload failed for "${t.peerId}"`, e)
          return e instanceof ContextResumeUnsupportedError ? 'context_resume_unsupported' : 'error'
        })
        launched.push({ tileId: t.id, peerId: t.peerId, outcome })
      } else {
        const outcome = deps.injectCommand(t.id, typed).then(
          (o): DirectiveOutcome => {
            try {
              deps.journal(`directive ${keys} -> "${t.peerId}": ${o}`)
            } catch (e) {
              reportDirectiveError(deps, `directive journal failed for "${t.peerId}"`, e)
            }
            return o
          },
          (e): 'error' => {
            reportDirectiveError(deps, `directive injection failed for "${t.peerId}"`, e)
            return 'error'
          }
        )
        launched.push({ tileId: t.id, peerId: t.peerId, outcome })
      }
    }
    if (missing.length > 0) {
      deps.journal(`directive ${keys} "${label}": ${unreachedTargetsText(missing, ambiguous)}`)
    }
    return { launched, unreached: unreachedTargets(missing, ambiguous) }
  } catch (e) {
    reportDirectiveError(deps, 'directive execution failed', e)
    return { launched, unreached: [], error: 'directive execution failed' }
  }
}

export async function runDirectiveOn(
  cmd: DeckDirective,
  peerIds: string[],
  prompt: string | undefined,
  label: string,
  deps: DirectiveRunDeps,
  options: DirectiveRunOptions = {}
): Promise<DeckDirectiveRunResult> {
  return settleLaunch(launchDirective(cmd, peerIds, prompt, label, deps, options), options.reportWaitMs ?? DIRECTIVE_REPORT_WAIT_MS)
}

async function settleLaunch(run: DirectiveLaunch, waitMs: number): Promise<DeckDirectiveRunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs)
  })
  let outcomes: (SettledOutcome | null)[]
  try {
    outcomes = await Promise.all(run.launched.map((t) => Promise.race([t.outcome, cap])))
  } finally {
    clearTimeout(timer)
  }
  const result: DeckDirectiveRunResult = { injected: [], refused: [], pending: [], unreached: run.unreached }
  run.launched.forEach(({ tileId, peerId }, i) => {
    const outcome = outcomes[i] ?? null
    if (outcome === null) result.pending.push({ tileId, peerId })
    else if (outcome === 'written') result.injected.push({ tileId, peerId })
    else result.refused.push({ tileId, peerId, reason: outcome })
  })
  if (run.error) result.error = run.error
  return result
}

export async function executeDirectiveItem(
  item: { id: string; title: string; directive?: unknown; target_peer_ids: string[] },
  deps: DirectiveRunDeps,
  options: DirectiveRunOptions = {}
): Promise<DirectiveDispatch> {
  const cmd = item.directive
  if (!isRoadmapDirectiveCommand(cmd)) {
    deps.reportError(`directive card "${item.title}" carries no valid command; skipped`)
    return { id: item.id, title: item.title, directive: null, injected: [], unreached: [] }
  }
  const run = await runDirectiveOn(cmd, item.target_peer_ids, undefined, item.title, deps, options)
  // A card directive carries no deposit id, the only source of 'context_resume_unsupported'.
  return { id: item.id, title: item.title, directive: cmd, ...run, refused: run.refused as NonNullable<DirectiveDispatch['refused']> }
}

export async function runDirectiveForCaller(
  cmd: DeckDirective,
  peerIds: string[],
  prompt: string | undefined,
  callerId: string,
  deps: DirectiveRunDeps,
  options: DirectiveRunOptions & { excludeSupervisor?: boolean } = {}
): Promise<DeckDirectiveRunResult> {
  const scopedDeps = options.excludeSupervisor
    ? { ...deps, listSessions: () => deps.listSessions().filter((session) => !session.supervisor) }
    : deps
  let run: DirectiveLaunch
  try {
    const inputNote = prompt ? ` with ${cmd === 'clear_reload' ? 'workstream' : 'prompt'} ${JSON.stringify(prompt)}` : ''
    scopedDeps.journal(`directive ${directiveKeys(cmd)} requested by ${callerId} for ${peerIds.join(', ')}${inputNote}`)
    run = launchDirective(cmd, peerIds, prompt, `deck_run_directive by ${callerId}`, scopedDeps, options)
  } catch (e) {
    return failedDeckDirectiveRun(scopedDeps, e)
  }
  return settleLaunch(run, options.reportWaitMs ?? DIRECTIVE_REPORT_WAIT_MS)
}

export function createRunDirectiveAdapter(
  deps: DirectiveRunDeps,
  run: typeof runDirectiveForCaller = runDirectiveForCaller
): (
  directive: DeckDirective,
  peerIds: string[],
  prompt: string | undefined,
  callerId: string,
  excludeSupervisor?: boolean,
  options?: { contextDepositId?: string }
) => Promise<DeckDirectiveRunResult> {
  return (directive, peerIds, prompt, callerId, excludeSupervisor = false, options) =>
    run(directive, peerIds, prompt, callerId, deps, {
      excludeSupervisor,
      ...(options?.contextDepositId ? { contextDepositId: options.contextDepositId } : {})
    })
}

export function createDirectiveBindings(
  deps: DirectiveRunDeps,
  execute: typeof executeDirectiveItem = executeDirectiveItem,
  createAdapter: typeof createRunDirectiveAdapter = createRunDirectiveAdapter
) {
  return {
    executeDirective: (item: Parameters<typeof executeDirectiveItem>[0]) => execute(item, deps),
    runDirective: createAdapter(deps)
  }
}
