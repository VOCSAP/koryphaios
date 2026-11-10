import { inboxEntryKey, type InboxAckStatus, type InboxEntry } from './types'

/** A forged limit that clears sooner than this never reaches the operator. */
export const QUOTA_NOTICE_DELAY_MS = 30_000

export interface QuotaEpisode {
  /**
   * `quota:<epoch ms of the 0 to >=1 transition>`. New per episode: an
   * acknowledgement is durable, so a fixed id would hide every later episode.
   */
  id: string
  startedAt: number
}

export type QuotaNoticeEntry = Extract<InboxEntry, { kind: 'event' }>

/** Tiles in a quota episode. An exited tile keeps its flag but waits on nothing. */
export function limitedSessionIds(sessions: readonly { id: string; rateLimited?: boolean; status?: string }[]): string[] {
  return sessions.filter((s) => s.rateLimited === true && s.status !== 'exited').map((s) => s.id)
}

export function quotaNoticeEntry(episode: QuotaEpisode, text: string): QuotaNoticeEntry {
  return { kind: 'event', id: episode.id, text, at: new Date(episode.startedAt).toISOString() }
}

/** The episode the Courrier lists: shown, and not acknowledged. */
export function listedQuotaEpisode(
  episode: QuotaEpisode | null,
  shown: boolean,
  ackState: Readonly<Record<string, InboxAckStatus>>
): QuotaEpisode | null {
  if (episode === null || !shown) return null
  return ackState[inboxEntryKey(quotaNoticeEntry(episode, ''))] === 'acked' ? null : episode
}

export interface QuotaNoticeState {
  episode: QuotaEpisode | null
  shown: boolean
}

export interface QuotaNoticeClock {
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

/** Follows the number of limited tiles; `onChange` fires only when the episode or its visibility changes. */
export function createQuotaNoticeTracker(
  clock: QuotaNoticeClock,
  onChange: (state: QuotaNoticeState) => void
): { observe: (limited: number) => void } {
  let episode: QuotaEpisode | null = null
  let shown = false
  let timer: unknown = null

  return {
    observe(limited) {
      if (limited <= 0) {
        if (episode === null) return
        if (timer !== null) clock.clearTimer(timer)
        timer = null
        episode = null
        shown = false
        onChange({ episode, shown })
        return
      }
      if (episode !== null) return
      const startedAt = clock.now()
      episode = { id: `quota:${startedAt}`, startedAt }
      shown = false
      timer = clock.setTimer(() => {
        timer = null
        shown = true
        onChange({ episode, shown })
      }, QUOTA_NOTICE_DELAY_MS)
      onChange({ episode, shown })
    }
  }
}
