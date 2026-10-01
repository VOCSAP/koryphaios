import { AvatarState } from '../shared/avatar-state'
import type { AvatarViewTheme } from '../shared/avatar-view'
import { createAvatarPresentation, type AvatarPresentation } from './avatar-presentation'
import type { SupportedLocale } from './i18n'

export interface AvatarBootstrapOptions {
  theme: AvatarViewTheme
  locale: SupportedLocale
  now(): number
}

export interface AvatarBootstrap {
  state: AvatarState
  presentation: AvatarPresentation
}

export function createAvatarBootstrap(options: AvatarBootstrapOptions): AvatarBootstrap {
  const state = new AvatarState({ now: options.now })
  const presentation = createAvatarPresentation({ state, theme: options.theme, locale: options.locale, now: options.now })
  return { state, presentation }
}
