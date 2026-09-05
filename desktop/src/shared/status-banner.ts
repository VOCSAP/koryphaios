// Which single banner the top strip shows. Pure, so the PRIORITY between the
// four states is testable without mounting the renderer: the states overlap in
// real life (a link that comes back both clears the offline banner and reveals
// the conflicts it produced), and only one bar may ever be painted -- the
// banner is a fixed overlay, two of them would stack over the window.
//
// No React, no electron, no @shared alias: importable by a relative path from
// bun test.

import type { RoadmapSyncStatus } from './types'

export type StatusBannerKind = 'broker-down' | 'conflicts' | 'refused' | 'replica-offline'

export interface StatusBannerInput {
  /** Reachability of the LOCAL broker; null until the first poll answers. */
  brokerUp: boolean | null
  /** The operator hid the banner of the outage currently open. */
  brokerDismissed: boolean
  /**
   * Conflicts of THIS project -- the same count as the Roadmap rail badge,
   * never `status.conflicts`, which the broker computes across every project.
   */
  conflicts: number
  status: RoadmapSyncStatus
}

/**
 * The ladder, most blocking first:
 *
 * 1. the local broker is unreachable -- nothing else can be acted on, and the
 *    operator's dismissal of THAT outage silences the whole strip (the rail
 *    keeps its red dot): a conflict cannot be arbitrated through a broker that
 *    does not answer, so promoting a lower banner here would offer an action
 *    that is guaranteed to fail;
 * 2. cards await arbitration -- the only state carrying an operator ACTION,
 *    and the one that appears exactly when the offline banner disappears;
 * 3. the upstream refused pushes -- the link is up, the changes are not
 *    leaving, and no button can fix it;
 * 4. the upstream is unreachable -- work continues locally, only the sharing
 *    is paused.
 */
export function bannerKind(input: StatusBannerInput): StatusBannerKind | null {
  if (input.brokerUp === false) return input.brokerDismissed ? null : 'broker-down'
  if (input.conflicts > 0) return 'conflicts'
  // `online === true` and not merely "not false": an undefined online is a
  // broker that never reported one, and a refusal counter without a link state
  // must not be read as a healthy link.
  if (input.status.online === true && (input.status.refused ?? 0) > 0) return 'refused'
  if (input.status.mode === 'replica' && input.status.online === false) return 'replica-offline'
  return null
}
