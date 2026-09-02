// Card 96c98453: the three sinks of ONE contract, kept in a single module on
// purpose. A refused template must never read as a success -- one third of
// that promise lives in the main process (ipc.ts's template:apply handler
// must not throw for a deliberate operator refusal, but MUST throw for a
// real anomaly), the second third lives in the agent route (deck-control.ts's
// deck_apply_template must not treat a non-ok resolution as an untyped
// empty-array fallback), and the last third lives in the renderer (store.ts's
// applyTemplate must not show the success toast for that same refusal).
// Splitting these into separate modules would let them drift independently
// and let the original bug back in through whichever sink nobody re-checked.
// Pure, relative imports only -- no `@shared/*` alias, no electron -- so this
// file (unlike ipc.ts and store.ts themselves) is importable by `bun test`'s
// DEFAULT resolution, with no extra flag.

import type { TemplateInput, TemplateResolveResult } from './template'

/**
 * Main-process sink (ipc.ts's `template:apply` handler): the ONLY way that
 * handler obtains `TemplateInput[]` to spawn (review correction C3, card
 * 96c98453) -- there is no other accessible source of `inputs` in ipc.ts's
 * scope, so a mutation that tries to bypass this decision (e.g. "compute the
 * outcome, then return a count anyway" for a real anomaly) has no `inputs`
 * to fall back on, and the anomaly's `throw` cannot be silently ignored by
 * the caller the way a returned descriptor could. 'refused' (the operator's
 * own choice in the shell-field approval dialog) is NEVER an error -- it
 * returns null. 'containment' (path outside the allowed template dirs) and
 * 'malformed' (unreadable / invalid file) are real anomalies and each throw
 * their own distinct message, never fused into one. The switch's
 * never-typed default makes a future fourth reason a compile error here,
 * not a silent fall-through into one of these two buckets.
 */
export function templateInputsOrThrow(result: TemplateResolveResult, path: string): TemplateInput[] | null {
  if (result.ok) return result.inputs
  switch (result.reason) {
    case 'refused':
      return null
    case 'containment':
      throw new Error(`template path is outside the allowed template directories: ${path}`)
    case 'malformed':
      throw new Error(`template file is missing or invalid: ${path}`)
    default: {
      const _exhaustive: never = result.reason
      throw new Error(`unknown template resolution failure: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Agent-route sink (deck-control.ts's `deck_apply_template`): this route
 * does not care WHY resolution failed (it never throws through the HTTP
 * endpoint for any reason, see deck-control.ts's own comment at its call
 * site) -- every non-ok reason maps to an empty batch. Review correction C2,
 * card 96c98453: this used to be an inline `resolved.ok ? resolved.inputs :
 * []` ternary at the call site with no exhaustiveness check of its own, so a
 * future fourth reason would have compiled clean and silently fallen into
 * the empty-batch bucket. A dedicated switch with its own never-typed
 * default makes that a compile error here too, same as the throwing sink
 * above -- the third sink of TemplateResolveResult lives in this module
 * alongside the other two instead of drifting on its own.
 */
export function templateInputsOrEmpty(result: TemplateResolveResult): TemplateInput[] {
  if (result.ok) return result.inputs
  switch (result.reason) {
    case 'containment':
    case 'malformed':
    case 'refused':
      return []
    default: {
      const _exhaustive: never = result.reason
      void _exhaustive
      return []
    }
  }
}

/**
 * Renderer sink (store.ts's `applyTemplate` action): given the count
 * `window.api.applyTemplate` resolved to (a number on success, or null when
 * the operator declined -- see templateInputsOrThrow above, whose 'refused'
 * branch produces that null), decide whether to show the "template applied"
 * success toast. null must NEVER show it -- that IS the bug this card fixes
 * (a refusal reading as a success toast).
 *
 * Review correction C4, card 96c98453: `typeof count === 'number'` rather
 * than `count !== null`. Unreachable today (the IPC contract only ever
 * resolves to a number or null), but strictly safer: `JSON.stringify({value:
 * undefined})` DROPS the key entirely, so a future handler on the companion
 * (phone) transport that resolves without returning anything would arrive
 * client-side as `undefined`, and `undefined !== null` is true -- a success
 * toast for a value that was never a real count. `typeof count === 'number'`
 * has no such gap.
 */
export function shouldShowTemplateAppliedToast(count: number | null): boolean {
  return typeof count === 'number'
}
