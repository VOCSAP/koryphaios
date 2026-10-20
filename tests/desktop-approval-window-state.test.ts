import { expect, test } from 'bun:test'
import {
  createApprovalWindowState,
  observeApprovalRead,
  requestApproval,
  settleApproval,
  type ApprovalWindowRequest
} from '../desktop/src/main/approval-window-state.ts'
import type { ApprovalDocument } from '../desktop/src/shared/approval-document.ts'

const document: ApprovalDocument = Object.freeze({
  message: 'Run this command?',
  detail: '01| npm run dev',
  approve: 'Run',
  refuse: 'Refuse',
  close: 'Close'
})

const readMetrics = { viewportHeight: 100, scrollHeight: 500, scrollTop: 400 }

function opened() {
  const result = requestApproval(createApprovalWindowState(), document)
  if (result.kind !== 'opened') throw new Error('request unexpectedly busy')
  return result
}

function approve(state: ReturnType<typeof createApprovalWindowState>, request: ApprovalWindowRequest) {
  return settleApproval(state, {
    generation: request.generation,
    fingerprint: request.fingerprint,
    verdict: 'approve'
  })
}

test('keeps the first immutable request when a second request is busy', () => {
  const first = opened()
  const second = requestApproval(first.state, { ...document, detail: '02| rm -rf .' })

  expect(second.kind).toBe('busy')
  expect(second.state).toBe(first.state)
  expect(second.state.current).toBe(first.current)
  expect(Object.isFrozen(first.current)).toBe(true)
  expect(Object.isFrozen(first.current.document)).toBe(true)
})

test('requires the exact current fingerprint and completed reading before approval', () => {
  const first = opened()
  const stale = observeApprovalRead(first.state, {
    generation: first.current.generation,
    fingerprint: 'wrong',
    metrics: readMetrics
  })
  const beforeRead = approve(first.state, first.current)
  const read = observeApprovalRead(first.state, {
    generation: first.current.generation,
    fingerprint: first.current.fingerprint,
    metrics: readMetrics
  })
  const approved = settleApproval(read.state, {
    generation: first.current.generation,
    fingerprint: first.current.fingerprint,
    verdict: 'approve'
  })

  expect(stale.accepted).toBe(false)
  expect(beforeRead.accepted).toBe(false)
  expect(read.accepted).toBe(true)
  expect(approved).toEqual({ accepted: true, state: { generation: 1, current: null }, verdict: 'approve' })
})

test('accepts Refuse before reading and consumes the request once', () => {
  const first = opened()
  const refused = settleApproval(first.state, {
    generation: first.current.generation,
    fingerprint: first.current.fingerprint,
    verdict: 'refuse'
  })
  const repeated = settleApproval(refused.state, {
    generation: first.current.generation,
    fingerprint: first.current.fingerprint,
    verdict: 'refuse'
  })

  expect(refused).toEqual({ accepted: true, state: { generation: 1, current: null }, verdict: 'refuse' })
  expect(repeated.accepted).toBe(false)
  expect(repeated.verdict).toBeNull()
})

test('rejects an intent from another generation even with the exact fingerprint', () => {
  const first = opened()
  const otherGeneration = first.current.generation + 1
  const read = observeApprovalRead(first.state, {
    generation: otherGeneration,
    fingerprint: first.current.fingerprint,
    metrics: readMetrics
  })
  const readyState = observeApprovalRead(first.state, {
    generation: first.current.generation,
    fingerprint: first.current.fingerprint,
    metrics: readMetrics
  }).state
  const refuse = settleApproval(first.state, { generation: otherGeneration, fingerprint: first.current.fingerprint, verdict: 'refuse' })
  const approve = settleApproval(readyState, { generation: otherGeneration, fingerprint: first.current.fingerprint, verdict: 'approve' })

  expect(read.accepted, 'a read observed for another generation').toBe(false)
  expect(refuse).toMatchObject({ accepted: false, verdict: null, reason: 'stale-request' })
  expect(approve).toMatchObject({ accepted: false, verdict: null, reason: 'stale-request' })
  expect(refuse.state.current).toBe(first.current)
})

test('rejects an infinite viewport height as completed reading', () => {
  const first = opened()
  const result = observeApprovalRead(first.state, {
    generation: first.current.generation,
    fingerprint: first.current.fingerprint,
    metrics: { viewportHeight: Number.POSITIVE_INFINITY, scrollHeight: 500, scrollTop: 0 }
  })

  expect(result.accepted, 'an infinite viewport would count as having read any document').toBe(false)
  expect(result.state.current?.read).toBe(false)
})

test('rejects invalid verdict values and invalid reading metrics', () => {
  const first = opened()
  for (const metrics of [
    { viewportHeight: Number.NaN, scrollHeight: 1, scrollTop: 0 },
    { viewportHeight: 1, scrollHeight: Number.POSITIVE_INFINITY, scrollTop: 0 },
    { viewportHeight: 0, scrollHeight: 1, scrollTop: 0 },
    { viewportHeight: 1, scrollHeight: 1, scrollTop: -1 }
  ]) {
    expect(
      observeApprovalRead(first.state, {
        generation: first.current.generation,
        fingerprint: first.current.fingerprint,
        metrics
      }).accepted
    ).toBe(false)
  }

  const invalid = settleApproval(first.state, {
    generation: first.current.generation,
    fingerprint: first.current.fingerprint,
    verdict: 'allow'
  })
  expect(invalid.accepted).toBe(false)
  expect(invalid.reason).toBe('invalid-verdict')
})
