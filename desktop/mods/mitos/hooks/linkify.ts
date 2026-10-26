export const MAX_PATHS = 32
export const MAX_HREF = 2048
export const MAX_TEXT_CHARS = 64 * 1024

export const EXECUTABLE_FLOOR: ReadonlySet<string> = new Set([
  'exe', 'bat', 'cmd', 'ps1', 'psm1', 'msi', 'com', 'scr', 'vbs', 'hta',
  'lnk', 'url', 'sh', 'reg', 'jar', 'appref-ms',
  'js', 'jse', 'vbe', 'wsf', 'wsh', 'msc', 'cpl', 'pif', 'chm', 'scf',
  'settingcontent-ms', 'application', 'gadget',
])

// `code` marks a whole inline-code span: its label is the span verbatim, since a backslash
// escape inside backticks is displayed as typed.
export type Candidate = { start: number; end: number; label: string; path: string; code: boolean }

// Over-matching only leaves a short message unlinked; under-matching rewrites a limit
// message that Claude Code's quota detection must read as written.
const STOCK_VOCABULARY = /limit|reset|quota|overloaded|usage/i
const STOCK_MAX_CHARS = 400
const STOCK_MAX_LINES = 3

export function mustStayStock(text: string): boolean {
  return (
    text.length <= STOCK_MAX_CHARS &&
    text.split('\n').length <= STOCK_MAX_LINES &&
    STOCK_VOCABULARY.test(text)
  )
}

export function allowedExtensions(configured: unknown): { allowed: Set<string>; refused: string[] } {
  const allowed = new Set<string>()
  const refused: string[] = []
  for (const entry of Array.isArray(configured) ? configured : []) {
    const extension = typeof entry === 'string' ? entry.trim().toLowerCase().replace(/^\./, '') : ''
    if (/^[a-z0-9]{1,16}$/.test(extension) && !EXECUTABLE_FLOOR.has(extension)) allowed.add(extension)
    else refused.push(String(entry))
  }
  return { allowed, refused }
}

export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

// Every quantifier is bounded and no class repeats its own opening character: an
// agent-written reply reaches these, and an unbounded one costs quadratic time.
const INLINE_CODE = /(`{1,32})[\s\S]{0,8192}?\1/g
const OTHER_INLINE_ZONES = [
  /!?\[[^[\]\n]{0,1024}\]\((?:[^()\n]|\([^()\n]{0,1024}\)){0,4096}\)/g,
  /<[^<>\s]{1,4096}>/g,
  /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s<>]{0,4096}/g,
]

type Span = { start: number; end: number; content: string }

// `zones` never take a link; a span becomes one only when it overlaps none of them.
function protectedZones(text: string): { zones: Array<[number, number]>; spans: Span[] } {
  const zones: Array<[number, number]> = []
  let offset = 0
  let fence: { marker: string; start: number } | undefined
  for (const line of text.split('\n')) {
    const open = FENCE.exec(line)?.[1]
    if (fence === undefined && open !== undefined) fence = { marker: open, start: offset }
    else if (fence !== undefined && open !== undefined && open[0] === fence.marker[0] && open.length >= fence.marker.length) {
      zones.push([fence.start, offset + line.length])
      fence = undefined
    }
    offset += line.length + 1
  }
  if (fence !== undefined) zones.push([fence.start, text.length])
  for (const pattern of OTHER_INLINE_ZONES) {
    for (const match of text.matchAll(pattern)) zones.push([match.index, match.index + match[0].length])
  }
  const spans: Span[] = []
  for (const match of text.matchAll(INLINE_CODE)) {
    const run = match[1]!.length
    spans.push({ start: match.index, end: match.index + match[0].length, content: match[0].slice(run, -run) })
  }
  return { zones, spans }
}

const SEGMENT = String.raw`[\p{L}\p{N}_.\-@+~#%$]`
const PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.\-/\\:@~+#%$])` +
    String.raw`((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?(?:${SEGMENT}+[\\/])*${SEGMENT}*\.(?=\p{N}*\p{L})[\p{L}\p{N}]{1,16})` +
    String.raw`(?::(\d{1,7})(?::(\d{1,7}))?)?` +
    String.raw`(?![\p{L}\p{N}_\-/\\@+~#%$])`,
  'gu',
)

// A directory has no extension to tell it from a word, so it needs a root or a final separator.
// A name holds a character other than a dot, so `./`, `...` and a trailing sentence period are not one;
// a name followed by `:` is a drive or a stream (`\\?\C:\x`), never the end of a directory.
const NAME_CHARACTER = String.raw`[\p{L}\p{N}_\-@+~#%$]`
const DIRECTORY_SEGMENT = String.raw`\.{0,2}${NAME_CHARACTER}${SEGMENT}{0,254}`
const LAST_DIRECTORY_SEGMENT = String.raw`\.{0,2}${NAME_CHARACTER}(?:${SEGMENT}{0,253}${NAME_CHARACTER})?`
export const DIRECTORY = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.\-/\\:@~+#%$])` +
    String.raw`((?:[A-Za-z]:[\\/]|[\\/])(?:${DIRECTORY_SEGMENT}[\\/]){0,128}${LAST_DIRECTORY_SEGMENT}[\\/]?` +
    String.raw`|(?:\.{1,2}[\\/]){0,16}(?:${DIRECTORY_SEGMENT}[\\/]){1,128})` +
    String.raw`(?![\p{L}\p{N}_\-/\\@+~#%$]|\.[\p{L}\p{N}_\-/\\@+~#%$.]|:\S)`,
  'gu',
)

// Windows drops a trailing dot or space from a name, so `bin.exe.` opens `bin.exe`.
const TRAILING_DOT_OR_SPACE = /(?:^|[\\/])(?!\.{1,2}(?:[\\/]|$))[^\\/]{0,255}[. ](?=[\\/]|$)/

export const BOUNDED_PATTERNS: readonly RegExp[] = [INLINE_CODE, ...OTHER_INLINE_ZONES, DIRECTORY, TRAILING_DOT_OR_SPACE]

function wholePath(content: string): string | undefined {
  const trimmed = content.trim()
  if (trimmed === '' || trimmed.length > MAX_HREF || /\s/.test(trimmed)) return undefined
  for (const pattern of [PATH, DIRECTORY]) {
    for (const match of trimmed.matchAll(pattern)) {
      if (match.index === 0 && match[0].length === trimmed.length) return match[1]!
    }
  }
  return undefined
}

// The path patterns run on one whitespace-free token at a time, at most MAX_HREF long, so their
// backtracking stays bounded by the token rather than by the whole reply.
export function findCandidates(text: string): Candidate[] {
  if (text.length > MAX_TEXT_CHARS) return []
  const { zones, spans } = protectedZones(text)
  const overlaps = (list: ReadonlyArray<readonly [number, number]>, start: number, end: number) =>
    list.some(([from, to]) => start < to && end > from)
  const everyZone: Array<[number, number]> = [...zones, ...spans.map((span): [number, number] => [span.start, span.end])]
  const candidates: Candidate[] = []
  for (const token of text.matchAll(/\S+/g)) {
    if (token[0].length > MAX_HREF) continue
    const files: Array<[number, number]> = []
    for (const match of token[0].matchAll(PATH)) {
      const start = token.index + match.index
      const end = start + match[0].length
      files.push([start, end])
      if (overlaps(everyZone, start, end)) continue
      candidates.push({ start, end, label: match[0], path: match[1]!, code: false })
    }
    for (const match of token[0].matchAll(DIRECTORY)) {
      const start = token.index + match.index
      const end = start + match[0].length
      if (overlaps(files, start, end) || overlaps(everyZone, start, end)) continue
      candidates.push({ start, end, label: match[0], path: match[1]!, code: false })
    }
  }
  // CommonMark pairs backtick runs of equal length and lets a backslash escape the opening one:
  // a span read differently by the renderer is left alone rather than linked.
  for (const span of spans) {
    if (overlaps(zones, span.start, span.end)) continue
    if (/[`\\]/.test(text[span.start - 1] ?? '') || text[span.end] === '`' || span.content.includes('`')) continue
    const path = wholePath(span.content)
    if (path !== undefined) candidates.push({ start: span.start, end: span.end, label: text.slice(span.start, span.end), path, code: true })
  }
  return candidates.sort((a, b) => a.start - b.start)
}

export function refusedSpelling(path: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'control character'
  if (/^[\\/]{2}/.test(path)) return 'network or device path'
  if (/^[A-Za-z]:(?![\\/])/.test(path)) return 'drive-relative path'
  if (path.slice(/^[A-Za-z]:/.test(path) ? 2 : 0).includes(':')) return 'alternate data stream'
  if (TRAILING_DOT_OR_SPACE.test(path)) return 'trailing dot or space'
  return undefined
}

// Folds `.` and `..` and turns every separator into `/`; a rooted path takes the drive
// of a Windows cwd. Undefined when `..` climbs above the root.
export function toAbsolute(path: string, cwd: string): string | undefined {
  const slashed = path.replace(/\\/g, '/')
  const cwdSlashed = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const cwdDrive = /^[A-Za-z]:/.exec(cwdSlashed)?.[0] ?? ''
  let root: string
  let rest: string
  if (/^[A-Za-z]:\//.test(slashed)) {
    root = slashed.slice(0, 2)
    rest = slashed.slice(3)
  } else if (slashed.startsWith('/')) {
    root = cwdDrive
    rest = slashed.slice(1)
  } else {
    root = cwdDrive
    rest = `${cwdSlashed.slice(cwdDrive.length + 1)}/${slashed}`
  }
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
    } else segments.push(segment)
  }
  return `${root}/${segments.join('/')}`
}

export function encodeFileHref(absolute: string): string {
  const drive = /^[A-Za-z]:/.test(absolute) ? absolute.slice(0, 2) : ''
  let encoded = drive
  for (const character of absolute.slice(drive.length)) {
    if (/[A-Za-z0-9\-._~/]/.test(character)) {
      encoded += character
      continue
    }
    for (const byte of new TextEncoder().encode(character)) encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return drive === '' ? `file://${encoded}` : `file:///${encoded}`
}

export function applyLinks(text: string, candidates: readonly Candidate[], hrefs: ReadonlyMap<string, string>): string {
  let result = text
  for (const candidate of [...candidates].sort((a, b) => b.start - a.start)) {
    const href = hrefs.get(candidate.path)
    if (href === undefined) continue
    const label = candidate.code ? candidate.label : candidate.label.replace(/[\\[\]]/g, '\\$&')
    result = `${result.slice(0, candidate.start)}[${label}](${href})${result.slice(candidate.end)}`
  }
  return result
}
