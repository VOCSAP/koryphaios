import type { AvatarAppearance } from './avatar-appearance'
import type { AvatarState, AvatarSummary } from '../shared/avatar-state'
import type { AvatarViewPosition, AvatarViewState, AvatarViewSummary, AvatarViewTheme } from '../shared/avatar-view'

export interface AvatarPresentationOptions {
  state: AvatarState
  appearance: AvatarAppearance
  theme: AvatarViewTheme
  send(state: AvatarViewState): void
  now?(): number
  generation?: number
  position?: AvatarViewPosition | null
}

export interface AvatarPresentation {
  getState(): AvatarViewState
  summaryForTray(): AvatarViewSummary
  setGeneration(generation: number): void
  setTheme(theme: AvatarViewTheme): void
  setPosition(position: AvatarViewPosition | null): void
  updateAppearance(patch: Partial<AvatarAppearance>): void
}

function projectSummary(summary: AvatarSummary): AvatarViewSummary {
  return {
    face: summary.face,
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
  let appearance = options.appearance
  let theme = options.theme
  let generation = options.generation ?? 0
  let position = options.position ?? null
  let revision = 0
  let current: AvatarViewState | null = null

  const publish = (): AvatarViewState => {
    const dndActive = appearance.dndUntil !== null && now() < appearance.dndUntil
    current = {
      generation,
      revision: ++revision,
      summary: projectSummary(options.state.summary()),
      presentation: {
        position,
        theme,
        motion: appearance.motion,
        dndActive,
        visible: appearance.visible,
        alwaysOnTop: appearance.alwaysOnTop,
        positionLocked: appearance.positionLocked,
        size: appearance.size,
        idleOpacity: appearance.idleOpacity
      }
    }
    options.send(current)
    return current
  }

  return {
    getState: publish,
    summaryForTray: () => publish().summary,
    setGeneration(nextGeneration) {
      generation = nextGeneration
      publish()
    },
    setTheme(nextTheme) {
      theme = nextTheme
      publish()
    },
    setPosition(nextPosition) {
      position = nextPosition
      publish()
    },
    updateAppearance(patch) {
      appearance = { ...appearance, ...patch }
      publish()
    }
  }
}
