// Pure builder for the per-session claude command line, plus the sibling
// pure encoder for the post-spawn prompt-keystroke path (150eb188). No
// node-pty / electron imports so both are unit-testable under bun.
//
// Fork-on-every-resume (DESIGN §6.2 / §11): a new session is launched with its
// own --session-id; resuming forks the previous session into a fresh id so two
// live processes never share a session id. The resume form deliberately omits
// the stored args and never re-passes --agent / --model, which Claude Code
// auto-restores on --fork-session (verified CC 2.1.158, DESIGN §14.3).
//
// Initial prompt (PLAN C2) does NOT ride argv anymore: 07dc42c0 fixed the
// headless adapters' win32 CommandLineToArgvW mangling by moving operator
// text off argv onto stdin/file, but excluded this interactive-PTY path on
// purpose (stdin redirect would break live keystrokes). 150eb188 closes the
// remaining exposure the other way: session-service types the prompt into
// the live terminal once it is up (see encodeInitialPromptKeystrokes below),
// instead of composing it into the spawned command line.

import { join } from 'node:path'

/**
 * Basename of the embedded deck-plugin dir, wherever index.ts's
 * getDeckPluginDir resolves it (packaged: `resourcesPath/deck-plugin`, dev:
 * `appPath/deck-plugin`). Pulled out as a pure constant, not re-derived by
 * each caller, so index.ts's host resolution and sandbox-command.ts's
 * SANDBOX_DECK_PLUGIN_NAME/DIR stay pinned to the SAME string without an
 * import cycle (index.ts already imports this module for
 * createMissingDirTracker; sandbox-command.ts cannot import index.ts, an
 * electron-heavy module). Card a79c7696 volet 1 review: the sandboxed
 * copy's basename, the ProjectionEntry name driving clean/chown, and this
 * host-side basename were three unpinned occurrences of the literal
 * 'deck-plugin' before this constant existed.
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

/** ` --effort <e>` when an effort level is set, otherwise empty. */
function effortFlag(effort?: string): string {
  const e = effort?.trim()
  return e ? ` --effort ${e}` : ''
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
 * Tracks whether a "the dir is missing" report has already fired for the
 * CURRENT episode of absence, so a caller re-checking the dir on every spawn
 * (card d02c8e96 fix c) can report the transition exactly once per episode
 * instead of once per process (too late to ever catch a mid-run deletion,
 * since the report would already be spent from the very first boot-time
 * check) or once per spawn (log spam for the long, ordinary window where a
 * dev checkout simply has no plugin build).
 *
 * Pure state machine, no fs/electron import, so the transition semantics --
 * the exact thing the card's incident hinged on -- are unit-testable under
 * bun independently of index.ts's impure existsSync/reportError wiring.
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
 * Encode arbitrary text as ONE pty write that Claude Code's TUI actually
 * SUBMITS: bracketed paste (xterm `ESC[200~...ESC[201~`, the precedent already
 * used by BrowserView.tsx's `bracketedPaste()`) with the `\r` submit keystroke
 * appended, all in a single string.
 *
 * The single-write, marker-wrapped shape is load-bearing. Splitting it back
 * into "write the text, then write `\r`" reintroduces a measured defect (card
 * 6168b7f4, measured 2026-08-13 against CLI v2.1.229). Two facts, both measured
 * on this platform, that only bite together:
 *
 *  1. Windows/ConPTY COALESCES back-to-back `pty.write()` calls into a single
 *     read on the child: `write(text)` then `write('\r')` with no await arrives
 *     as ONE chunk (239 chars + CR measured as a single 240-byte read; the same
 *     pair 120 ms apart arrives as 240 then 1).
 *  2. Claude Code's ANSI tokenizer only emits a control character as its OWN
 *     token when the whole read is UNDER 64 characters. At or above that the CR
 *     is absorbed into the surrounding text run and never becomes a `return`
 *     key, so the text lands at the prompt and sits there, unsubmitted, with no
 *     error anywhere. Measured against the real CLI: a 63-byte coalesced chunk
 *     submits, a 64-byte one does not, and a lone `\r` sent afterwards submits
 *     it instantly.
 *
 * The closing `ESC[201~` is what makes this deterministic instead of a race: it
 * is a sequence token, so it CLOSES the text run inside the tokenizer and the
 * trailing `\r` is a separate token whatever the read size (measured: 252 bytes
 * in one write submits). A delay between two writes would also work on a quiet
 * machine and silently stop working on a loaded one.
 *
 * `text` can originate from a project template (`templates/*.json` in a CLONED
 * repo, hostile input #1 per CLAUDE.md) and this function's output reaches a
 * LIVE TERMINAL (hostile input #4) -- so every ESC byte is stripped first.
 * Bracketed paste is not a sanitizer: a literal `ESC[201~` inside the text
 * would close the paste early and let the remainder be interpreted as
 * keystrokes (terminal escape-sequence injection). Stripping ALL ESC bytes
 * (not just that one marker) closes the whole class at once -- neither a prompt
 * nor an injected command has a legitimate use for a raw control byte.
 *
 * A bare `\r` (or a `\r\n` pair) is normalized to `\n` for the same reason:
 * bracketed paste protects against embedded `\n` submitting early on a TUI
 * that honours it correctly, but not every terminal app treats a raw CR
 * inside the paste as literal -- some read it as Enter regardless. Folding
 * both CRLF and lone CR to LF removes the other control byte capable of
 * submitting early, without touching the text's actual content.
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
