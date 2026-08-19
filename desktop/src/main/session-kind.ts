// Pure predicate: does a session's effective launch command run the Claude
// Code CLI itself, as opposed to some other CLI (codex, gemini, a custom
// agent)? No node-pty / electron imports, unit-testable under bun.
//
// Drives the quota auto-resume double-injection gate (card fd1914cc):
// Claude Code 2.1.235+ ships its own `autoContinueAtUsageLimit` resume
// (settings key, default true), so the Deck's own quota detector+injector
// must stay OFF for a Claude launch and unchanged (ON) for everything else.
//
// DERIVED, NEVER PERSISTED (deliberate design choice, not an oversight): a
// field baked onto SessionDef at creation would go stale the moment
// `command` is edited, and would require migrating already-persisted
// sessions. session-service.ts resolves this ONCE PER SPAWN (`startPty`'s
// `resolveClaudeLaunch`/`base`) and freezes the result into RuntimeState
// for the lifetime of that spawn -- this predicate itself stays a plain,
// stateless function; the freeze-at-spawn discipline lives with the caller.
//
// Matches ANY whitespace-separated token of the command (path-stripped,
// extension-stripped), not only the first: this covers `npx claude`,
// `cmd /c claude`, `wsl claude`, `docker exec ... claude` -- launches where
// the literal executable name is not the first token. Per the asymmetry of
// failure modes (card fd1914cc context): a false positive (a non-claude
// session wrongly treated as self-resuming) degrades VISIBLY -- the tile
// just sits stopped, the operator notices and flips the per-session
// override; a false negative (a claude session wrongly kept on the Deck's
// own injector) double-injects SILENTLY into a live terminal. So this
// predicate is deliberately GENEROUS, not narrow: it accepts the rare
// visible false positive (e.g. a flag value that happens to spell out
// `claude`, like `some-cli --agent claude`) rather than risk the costlier
// silent one. What it still cannot catch, and does not pretend to: a
// RENAMED claude binary/alias (e.g. a wrapper literally called `cc`) --
// that has no token spelling `claude` at all, an open gap, not silently
// closed.

const EXECUTABLE_EXTENSIONS = ['.cmd', '.exe', '.bat', '.ps1']

/** Splits `command` into tokens, keeping a `"quoted segment"` as one token. */
function tokenize(command: string): string[] {
  const re = /"([^"]*)"|(\S+)/g
  const tokens: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) {
    tokens.push(m[1] !== undefined ? m[1] : m[2]!)
  }
  return tokens
}

/** basename, extension-stripped (.cmd/.exe/.bat/.ps1), lowercased. */
function normalizeToken(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  let name = base.toLowerCase()
  for (const ext of EXECUTABLE_EXTENSIONS) {
    if (name.endsWith(ext)) {
      name = name.slice(0, -ext.length)
      break
    }
  }
  return name
}

/**
 * True when `command` (a session's resolved base launch command, BEFORE
 * --session-id/--resume/etc are appended) launches the `claude` binary,
 * anywhere in the line. Empty string => true: it resolves to the
 * CONFIGURED launch command (`this.launchCommand` in session-service.ts,
 * itself `DEFAULT_LAUNCH_COMMAND` from launch-config.ts unless a
 * global/local launch-config.json overrides it) -- the constant alone is
 * NOT what an empty command resolves to, the caller's current
 * configuration is.
 */
export function isClaudeLaunch(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return true

  return tokenize(trimmed).some((token) => normalizeToken(token) === 'claude')
}
