import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  reachedBottom,
  type ApprovalReadMetrics,
  type ApprovalWindowApi,
  type ApprovalWindowSnapshot
} from '../../../shared/approval-window'

export interface ApprovalReaderProps {
  api: ApprovalWindowApi
  /** Closing the window settles the request as a refusal main-side. */
  closeWindow(): void
}

const keyOf = (snapshot: ApprovalWindowSnapshot): string => `${snapshot.generation}:${snapshot.fingerprint}`

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Chromium may report a fractional scrollTop under zoom; main's predicate has no tolerance, so the sub-pixel is rounded up here. */
function metricsOf(element: HTMLElement): ApprovalReadMetrics {
  return { viewportHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: Math.ceil(element.scrollTop) }
}

export function ApprovalReader({ api, closeWindow }: ApprovalReaderProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ApprovalWindowSnapshot | null>(null)
  const [atBottom, setAtBottom] = useState(false)
  const [readKey, setReadKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLPreElement>(null)
  const refuseRef = useRef<HTMLButtonElement>(null)
  const snapshotRef = useRef<ApprovalWindowSnapshot | null>(null)
  const readKeyRef = useRef<string | null>(null)
  const pendingReadRef = useRef<string | null>(null)
  const busyRef = useRef(false)

  const key = snapshot === null ? null : keyOf(snapshot)
  const unlocked = key !== null && readKey === key && atBottom && !busy

  useEffect(() => {
    let live = true
    api.getState().then(
      (state) => {
        if (!live) return
        snapshotRef.current = state
        setSnapshot(state)
        setAtBottom(false)
        setError(null)
      },
      (failure: unknown) => {
        api.reportError(`state unavailable: ${describe(failure)}`)
        closeWindow()
      }
    )
    return () => {
      live = false
    }
  }, [api, closeWindow])

  const measure = useCallback((): void => {
    const current = snapshotRef.current
    const element = scrollRef.current
    if (current === null || element === null) return
    const metrics = metricsOf(element)
    const bottom = reachedBottom(metrics)
    setAtBottom(bottom)
    const currentKey = keyOf(current)
    if (!bottom || readKeyRef.current === currentKey || pendingReadRef.current === currentKey) return
    pendingReadRef.current = currentKey
    api.read({ generation: current.generation, fingerprint: current.fingerprint, metrics }).then(
      () => {
        if (snapshotRef.current === null || keyOf(snapshotRef.current) !== currentKey) return
        readKeyRef.current = currentKey
        setReadKey(currentKey)
        setError(null)
      },
      (failure: unknown) => {
        api.reportError(`read rejected: ${describe(failure)}`)
        setError(current.presentation.text.readFailed)
      }
    ).finally(() => {
      if (pendingReadRef.current === currentKey) pendingReadRef.current = null
    })
  }, [api])

  useLayoutEffect(() => {
    if (snapshot === null) return
    document.documentElement.lang = snapshot.presentation.lang
    refuseRef.current?.focus()
    measure()
    const frame = requestAnimationFrame(measure)
    const element = scrollRef.current
    element?.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer !== null) {
      if (element) observer.observe(element)
      if (textRef.current) observer.observe(textRef.current)
    }
    return () => {
      cancelAnimationFrame(frame)
      element?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [snapshot, measure])

  const settleBusy = useCallback((value: boolean): void => {
    busyRef.current = value
    setBusy(value)
  }, [])

  const refuse = useCallback((): void => {
    const current = snapshotRef.current
    if (busyRef.current) return
    if (current === null) {
      closeWindow()
      return
    }
    settleBusy(true)
    api.verdict({ generation: current.generation, fingerprint: current.fingerprint, verdict: 'refuse' }).catch((failure: unknown) => {
      api.reportError(`refusal rejected: ${describe(failure)}`)
      closeWindow()
    })
  }, [api, closeWindow, settleBusy])

  const submitApproval = async (): Promise<void> => {
    if (!unlocked) return
    const current = snapshotRef.current
    const element = scrollRef.current
    if (current === null || element === null || busyRef.current) return
    const metrics = metricsOf(element)
    if (!reachedBottom(metrics)) {
      setAtBottom(false)
      return
    }
    settleBusy(true)
    const identity = { generation: current.generation, fingerprint: current.fingerprint }
    try {
      await api.read({ ...identity, metrics })
      await api.verdict({ ...identity, verdict: 'approve' })
    } catch (failure) {
      api.reportError(`approval rejected: ${describe(failure)}`)
      setError(current.presentation.text.verdictFailed)
      settleBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      refuse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refuse])

  if (snapshot === null) return <div className="approval-root" aria-busy="true" />

  const { document: request, presentation } = snapshot
  const status = error ?? (atBottom ? presentation.text.reached : presentation.text.unreached)

  return (
    <div className="approval-root">
      <header className="modal-head">
        <h2>{request.message}</h2>
      </header>
      <div ref={scrollRef} className="approval-scroll" tabIndex={0} role="region" aria-label={presentation.text.regionLabel}>
        <pre ref={textRef} className="approval-text">{request.detail}</pre>
      </div>
      <footer className="approval-foot">
        <p id="approval-status" className={error === null ? 'approval-status' : 'approval-status is-error'} role={error === null ? 'status' : 'alert'}>
          {status}
        </p>
        <div className="modal-actions">
          <button ref={refuseRef} type="button" className="btn" disabled={busy} onClick={refuse}>
            {request.refuse}
          </button>
          <button type="button" className="primary" disabled={!unlocked} aria-describedby="approval-status" onClick={() => void submitApproval()}>
            {request.approve}
          </button>
        </div>
      </footer>
    </div>
  )
}
