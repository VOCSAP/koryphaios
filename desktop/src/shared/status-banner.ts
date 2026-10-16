// Which single banner the top strip shows. Pure, so the PRIORITY between the
// four states is testable without mounting the renderer: the states overlap in
// real life (a link that comes back both clears the offline banner and reveals
// the conflicts it produced), and only one bar may ever be painted -- the
// banner is a fixed overlay, two of them would stack over the window.
//
// No React, no electron, no @shared alias: importable by a relative path from
// bun test.

import type { OperatorTrustState, RoadmapSyncOfflineReason, RoadmapSyncStatus } from './types'

export type StatusBannerKind =
  | 'broker-stopped'
  | 'broker-down'
  | 'operator-unconfigured'
  | 'operator-not-trusted'
  | 'operator-incompatible'
  | 'operator-identity-unreadable'
  | 'operator-invalid'
  | 'operator-unreachable'
  | 'conflicts'
  | 'refused'
  | 'replica-offline'

export interface StatusBannerInput {
  /** The operator stopped the local broker on purpose: not dismissable, only Start clears it. */
  brokerManualStop: boolean
  /** Reachability of the LOCAL broker; null until the first poll answers. */
  brokerUp: boolean | null
  /** The operator hid the banner of the outage currently open. */
  brokerDismissed: boolean
  operatorTrust: OperatorTrustState
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
 * 1. the operator stopped the local broker on purpose;
 * 2. the local broker is unreachable;
 * 3. cards await arbitration;
 * 4. the upstream refused pushes;
 * 5. operator trust is degraded, so privileged actions remain unavailable;
 * 6. the upstream is unreachable.
 */
export function bannerKind(input: StatusBannerInput): StatusBannerKind | null {
  if (input.brokerManualStop) return 'broker-stopped'
  if (input.brokerUp === false) return input.brokerDismissed ? null : 'broker-down'
  if (input.conflicts > 0) return 'conflicts'
  // `online === true` and not merely "not false": an undefined online is a
  // broker that never reported one, and a refusal counter without a link state
  // must not be read as a healthy link.
  if (input.status.online === true && (input.status.refused ?? 0) > 0) return 'refused'
  if (input.operatorTrust === 'unconfigured') return 'operator-unconfigured'
  if (input.operatorTrust === 'not-trusted') return 'operator-not-trusted'
  if (input.operatorTrust === 'incompatible') return 'operator-incompatible'
  if (input.operatorTrust === 'identity-unreadable') return 'operator-identity-unreadable'
  if (input.operatorTrust === 'invalid') return 'operator-invalid'
  if (input.operatorTrust === 'unreachable') return 'operator-unreachable'
  if (input.status.mode === 'replica' && input.status.online === false) return 'replica-offline'
  return null
}

/**
 * The i18n key for the replica-offline banner (card 7974fb83): none of the
 * three reasons changes retry/backoff or federation dormancy, only which
 * sentence is true. 'stale_upstream' and 'refused' are not network outages --
 * naming them 'unreachable' sends the operator hunting for a problem that is
 * not there. Falls back to the original wording for 'transport', null, and
 * undefined (an older broker that has never sent the field) alike.
 */
export function replicaOfflineTextKey(reason: RoadmapSyncOfflineReason | null | undefined): string {
  if (reason === 'stale_upstream') return 'banner.replicaStale'
  if (reason === 'refused') return 'banner.replicaRefused'
  return 'banner.replicaOffline'
}
