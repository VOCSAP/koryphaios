import type { DirectiveDispatch, RoadmapDirective, SessionRuntime, UnreachedDirectiveTarget } from '../shared/types'
import type { MagicCompactMode } from './launch-config'
import {
  DIRECTIVE_ACCEPTS_PROMPT,
  directiveCommands,
  directiveKeys,
  isDirectiveCommand,
  PEER_ID_RE,
  resolveDirectiveTargets
} from './directive'
import { unreachedTargets, unreachedTargetsText } from './directive-journal'

export const DIRECTIVE_PROMPT_MAX = 500
export const DIRECTIVE_MAX_TARGETS = 16

export interface DirectiveRunDeps {
  listSessions(): SessionRuntime[]
  injectCommand(tileId: string, keys: string): Promise<string>
  runMagicCompact(tileId: string, peerId: string, useMagic: boolean, mode: MagicCompactMode): Promise<void>
  /** Called once per run, and only for magic_compact. */
  resolveMagic(): { useMagic: boolean; mode: MagicCompactMode }
  journal(line: string): void
  reportError(message: string, error?: unknown): void
}

export interface DirectiveRunResult {
  injected: { tileId: string; peerId: string }[]
  unreached: UnreachedDirectiveTarget[]
  error?: 'directive execution failed'
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
  directive: RoadmapDirective
  peerIds: string[]
  prompt: string | undefined
}

/** Validates deck_run_directive's raw arguments; throws a message meant for the calling agent. */
export function parseRunDirectiveArgs(args: Record<string, unknown>): RunDirectiveArgs {
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
  const rawPrompt = args['prompt']
  if (rawPrompt !== undefined && rawPrompt !== null && typeof rawPrompt !== 'string') {
    throw new Error('prompt must be a string')
  }
  const prompt = typeof rawPrompt === 'string' ? sanitizeDirectivePrompt(rawPrompt) : ''
  if (!prompt) return { directive, peerIds: normalizedPeerIds, prompt: undefined }
  if (!DIRECTIVE_ACCEPTS_PROMPT[directive]) {
    throw new Error(`directive "${directive}" does not accept a prompt`)
  }
  const promptLength = [...prompt].length
  if (promptLength > DIRECTIVE_PROMPT_MAX) {
    throw new Error(`prompt is ${promptLength} characters, the limit is ${DIRECTIVE_PROMPT_MAX}`)
  }
  return { directive, peerIds: normalizedPeerIds, prompt }
}

function reportDirectiveError(deps: DirectiveRunDeps, message: string, error: unknown): void {
  deps.reportError(message, error)
}

function failedDirectiveRun(deps: DirectiveRunDeps, error: unknown): DirectiveRunResult {
  reportDirectiveError(deps, 'directive execution failed', error)
  return { injected: [], unreached: [], error: 'directive execution failed' }
}

export function runDirectiveOn(
  cmd: RoadmapDirective,
  peerIds: string[],
  prompt: string | undefined,
  label: string,
  deps: DirectiveRunDeps
): DirectiveRunResult {
  const injected: { tileId: string; peerId: string }[] = []
  try {
    const keys = directiveKeys(cmd)
    const typed = prompt ? `${keys} ${prompt}` : keys
    const { matched, missing, ambiguous } = resolveDirectiveTargets(peerIds, deps.listSessions())
    if (matched.length === 0) {
      const detail = unreachedTargetsText(missing, ambiguous) || `requested: ${peerIds.join(', ') || 'none'}`
      deps.journal(`directive ${keys} "${label}": ${detail}`)
      return { injected: [], unreached: unreachedTargets(missing, ambiguous) }
    }
    const magic = cmd === 'magic_compact' ? deps.resolveMagic() : null
    for (const t of matched) {
      if (magic) {
        void deps
          .runMagicCompact(t.id, t.peerId, magic.useMagic, magic.mode)
          .catch((e) => reportDirectiveError(deps, `magic_compact failed for "${t.peerId}"`, e))
      } else {
        void deps
          .injectCommand(t.id, typed)
          .then((outcome) => deps.journal(`directive ${keys} -> "${t.peerId}": ${outcome}`))
          .catch((e) => reportDirectiveError(deps, `directive injection failed for "${t.peerId}"`, e))
      }
      injected.push({ tileId: t.id, peerId: t.peerId })
    }
    if (missing.length > 0) {
      deps.journal(`directive ${keys} "${label}": ${unreachedTargetsText(missing, ambiguous)}`)
    }
    return {
      injected,
      unreached: unreachedTargets(missing, ambiguous)
    }
  } catch (e) {
    reportDirectiveError(deps, 'directive execution failed', e)
    return { injected, unreached: [], error: 'directive execution failed' }
  }
}

export function executeDirectiveItem(
  item: { id: string; title: string; directive?: unknown; target_peer_ids: string[] },
  deps: DirectiveRunDeps
): DirectiveDispatch {
  const cmd = item.directive
  if (!isDirectiveCommand(cmd)) {
    deps.reportError(`directive card "${item.title}" carries no valid command; skipped`)
    return { id: item.id, title: item.title, directive: null, injected: [], unreached: [] }
  }
  const run = runDirectiveOn(cmd, item.target_peer_ids, undefined, item.title, deps)
  return { id: item.id, title: item.title, directive: cmd, ...run }
}

export function runDirectiveForCaller(
  cmd: RoadmapDirective,
  peerIds: string[],
  prompt: string | undefined,
  callerId: string,
  deps: DirectiveRunDeps,
  options: { excludeSupervisor?: boolean } = {}
): DirectiveRunResult {
  const scopedDeps = options.excludeSupervisor
    ? { ...deps, listSessions: () => deps.listSessions().filter((session) => !session.supervisor) }
    : deps
  try {
    const promptNote = prompt ? ` with prompt ${JSON.stringify(prompt)}` : ''
    scopedDeps.journal(`directive ${directiveKeys(cmd)} requested by ${callerId} for ${peerIds.join(', ')}${promptNote}`)
    return runDirectiveOn(cmd, peerIds, prompt, `deck_run_directive by ${callerId}`, scopedDeps)
  } catch (e) {
    return failedDirectiveRun(scopedDeps, e)
  }
}

export function createRunDirectiveAdapter(
  deps: DirectiveRunDeps,
  run: typeof runDirectiveForCaller = runDirectiveForCaller
): (
  directive: RoadmapDirective,
  peerIds: string[],
  prompt: string | undefined,
  callerId: string,
  excludeSupervisor?: boolean
) => DirectiveRunResult {
  return (directive, peerIds, prompt, callerId, excludeSupervisor = false) =>
    run(directive, peerIds, prompt, callerId, deps, { excludeSupervisor })
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
