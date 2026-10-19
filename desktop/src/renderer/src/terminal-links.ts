import type { ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm'
import type { LinkIntent, LinkOutcome, LinkRefusal } from '../../shared/types'
import { cellOfIndex, detectLinks, locate, logicalLine, type RowCell } from '../../shared/link-detect'

/** What main refuses, plus the one refusal made here without asking main. */
export type LinkNotice = LinkRefusal | 'sandbox'

export interface TerminalLinkDeps {
  open(target: string, intent: LinkIntent): Promise<LinkOutcome>
  onRefused(reason: LinkNotice): void
  report(message: string): void
  /** False on a sandbox tile: its paths are the container's, so only http(s) stays clickable. */
  fileLinks(): boolean
}

export interface LinkTerminal {
  cols: number
  options: { linkHandler?: ILinkHandler | null }
  buffer: {
    active: {
      getLine(row: number):
        | { isWrapped: boolean; translateToString(trimRight?: boolean): string; getCell(x: number): RowCell | undefined }
        | undefined
    }
  }
  registerLinkProvider(provider: ILinkProvider): { dispose(): void }
}

export const WEB_URL_RE = /^https?:/i

/** Click reveals, Ctrl/Cmd+click opens; main decides what either may do. */
export function activateLink(
  deps: TerminalLinkDeps,
  target: string,
  event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>
): void {
  // Right and middle clicks belong to copy and paste.
  if (event.button !== 0) return
  if (!WEB_URL_RE.test(target) && !deps.fileLinks()) {
    deps.report(`file link refused on a sandbox tile: ${target.slice(0, 200)}`)
    deps.onRefused('sandbox')
    return
  }
  const intent: LinkIntent = event.ctrlKey || event.metaKey ? 'open' : 'reveal'
  deps.open(target, intent).then(
    (outcome) => {
      if (!outcome.ok) deps.onRefused(outcome.reason)
    },
    (e: unknown) => {
      deps.report(`open link failed: ${e instanceof Error ? e.message : String(e)}`)
      deps.onRefused('failed')
    }
  )
}

/**
 * One click path for every link of a session terminal: OSC 8 hyperlinks (via
 * xterm's linkHandler) and links found in the printed text.
 */
export function installTerminalLinks(term: LinkTerminal, deps: TerminalLinkDeps): void {
  const activate = (target: string, event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>): void =>
    activateLink(deps, target, event)

  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, text) => activate(text, event)
  }

  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const row = bufferLineNumber - 1
      const line = logicalLine(
        (r) => term.buffer.active.getLine(r)?.translateToString(true),
        row,
        term.cols,
        (r) => term.buffer.active.getLine(r)?.isWrapped ?? false
      )
      const cellAt = (r: number, index: number): { col: number; width: number } =>
        cellOfIndex((x) => term.buffer.active.getLine(r)?.getCell(x), term.cols, index)
      const links: ILink[] = []
      for (const match of detectLinks(line.text)) {
        if (!WEB_URL_RE.test(match.target) && !deps.fileLinks()) continue
        const start = locate(line, match.start)
        const end = locate(line, match.end - 1)
        if (start.row > row || end.row < row) continue
        const startCell = cellAt(start.row, start.col)
        const endCell = cellAt(end.row, end.col)
        links.push({
          range: {
            start: { x: startCell.col + 1, y: start.row + 1 },
            end: { x: endCell.col + endCell.width, y: end.row + 1 }
          },
          text: line.text.slice(match.start, match.end),
          activate: (event) => activate(match.target, event)
        })
      }
      callback(links.length > 0 ? links : undefined)
    }
  })
}
