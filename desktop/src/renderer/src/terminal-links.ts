import type { ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm'
import type { ImagePreviewResult, LinkIntent, LinkOutcome, LinkRefusal } from '../../shared/types'
import { cellOfIndex, detectLinks, locate, logicalLine, type RowCell } from '../../shared/link-detect'

/** What main refuses, plus the one refusal made here without asking main. */
export type LinkNotice = LinkRefusal | 'sandbox'

export interface TerminalLinkDeps {
  open(target: string, intent: LinkIntent): Promise<LinkOutcome>
  /** Main refuses by value; a rejection is a transport failure. */
  preview(target: string): Promise<ImagePreviewResult>
  onRefused(reason: LinkNotice): void
  report(message: string): void
  /** False on a sandbox tile: its paths are the container's, so only http(s) stays clickable. */
  fileLinks(): boolean
  /** Translated text for an i18n key, read at hover time so a locale change applies to the next tooltip. */
  label(key: string): string
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
const PREVIEW_TARGET_RE = /\.(?:png|jpe?g)$/i
const TOOLTIP_OFFSET = 12
const VIEWPORT_MARGIN = 8

interface PreviewJob {
  target: string
  host: HTMLDivElement
  generation: number
}

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
export function installTerminalLinks(term: LinkTerminal, deps: TerminalLinkDeps): { dispose(): void } {
  const activate = (target: string, event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>): void =>
    activateLink(deps, target, event)
  let tooltip: HTMLDivElement | undefined
  // Every leave, replacement and dispose moves the generation on: an answer for an older hover is dropped.
  let generation = 0
  let requesting = false
  let waiting: PreviewJob | undefined
  const anchor = { x: 0, y: 0 }
  const hideTooltip = (): void => {
    generation++
    tooltip?.remove()
    tooltip = undefined
  }
  const placeInViewport = (host: HTMLDivElement): void => {
    // A fixed box is as wide as the room right of its left edge: measured anywhere but at 0 it would come out too narrow.
    host.style.setProperty('--terminal-link-tooltip-x', '0px')
    const box = host.getBoundingClientRect()
    const x = Math.max(VIEWPORT_MARGIN, Math.min(anchor.x, window.innerWidth - box.width - VIEWPORT_MARGIN))
    const y = Math.max(VIEWPORT_MARGIN, Math.min(anchor.y, window.innerHeight - box.height - VIEWPORT_MARGIN))
    host.style.setProperty('--terminal-link-tooltip-x', `${x}px`)
    host.style.setProperty('--terminal-link-tooltip-y', `${y}px`)
  }
  const addNote = (host: HTMLDivElement, key: string): void => {
    const note = document.createElement('div')
    note.className = 'terminal-link-preview-note'
    note.textContent = deps.label(key)
    host.append(note)
  }
  const present = (host: HTMLDivElement, target: string, result: ImagePreviewResult | undefined): void => {
    host.querySelector('.terminal-link-preview-note')?.remove()
    if (result?.ok === false && result.reason === 'busy') return
    if (!result?.ok) {
      addNote(host, 'tile.linkPreviewUnavailable')
      placeInViewport(host)
      return
    }
    const img = document.createElement('img')
    img.className = 'terminal-link-preview'
    img.alt = ''
    img.width = result.width
    img.height = result.height
    img.addEventListener('load', () => placeInViewport(host))
    img.addEventListener('error', () => {
      deps.report(`image preview could not be decoded: ${target.slice(0, 200)}`)
      img.remove()
      addNote(host, 'tile.linkPreviewUnavailable')
      placeInViewport(host)
    })
    img.src = result.dataUrl
    host.append(img)
  }
  // One request at a time; of the hovers that pile up behind it, only the last is kept.
  const requestPreview = (job: PreviewJob): void => {
    if (requesting) {
      waiting = job
      return
    }
    requesting = true
    deps
      .preview(job.target)
      .then(
        (result) => {
          if (job.generation === generation) present(job.host, job.target, result)
        },
        (e: unknown) => {
          deps.report(`image preview failed: ${e instanceof Error ? e.message : String(e)}`)
          if (job.generation === generation) present(job.host, job.target, undefined)
        }
      )
      .finally(() => {
        requesting = false
        const next = waiting
        waiting = undefined
        if (next && next.generation === generation) requestPreview(next)
      })
  }
  const showTooltip = (target: string, event: Pick<MouseEvent, 'clientX' | 'clientY'>): void => {
    if (typeof document === 'undefined') return
    hideTooltip()
    tooltip = document.createElement('div')
    tooltip.className = 'terminal-link-tooltip xterm-hover'
    tooltip.setAttribute('role', 'tooltip')
    // Main sends a web target to the browser whatever the intent, so a web link has one gesture.
    const gestures = WEB_URL_RE.test(target)
      ? [deps.label('tile.linkBrowser'), deps.label('tile.linkShift')]
      : deps.fileLinks()
        ? [deps.label('tile.linkReveal'), deps.label('tile.linkOpen'), deps.label('tile.linkShift')]
        : [deps.label('tile.linkSandbox')]
    tooltip.textContent = [target, ...gestures].join('\n')
    anchor.x = event.clientX + TOOLTIP_OFFSET
    anchor.y = event.clientY + TOOLTIP_OFFSET
    tooltip.style.setProperty('--terminal-link-tooltip-x', `${anchor.x}px`)
    tooltip.style.setProperty('--terminal-link-tooltip-y', `${anchor.y}px`)
    document.body.append(tooltip)
    if (!WEB_URL_RE.test(target) && deps.fileLinks() && PREVIEW_TARGET_RE.test(target)) {
      addNote(tooltip, 'tile.linkPreviewLoading')
      requestPreview({ target, host: tooltip, generation })
    }
  }

  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, text) => activate(text, event),
    hover: (event, text) => showTooltip(text, event),
    leave: hideTooltip
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
          activate: (event) => activate(match.target, event),
          hover: (event) => showTooltip(match.target, event),
          leave: hideTooltip
        })
      }
      callback(links.length > 0 ? links : undefined)
    }
  })
  return { dispose: hideTooltip }
}
