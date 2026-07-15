// Element-pick core (PLAN D1/D2b): hover highlight, selector candidates and
// ElementPick payload construction. Shared by the two inspect-mode transports:
//   - preload/browser-inspect.ts  (embedded <webview>, ipcRenderer.sendToHost)
//   - design-client/deck-design.ts (external Tauri/Electron apps, HTTP POST to
//     the Deck's loopback design endpoint)
// Pure DOM code, zero imports besides types — must stay embeddable anywhere.

/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type { ElementPick, ElementSelector } from './types'

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
}

export function buildPick(el: HTMLElement): ElementPick {
  const rect = el.getBoundingClientRect()
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: Array.from(el.classList).slice(0, 8),
    text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160),
    selectors: buildSelectors(el),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    pageUrl: location.href
  }
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
