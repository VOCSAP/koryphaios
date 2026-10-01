import { AvatarState } from '../shared/avatar-state'
import type { AvatarViewState, AvatarViewTheme } from '../shared/avatar-view'
import type { AvatarAppearance } from './avatar-appearance'
import { createAvatarPresentation, type AvatarPresentation } from './avatar-presentation'

export interface AvatarBootstrapOptions {
  appearance: AvatarAppearance
  theme: AvatarViewTheme
  now(): number
  send(state: AvatarViewState): void
}

export interface AvatarBootstrap {
  state: AvatarState
  presentation: AvatarPresentation
}

export function createAvatarBootstrap(options: AvatarBootstrapOptions): AvatarBootstrap {
  const state = new AvatarState({ now: options.now })
  const presentation = createAvatarPresentation({
    state,
    appearance: options.appearance,
    theme: options.theme,
    send: options.send,
    now: options.now
  })
  return { state, presentation }
}
