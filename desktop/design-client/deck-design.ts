// deck-design client (PLAN D2b): drop this script into ANY webview-based app
// (Tauri, Electron, plain dev server page) to get Deck inspect mode inside it.
//
//   Ctrl+Shift+D  toggle inspect mode (hover highlight, click picks, Esc exits)
//
// A pick is POSTed to the Deck's LOOPBACK design endpoint; the Deck routes it
// into the docked/selected agent's prompt exactly like a pick from the
// embedded browser. Nothing transits the claude-peers broker (which may be a
// remote headless server): target app and Deck talk on 127.0.0.1 only.
//
// Endpoint discovery, in order:
//   1. window.__DECK_DESIGN__ = { url, token, source? }
//      (a Tauri app injects it from the env the Deck put in its PTY:
//       CLAUDE_DECK_DESIGN_URL / CLAUDE_DECK_DESIGN_TOKEN — see README)
//   2. <meta name="deck-design-url" content="…"> +
//      <meta name="deck-design-token" content="…">
//      (+ optional <meta name="deck-design-source" content="my-app">)
//
// Built to deck-plugin/design/deck-design.js by `npm run build:design`
// (dependency-free, safe to embed in a dev build; do NOT ship it in prod).

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
