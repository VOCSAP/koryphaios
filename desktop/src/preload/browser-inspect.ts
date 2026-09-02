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
import { createDrawModifierWatcher } from '@shared/draw-modifier'

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

// Hold-to-draw (embedded browser rework, docs/browser-design.md's "Draw
// mode" section): watched HERE, on the GUEST page's own document, because key
// events over the <webview> guest never reach the host window -- it is a
// separate Electron webContents/renderer process. BrowserView.tsx merges
// this with its OWN host-side watcher (armed once the pointer/focus is over
// the canvas/toolbar rather than the page) -- see that file's own comment
// for why both installs are needed. `process.platform` is available
// directly here, same as every other Node global this preload already
// relies on (`sandbox=no` on the <webview>'s webpreferences, set by
// BrowserView.tsx, is what gives a webview preload that access without a
// contextBridge indirection).
createDrawModifierWatcher(
  document,
  process.platform === 'darwin' ? 'mac' : 'other',
  (held) => ipcRenderer.sendToHost('deck:draw-modifier', held)
)

// A navigation (or the guest tearing down) mid-hold must not leave the host
// stuck believing the modifier is still held: neither a `blur` nor a keyup
// is guaranteed to fire on the way out (the page can navigate, or be torn
// down, with focus still inside it) -- force the host back to "not held"
// explicitly on both exit paths.
const forceDrawModifierReleased = (): void => ipcRenderer.sendToHost('deck:draw-modifier', false)
window.addEventListener('pagehide', forceDrawModifierReleased)
window.addEventListener('beforeunload', forceDrawModifierReleased)
// Focus leaving the guest is the COMMON exit path, not an edge case: the
// canvas the host raises on keydown sits over the page, so the operator's
// very next press lands on the host and moves focus there -- the keyup then
// happens in the host and this document never sees it. A window-level blur
// is dispatched on `window` only (it does not travel through `document`, so
// the watcher's own capture-phase blur listener cannot observe it), hence
// the explicit release here. The host mirrors this from its side too (a
// host-side keyup also clears the guest signal) so the pair closes both ways.
window.addEventListener('blur', forceDrawModifierReleased)
