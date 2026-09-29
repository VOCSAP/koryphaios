import { join } from 'node:path'

export interface AvatarLifetimeApp {
  setPath(name: string, path: string): void
  requestSingleInstanceLock(): boolean
  releaseSingleInstanceLock(): void
}

export interface AvatarLifetimeLease {
  release(): void
}

export function configureAvatarLifetime(app: AvatarLifetimeApp, deckUserData: string): AvatarLifetimeLease | null {
  app.setPath('userData', join(deckUserData, 'avatar'))
  return claimAvatarLifetime(app)
}

export function claimAvatarLifetime(app: Pick<AvatarLifetimeApp, 'requestSingleInstanceLock' | 'releaseSingleInstanceLock'>): AvatarLifetimeLease | null {
  if (!app.requestSingleInstanceLock()) return null

  let released = false
  return {
    release() {
      if (released) return
      released = true
      app.releaseSingleInstanceLock()
    }
  }
}
