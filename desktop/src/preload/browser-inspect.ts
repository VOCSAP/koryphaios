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

ipcRenderer.on('deck:enter-inspect', mode.enter)
ipcRenderer.on('deck:exit-inspect', mode.exit)
