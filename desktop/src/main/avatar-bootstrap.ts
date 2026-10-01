import { AvatarState } from '../shared/avatar-state'
import type { AvatarViewTheme } from '../shared/avatar-view'
import { createAvatarPresentation, type AvatarPresentation } from './avatar-presentation'

export interface AvatarBootstrapOptions {
  theme: AvatarViewTheme
  now(): number
}

export interface AvatarBootstrap {
  state: AvatarState
  presentation: AvatarPresentation
}

export function createAvatarBootstrap(options: AvatarBootstrapOptions): AvatarBootstrap {
  const state = new AvatarState({ now: options.now })
  const presentation = createAvatarPresentation({ state, theme: options.theme, now: options.now })
  return { state, presentation }
}
