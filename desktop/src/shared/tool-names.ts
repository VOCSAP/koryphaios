// Pure module, no imports.

const TOOL_NAME = /^[A-Za-z0-9_*:()-]+$/

/** Upper bounds on a `--disallowedTools` list, so a hostile file cannot inflate a command line. */
const MAX_TOOL_NAMES = 64
const MAX_TOOL_NAME_LENGTH = 128

/**
 * A list of tool names or permission rules for `--disallowedTools`. A name is
 * interpolated into a login-shell command line, so it holds no space, quote,
 * `$`, backtick or separator: anything outside the pattern makes the whole
 * list invalid, and callers refuse it rather than dropping the offender, since
 * a deny-list with a missing entry silently allows that tool. The empty list is
 * valid and means no denial.
 */
export function isToolNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TOOL_NAMES &&
    value.every((name) => typeof name === 'string' && name.length <= MAX_TOOL_NAME_LENGTH && TOOL_NAME.test(name))
  )
}

// The form the Deck wrote into launch args: the flag, a space, a comma list, double-quoted or bare. The
// quotes must pair up, and the pair must end the args or be followed by another flag: the CLI reads
// every bare word after the list as one more tool name, so lifting the list alone would drop those.
const LEGACY_FLAG = /(^|\s)--disallowedTools\s+(?:"([^"\s]+)"|([^"\s]+))(?=\s*$|\s+-)/g

/**
 * Lifts a `--disallowedTools "<a,b>"` pair out of free launch args into the
 * structured field. Only when the field is absent, the pair is the only one,
 * and its list is valid: otherwise `args` is returned untouched, so a fresh
 * launch still passes the flag through the args it always travelled in.
 */
export function liftDisallowedTools(
  args: string,
  current: readonly string[] | undefined
): { args: string; disallowedTools: string[] | undefined } {
  const unchanged = { args, disallowedTools: current?.length ? [...current] : undefined }
  if (current?.length) return unchanged
  const matches = [...args.matchAll(LEGACY_FLAG)]
  if (matches.length !== 1) return unchanged
  const match = matches[0]!
  const names = (match[2] ?? match[3]!).split(',')
  if (!isToolNameList(names)) return unchanged
  const rest = args.slice(0, match.index) + args.slice(match.index + match[0].length)
  return { args: rest.trim(), disallowedTools: names }
}
