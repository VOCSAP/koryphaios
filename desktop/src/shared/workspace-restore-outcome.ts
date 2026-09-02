// Card 07134c6a, prerequisite for the 64f8f629 dossier: WorkspaceService's
// restore() has six distinct failure reasons, but the old `boolean`
// contract could only say yes/no, so store.ts fell
// back to a client-side GUESS -- and that guess was wrong for three of the
// six (shell-declined, cwd-declined, lock-race all showed "Already owned by
// another live window"). This module is the SAME shape as
// template-apply-outcome.ts (card 96c98453): a single pure module, relative
// imports only, no `@shared/*` alias, no electron -- so it (unlike ipc.ts
// and store.ts themselves) is importable by `bun test`'s DEFAULT resolution.
// Unlike that lot, this one's PRODUCER (workspace-service.ts) is ALREADY
// bun-testable directly (its own header comment: no electron/node-pty
// imports), so the wiring gap that lot could only name as an unclosed
// residual is closeable HERE, at the real call site, not just at a
// pure-extracted decision function.

/**
 * Discriminated result of WorkspaceService.restore(). One reason literal per
 * real cause (each of restore()'s own `return` sites) -- never pre-merged,
 * so the CONSUMER decides behaviour per reason via an exhaustive switch,
 * same principle as TemplateResolveResult.
 */
export type WorkspaceRestoreResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'empty' | 'locked' | 'shell-declined' | 'cwd-declined' | 'lock-race' }

/**
 * The five reasons that RESOLVE quietly rather than throw -- deliberately
 * excludes 'lock-race', which workspaceRestoreOrThrow below always throws
 * for, so it can never actually appear in a WorkspaceRestoreOutcome. Named
 * separately (rather than re-deriving it at each use) so both this file's
 * two functions and any consumer agree on the same narrowed set.
 *
 * This exclusion is WRITTEN BY HAND, not derived from workspaceRestoreOrThrow's
 * own switch: the two must be kept in sync manually. A second reason that
 * starts throwing (e.g. a future card) needs adding here too -- forgetting
 * fails the type SAFE (workspaceRestoreToastKeyFor's own exhaustive switch
 * below would then be missing a case and fail to compile, since the newly
 * un-excluded reason would still reach it), but it is not automatic, and
 * that is worth saying rather than assuming.
 */
export type WorkspaceRestoreQuietReason = Exclude<
  Exclude<WorkspaceRestoreResult, { ok: true }>['reason'],
  'lock-race'
>

/** The main-process sink's resolved (non-throwing) outcome. */
export type WorkspaceRestoreOutcome = { applied: true } | { applied: false; reason: WorkspaceRestoreQuietReason }

/**
 * Main-process sink (ipc.ts's `workspace:restore` handler): the ONLY way
 * that handler turns a WorkspaceRestoreResult into what it returns to its
 * caller. Three behavioural classes, arbitrated by the team-lead on card
 * 64f8f629 (the rule generalizes beyond that one card): 'missing', 'empty'
 * and 'locked' are normal, nothing-moved outcomes -- they resolve quietly.
 * 'shell-declined' and 'cwd-declined' are the operator's OWN deliberate
 * choice at the approval dialog -- they already know why, so this resolves
 * quietly too (mirrors template:apply's 'refused' precedent, card 96c98453:
 * not an error). 'lock-race' is the ONE reason where the actor does NOT
 * already know why -- restoreFrom() already swapped their live sessions
 * before the lock reclaim failed, so the announced and real state would
 * otherwise diverge -- it THROWS, with a message that says what happened.
 * The switch's never-typed default makes a future seventh reason (e.g.
 * 64f8f629's own 'unattended caller' refusal) a compile error here, not a
 * silent fall-through into one of the quiet buckets.
 */
export function workspaceRestoreOrThrow(result: WorkspaceRestoreResult): WorkspaceRestoreOutcome {
  if (result.ok) return { applied: true }
  switch (result.reason) {
    case 'missing':
    case 'empty':
    case 'locked':
    case 'shell-declined':
    case 'cwd-declined':
      return { applied: false, reason: result.reason }
    case 'lock-race':
      throw new Error(
        'workspace restore failed partway through: your sessions were already swapped, but the lock could not be reclaimed -- check the current state in the workspace picker'
      )
    default: {
      const _exhaustive: never = result.reason
      throw new Error(`unknown workspace restore failure: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Renderer sink (store.ts's `restoreWorkspace` action): which toast to show
 * for a non-applied outcome, or none. 'empty' reuses the EXISTING
 * toast.nothingToRestore string verbatim (its wording already fit that
 * cause; the bug was routing, not wording). 'locked' reuses the EXISTING
 * toast.alreadyOpen ("Session already open"), which fits it. 'missing' used
 * to ALSO fall into toast.alreadyOpen (review correction C3, card
 * 07134c6a): that wording is FALSE for a workspace whose FILE no longer
 * exists -- "already open" implies a live conflict, not a vanished file --
 * so it gets its own dedicated toast.workspaceMissing string instead of
 * reusing a message that fit a different cause by coincidence.
 * 'shell-declined'/'cwd-declined' show NOTHING: the operator just made this
 * choice at the dialog, a toast would be redundant, and showing the WRONG
 * one (the bug this card fixes) is worse than showing none. The default
 * branch is a safety net, not the enforcement point -- a genuinely new
 * QUIET reason is already caught at compile time by THIS switch's own
 * `_exhaustive: never` (forcing a real decision, not silently falling
 * through), it only fails open to null for a value that bypassed the type
 * system entirely (e.g. `as any`), which cannot happen from a real
 * WorkspaceRestoreResult.
 */
export function workspaceRestoreToastKeyFor(
  reason: WorkspaceRestoreQuietReason
): 'toast.nothingToRestore' | 'toast.alreadyOpen' | 'toast.workspaceMissing' | null {
  switch (reason) {
    case 'empty':
      return 'toast.nothingToRestore'
    case 'locked':
      return 'toast.alreadyOpen'
    case 'missing':
      return 'toast.workspaceMissing'
    case 'shell-declined':
    case 'cwd-declined':
      return null
    default: {
      const _exhaustive: never = reason
      void _exhaustive
      return null
    }
  }
}
