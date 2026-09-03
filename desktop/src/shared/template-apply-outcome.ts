// The three sinks of one contract, kept in a single module on purpose: a
// refused template must never read as a success, and splitting
// main/agent/renderer handling into separate modules would let them drift
// independently.
// Pure, relative imports only -- no @shared/* alias, no electron -- so this
// file is importable by bun test's default resolution.
// deck_apply_template must not treat a non-ok resolution as an untyped

import type { TemplateInput, TemplateResolveResult } from './template'

/**
 * The only way the main-process template:apply handler obtains TemplateInput[]
 * to spawn.
 * 'refused' (the operator's own choice at the shell-field approval dialog) is
 * never an error and returns null; 'containment' and 'malformed' are real
 * anomalies and each throw their own distinct message.
 * The switch's never-typed default makes a future fourth reason a compile
 * error, not a silent fall-through.
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
 * Agent-route sink: every non-ok reason maps to an empty batch, the route
 * never throws. A dedicated switch with a never-typed default, not an inline
 * ternary, so a fourth reason is a compile error here too.
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
 * Decides whether to show the "template applied" success toast: null must never
 * show it.
 * Checks typeof count === 'number' rather than count !== null -- JSON.stringify
 * drops an undefined key entirely, so a handler that resolves without returning
 * anything would arrive client-side as undefined, and undefined !== null would
 * wrongly read as success.
 */
export function shouldShowTemplateAppliedToast(count: number | null): boolean {
  return typeof count === 'number'
}
