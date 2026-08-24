// Guest preload injected into the embedded-browser <webview> (PLAN D1).
//
// Thin transport around the shared inspect-mode core (shared/element-pick.ts):
// the Deck renderer toggles it with webview.send('deck:enter-inspect' /
// 'deck:exit-inspect'); a pick (or Escape) reports back over
// ipcRenderer.sendToHost. Living in a preload (rather than an
// executeJavaScript injection) means the bridge re-installs itself on every
// navigation for free.

import { ipcRenderer } from 'electron'
import { createInspectMode } from '@shared/element-pick'

const mode = createInspectMode({
  onPick: (pick) => ipcRenderer.sendToHost('deck:element-selected', pick),
  // S hover-shortcut (Chantier OD6): screenshot the hovered element without
  // ever clicking it, so a hover-dependent state (menu, dropdown) survives.
  onShot: (pick) => ipcRenderer.sendToHost('deck:element-shot', pick),
  // Tell the host to unpress the ⌖ button (single-shot / Escape).
  onExit: () => ipcRenderer.sendToHost('deck:inspect-ended')
})

// Annotate review (Chantier OD5, DESIGN-ORCA-DOOP-ADOPTION.md §3.5): a SECOND
// inspect instance armed with { multi: true } -- a pick here does not exit,
// so the operator pins several elements before sending one batched review.
// Distinct channels from the single-shot pair above so BrowserView.tsx can
// tell which mode produced a pick/exit without any payload-shape sniffing.
// The host guarantees the two are never armed at once (entering one sends
// this preload the OTHER mode's exit message first) -- this file stays a
// dumb transport and does not enforce that itself.
const reviewMode = createInspectMode(
  {
    onPick: (pick) => ipcRenderer.sendToHost('deck:annotation-picked', pick),
    onExit: () => ipcRenderer.sendToHost('deck:review-inspect-ended')
  },
  { multi: true }
)

ipcRenderer.on('deck:enter-inspect', mode.enter)
ipcRenderer.on('deck:exit-inspect', mode.exit)
ipcRenderer.on('deck:enter-inspect-multi', reviewMode.enter)
ipcRenderer.on('deck:exit-inspect-multi', reviewMode.exit)
