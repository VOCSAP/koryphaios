import type { CSSProperties } from 'react'
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import lightPlus from '@shikijs/themes/light-plus'
import darkPlus from '@shikijs/themes/dark-plus'
import { planHighlight, type CodeLang } from '@shared/code-lang'

// Imports each grammar individually rather than the shiki barrel, which drags
// in every grammar and theme; JS regex engine only, no WASM blob, with
// forgiving mode so an uncompilable grammar's regex leaves its tokens unstyled
// instead of throwing.
// Loaders are literal dynamic imports typed as Record<CodeLang,…>, so a
// CodeLang with no grammar is a compile error rather than a runtime blank.
// Bi-theme output: light lands inline, dark in --shiki-dark, so flipping
// data-theme is pure CSS and never re-tokenises.
// codeToTokens runs synchronously on the renderer's main thread and freezes
// every tile and terminal while it works — planHighlight bounds this by
// yielding between blocks; do not remove that yielding.

type GrammarLoader = () => Promise<{ default: LanguageRegistration[] }>

const GRAMMARS = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  python: () => import('@shikijs/langs/python'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  xml: () => import('@shikijs/langs/xml'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  docker: () => import('@shikijs/langs/docker'),
  make: () => import('@shikijs/langs/make'),
  ini: () => import('@shikijs/langs/ini'),
  diff: () => import('@shikijs/langs/diff')
} satisfies Record<CodeLang, GrammarLoader>

/** One styled run of characters inside a line. */
export interface HlToken {
  content: string
  style?: CSSProperties
}

/** Tokens of one line; an empty array is a legitimately empty line. */
export type HlLine = HlToken[]

/** A contiguous run of code sharing one grammar (one file, or one diff hunk). */
export interface HlBlock {
  code: string
  lang: CodeLang
}

/**
 * Hand the main thread back between two blocks. `codeToTokens` is synchronous
 * and cannot be interrupted, so this is the only place a long diff can breathe:
 * without it, 100 hunks tokenise as ONE uninterruptible task.
 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const THEME_OPTIONS = {
  themes: { light: 'light-plus', dark: 'dark-plus' },
  defaultColor: 'light',
  cssVariablePrefix: '--shiki-'
} as const

let corePromise: Promise<HighlighterCore> | null = null
const loaded = new Set<CodeLang>()
/** One trace per failing grammar: a broken chunk must not spam the log sink. */
const reported = new Set<string>()

function core(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [lightPlus, darkPlus],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })
  return corePromise
}

function trace(key: string, message: string): void {
  if (reported.has(key)) return
  reported.add(key)
  window.api.reportError('highlight', message)
}

async function ensureLang(hl: HighlighterCore, lang: CodeLang): Promise<boolean> {
  if (loaded.has(lang)) return true
  try {
    const mod = await GRAMMARS[lang]()
    await hl.loadLanguage(mod.default)
    // Warm-up on a throwaway line: the first tokenisation of a grammar pays
    // the regex-compilation cost, and paying it here keeps it off the frame
    // that renders the file the operator just clicked.
    hl.codeToTokens('\n', { ...THEME_OPTIONS, lang })
    loaded.add(lang)
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    trace(`load:${lang}`, `shiki grammar "${lang}" failed to load: ${msg}`)
    return false
  }
}

/** `font-style` -> `fontStyle`; `--shiki-dark` is a custom property, kept raw. */
function toStyle(raw: Record<string, string> | undefined): CSSProperties | undefined {
  if (!raw) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  }
  return out as CSSProperties
}

/**
 * Tokenise several blocks in one pass. Returns one entry per block, `null`
 * where that block could not be highlighted (grammar missing, budget spent,
 * tokeniser threw) -- the caller then renders that block as plain text, so a
 * failure degrades the colours and never the content.
 */
export async function highlightBlocks(blocks: HlBlock[]): Promise<Array<HlLine[] | null>> {
  const out: Array<HlLine[] | null> = blocks.map(() => null)
  // The budget decision is a PURE function in @shared/code-lang, so it can be
  // tested at the repo root without pulling shiki in (root tests run before
  // desktop/node_modules exists in CI).
  const allowed = planHighlight(blocks.map((b) => b.code.length))
  if (!allowed.some(Boolean)) return out

  let hl: HighlighterCore
  try {
    hl = await core()
  } catch (e) {
    trace('core', `shiki core failed to start: ${e instanceof Error ? e.message : String(e)}`)
    return out
  }

  let tokenisedOne = false
  for (const [i, block] of blocks.entries()) {
    if (!allowed[i]) continue
    if (!(await ensureLang(hl, block.lang))) continue
    // Breathe BEFORE each block but the first: every block is a freeze of its
    // own, and chaining them without a yield rebuilds the single long task
    // this whole budget exists to prevent.
    if (tokenisedOne) await yieldToUi()
    try {
      const { tokens } = hl.codeToTokens(block.code, { ...THEME_OPTIONS, lang: block.lang })
      tokenisedOne = true
      out[i] = tokens.map((line) =>
        line.map((tok) => ({ content: tok.content, style: toStyle(tok.htmlStyle) }))
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      trace(`tokens:${block.lang}`, `shiki tokenisation failed for "${block.lang}": ${msg}`)
    }
  }
  return out
}

/** Single-block shorthand: the whole file, one grammar. */
export async function highlightCode(code: string, lang: CodeLang): Promise<HlLine[] | null> {
  const [lines] = await highlightBlocks([{ code, lang }])
  return lines ?? null
}
