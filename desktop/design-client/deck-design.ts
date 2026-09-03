// Drop into any webview-based app to add Deck inspect mode (Ctrl+Shift+D); a
// pick posts to the Deck's loopback design endpoint on 127.0.0.1 only, never
// through the broker.
// Endpoint discovery: window.__DECK_DESIGN__ = {url, token, source?}, or <meta
// name="deck-design-url">/<meta name="deck-design-token"> (+ optional
// deck-design-source).
// Built to deck-plugin/design/deck-design.js by npm run build:design —
// dependency-free; do not ship in prod.

import { createInspectMode } from '../src/shared/element-pick'
import type { ElementPick } from '../src/shared/types'

interface DeckDesignConfig {
  url: string
  token: string
  source?: string
}

function meta(name: string): string {
  const el = document.querySelector(`meta[name="${name}"]`)
  return el?.getAttribute('content') ?? ''
}

function resolveConfig(): DeckDesignConfig | null {
  const w = window as unknown as { __DECK_DESIGN__?: Partial<DeckDesignConfig> }
  const g = w.__DECK_DESIGN__
  const url = (g?.url ?? meta('deck-design-url')).replace(/\/+$/, '')
  const token = g?.token ?? meta('deck-design-token')
  const source = g?.source ?? meta('deck-design-source')
  if (!url || !token) return null
  return { url, token, source: source || undefined }
}

/** Tiny fixed badge so the operator knows inspect mode is armed. */
function makeBadge(): HTMLElement {
  const el = document.createElement('div')
  el.textContent = '⌖ deck inspect'
  el.style.cssText = [
    'position:fixed',
    'right:10px',
    'bottom:10px',
    'z-index:2147483647',
    'padding:4px 10px',
    'border-radius:14px',
    'background:#4da3ff',
    'color:#fff',
    'font:12px system-ui,sans-serif',
    'pointer-events:none',
    'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
  ].join(';')
  return el
}

function postPick(cfg: DeckDesignConfig, pick: ElementPick): void {
  void fetch(`${cfg.url}/design/pick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deck-token': cfg.token },
    body: JSON.stringify({ source: cfg.source ?? '', pick })
  }).catch(() => {
    /* Deck closed or unreachable: the pick is simply lost */
  })
}

function install(): void {
  const cfg = resolveConfig()
  if (!cfg) return // not launched from a Deck terminal / not wired: stay inert

  let armed = false
  const badge = makeBadge()

  const mode = createInspectMode({
    onPick: (pick) => postPick(cfg, pick),
    onExit: () => {
      armed = false
      badge.remove()
    }
  })

  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'd'))
        return
      e.preventDefault()
      e.stopPropagation()
      if (armed) {
        mode.exit()
        armed = false
        badge.remove()
      } else {
        mode.enter()
        armed = true
        document.body.appendChild(badge)
      }
    },
    true
  )
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install)
} else {
  install()
}
