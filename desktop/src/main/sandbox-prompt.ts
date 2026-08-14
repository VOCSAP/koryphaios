// Card 9e529177: text composition + the two guards around
// --append-system-prompt-file (session-command.ts's appendSystemPromptFlag)
// inside a sandboxed wrap() (index.ts). No electron import -- mirrors
// sandbox-command.ts's separation between pure builders and the disk-touching
// orchestration that calls them (see that file's header), which is what
// keeps this bun-testable: index.ts itself pulls in electron and cannot be
// imported under `bun test`. isWithinDir touches disk (realpathSync); every
// other export here is pure text.
//
// The flag is SINGULAR (session-command.ts's SessionDef.appendSystemPromptFile),
// so composing the role prompt and the mount-mode protection notice into ONE
// file is what avoids posing the flag twice -- never a second flag occurrence.

import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { APP_STATE_SUBDIR } from './migrate-data-dir'

/** ` --append-system-prompt-file "<path>"` matcher, shared by extract + rewrite. */
const FLAG_RE = /--append-system-prompt-file "([^"]*)"/

/**
 * The containment root composeSandboxAppendPrompt anchors on: SAME
 * expression as index.ts's `secretsDir()`/local `stateDir` consts
 * (`join(app.getPath('userData'), APP_STATE_SUBDIR)`), factored out here so
 * a test can pin the expression production actually uses instead of an
 * independently-injected tmpdir that could silently diverge from it. This is
 * also exactly the `dir` argument `writeSupervisorSystemPrompt`
 * (supervisor.ts) and `writeEmbeddedAgentPrompt` (team-embedded.ts) write
 * their role prompt files DIRECTLY into (`join(dir, '<name>.md')`) -- the
 * legitimate case this containment check exists to accept, not just refuse.
 * Takes `userDataDir` (== `app.getPath('userData')`) as a parameter rather
 * than importing `electron` itself, which is what keeps this bun-testable.
 */
export function sandboxPromptRoot(userDataDir: string): string {
  return join(userDataDir, APP_STATE_SUBDIR)
}

/** Only a session id of this exact shape should reach a filename or container path. */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Card 9e529177 audit (defense in depth, not a live-exploit fix): create()
 * always mints a randomUUID, but restoreFrom() takes a persisted d.id
 * verbatim (session-service.ts) and nothing anywhere validates its shape.
 * Refusing a non-uuid sessionId here stops it from being interpolated into
 * the filename/container path this card introduces
 * (`${SANDBOX_RUN_DIR}/prompt-${sessionId}.txt`), which index.ts's wrap()
 * later hands to `exec ${command}` in raw shell interpolation
 * (buildLaunchScript, sandbox-command.ts).
 */
export function isValidSandboxSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

/**
 * Sync realpath-based containment, symlinks included: `target` must resolve
 * strictly inside `root`. Mirrors diff-service.ts's realpathWithin, sync
 * because SessionService's SandboxWrapper.wrap contract is SYNCHRONOUS
 * (`wrap(...): string`, no Promise -- session-service.ts), so the async
 * version cannot be awaited at index.ts's only call site. Missing target /
 * broken symlink / missing root all resolve to `false` (fail closed).
 *
 * Card 9e529177 audit: before this card, --append-system-prompt-file's host
 * path was never readable from inside the container, so an uncontained path
 * was harmless dead weight. wrap() now reads it host-side and injects the
 * content into the sandboxed agent's prompt -- an uncontained path would
 * newly become an exfiltration vector (e.g. ~/.ssh/id_rsa) for a compromised
 * agent with network egress. This is what closes that.
 */
export function isWithinDir(root: string, target: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(target)
    return realTarget !== realRoot && realTarget.startsWith(realRoot + sep)
  } catch {
    return false
  }
}

/** The HOST path carried by an existing flag on this command line, or undefined. */
export function extractAppendSystemPromptFile(command: string): string | undefined {
  const path = command.match(FLAG_RE)?.[1]?.trim()
  return path || undefined
}

export interface AppendPromptRewrite {
  /**
   * The composed content to write to the container-side prompt file, or
   * `null` when both `roleContent` and `notice` are empty -- the caller must
   * leave the command untouched: no file to write, no flag to rewrite.
   */
  composed: string | null
  /** `command` with the flag rewritten (or inserted) to `containerPath`. Equal to the input `command` when `composed` is `null`. */
  command: string
}

/**
 * Composes `roleContent` (the existing --append-system-prompt-file's content,
 * if the flag was present) and `notice` (renderProtectionNotice's output, if
 * the mount-mode protection plan applied) into one string, role first. Either
 * piece missing degrades to the other; both missing composes nothing.
 *
 * Rewrites the flag to `containerPath` if it was present, or INSERTS it if it
 * was absent -- a sandboxed session with no role prompt still needs the
 * notice to reach the container, which the flag is the only vehicle for.
 */
export function composeAppendSystemPrompt(
  command: string,
  roleContent: string,
  notice: string,
  containerPath: string
): AppendPromptRewrite {
  const composed = [roleContent.trim(), notice.trim()].filter(Boolean).join('\n\n')
  if (!composed) return { composed: null, command }
  const flagMatch = command.match(FLAG_RE)
  const rewritten = flagMatch
    ? command.replace(flagMatch[0], `--append-system-prompt-file "${containerPath}"`)
    : `${command} --append-system-prompt-file "${containerPath}"`
  return { composed, command: rewritten }
}
