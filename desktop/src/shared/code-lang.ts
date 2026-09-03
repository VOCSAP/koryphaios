// Pure "what language is this?" resolver for the two READ-ONLY code surfaces
// of the Deck (card 526665f7): the Files viewer and the diff colorizer. Kept
// out of the renderer so it runs under `bun test` with no DOM, and so a future
// editor surface reuses the same table instead of minting a second one.
//
// The union below is the CONTRACT: the renderer's grammar table is typed
// `satisfies Record<CodeLang, …>`, so adding a member here without shipping a
// grammar is a COMPILE error, never a blank viewer at runtime. Growth of the
// domain (a language nobody mapped) degrades to plain text, which is exactly
// what both surfaces render today.

export type CodeLang =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'jsonc'
  | 'yaml'
  | 'markdown'
  | 'css'
  | 'html'
  | 'python'
  | 'shellscript'
  | 'rust'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'sql'
  | 'toml'
  | 'xml'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'docker'
  | 'make'
  | 'ini'
  | 'diff'

/** Extension (lower-case, no dot) -> grammar. */
const BY_EXT: Record<string, CodeLang> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  html: 'html',
  htm: 'html',
  py: 'python',
  pyi: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  sql: 'sql',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  ini: 'ini',
  cfg: 'ini',
  diff: 'diff',
  patch: 'diff'
}

/** Exact file names that carry no extension (or a misleading one). */
const BY_NAME: Record<string, CodeLang> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  'cargo.lock': 'toml',
  'package-lock.json': 'json'
}

/** `#!` interpreters worth recognising when the name says nothing. */
const BY_SHEBANG: Array<[RegExp, CodeLang]> = [
  [/\b(bash|sh|zsh|dash)\b/, 'shellscript'],
  [/\bpython[0-9.]*\b/, 'python'],
  [/\b(node|bun|deno)\b/, 'javascript'],
  [/\bruby\b/, 'ruby'],
  [/\bphp\b/, 'php']
]

/**
 * Grammar for a file, or `null` when nothing matches -- `null` means "render as
 * plain text", the pre-existing behaviour, never an error. `path` may be
 * root-relative, absolute, POSIX- or Windows-separated. `firstLine` is
 * optional and only consulted when name and extension say nothing.
 */
export function resolveCodeLang(path: string, firstLine?: string): CodeLang | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (!name) return null

  const byName = BY_NAME[name]
  if (byName) return byName

  // `Dockerfile.dev` / `Makefile.local`: the STEM carries the identity.
  const stem = name.split('.')[0]
  if (stem && stem !== name && BY_NAME[stem]) return BY_NAME[stem]

  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    const byExt = BY_EXT[name.slice(dot + 1)]
    if (byExt) return byExt
  }

  if (firstLine?.startsWith('#!')) {
    for (const [re, lang] of BY_SHEBANG) if (re.test(firstLine)) return lang
  }
  return null
}

// Shiki's tokenisation is synchronous and runs on the renderer's main thread,
// freezing the whole window for its duration.
// Two caps because they bound different things: per-block bounds the worst
// single freeze, total bounds the CPU spent on one request (the renderer yields
// between blocks, so total cannot bound the freeze).
// A global cap alone let one oversized block sail through by summing and
// comparing once; the Files viewer always submits one whole-file block, so the
// per-block cap is what protects it.
export const HIGHLIGHT_MAX_BLOCK_CHARS = 64 * 1024
export const HIGHLIGHT_MAX_TOTAL_CHARS = 256 * 1024

/**
 * Which blocks may be tokenised, in order. An oversized block is skipped
 * WITHOUT spending the budget, so its neighbours stay coloured (a diff loses
 * its one giant hunk, not its colours). Once the total budget is spent every
 * later block is skipped too, so the colouring degrades as a PREFIX: what the
 * operator reads first is what gets coloured, instead of an all-or-nothing
 * refusal.
 */
export function planHighlight(sizes: number[]): boolean[] {
  let spent = 0
  let exhausted = false
  return sizes.map((size) => {
    if (size > HIGHLIGHT_MAX_BLOCK_CHARS) return false
    if (exhausted || spent + size > HIGHLIGHT_MAX_TOTAL_CHARS) {
      exhausted = true
      return false
    }
    spent += size
    return true
  })
}

/** Kinds of line a unified diff carries. `ctx`/`meta` are the unclassed ones. */
export type DiffLineKind = 'file' | 'hunk' | 'section' | 'meta' | 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: DiffLineKind
  /** The raw line, marker included -- what is rendered when unhighlighted. */
  text: string
  /** Marker-stripped code for `add`/`del`/`ctx`, else `null`. */
  code: string | null
  /** Grammar of the file this line belongs to, `null` when unknown. */
  lang: CodeLang | null
}

/**
 * Classify a unified diff line by line, tracking which FILE each hunk belongs
 * to so its code can be tokenised with the right grammar. The kind order
 * mirrors the historical `DiffText` colorizer exactly (`+++`/`---` before the
 * bare `+`/`-`), so the structural colours cannot drift.
 */
export function classifyDiffLines(text: string): DiffLine[] {
  let lang: CodeLang | null = null
  return text.split('\n').map((line): DiffLine => {
    const git = /^diff --git a\/.+ b\/(.+)$/.exec(line)
    if (git?.[1]) {
      lang = resolveCodeLang(git[1])
      return { kind: 'meta', text: line, code: null, lang: null }
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      const target = line.slice(3).trim().replace(/^[ab]\//, '')
      if (target && target !== '/dev/null') lang = resolveCodeLang(target)
      return { kind: 'file', text: line, code: null, lang: null }
    }
    if (line.startsWith('@@')) return { kind: 'hunk', text: line, code: null, lang: null }
    if (line.startsWith('+')) return { kind: 'add', text: line, code: line.slice(1), lang }
    if (line.startsWith('-')) return { kind: 'del', text: line, code: line.slice(1), lang }
    if (line.startsWith('# ---')) return { kind: 'section', text: line, code: null, lang: null }
    if (line === '' || line.startsWith(' '))
      return { kind: 'ctx', text: line, code: line.slice(1), lang }
    // `index …`, `new file mode …`, `\ No newline at end of file`: structure,
    // not code. Unclassed today, and left unclassed.
    return { kind: 'meta', text: line, code: null, lang: null }
  })
}
