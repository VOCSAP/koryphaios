// Fork-on-every-resume: a new session launches with its own --session-id;
// resuming forks the previous session into a fresh id so two live processes
// never share a session id. The resume form omits stored args and never
// re-passes --agent/--model, which Claude Code auto-restores on --fork-session.
// The initial prompt is typed into the live terminal once it's up, not composed
// into the spawned command line — argv on this interactive-PTY path can't be
// redirected to stdin/file without breaking live keystrokes.

import { join } from 'node:path'

/**
 * Pulled out as a pure constant so index.ts's host resolution and
 * sandbox-command.ts's sandboxed-copy basename stay pinned to the same string
 * without an import cycle (sandbox-command.ts cannot import the electron-heavy
 * index.ts).
 */
export const DECK_PLUGIN_DIRNAME = 'deck-plugin'

/**
 * Pure decision behind index.ts's getDeckPluginDir: a packaged app reads the
 * plugin from `resourcesPath`, a dev checkout reads it from the repo via
 * `appPath`. Extracted here instead of left inline in index.ts (an
 * electron-importing module) so this exact resolution -- and in particular
 * its basename -- is bun-testable against SANDBOX_DECK_PLUGIN_NAME. Before
 * this existed, the reviewer measured the invariant "the copy's destination
 * basename equals what --plugin-dir is rewritten to" as asserted by comment
 * only, unreachable by any test.
 */
export function deckPluginDirFor(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return join(isPackaged ? resourcesPath : appPath, DECK_PLUGIN_DIRNAME)
}

export type SpawnMode = 'fresh' | 'resume'

export interface SessionCommandInput {
  /** Base launch command (resolved launchCommand or a per-session override). */
  baseCommand: string
  /** The session id to launch under. For resume this is the NEW (forked) id. */
  sessionId: string
  /** For resume: the previous session id to --resume from. */
  prevSessionId?: string
  /** Extra launch args appended on a fresh launch only (e.g. "--agent foo"). */
  args?: string
  /**
   * Reasoning effort level for `--effort`. Re-passed on BOTH fresh and resume
   * (unlike --agent/--model, --effort is not auto-restored by --fork-session).
   * Empty/undefined => omit the flag entirely (Claude's default effort).
   */
  effort?: string
  /**
   * Absolute path to the Deck's embedded plugin dir (SessionStart back-channel
   * hook, approval hook, deck-control/demo-browser MCP bridges, roadmap-card
   * skill + roadmap-scribe agent). When set, prepends `--plugin-dir "<dir>"`
   * so the whole plugin loads for this session (back-channel hook keeps the
   * per-tile session id current across /clear). Empty/undefined => omit the
   * flag (no plugin). Passed on BOTH fresh and resume.
   */
  pluginDir?: string
  /**
   * Path to a generated .mcp config, emitted as `--mcp-config "<path>"` on
   * BOTH fresh and resume (not restored by --fork-session, like --effort).
   * Used by the supervisor's deck-control bridge (PLAN C5).
   */
  mcpConfig?: string
  /**
   * Path to a generated system-prompt extension, emitted as
   * `--append-system-prompt-file "<path>"` on BOTH fresh and resume (the
   * system prompt is rebuilt at every launch). Used to anchor the
   * supervisor's role at harness level (PLAN C8).
   */
  appendSystemPromptFile?: string
  mode: SpawnMode
}

/**
 * Sanitized and double-quoted the same way as the agent/model flags built
 * alongside it, closing this field for every caller at once — the operator's
 * menu, a template, a restored workspace, and a deck-control agent — rather
 * than one entry point at a time.
 */
function effortFlag(effort?: string): string {
  const e = sanitizeFlagValue(effort ?? '')
  return e ? ` --effort "${e}"` : ''
}

/** ` --mcp-config "<path>"` when set, otherwise empty. */
function mcpConfigFlag(mcpConfig?: string): string {
  const p = mcpConfig?.trim()
  return p ? ` --mcp-config "${p}"` : ''
}

/** ` --append-system-prompt-file "<path>"` when set, otherwise empty. */
function appendSystemPromptFlag(path?: string): string {
  const p = path?.trim()
  return p ? ` --append-system-prompt-file "${p}"` : ''
}

/** ` --plugin-dir "<dir>"` when a plugin dir is set, otherwise empty. */
function pluginFlag(pluginDir?: string): string {
  const d = pluginDir?.trim()
  return d ? ` --plugin-dir "${d}"` : ''
}

/**
 * Reports a missing plugin dir exactly once per episode of absence, not once
 * per process (too late for a mid-run deletion) nor once per spawn (log spam
 * for an ordinary dev checkout with no plugin build).
 * Pure state machine with no fs/electron import, so the transition semantics
 * are unit-testable under bun independently of the caller's impure
 * existsSync/reportError wiring.
 */
export function createMissingDirTracker(): { check(exists: boolean): boolean } {
  let reported = false
  return {
    /**
     * Call with whether the watched dir currently exists. Returns true
     * exactly once per transition into "missing" -- covers both "already
     * missing at the very first check" and "was present, just disappeared".
     * Returns false on every subsequent call while it stays missing (no
     * spam), and re-arms (next disappearance reports again) as soon as a
     * call observes the dir present again.
     */
    check(exists: boolean): boolean {
      if (exists) {
        reported = false
        return false
      }
      if (reported) return false
      reported = true
      return true
    }
  }
}

/**
 * Quote a free-text prompt as ONE argument of the command string the PTY shell
 * parses (shell-command.ts: POSIX `sh -l -c "<cmd>"`, win32 PowerShell
 * `-Command <cmd>`). Single quotes are the only quoting that is inert in both
 * flavours (no $/backtick expansion); the embedded-quote escape differs:
 * POSIX `'\''`, PowerShell doubles it (`''`). Newlines survive inside quotes.
 */
export function quotePromptArg(prompt: string, plat: NodeJS.Platform = process.platform): string {
  if (plat === 'win32') return `'${prompt.replace(/'/g, "''")}'`
  return `'${prompt.replace(/'/g, "'\\''")}'`
}

/**
 * Allow-list an `--agent` / `--model` flag value before it is interpolated into
 * the login-shell command line (B6 hardening). Both are identifiers; the model
 * form additionally carries the 1M-context suffix `[1m]`, so brackets are
 * permitted. Every shell metacharacter ($ ` " ' \ ; & | < > ( ) { } space
 * newline …) is rejected, so a template- / remote-supplied value cannot break
 * out of the command string (it is also double-quoted at the call site). Returns
 * '' (flag omitted) for anything outside the allow-list — the pickers only ever
 * yield valid ids, and the graph path's own `sanitizeModel` is deliberately NOT
 * reused here because it strips the `[1m]` brackets.
 */
export function sanitizeFlagValue(v: string): string {
  const t = v.trim()
  return /^[A-Za-z0-9._:@/[\]-]{1,128}$/.test(t) ? t : ''
}

export function buildSessionCommandLine(input: SessionCommandInput): string {
  const base = input.baseCommand.trim()

  if (input.mode === 'resume' && input.prevSessionId) {
    // No args / --agent / --model: Claude auto-restores them on --fork-session.
    // --effort, --mcp-config and --append-system-prompt-file are the
    // exceptions (not auto-restored).
    // Ids are double-quoted even though they are UUID-shaped by construction:
    // prevSessionId can originate from the desk-session back-channel, whose file
    // lives in a dir mounted into sandbox containers (validated in
    // desk-session.ts). Quoting is the second lock on that door.
    return `${base}${pluginFlag(input.pluginDir)}${mcpConfigFlag(input.mcpConfig)}${appendSystemPromptFlag(input.appendSystemPromptFile)} --resume "${input.prevSessionId}" --fork-session --session-id "${input.sessionId}"${effortFlag(input.effort)}`
  }

  let line = `${base}${pluginFlag(input.pluginDir)}${mcpConfigFlag(input.mcpConfig)}${appendSystemPromptFlag(input.appendSystemPromptFile)} --session-id "${input.sessionId}"`
  const extra = input.args?.trim()
  if (extra) line += ` ${extra}`
  line += effortFlag(input.effort)
  // No positional initial prompt here anymore (150eb188): session-service
  // injects it as post-spawn PTY keystrokes via encodeInitialPromptKeystrokes
  // below, once the tile is actually up, instead of composing it into argv
  // (win32's CommandLineToArgvW re-parse corrupted it past the first embedded
  // quote -- the same class of bug 07dc42c0 fixed for the headless adapters).
  return line
}

/**
 * Encodes text as bracketed paste with the \r submit keystroke appended in a
 * single write: on Windows/ConPTY back-to-back writes coalesce into one read,
 * and Claude Code's tokenizer only treats a control character as its own token
 * when the whole read is under 64 characters — split writes can land the text
 * unsubmitted with no error.
 * The closing paste marker closes the text run inside the tokenizer, so the
 * trailing \r is always a separate token regardless of read size.
 * Every ESC byte is stripped first, since text can originate from a cloned
 * repo's template and reach a live terminal: bracketed paste is not a
 * sanitizer, and a literal escape sequence inside the text could close the
 * paste early and let the remainder be interpreted as keystrokes.
 * A bare \r or \r\n is normalized to \n, since not every terminal app treats a
 * raw CR inside the paste as literal.
 */
export function encodeSubmittedKeystrokes(text: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n')
  return `\x1b[200~${safe}\x1b[201~\r`
}

/**
 * Encode an initial prompt as post-spawn PTY keystrokes (150eb188):
 * session-service writes this once a fresh tile's startup-ack fires, instead
 * of composing the prompt into the spawned command line.
 *
 * Thin alias over `encodeSubmittedKeystrokes` above, which carries the whole
 * rationale. Kept under its own name because this is where the encoding was
 * introduced; card 6168b7f4 generalized the SAME encoding to
 * `SessionService.injectCommand` rather than growing a second, subtly
 * different one next to it.
 */
export function encodeInitialPromptKeystrokes(prompt: string): string {
  return encodeSubmittedKeystrokes(prompt)
}

/**
 * Whether a fresh spawn should record `prompt` for post-startup-ack keystroke
 * injection (150eb188). Pure predicate so the once-per-spawn invariant (never
 * on resume, never for an empty/whitespace-only prompt) stays unit-testable
 * even though the Map it gates (`pendingPrompt` in session-service.ts) lives
 * on a class that imports node-pty and can't be constructed under bun.
 */
export function shouldInjectPrompt(mode: SpawnMode, prompt: string | undefined): boolean {
  return mode === 'fresh' && !!prompt?.trim()
}
