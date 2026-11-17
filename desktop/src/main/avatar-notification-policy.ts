import { AVATAR_NOTIFICATION_LEASE_MS } from '../shared/avatar-protocol'

export interface AvatarNotificationAvailability {
  serviceReady: boolean
  maskReady: boolean
  maskVisible: boolean
  rendererAlive: boolean
  dndActive: boolean
}

/** The Avatar may stand in for the Deck's OS notifications only when every condition holds strictly; a truthy value is not enough. */
export function canReplaceDeckNotifications(availability: AvatarNotificationAvailability, projectionReady: boolean): boolean {
  return (
    availability.serviceReady === true &&
    availability.maskReady === true &&
    availability.maskVisible === true &&
    availability.rendererAlive === true &&
    availability.dndActive === false &&
    projectionReady === true
  )
}

export interface AvatarNotificationObservation {
  negotiated: boolean
  bound: boolean
  currentContext: boolean
  status: {
    replace: boolean
    receivedAt: number
    leaseMs: number
  } | null
}

/** `now` and `receivedAt` come from one monotonic clock; a lease at its full length, a clock gone backwards or a non-finite value never suppresses. */
export function shouldSuppressDeckNotification(observation: AvatarNotificationObservation, now: number): boolean {
  const { status } = observation
  if (observation.negotiated !== true || observation.bound !== true || observation.currentContext !== true) return false
  if (status === null || status.replace !== true || status.leaseMs !== AVATAR_NOTIFICATION_LEASE_MS) return false
  if (!Number.isFinite(status.receivedAt) || !Number.isFinite(now)) return false
  const age = now - status.receivedAt
  return age >= 0 && age < AVATAR_NOTIFICATION_LEASE_MS
}
