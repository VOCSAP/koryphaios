import type { Terminal } from '@xterm/xterm'
import { useDeck } from './store'

function reportClipboardFailure(action: 'copy' | 'paste'): void {
  const message = `clipboard ${action} failed`
  window.api.reportError('terminal', message)
  useDeck.getState().showToast(message, 'error', { raw: true })
}

type CopyResult = 'empty' | 'copied' | 'failed'

export async function copySelection(term: Terminal): Promise<CopyResult> {
  const selection = term.getSelection()
  if (!selection) return 'empty'
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    reportClipboardFailure('copy')
    return 'failed'
  }
  try {
    await navigator.clipboard.writeText(selection)
    term.clearSelection()
    return 'copied'
  } catch {
    reportClipboardFailure('copy')
    return 'failed'
  }
}

export async function pasteFromClipboard(term: Terminal): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    reportClipboardFailure('paste')
    return
  }
  try {
    const text = await navigator.clipboard.readText()
    if (text) term.paste(text)
  } catch {
    reportClipboardFailure('paste')
  }
}

export async function handleTerminalContextMenu(
  term: Terminal,
  event: Pick<MouseEvent, 'preventDefault' | 'shiftKey'>
): Promise<void> {
  event.preventDefault()
  if (term.modes.mouseTrackingMode !== 'none' && !event.shiftKey) return
  if ((await copySelection(term)) === 'empty') await pasteFromClipboard(term)
}
