import type { EnsureOutcome } from './broker-spawn'

export type BrokerStartResult = { ok: true } | { ok: false; error: string }

export interface BrokerStartDeps {
  /** Removes the operator's stop marker; throws when the file cannot be removed. */
  clearMarker(): void
  /** GET /health of the loopback broker: true when it answers. */
  isAlive(): Promise<boolean>
  ensure(): Promise<EnsureOutcome>
  /** Re-reads the marker and re-broadcasts the broker status, whatever the outcome. */
  refresh(): void
  report(scope: string, message: string, error?: unknown): void
}

function failureOf(outcome: EnsureOutcome): string | null {
  switch (outcome.action) {
    case 'started':
    case 'already-running':
      return null
    case 'skipped':
      return outcome.reason === 'remote-mode'
        ? 'the Deck uses a remote broker, there is no local broker to start'
        : 'the broker was stopped again while it was being started'
    case 'not-found':
      return 'no broker.ts to start: add the claude-peers MCP entry to ~/.claude.json or run the Deck from its repository'
    case 'failed':
      return `the broker did not start from ${outcome.script}: ${outcome.reason}`
  }
}

/**
 * The banner's Start button. The marker goes first, or ensure() would refuse
 * on it; /health is asked before any spawn because the Avatar tray may have
 * started the broker a moment earlier, and a second broker on the same port
 * only fails after it has opened the database. Concurrent clicks share one
 * start.
 */
export function createBrokerStart(deps: BrokerStartDeps): () => Promise<BrokerStartResult> {
  let inFlight: Promise<BrokerStartResult> | null = null

  const fail = (message: string, error?: unknown): BrokerStartResult => {
    deps.report('broker', `broker start failed: ${message}`, error)
    return { ok: false, error: message }
  }

  const run = async (): Promise<BrokerStartResult> => {
    try {
      deps.clearMarker()
    } catch (e) {
      return fail(`the stop marker could not be removed: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    try {
      if (await deps.isAlive()) return { ok: true }
      const failure = failureOf(await deps.ensure())
      return failure === null ? { ok: true } : fail(failure)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), e)
    }
  }

  return () => {
    inFlight ??= run().finally(() => {
      inFlight = null
      try {
        deps.refresh()
      } catch (e) {
        deps.report('broker', 'broker status refresh failed', e)
      }
    })
    return inFlight
  }
}
