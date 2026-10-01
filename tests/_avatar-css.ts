import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STYLES = join(import.meta.dir, '..', 'desktop', 'src', 'renderer', 'src', 'styles.css')
const HEADER = '/* ---------- Avatar character window (A2)'

export interface CssRule {
  atRule: string | null
  selectors: string[]
  body: string
}

export function avatarCssBlock(source: string = readFileSync(STYLES, 'utf-8')): string {
  const start = source.indexOf(HEADER)
  if (start < 0) throw new Error('the avatar section header is missing from styles.css, so its rules cannot be checked')
  const next = source.indexOf('/* ---------- ', start + HEADER.length)
  return source.slice(start, next < 0 ? undefined : next)
}

export function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor)
    if (open < 0) break
    const prelude = text.slice(cursor, open).trim()
    let depth = 1
    let end = open + 1
    while (end < text.length && depth > 0) {
      if (text[end] === '{') depth++
      else if (text[end] === '}') depth--
      end++
    }
    if (depth !== 0) throw new Error(`unbalanced braces after "${prelude}"`)
    const body = text.slice(open + 1, end - 1)
    if (prelude.startsWith('@')) rules.push({ atRule: prelude, selectors: [], body })
    else rules.push({ atRule: null, selectors: prelude.split(',').map((s) => s.trim()).filter(Boolean), body })
    cursor = end
  }
  return rules
}

// The one exception: the avatar window's own document must be transparent, above any .avatar-root.
export const AVATAR_DOCUMENT_SELECTORS = ['html.avatar-document', 'html.avatar-document body'] as const

export function unrootedSelectors(rules: CssRule[]): string[] {
  return rules
    .filter((rule) => rule.atRule === null)
    .flatMap((rule) => rule.selectors)
    .filter((selector) => !/^\.avatar-root(?![\w-])/.test(selector) && !(AVATAR_DOCUMENT_SELECTORS as readonly string[]).includes(selector))
}

export function declarationValues(rules: CssRule[], selector: string, property: string): string[] {
  return rules
    .filter((rule) => rule.selectors.includes(selector))
    .flatMap((rule) => rule.body.split(';'))
    .map((declaration) => declaration.split(':'))
    .filter(([name]) => name?.trim() === property)
    .map(([, value]) => (value ?? '').trim())
}
