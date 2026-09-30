import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm'

export const FOCUS_REPORTING_MODE = 1004

type CsiParams = (number | number[])[]

export interface FocusReportingTerminal {
  parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: CsiParams) => boolean
    ): { dispose(): void }
  }
}

/**
 * Keeps a Claude Code terminal believing it has focus. Once it receives ESC[O,
 * Claude Code stops animating its OSC title, and the title tick is the only
 * signal the activity predicate reads, so every unfocused tile would read idle.
 * Swallowing DECSET 1004 means xterm never enables focus reports; filtering
 * ESC[O out of the input stream instead would risk cutting operator bytes.
 * xterm's public handler only sees a copy of the parameters, so a sequence
 * mixing 1004 with other modes cannot be split: it is passed through whole,
 * keeping those modes, and reported once.
 */
export function suppressFocusReporting(
  term: FocusReportingTerminal,
  report: (message: string) => void
): { dispose(): void } {
  let reportedCombined = false
  return term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (!params.includes(FOCUS_REPORTING_MODE)) return false
    if (params.length === 1) return true
    if (!reportedCombined) {
      reportedCombined = true
      report(
        `terminal enabled focus reporting together with modes ${JSON.stringify(params)}; ` +
          'focus reports stay on for this terminal and its activity may read idle while unfocused'
      )
    }
    return false
  })
}

/** The only way a session terminal is built, so the focus guard cannot be forgotten at a call site. */
export function createSessionTerminal(
  options: ITerminalOptions & ITerminalInitOnlyOptions,
  report: (message: string) => void
): Terminal {
  const term = new Terminal(options)
  suppressFocusReporting(term, report)
  return term
}
