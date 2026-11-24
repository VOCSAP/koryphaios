// The danger signal of a permission request as the operator sees it. The
// agent's hook sends `danger` with the request it signs itself, so neither the
// list nor its messages are believed: the Deck runs the warn rules again on
// the call rebuilt from the request text, and every message it shows comes
// from a rule the Deck holds whenever it holds one.

import { createHash } from 'node:crypto'
import type { Approval } from './approval-auth'
import type { DangerView, DangerViewEntry } from '../shared/types'
import { KORY_RULES } from '../shared/ttsr-builtin'
import type { IsolatedCall, IsolatedEvaluation } from '../shared/ttsr-probe'
import type { TtsrEffectiveRule } from '../shared/ttsr-types'

export type ReceivedDanger = Approval['danger'][number]
export type ViewedApproval = Approval & { danger_view?: DangerView }

const SOURCES = ['kory', 'user', 'repo'] as const
type Source = (typeof SOURCES)[number]

const KORY_MESSAGES = new Map(KORY_RULES.map((r) => [`kory/${r.id}`, r.message]))

const INPUT_PREFIX = 'Input: '
const CWD_PREFIX = 'Working directory: '
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const CUT_MARKER = / … \[truncated from \d{1,12} characters\]$/

function sourceOf(id: string): Source | null {
  const prefix = id.slice(0, id.indexOf('/'))
  return (SOURCES as readonly string[]).includes(prefix) ? (prefix as Source) : null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The tool call a permission request was raised for, read back from the
 * hook's text: line 1 `<tool>` or `<tool>: <detail>`, then `Input: <json>`
 * when the input is not empty, then the working directory. Null when the text
 * does not have that shape or the input was cut by the length cap: a call the
 * Deck cannot rebuild exactly is not judged on a guess. An Input line that is
 * not cut and still does not parse is an anomaly, handed to `onMalformed`.
 */
export function rebuildPermissionCall(
  approval: Pick<Approval, 'kind' | 'question'>,
  onMalformed: (error: unknown) => void = () => undefined
): IsolatedCall | null {
  if (approval.kind !== 'permission') return null
  const lines = approval.question.split('\n')
  const head = lines[0] ?? ''
  const sep = head.indexOf(': ')
  const tool = sep === -1 ? head : head.slice(0, sep)
  if (!TOOL_NAME.test(tool)) return null
  let next = 1
  let input: Record<string, unknown> = {}
  if (lines[1]?.startsWith(INPUT_PREFIX)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[1].slice(INPUT_PREFIX.length))
    } catch (e) {
      // The length cap cutting the Input line is expected; the view says 'unavailable' either way.
      if (!CUT_MARKER.test(lines[1])) onMalformed(e)
      return null
    }
    if (!isPlainObject(parsed)) return null
    input = parsed
    next = 2
  } else if (sep !== -1) {
    return null
  }
  const cwdLine = lines[next]
  const cwd = cwdLine?.startsWith(CWD_PREFIX) ? cwdLine.slice(CWD_PREFIX.length) : undefined
  return { tool_name: tool, tool_input: input, ...(cwd ? { cwd } : {}) }
}

/**
 * What the operator is shown: the Deck's own matches first, in rule order,
 * then what only the agent's hook reported, kept but marked unconfirmed.
 * A kory id reads Kory's built-in text or nothing; a user or repo id reads
 * the text of the rule the Deck holds, else the text the hook carried,
 * flagged as the agent's so it is never voiced as the operator's rule.
 */
export function resolveDangerView(
  received: readonly ReceivedDanger[],
  evaluation: IsolatedEvaluation | null,
  deckRules: readonly TtsrEffectiveRule[]
): DangerView {
  const deckMessages = new Map(deckRules.map((r) => [r.qualifiedId, r.message]))
  const entries: DangerViewEntry[] = []
  const seen = new Set<string>()
  const add = (id: string, carried: string | null, confirmed: boolean): void => {
    const source = sourceOf(id)
    if (source === null || seen.has(id)) return
    seen.add(id)
    if (source === 'kory') {
      const message = KORY_MESSAGES.get(id) ?? null
      entries.push({ id, source, message, messageFrom: 'deck', known: message !== null, confirmed })
    } else {
      const held = deckMessages.get(id)
      entries.push(
        held !== undefined
          ? { id, source, message: held, messageFrom: 'deck', known: true, confirmed }
          : { id, source, message: carried, messageFrom: 'agent', known: true, confirmed }
      )
    }
  }
  for (const id of evaluation?.matched ?? []) add(id, null, true)
  for (const d of received) add(d.id, d.message, false)
  const reevaluation = evaluation === null ? 'unavailable' : evaluation.unevaluated.length > 0 ? 'partial' : 'done'
  return { reevaluation, entries }
}

function rulesFingerprint(rules: readonly TtsrEffectiveRule[]): string {
  const h = createHash('sha256')
  for (const r of rules) {
    h.update(JSON.stringify([r.qualifiedId, r.mode, r.event, r.tools, r.field, r.pattern, r.flags ?? '', r.paths ?? [], r.message]))
    h.update('\n')
  }
  return h.digest('hex')
}

export interface DangerEnricherDeps {
  /** The rules to run for an approval naming this tile. */
  rulesFor(tileRef: string): readonly TtsrEffectiveRule[]
  /** Never rejects (evaluateIsolated). */
  evaluate(rules: readonly TtsrEffectiveRule[], call: IsolatedCall): Promise<IsolatedEvaluation>
  report(text: string, err?: unknown): void
}

/**
 * Adds `danger_view` to every permission row. A row is judged once per rule
 * set: the cache key holds the rules' fingerprint, so disabling a rule while
 * a request is open recomputes its view.
 */
export function createDangerEnricher(deps: DangerEnricherDeps): (list: readonly Approval[]) => Promise<ViewedApproval[]> {
  const cache = new Map<string, { key: string; view: Promise<DangerView> }>()
  const viewOf = async (a: Approval): Promise<DangerView> => {
    const rules = deps.rulesFor(a.origin.tile_ref)
    const key = `${rulesFingerprint(rules)}\n${JSON.stringify(a.danger)}`
    const hit = cache.get(a.id)
    if (hit && hit.key === key) return hit.view
    const call = rebuildPermissionCall(a, (e) =>
      deps.report(`approval ${a.id}: its Input line is not cut yet is not JSON, so the Deck cannot check its danger signal`, e)
    )
    const view = (async () => resolveDangerView(a.danger, call ? await deps.evaluate(rules, call) : null, rules))()
    cache.set(a.id, { key, view })
    return view
  }
  return async (list) => {
    const live = new Set(list.map((a) => a.id))
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
    const out: ViewedApproval[] = []
    for (const a of list) {
      if (a.kind !== 'permission') {
        out.push(a)
        continue
      }
      try {
        out.push({ ...a, danger_view: await viewOf(a) })
      } catch (e) {
        cache.delete(a.id)
        deps.report(`approval ${a.id}: the danger signal could not be checked by the Deck`, e)
        out.push({ ...a, danger_view: resolveDangerView(a.danger, null, []) })
      }
    }
    return out
  }
}
