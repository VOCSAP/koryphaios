// Minimal markdown tokenizer for the roadmap detail modal (PLAN K5).
//
// The description/rationale/context fields are free markdown WRITTEN BY AGENTS,
// so the renderer must be injection-safe by construction: this module only
// produces a token tree (no HTML strings), and the React side maps tokens to
// elements -- React escapes every text node, so no sanitizer is needed and no
// markdown dependency enters the repo (zero-dep convention).
//
// Supported subset (enough for briefings): #..#### headings, paragraphs,
// unordered (-/*) and ordered (1.) lists, ``` code fences, inline `code`,
// **bold**, *italic*, [label](url) links. Everything else renders literally.
//
// Pure (no react/electron imports) so it is unit-testable under `bun test`.

export type InlineToken =
  | { t: 'text'; text: string }
  | { t: 'bold'; children: InlineToken[] }
  | { t: 'italic'; children: InlineToken[] }
  | { t: 'code'; text: string }
  | { t: 'link'; label: string; href: string }

export type BlockToken =
  | { t: 'heading'; level: number; children: InlineToken[] }
  | { t: 'paragraph'; children: InlineToken[] }
  | { t: 'list'; ordered: boolean; items: InlineToken[][] }
  | { t: 'codeblock'; text: string; lang: string }

/** Parse inline markup. Unterminated markers fall through as literal text. */
export function parseInline(src: string): InlineToken[] {
  const out: InlineToken[] = []
  let text = ''
  let i = 0
  const flush = (): void => {
    if (text) {
      out.push({ t: 'text', text })
      text = ''
    }
  }
  while (i < src.length) {
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i) {
        flush()
        out.push({ t: 'code', text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2)
      if (end > i + 1) {
        flush()
        out.push({ t: 'bold', children: parseInline(src.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (src[i] === '*') {
      const end = src.indexOf('*', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: 'italic', children: parseInline(src.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (src[i] === '[') {
      const close = src.indexOf(']', i + 1)
      if (close > i && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2)
        if (end > close + 1) {
          flush()
          out.push({ t: 'link', label: src.slice(i + 1, close), href: src.slice(close + 2, end) })
          i = end + 1
          continue
        }
      }
    }
    text += src[i]
    i++
  }
  flush()
  return out
}

const HEADING_RE = /^(#{1,4})\s+(.*)$/
const UL_RE = /^\s*[-*]\s+(.*)$/
const OL_RE = /^\s*\d+[.)]\s+(.*)$/
const FENCE_RE = /^```(\S*)\s*$/

/** Parse a full markdown string into a flat block list. */
export function parseMarkdown(src: string): BlockToken[] {
  const blocks: BlockToken[] = []
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: InlineToken[][] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length) {
      blocks.push({ t: 'paragraph', children: parseInline(paragraph.join('\n')) })
      paragraph = []
    }
  }
  const flushList = (): void => {
    if (list) {
      blocks.push({ t: 'list', ordered: list.ordered, items: list.items })
      list = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    const fence = line.match(FENCE_RE)
    if (fence) {
      flushParagraph()
      flushList()
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      // An unterminated fence swallows the rest: still rendered as code.
      blocks.push({ t: 'codeblock', text: body.join('\n'), lang: fence[1] ?? '' })
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({
        t: 'heading',
        level: heading[1]!.length,
        children: parseInline(heading[2] ?? '')
      })
      continue
    }

    const ul = line.match(UL_RE)
    const ol = ul ? null : line.match(OL_RE)
    if (ul || ol) {
      flushParagraph()
      const ordered = !!ol
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(parseInline((ul?.[1] ?? ol?.[1]) as string))
      continue
    }

    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return blocks
}
