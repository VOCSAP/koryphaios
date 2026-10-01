import type { AvatarState, AvatarSummary } from '../shared/avatar-state'
import type { AvatarViewState, AvatarViewSummary, AvatarViewTheme } from '../shared/avatar-view'
import { avatarFaceCopy } from './avatar-face-copy'
import type { AvatarPublication } from './avatar-window-state'
import type { SupportedLocale } from './i18n'

export interface AvatarPresentationOptions {
  state: AvatarState
  theme: AvatarViewTheme
  locale: SupportedLocale
  now?(): number
}

export interface AvatarPresentation {
  project(publication: AvatarPublication): AvatarViewState
  setTheme(theme: AvatarViewTheme): void
}

function projectSummary(summary: AvatarSummary, locale: SupportedLocale): AvatarViewSummary {
  return {
    face: summary.face,
    faceCopy: avatarFaceCopy(summary, locale),
    counters: {
      working: summary.counters.working,
      idle: summary.counters.idle,
      unknown: summary.counters.unknown,
      waiting: summary.counters.waiting,
      exited: summary.counters.exited,
      rateLimited: summary.counters.rateLimited
    },
    unread: summary.unread,
    decks: summary.decks.map((deck) => ({
      identity: {
        deckRunId: deck.identity.deckRunId,
        broker_url: deck.identity.broker_url
      },
      counters: {
        working: deck.counters.working,
        idle: deck.counters.idle,
        unknown: deck.counters.unknown,
        waiting: deck.counters.waiting,
        exited: deck.counters.exited,
        rateLimited: deck.counters.rateLimited
      },
      unread: deck.unread,
      suspect: deck.suspect,
      brokerReachable: deck.brokerReachable,
      torchOut: deck.torchOut
    }))
  }
}

export function createAvatarPresentation(options: AvatarPresentationOptions): AvatarPresentation {
  const now = options.now ?? Date.now
  let theme = options.theme

  return {
    project(publication) {
      const appearance = publication.appearance
      return {
        generation: publication.generation ?? 0,
        revision: publication.revision,
        summary: projectSummary(options.state.summary(), options.locale),
        presentation: {
          position: publication.position ? { x: publication.position.x, y: publication.position.y } : null,
          theme,
          motion: appearance.motion,
          dndActive: appearance.dndUntil !== null && now() < appearance.dndUntil,
          visible: appearance.visible,
          alwaysOnTop: appearance.alwaysOnTop,
          positionLocked: appearance.positionLocked,
          size: appearance.size,
          idleOpacity: appearance.idleOpacity
        }
      }
    },
    setTheme(nextTheme) {
      theme = nextTheme
    }
  }
}
