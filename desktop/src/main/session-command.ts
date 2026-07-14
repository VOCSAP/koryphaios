// Pure builder for the per-session claude command line. No node-pty / electron
// imports so it is unit-testable under bun.
//
// Fork-on-every-resume (DESIGN §6.2 / §11): a new session is launched with its
// own --session-id; resuming forks the previous session into a fresh id so two
// live processes never share a session id. The resume form deliberately omits
// the stored args and never re-passes --agent / --model, which Claude Code
// auto-restores on --fork-session (verified CC 2.1.158, DESIGN §14.3).

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
   * Absolute path to the Deck's embedded plugin dir. When set, prepends
   * `--plugin-dir "<dir>"` so the SessionStart back-channel hook loads for this
   * session (keeps the per-tile session id current across /clear). Empty/
   * undefined => omit the flag (no plugin). Passed on BOTH fresh and resume.
   */
  pluginDir?: string
  /**
   * Initial prompt submitted as Claude's positional argument on a FRESH launch
   * only (PLAN C2). Never re-played on resume: --resume restores the previous
   * conversation, so the prompt already lives in the transcript.
   */
  prompt?: string
  /**
   * Path to a generated .mcp config, emitted as `--mcp-config "<path>"` on
   * BOTH fresh and resume (not restored by --fork-session, like --effort).
   * Used by the supervisor's deck-control bridge (PLAN C5).
   */
  mcpConfig?: string
  /** Shell-quoting flavour for the prompt (win32 = PowerShell). Test hook. */
  platform?: NodeJS.Platform
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

/** ` --plugin-dir "<dir>"` when a plugin dir is set, otherwise empty. */
function pluginFlag(pluginDir?: string): string {
  const d = pluginDir?.trim()
  return d ? ` --plugin-dir "${d}"` : ''
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

export function buildSessionCommandLine(input: SessionCommandInput): string {
  const base = input.baseCommand.trim()

  if (input.mode === 'resume' && input.prevSessionId) {
    // No args / --agent / --model: Claude auto-restores them on --fork-session.
    // --effort and --mcp-config are the exceptions (not auto-restored).
    return `${base}${pluginFlag(input.pluginDir)}${mcpConfigFlag(input.mcpConfig)} --resume ${input.prevSessionId} --fork-session --session-id ${input.sessionId}${effortFlag(input.effort)}`
  }

  let line = `${base}${pluginFlag(input.pluginDir)}${mcpConfigFlag(input.mcpConfig)} --session-id ${input.sessionId}`
  const extra = input.args?.trim()
  if (extra) line += ` ${extra}`
  line += effortFlag(input.effort)
  // Positional initial prompt, last so it never swallows a flag (fresh only --
  // the resume branch above returns before reaching here by construction).
  const prompt = input.prompt?.trim()
  if (prompt) line += ` ${quotePromptArg(prompt, input.platform)}`
  return line
}
