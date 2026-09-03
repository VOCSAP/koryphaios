// Pure, stateless predicate: whether does not persist, session-service resolves
// it once per spawn and freezes the result for that spawn's lifetime.
// Matches any whitespace-separated token, not only the first, to catch wrappers
// like npx claude or docker exec ... claude.
// Deliberately generous: a false positive degrades visibly (tile sits stopped),
// a false negative double-injects silently, so ambiguous cases are treated as
// claude.
// Does not catch a renamed claude binary with no token spelling claude at all.

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
