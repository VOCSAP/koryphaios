import { createHash } from 'node:crypto'

import type { ApprovalDocument } from '../shared/approval-document'
import { reachedBottom, type ApprovalReadMetrics, type ApprovalVerdict } from '../shared/approval-window'

export interface ApprovalWindowRequest {
  readonly generation: number
  readonly fingerprint: string
  readonly document: ApprovalDocument
  readonly read: boolean
}

export interface ApprovalWindowState {
  readonly generation: number
  readonly current: ApprovalWindowRequest | null
}

export interface ApprovalReadIntent {
  generation: number
  fingerprint: string
  metrics: ApprovalReadMetrics
}

export interface ApprovalVerdictIntent {
  generation: number
  fingerprint: string
  verdict: unknown
}

export type ApprovalRequestResult =
  | { kind: 'opened'; state: ApprovalWindowState; current: ApprovalWindowRequest }
  | { kind: 'busy'; state: ApprovalWindowState }

export interface ApprovalTransition {
  accepted: boolean
  state: ApprovalWindowState
}

export interface ApprovalSettlement extends ApprovalTransition {
  verdict: ApprovalVerdict | null
  reason?: 'missing-request' | 'stale-request' | 'invalid-verdict' | 'reading-required'
}

const frozenState = (generation: number, current: ApprovalWindowRequest | null): ApprovalWindowState => Object.freeze({ generation, current })

export function createApprovalWindowState(): ApprovalWindowState {
  return frozenState(0, null)
}

export function fingerprintApprovalDocument(document: ApprovalDocument): string {
  const value = JSON.stringify([document.message, document.detail, document.approve, document.refuse, document.close, document.showFile ?? null])
  return createHash('sha256').update(value).digest('hex')
}

export function requestApproval(state: ApprovalWindowState, document: ApprovalDocument): ApprovalRequestResult {
  if (state.current !== null) return { kind: 'busy', state }
  const current: ApprovalWindowRequest = Object.freeze({
    generation: state.generation + 1,
    fingerprint: fingerprintApprovalDocument(document),
    document: Object.freeze({ ...document }),
    read: false
  })
  return { kind: 'opened', state: frozenState(current.generation, current), current }
}

function isCurrent(state: ApprovalWindowState, generation: number, fingerprint: string): state is ApprovalWindowState & { current: ApprovalWindowRequest } {
  return state.current !== null && state.current.generation === generation && state.current.fingerprint === fingerprint
}

export function observeApprovalRead(state: ApprovalWindowState, intent: ApprovalReadIntent): ApprovalTransition {
  if (!isCurrent(state, intent.generation, intent.fingerprint) || !reachedBottom(intent.metrics)) return { accepted: false, state }
  const current = Object.freeze({ ...state.current, read: true })
  return { accepted: true, state: frozenState(state.generation, current) }
}

export function settleApproval(state: ApprovalWindowState, intent: ApprovalVerdictIntent): ApprovalSettlement {
  if (state.current === null) return { accepted: false, state, verdict: null, reason: 'missing-request' }
  if (!isCurrent(state, intent.generation, intent.fingerprint)) return { accepted: false, state, verdict: null, reason: 'stale-request' }
  if (intent.verdict !== 'approve' && intent.verdict !== 'refuse') return { accepted: false, state, verdict: null, reason: 'invalid-verdict' }
  if (intent.verdict === 'approve' && !state.current.read) return { accepted: false, state, verdict: null, reason: 'reading-required' }
  return { accepted: true, state: frozenState(state.generation, null), verdict: intent.verdict }
}
