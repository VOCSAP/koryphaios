// Element-pick prompt composition (Chantier OD1). Pure, no DOM: turns the
// OPTIONAL enriched fields on an ElementPick (see shared/types.ts) into a
// compact, agent-facing plain-text block appended after the existing i18n
// lead sentence (browser.elementPrompt / browser.elementPromptText) in both
// consumption sites (BrowserView.tsx's webview handler, App.tsx's
// onDesignPick handler). English fixed labels on purpose: this is technical
// data for the agent, the same register as the existing `[viewport: …]`
// suffix, not operator-facing copy -- no i18n keys here.

import type { ElementPick, PickAnnotation } from './types'

/** role + accessibleName combined onto one line, whichever is present. */
function roleLine(pick: ElementPick): string | null {
  if (!pick.role && !pick.accessibleName) return null
  let line = 'role:'
  if (pick.role) line += ` ${pick.role}`
  if (pick.accessibleName) line += ` "${pick.accessibleName}"`
  return line
}

/** Chantier OD3: React dev-metadata source location, when present. */
function sourceLine(pick: ElementPick): string | null {
  return pick.sourceFile ? `source: ${pick.sourceFile}` : null
}

/** Chantier OD3: surrounding React component stack, when present. */
function reactLine(pick: ElementPick): string | null {
  return pick.reactComponents ? `react: ${pick.reactComponents}` : null
}

function attrsLine(pick: ElementPick): string | null {
  if (!pick.attributes) return null
  const entries = Object.entries(pick.attributes)
  if (!entries.length) return null
  return `attrs: ${entries.map(([k, v]) => `${k}="${v}"`).join(' ')}`
}

function stylesLine(pick: ElementPick): string | null {
  if (!pick.styles) return null
  const entries = Object.entries(pick.styles)
  if (!entries.length) return null
  return `styles: ${entries.map(([k, v]) => `${k}:${v}`).join('; ')}`
}

function ancestorsLine(pick: ElementPick): string | null {
  if (!pick.ancestors || !pick.ancestors.length) return null
  return `ancestors: ${pick.ancestors.join(' > ')}`
}

function nearbyLine(pick: ElementPick): string | null {
  if (!pick.nearbyText || !pick.nearbyText.length) return null
  return `nearby: ${pick.nearbyText.map((t) => `"${t}"`).join(' | ')}`
}

/**
 * A compact "[element context]" block from the enriched pick fields, or ''
 * when the pick carries none of them (older external bundles, or a plain
 * element with no signal). Callers append this directly after the existing
 * elementPrompt/elementPromptText sentences.
 */
export function formatPickDetails(pick: ElementPick): string {
  const lines = [
    roleLine(pick),
    sourceLine(pick),
    reactLine(pick),
    pick.isFixed ? 'fixed: yes' : null,
    attrsLine(pick),
    stylesLine(pick),
    ancestorsLine(pick),
    nearbyLine(pick),
    pick.html ? `html: ${pick.html}` : null
  ].filter((l): l is string => l !== null)

  if (!lines.length) return ''
  return `\n[element context]\n${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Annotate review report (Chantier OD5, DESIGN-ORCA-DOOP-ADOPTION.md §3.5):
// up to PICK_BUDGET.annotationsMaxPerPage pinned elements, each with an
// operator comment + intent + priority, folded into ONE structured
// `## Design Feedback` message instead of one prompt per pick. Layout ported
// from orca's browser-annotation-output.ts (MIT) -- including its backtick-
// fence trick (a picked element's outerHTML can itself contain ``` runs) --
// but this is its own function with its own shape, not a wrapper around
// formatPickDetails above: that one is a compact inline block appended to an
// existing sentence, this one is the whole message. English fixed labels for
// the same reason as formatPickDetails: agent-facing technical data, not
// operator-facing copy -- only the UI editing these fields is translated.
// ---------------------------------------------------------------------------

/** Longest run of consecutive backticks in `content`, at least `floor` (orca's maxBacktickRunLength). */
function maxBacktickRunLength(content: string, floor: number): number {
  let maxRun = floor
  let run = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) !== 96 /* ` */) {
      run = 0
      continue
    }
    run++
    if (run > maxRun) maxRun = run
  }
  return maxRun
}

/**
 * A fenced code block whose backtick marker is longer than every backtick
 * run embedded in `content` -- so a picked element's outerHTML containing
 * ``` (e.g. a code sample rendered on the page) can never terminate the
 * fence early and corrupt the rest of the report.
 */
function fence(language: string, content: string): string[] {
  const marker = '`'.repeat(maxBacktickRunLength(content, 3) + 1)
  return [`${marker}${language}`, content, marker]
}

/** Path (+ query, if any) of a page URL, for the report's heading; the raw URL on parse failure. */
function pathnameOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url || 'current page'
  }
}

/** `<tag> "accessibleName-or-text-snippet"`, or bare `<tag>` when neither is present. */
function elementLabel(pick: ElementPick): string {
  const snippet = pick.accessibleName || pick.text
  return snippet ? `${pick.tagName} "${snippet}"` : pick.tagName
}

/**
 * ONE structured Design Feedback message from a batch of pinned annotations:
 * header (page url + optional viewport), then one numbered section per
 * annotation (element label, intent, priority, selector, source/react when
 * present, bounds, styles, screenshot path when present, HTML in a fenced
 * block, and the operator's feedback). Empty input yields '' -- nothing to
 * review, nothing to send.
 */
export function formatAnnotationsReport(
  annotations: PickAnnotation[],
  page: { url: string; viewport?: string }
): string {
  if (!annotations.length) return ''

  const lines: string[] = [`## Design Feedback: ${pathnameOf(page.url)}`, '', `URL: ${page.url}`]
  if (page.viewport) lines.push(`Viewport: ${page.viewport}`)
  lines.push('')

  annotations.forEach((a, i) => {
    const { pick } = a
    const selector = pick.selectors[0]?.value ?? pick.tagName
    lines.push(`### ${i + 1}. ${elementLabel(pick)}`)
    lines.push(`Intent: ${a.intent}`)
    lines.push(`Priority: ${a.priority}`)
    lines.push(`Selector: ${selector}`)
    if (pick.sourceFile) lines.push(`Source: ${pick.sourceFile}`)
    if (pick.reactComponents) lines.push(`React: ${pick.reactComponents}`)
    lines.push(`Bounds: x=${pick.x ?? 0}, y=${pick.y ?? 0}, ${pick.width}x${pick.height}`)
    const styleEntries = pick.styles ? Object.entries(pick.styles) : []
    if (styleEntries.length) {
      lines.push('Styles:')
      for (const [k, v] of styleEntries) lines.push(`- ${k}: ${v}`)
    }
    if (a.screenshotPath) lines.push(`Screenshot: ${a.screenshotPath}`)
    if (pick.html) {
      lines.push('HTML:')
      lines.push(...fence('html', pick.html))
    }
    lines.push(`Feedback: ${a.comment}`)
    lines.push('')
  })

  return lines.join('\n').trimEnd()
}
