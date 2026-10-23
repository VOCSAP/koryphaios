import type { Terminal } from '@xterm/xterm'
import { useDeck } from './store'
import { normalizeTerminalSelection } from './terminal-selection-normalize'

type StringWidth = (text: string) => number

type TerminalWithUnicodeService = Terminal & {
  _core?: { unicodeService?: { getStringCellWidth?: StringWidth } }
}

function terminalStringWidth(term: Terminal): StringWidth | undefined {
  const unicodeService = (term as TerminalWithUnicodeService)._core?.unicodeService
  return typeof unicodeService?.getStringCellWidth === 'function'
    ? unicodeService.getStringCellWidth.bind(unicodeService)
    : undefined
}

function reportClipboardFailure(action: 'copy' | 'paste'): void {
  const message = `clipboard ${action} failed`
  window.api.reportError('terminal', message)
  useDeck.getState().showToast(message, 'error', { raw: true })
}

async function restoreSelectionIfCurrent(repaired: string, selection: string): Promise<void> {
  try {
    if (await navigator.clipboard.readText() === repaired) await navigator.clipboard.writeText(selection)
  } catch {
    reportClipboardFailure('copy')
  }
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
    const text = useDeck.getState().config?.normalizeTerminalCopy === false
      ? selection
      : normalizeTerminalSelection(selection, term.cols, {
          requireAgentIndent: true,
          stringWidth: terminalStringWidth(term)
        })
    await navigator.clipboard.writeText(text)
    if (text !== selection) {
      useDeck.getState().showToast('toast.terminalCopyRepaired', 'info', {
        action: {
          label: 'common.undo',
          onClick: () => {
            void restoreSelectionIfCurrent(text, selection)
          }
        }
      })
    }
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
