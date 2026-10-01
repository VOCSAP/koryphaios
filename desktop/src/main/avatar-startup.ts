import { followAvatarScreens, type AvatarScreenSource } from './avatar-assembly'
import type { AvatarEvent } from './avatar-window-state'

export interface AvatarThemeSource {
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

export interface AvatarStartupSteps {
  claimRegistry(): void
  createTray(): void
  theme: AvatarThemeSource
  themeChanged(): void
  screen: AvatarScreenSource
  geometryChanged(): void
  dispatch(event: AvatarEvent): unknown
}

/**
 * The window may only appear once the registry is held and the Tray offers Quit; geometry and theme are re-read
 * after subscribing because the startup await may have outlived their snapshot. Returns the follower stop.
 */
export function finishAvatarStartup(steps: AvatarStartupSteps): () => void {
  steps.claimRegistry()
  steps.createTray()
  steps.theme.on('updated', steps.themeChanged)
  const stopScreens = followAvatarScreens(steps.screen, steps.geometryChanged)
  steps.geometryChanged()
  steps.themeChanged()
  steps.dispatch({ kind: 'RestoreRequested' })
  return () => {
    steps.theme.removeListener('updated', steps.themeChanged)
    stopScreens()
  }
}
