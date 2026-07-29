import type { Terminal } from '@xterm/xterm'

// Clipboard bridge for every xterm the Deck hosts. Shared on purpose: this
// logic lived only in TerminalTile, so the sandbox LOGIN terminal shipped with
// no copy path at all -- and that is the one terminal where copying is the
// whole point (the operator has to move an OAuth URL to the host browser).
// Worse, the failure is silent AND misleading: the CLI running inside the
// container prints "Copied!" after writing to the CONTAINER's clipboard, which
// never reaches Windows. Any new terminal component must wire these two.

/** Copy the current selection to the clipboard and clear it. No-op if empty. */
export function copySelection(term: Terminal): boolean {
  const sel = term.getSelection()
  if (!sel) return false
  void navigator.clipboard.writeText(sel)
  term.clearSelection()
  return true
}

/** Paste clipboard text through xterm (bracketed-paste aware -> onData -> PTY). */
export async function pasteFromClipboard(term: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) term.paste(text)
  } catch {
    /* clipboard read denied / unavailable */
  }
}
