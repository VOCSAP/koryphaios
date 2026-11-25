import type { NotificationSoundKind } from '@shared/types'
import approvalUrl from './assets/sounds/approval.ogg'
import notificationUrl from './assets/sounds/notification.ogg'
import questionUrl from './assets/sounds/question.ogg'

export const SOUND_URLS: Record<NotificationSoundKind, string> = {
  permission: approvalUrl,
  question: questionUrl,
  attention: notificationUrl
}

export function playNotificationSound(kind: NotificationSoundKind): void {
  new Audio(SOUND_URLS[kind]).play().catch((e: unknown) => {
    const detail = e instanceof Error ? e.message : String(e)
    window.api.reportError('notification-sound', `the ${kind} sound could not play: ${detail}`)
  })
}
