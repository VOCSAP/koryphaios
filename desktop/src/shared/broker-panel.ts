// Which of the four states the Settings > Broker panel renders, and whether it
// may issue the read that feeds them. Pure, so the ORDER of the states is
// testable without mounting the renderer: a companion client is refused
// 'peersConfig:get' at the bridge, and a refused read that reached the error
// branch would show a paired phone "the configuration could not be read" --
// an alarm about a file that is simply none of its business.
//
// No React, no electron, no @shared alias: importable by a relative path from
// bun test.

import type { PeersConfigSummary } from './types'

export type BrokerPanelState = 'host-only' | 'error' | 'loading' | 'ready'

export interface BrokerPanelInput {
  /** The renderer is a companion client: window.api is the WebSocket shim. */
  companion: boolean
  /** Last summary read, null while none has been read yet. */
  peers: PeersConfigSummary | null
  /** The last read FAILED (distinct from `peers === null`, never read yet). */
  error: boolean
}

/**
 * The ladder, most decisive first:
 *
 * 1. a companion client -- the channel is on the remote-block floor, so no
 *    read can ever answer here and neither a stale summary nor a failure flag
 *    may be believed;
 * 2. the read failed -- an explicit message with a retry, never a blank page;
 * 3. no summary yet -- the read is in flight;
 * 4. the summary is here.
 */
export function brokerPanelState(input: BrokerPanelInput): BrokerPanelState {
  if (input.companion) return 'host-only'
  if (input.error) return 'error'
  if (input.peers === null) return 'loading'
  return 'ready'
}

/**
 * Whether the panel may call `peersConfig:get` at all. Derived from the state
 * machine above rather than re-testing `companion`, so the guard on the read
 * and the guard on the rendering can never disagree: the read is issued
 * exactly for the states that can display its result.
 */
export function shouldReadPeersConfig(companion: boolean): boolean {
  return brokerPanelState({ companion, peers: null, error: false }) !== 'host-only'
}
