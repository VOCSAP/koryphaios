import type { ApprovalDocument } from './approval-document'

export const APPROVAL_WINDOW_CHANNELS = {
  getState: 'approval-window:get-state',
  read: 'approval-window:read',
  verdict: 'approval-window:verdict',
  reportError: 'approval-window:report-error'
} as const

export const APPROVAL_READER_ERROR_MAX_BYTES = 2_048

export type ApprovalVerdict = 'approve' | 'refuse'

export interface ApprovalReadMetrics {
  viewportHeight: number
  scrollHeight: number
  scrollTop: number
}

/** The main process decides with this predicate; the reader only uses it to avoid sending a read the main would reject. */
export function reachedBottom(metrics: ApprovalReadMetrics): boolean {
  return (
    Number.isFinite(metrics.viewportHeight) &&
    Number.isFinite(metrics.scrollHeight) &&
    Number.isFinite(metrics.scrollTop) &&
    metrics.viewportHeight > 0 &&
    metrics.scrollHeight > 0 &&
    metrics.scrollTop >= 0 &&
    metrics.scrollTop <= metrics.scrollHeight &&
    metrics.scrollTop + metrics.viewportHeight >= metrics.scrollHeight
  )
}

export interface ApprovalPresentationText {
  regionLabel: string
  unreached: string
  reached: string
  readFailed: string
  verdictFailed: string
}

/** Interface text of the reader. It is not part of the approved content, so the fingerprint never covers it. */
export interface ApprovalPresentation {
  lang: 'en' | 'fr'
  text: ApprovalPresentationText
}

export interface ApprovalWindowSnapshot {
  generation: number
  fingerprint: string
  document: ApprovalDocument
  presentation: ApprovalPresentation
}

export interface ApprovalWindowVerdictIntent {
  generation: number
  fingerprint: string
  verdict: ApprovalVerdict
}

export interface ApprovalWindowApi {
  getState(): Promise<ApprovalWindowSnapshot>
  read(intent: ApprovalWindowReadMetricsIntent): Promise<void>
  verdict(intent: ApprovalWindowVerdictIntent): Promise<void>
  reportError(message: string): void
}

export interface ApprovalWindowReadMetricsIntent {
  generation: number
  fingerprint: string
  metrics: ApprovalReadMetrics
}
