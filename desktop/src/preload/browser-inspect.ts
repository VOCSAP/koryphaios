// Guest preload injected into the embedded-browser <webview> (PLAN D1).
//
// Implements "inspect mode": the Deck renderer toggles it with
// webview.send('deck:enter-inspect' / 'deck:exit-inspect'); while active, the
// hovered element is outlined and a click captures it (capture phase +
// preventDefault, so the page never sees the click) and reports an ElementPick
// back over ipcRenderer.sendToHost. Living in a preload (rather than an
// executeJavaScript injection) means the bridge re-installs itself on every
// navigation for free.
//
// This file must stay dependency-free besides `electron` (it is bundled as its
// own preload entry and runs inside arbitrary guest pages).
//
// The node tsconfig has no DOM lib (main/preload are node contexts); this
// preload is the one file that genuinely runs against a document, so it pulls
// the DOM lib in explicitly.

/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { ipcRenderer } from 'electron'
import type { ElementPick, ElementSelector } from '@shared/types'

/** Test-automation attributes, best source of a stable selector (vibeyard). */
const QA_ATTRS = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation']

const HIGHLIGHT = '0 0 0 2px #4da3ff inset, 0 0 0 9999px rgba(77,163,255,0.08) inset'

let inspecting = false
let hovered: HTMLElement | null = null
let savedShadow = ''

function setHovered(el: HTMLElement | null): void {
  if (hovered === el) return
  if (hovered) hovered.style.boxShadow = savedShadow
  hovered = el
  if (el) {
    savedShadow = el.style.boxShadow
    el.style.boxShadow = HIGHLIGHT
  }
}

function cssEscape(v: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/[^\w-]/g, '\\$&')
}

/** Structural fallback path: tag(:nth-of-type) chain, anchored at the nearest id. */
function cssPath(el: Element): string {
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
function buildSelectors(el: Element): ElementSelector[] {
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

function buildPick(el: HTMLElement): ElementPick {
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

function onMouseOver(e: MouseEvent): void {
  if (!inspecting) return
  if (e.target instanceof HTMLElement) setHovered(e.target)
}

function onClick(e: MouseEvent): void {
  if (!inspecting) return
  e.preventDefault()
  e.stopPropagation()
  const target = e.target instanceof HTMLElement ? e.target : hovered
  if (target) ipcRenderer.sendToHost('deck:element-selected', buildPick(target))
  // Single-shot: one pick per activation, and tell the host to unpress the button.
  exitInspect()
  ipcRenderer.sendToHost('deck:inspect-ended')
}

function onKeyDown(e: KeyboardEvent): void {
  if (!inspecting || e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  exitInspect()
  ipcRenderer.sendToHost('deck:inspect-ended')
}

function enterInspect(): void {
  if (inspecting) return
  inspecting = true
  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.documentElement.style.cursor = 'crosshair'
}

function exitInspect(): void {
  if (!inspecting) return
  inspecting = false
  setHovered(null)
  document.removeEventListener('mouseover', onMouseOver, true)
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('keydown', onKeyDown, true)
  document.documentElement.style.cursor = ''
}

ipcRenderer.on('deck:enter-inspect', enterInspect)
ipcRenderer.on('deck:exit-inspect', exitInspect)
