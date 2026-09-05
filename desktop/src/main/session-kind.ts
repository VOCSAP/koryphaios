// Pure, stateless predicate: whether does not persist, session-service resolves
// it once per spawn and freezes the result for that spawn's lifetime.
// Matches any whitespace-separated token, not only the first, to catch wrappers
// like npx claude or docker exec ... claude.
// Deliberately generous: a false positive degrades visibly (tile sits stopped),
// a false negative double-injects silently, so ambiguous cases are treated as
// claude.
// Does not catch a renamed claude binary with no token spelling claude at all.

/**
 * The clodex wrapper binary: takes every `claude` flag, injects the local
 * proxy's HTTPS_PROXY/CA into the environment and execs the real `claude`. A
 * tile launched through it is still a Claude Code session, so it answers the
 * same launch-kind question as `claude` itself.
 */
export const CLODEX_WRAPPER_BIN = 'clodex-claude'

const EXECUTABLE_EXTENSIONS = ['.cmd', '.exe', '.bat', '.ps1']

/** A token plus its bounds in the source line, so a rewrite can splice the
 * original text back instead of re-quoting the tokens it leaves alone. */
interface Token {
  value: string
  start: number
  end: number
}

/** Splits `command` into tokens, keeping a `"quoted segment"` as one token. */
function tokenize(command: string): Token[] {
  const re = /"([^"]*)"|(\S+)/g
  const tokens: Token[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) {
    tokens.push({
      value: m[1] !== undefined ? m[1] : m[2]!,
      start: m.index,
      end: m.index + m[0].length
    })
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
 * anywhere in the line -- directly or through the clodex wrapper, which
 * execs that same binary. Empty string => true: it resolves to the
 * CONFIGURED launch command (`this.launchCommand` in session-service.ts,
 * itself `DEFAULT_LAUNCH_COMMAND` from launch-config.ts unless a
 * global/local launch-config.json overrides it) -- the constant alone is
 * NOT what an empty command resolves to, the caller's current
 * configuration is.
 */
export function isClaudeLaunch(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return true

  return tokenize(trimmed).some((token) => {
    const name = normalizeToken(token.value)
    return name === 'claude' || name === CLODEX_WRAPPER_BIN
  })
}

/** True when a token of `command` already names the clodex wrapper binary. */
export function isClodexLaunch(command: string): boolean {
  return tokenize(command).some((token) => normalizeToken(token.value) === CLODEX_WRAPPER_BIN)
}

/**
 * Rewrites `command` to launch through the clodex wrapper: the FIRST token
 * naming the claude binary becomes a bare `clodex-claude` -- directory prefix
 * and executable extension dropped, since the wrapper resolves the real binary
 * itself -- while every other token is spliced back byte for byte, quoting
 * included. Returned unchanged when no token names claude, a command already
 * naming the wrapper included; the caller decides whether that is an anomaly.
 * Throws on an empty command rather than guessing: an empty command means "the
 * CONFIGURED launch command" (isClaudeLaunch above), which only the caller can
 * resolve.
 */
export function withClodexWrapper(command: string): string {
  if (!command.trim()) {
    throw new Error(
      'withClodexWrapper guard: refusing to wrap an empty launch command -- an empty command means the caller\'s CONFIGURED launch command, which the caller must resolve before asking for the clodex wrapper'
    )
  }
  const target = tokenize(command).find((token) => normalizeToken(token.value) === 'claude')
  if (!target) return command
  return command.slice(0, target.start) + CLODEX_WRAPPER_BIN + command.slice(target.end)
}
