const REDACTED = '[redacted]'

// Every quantifier is bounded and no keyword sits between two repeated
// classes: an agent-written line reaches this on the main thread, so the cost
// must stay linear in the line length.
const PREFIXED = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{16,512}',
    'sk_(?:live|test)_[A-Za-z0-9]{16,512}',
    'gh[pousr]_[A-Za-z0-9]{20,512}',
    'github_pat_[A-Za-z0-9_]{20,512}',
    'glpat-[A-Za-z0-9_-]{20,512}',
    'xox[baprs]-[A-Za-z0-9-]{10,512}',
    'AKIA[0-9A-Z]{16}',
    'AIza[0-9A-Za-z_-]{35}',
    'eyJ[A-Za-z0-9_-]{8,256}\\.[A-Za-z0-9_-]{8,4096}\\.[A-Za-z0-9_-]{8,4096}'
  ]
    .map((p) => `\\b${p}`)
    .join('|'),
  'g'
)
const AUTH_HEADER =
  /\b((?:Proxy-)?Authorization\\?["']?[ \t]{0,8}[:=][ \t]{0,8}\\?["']?(?:Basic|Bearer|Digest|Token|Negotiate)[ \t]{1,8})[A-Za-z0-9._~+/=-]{1,4096}/gi
const AUTH_HEADER_BARE =
  /\b((?:Proxy-)?Authorization\\?["']?[ \t]{0,8}[:=][ \t]{0,8}\\?["']?)(?!(?:Basic|Bearer|Digest|Token|Negotiate)[ \t])[^\s"',;]{8,4096}/gi
const BEARER =/\b(Bearer[ \t]{1,8})[A-Za-z0-9._~+/=-]{8,4096}/gi
const USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,128}:[^\s/]{1,256}@/gi
const ASSIGNMENT = /[A-Za-z0-9_.-]{1,64}(?=\\?["']?[ \t]{0,8}(?:[=:]|%3[Dd]))/g
const SEPARATOR = /\\?["']?[ \t]{0,8}(?:[=:]|%3[Dd])[ \t]{0,8}/y
const FLAG = /--([A-Za-z0-9_.-]{1,64})[ \t]{1,8}/g
const UNQUOTED_VALUE = /[^\s"'&,;\\<>]+/y
const SECRET_SUBSTRING = /token(?!s)|secret|passw(?:or)?d|credential|api[_-]?key/
const SECRET_SEGMENT = /(?:^|[_.-])(?:auth|cookie|session)(?:$|[_.-])/
const MIN_UNQUOTED = 8
const MAX_QUOTED = 512

export const MAX_LOGGED_CHARS = 8192

function isSecretName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return SECRET_SUBSTRING.test(normalized) || SECRET_SEGMENT.test(normalized)
}

interface ValueSpan {
  from: number
  to: number
  next: number
}

function valueAt(text: string, start: number): ValueSpan | null {
  const quote = text.startsWith('\\"', start) ? '\\"' : text[start] === '"' || text[start] === "'" ? text[start]! : ''
  if (quote) {
    const from = start + quote.length
    const window = text.slice(from, from + MAX_QUOTED + quote.length)
    const length = window.indexOf(quote)
    if (length > 0 && length <= MAX_QUOTED && !/[\r\n]/.test(window.slice(0, length))) {
      return { from, to: from + length, next: from + length + quote.length }
    }
    return unquotedRun(text, from, 1)
  }
  return unquotedRun(text, start, MIN_UNQUOTED)
}

function unquotedRun(text: string, start: number, minLength: number): ValueSpan | null {
  UNQUOTED_VALUE.lastIndex = start
  const match = UNQUOTED_VALUE.exec(text)
  if (!match || match[0].length < minLength) return null
  return { from: start, to: start + match[0].length, next: start + match[0].length }
}

function redactNamedValues(
  text: string,
  pattern: RegExp,
  locate: (m: RegExpExecArray, text: string) => { name: string; valueStart: number },
  accept: (name: string, index: number, text: string) => boolean
): string {
  let out = ''
  let copied = 0
  pattern.lastIndex = 0
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const { name, valueStart } = locate(m, text)
    if (!accept(name, m.index, text)) continue
    const span = valueAt(text, valueStart)
    if (!span) continue
    out += text.slice(copied, span.from) + REDACTED
    copied = span.to
    pattern.lastIndex = span.next
  }
  return out + text.slice(copied)
}

function locateAssignment(m: RegExpExecArray, text: string): { name: string; valueStart: number } {
  SEPARATOR.lastIndex = m.index + m[0].length
  SEPARATOR.test(text)
  return { name: m[0], valueStart: SEPARATOR.lastIndex }
}

function isSecretAssignment(name: string, index: number, text: string): boolean {
  if (isSecretName(name)) return true
  return name === 'key' && (text[index - 1] === '?' || text[index - 1] === '&')
}

/** Replaces the value of every known secret shape with `[redacted]`, keeping the rest of the text. Idempotent. */
export function redactSecrets(text: string): string {
  const shaped = text
    .replace(PREFIXED, REDACTED)
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(AUTH_HEADER_BARE, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(USERINFO, `$1${REDACTED}@`)
  const assigned = redactNamedValues(shaped, ASSIGNMENT, locateAssignment, isSecretAssignment)
  return redactNamedValues(
    assigned,
    FLAG,
    (m) => ({ name: m[1]!, valueStart: m.index + m[0].length }),
    isSecretName
  )
}
