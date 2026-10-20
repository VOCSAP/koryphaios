import type { ApprovalDocument } from './approval-document'

export const APPROVAL_WINDOW_CHANNELS = {
  getState: 'approval-window:get-state',
  read: 'approval-window:read',
  verdict: 'approval-window:verdict'
} as const

export type ApprovalVerdict = 'approve' | 'refuse'

export interface ApprovalReadMetrics {
  viewportHeight: number
  scrollHeight: number
  scrollTop: number
}

export interface ApprovalWindowSnapshot {
  generation: number
  fingerprint: string
  document: ApprovalDocument
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
}

export interface ApprovalWindowReadMetricsIntent {
  generation: number
  fingerprint: string
  metrics: ApprovalReadMetrics
}
