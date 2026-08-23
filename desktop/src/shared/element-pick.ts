// Element-pick core (PLAN D1/D2b): hover highlight, selector candidates and
// ElementPick payload construction. Shared by the two inspect-mode transports:
//   - preload/browser-inspect.ts  (embedded <webview>, ipcRenderer.sendToHost)
//   - design-client/deck-design.ts (external Tauri/Electron apps, HTTP POST to
//     the Deck's loopback design endpoint)
// Pure DOM code — zero imports besides types and shared/pick-security.ts
// (itself pure, DOM-free) — must stay embeddable anywhere.

/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type { ElementPick, ElementSelector } from './types'
import {
  containsSecret,
  isAriaAttributeName,
  PICK_ATTRIBUTE_ALLOWLIST,
  PICK_BUDGET,
  sanitizePickUrl
} from './pick-security'

/** Test-automation attributes, best source of a stable selector (vibeyard). */
export const QA_ATTRS = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation']

export const HIGHLIGHT_SHADOW =
  '0 0 0 2px #4da3ff inset, 0 0 0 9999px rgba(77,163,255,0.08) inset'

export function cssEscape(v: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/[^\w-]/g, '\\$&')
}

/** Structural fallback path: tag(:nth-of-type) chain, anchored at the nearest id. */
export function cssPath(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && parts.length < 6) {
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`)
      break
    }
    const tag = node.tagName.toLowerCase()
    let part = tag
    const parent: Element | null = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
    }
    parts.unshift(part)
    if (tag === 'body' || tag === 'html') break
    node = parent
  }
  return parts.join(' > ')
}

/** Candidate selectors, best-first: QA attrs > other data-* > #id > css path. */
export function buildSelectors(el: Element): ElementSelector[] {
  const out: ElementSelector[] = []
  for (const attr of QA_ATTRS) {
    const v = el.getAttribute(attr)
    if (v) out.push({ type: 'qa', value: `[${attr}="${v}"]` })
  }
  for (const attr of el.getAttributeNames()) {
    if (attr.startsWith('data-') && !QA_ATTRS.includes(attr)) {
      const v = el.getAttribute(attr)
      // Only short, discriminating values -- data-reactid-style noise helps no one.
      if (v && v.length <= 48 && out.length < 4) out.push({ type: 'attr', value: `[${attr}="${v}"]` })
    }
  }
  if ((el as HTMLElement).id) out.push({ type: 'id', value: `#${cssEscape((el as HTMLElement).id)}` })
  out.push({ type: 'css', value: cssPath(el) })
  return out
    .slice(0, PICK_BUDGET.selectorsMaxEntries)
    .map((s) => ({ type: s.type, value: s.value.slice(0, PICK_BUDGET.selectorValueMaxLength) }))
}

// ---------------------------------------------------------------------------
// Enriched payload helpers (Chantier OD1). Each is small and independently
// testable; buildPick wires them together. The page is untrusted (§3.4): every
// helper here applies redaction/sanitization inline via shared/pick-security.ts
// rather than trusting a later pass -- design-endpoint.ts's sanitizePick is
// defense in depth on top of this, not the only line of defense.
// ---------------------------------------------------------------------------

/** Computed style properties captured, in the order they appear in the prompt. */
const STYLE_PROPS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'background-color',
  'border',
  'border-radius',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'z-index'
]

/** True when a computed value is the property's uninformative default. */
function isDefaultStyleValue(prop: string, v: string): boolean {
  if (!v) return true
  if (v === 'auto' || v === 'normal' || v === 'none') return true
  if (prop === 'position' && v === 'static') return true
  if (prop === 'display' && v === 'inline') return true
  if (prop === 'background-color' && v === 'rgba(0, 0, 0, 0)') return true
  if ((prop === 'margin' || prop === 'padding' || prop === 'border-radius') && v === '0px') return true
  if (prop === 'border' && v.startsWith('0px')) return true
  return false
}

/** Computed styles, filtered of default values so only signal remains. */
export function pickStyles(el: Element): Record<string, string> | undefined {
  const cs = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const prop of STYLE_PROPS) {
    const v = cs.getPropertyValue(prop)
    if (isDefaultStyleValue(prop, v)) continue
    out[prop] = v.slice(0, PICK_BUDGET.styleValueMaxLength)
  }
  return Object.keys(out).length ? out : undefined
}

/** Allowlisted attributes only (PICK_ATTRIBUTE_ALLOWLIST + aria-*); values capped and redacted. */
export function pickAttributes(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  let count = 0
  for (const name of el.getAttributeNames()) {
    // Entry cap applies guest-side too: the webview path never crosses
    // sanitizePick, so a page stacking dozens of aria-* on one element would
    // otherwise inflate the prompt unchecked.
    if (count >= PICK_BUDGET.attributesMaxEntries) break
    if (!PICK_ATTRIBUTE_ALLOWLIST.includes(name) && !isAriaAttributeName(name)) continue
    const raw = el.getAttribute(name)
    if (raw === null) continue
    if (containsSecret(raw)) {
      out[name] = '[redacted]'
      count++
      continue
    }
    if (name === 'href' || name === 'src') {
      const sanitized = sanitizePickUrl(raw)
      if (!sanitized) continue // drop rather than emit an empty href/src
      out[name] = sanitized
      count++
      continue
    }
    out[name] = raw.slice(0, PICK_BUDGET.attributeValueMaxLength)
    count++
  }
  return Object.keys(out).length ? out : undefined
}

function boundedText(el: Element, cap: number): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? ''
  return raw.trim().replace(/\s+/g, ' ').slice(0, cap)
}

function resolveAriaLabelledBy(el: Element, ids: string): string {
  const doc = el.ownerDocument
  const names: string[] = []
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const ref = doc.getElementById(id)
    if (ref) {
      const text = boundedText(ref, PICK_BUDGET.accessibleNameMaxLength)
      if (text) names.push(text)
    }
  }
  return names.join(' ')
}

/** aria-label > resolved aria-labelledby > alt > title, first non-empty, trimmed and capped. */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')
  let name = ''
  if (ariaLabel && ariaLabel.trim()) {
    name = ariaLabel.trim()
  } else {
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) name = resolveAriaLabelledBy(el, labelledBy)
  }
  if (!name) name = el.getAttribute('alt')?.trim() || ''
  if (!name) name = el.getAttribute('title')?.trim() || ''
  name = name.replace(/\s+/g, ' ')
  if (!name) return ''
  if (containsSecret(name)) return '[redacted]'
  return name.slice(0, PICK_BUDGET.accessibleNameMaxLength)
}

/** Trimmed text of up to 2 previous + 2 next element siblings. */
export function pickNearbyText(el: Element): string[] | undefined {
  const out: string[] = []
  const collect = (sibling: Element | null): void => {
    if (!sibling || out.length >= PICK_BUDGET.nearbyTextMaxEntries) return
    const text = boundedText(sibling, PICK_BUDGET.nearbyTextEntryMaxLength)
    if (!text || containsSecret(text)) return
    out.push(text)
  }
  let prev = el.previousElementSibling
  for (let i = 0; i < 2 && prev; i++) {
    collect(prev)
    prev = prev.previousElementSibling
  }
  let next = el.nextElementSibling
  for (let i = 0; i < 2 && next; i++) {
    collect(next)
    next = next.nextElementSibling
  }
  return out.length ? out : undefined
}

function ancestorLabel(node: Element): string {
  const tag = node.tagName.toLowerCase()
  let label = tag
  if (node.id && !containsSecret(node.id)) {
    label = `#${cssEscape(node.id)}`
  } else {
    const ariaLabel = node.getAttribute('aria-label')
    const cls = node.classList[0]
    if (ariaLabel && ariaLabel.trim() && !containsSecret(ariaLabel)) {
      label = `${tag}[aria-label="${ariaLabel.trim().slice(0, PICK_BUDGET.ancestorLabelMaxLength)}"]`
    } else if (cls) {
      label = `${tag}.${cls}`
    }
  }
  // Whole-entry cap, same bound sanitizePick enforces main-side: an id or
  // class name is page-controlled and can be arbitrarily long.
  return label.slice(0, PICK_BUDGET.ancestorEntryMaxLength)
}

/** Readable ancestor labels from parentElement up to (excluding) body, outermost first. */
export function pickAncestors(el: Element): string[] | undefined {
  const labels: string[] = []
  let node = el.parentElement
  while (node && node.tagName.toLowerCase() !== 'body' && labels.length < PICK_BUDGET.ancestorsMaxEntries) {
    labels.push(ancestorLabel(node))
    node = node.parentElement
  }
  labels.reverse()
  return labels.length ? labels : undefined
}

/** True when position:fixed/sticky anywhere in the element's ancestry (bounded walk). */
export function isElementFixed(el: Element): boolean {
  let node: Element | null = el
  for (let i = 0; i < 20 && node; i++) {
    const pos = getComputedStyle(node).position
    if (pos === 'fixed' || pos === 'sticky') return true
    node = node.parentElement
  }
  return false
}

/** outerHTML, capped; undefined (never truncated-and-kept) when it contains a secret. */
function pickHtml(el: Element): string | undefined {
  const raw = (el as HTMLElement).outerHTML || ''
  if (!raw) return undefined
  const truncated = raw.length > PICK_BUDGET.htmlMaxLength
  const html = truncated ? raw.slice(0, PICK_BUDGET.htmlMaxLength) + ' …' : raw
  return containsSecret(html) ? undefined : html
}

export function buildPick(el: HTMLElement): ElementPick {
  const rect = el.getBoundingClientRect()
  const rawId = el.id || ''
  const id = rawId && !containsSecret(rawId) ? rawId : ''
  const rawText = boundedText(el, PICK_BUDGET.textMaxLength)
  const text = rawText && containsSecret(rawText) ? '[redacted]' : rawText
  const selectors = buildSelectors(el).filter((s) => !containsSecret(s.value))
  const role = el.getAttribute('role')
  const name = accessibleName(el)
  const attributes = pickAttributes(el)
  const styles = pickStyles(el)
  const html = pickHtml(el)
  const nearbyText = pickNearbyText(el)
  const ancestors = pickAncestors(el)

  const pick: ElementPick = {
    tagName: el.tagName.toLowerCase(),
    id,
    classes: Array.from(el.classList).slice(0, PICK_BUDGET.classesMaxEntries),
    text,
    selectors,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    pageUrl: sanitizePickUrl(location.href),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    isFixed: isElementFixed(el)
  }
  if (role) pick.role = role
  if (name) pick.accessibleName = name
  if (attributes) pick.attributes = attributes
  if (styles) pick.styles = styles
  if (html) pick.html = html
  if (nearbyText) pick.nearbyText = nearbyText
  if (ancestors) pick.ancestors = ancestors
  return pick
}

/**
 * Install inspect mode on the current document: crosshair cursor, hover
 * highlight, capture-phase click -> onPick(payload), Escape or one pick ->
 * teardown + onExit. Returns the enter/exit pair; enter is idempotent.
 */
export function createInspectMode(handlers: {
  onPick: (pick: ElementPick) => void
  onExit: () => void
}): { enter: () => void; exit: () => void } {
  let inspecting = false
  let hovered: HTMLElement | null = null
  let savedShadow = ''

  function setHovered(el: HTMLElement | null): void {
    if (hovered === el) return
    if (hovered) hovered.style.boxShadow = savedShadow
    hovered = el
    if (el) {
      savedShadow = el.style.boxShadow
      el.style.boxShadow = HIGHLIGHT_SHADOW
    }
  }

  function onMouseOver(e: MouseEvent): void {
    if (!inspecting) return
    if (e.target instanceof HTMLElement) setHovered(e.target)
  }

  function onClick(e: MouseEvent): void {
    if (!inspecting) return
    e.preventDefault()
    e.stopPropagation()
    const target = e.target instanceof HTMLElement ? e.target : hovered
    if (target) handlers.onPick(buildPick(target))
    // Single-shot: one pick per activation.
    exit()
    handlers.onExit()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!inspecting || e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    exit()
    handlers.onExit()
  }

  function enter(): void {
    if (inspecting) return
    inspecting = true
    document.addEventListener('mouseover', onMouseOver, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.documentElement.style.cursor = 'crosshair'
  }

  function exit(): void {
    if (!inspecting) return
    inspecting = false
    setHovered(null)
    document.removeEventListener('mouseover', onMouseOver, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.documentElement.style.cursor = ''
  }

  return { enter, exit }
}
