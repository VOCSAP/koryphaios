import { app } from 'electron'

export interface AvatarLifetimeLease {
  release(): void
}

export function claimAvatarLifetime(): AvatarLifetimeLease | null {
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
