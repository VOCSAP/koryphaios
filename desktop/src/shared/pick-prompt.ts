// Element-pick prompt composition (Chantier OD1). Pure, no DOM: turns the
// OPTIONAL enriched fields on an ElementPick (see shared/types.ts) into a
// compact, agent-facing plain-text block appended after the existing i18n
// lead sentence (browser.elementPrompt / browser.elementPromptText) in both
// consumption sites (BrowserView.tsx's webview handler, App.tsx's
// onDesignPick handler). English fixed labels on purpose: this is technical
// data for the agent, the same register as the existing `[viewport: …]`
// suffix, not operator-facing copy -- no i18n keys here.

import type { ElementPick } from './types'

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
