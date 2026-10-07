import { COMPANION_MANIFEST, REMOTE_BLOCKED_CHANNELS } from '../../../shared/companion'

/** Derived from the companion's remote floor, so every host offering a verdict follows a re-tiering. */
export const VERDICT_BLOCKED_REMOTELY =
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalReply.channel) ||
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalDecline.channel) ||
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalAck.channel) ||
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalAllow.channel) ||
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalAnswers.channel) ||
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalHandback.channel)

/** False on a remote companion whose verdict channels are blocked: render no verdict control. */
export function canAnswerVerdict(remote: boolean): boolean {
  return !(remote && VERDICT_BLOCKED_REMOTELY)
}
