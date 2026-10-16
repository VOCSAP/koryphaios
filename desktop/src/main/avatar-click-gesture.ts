import type { AvatarCommand } from '../shared/avatar-protocol'
import {
  selectAvatarAttentionDeck,
  selectAvatarFocusDeck,
  type AvatarDeckIdentity,
  type AvatarDeckStatus
} from '../shared/avatar-state'
import type { AvatarViewGesture } from '../shared/avatar-view'

export interface AvatarClickGestureDeps {
  decks(): readonly AvatarDeckStatus[]
  attached(): readonly AvatarDeckIdentity[]
  send(identity: AvatarDeckIdentity, command: AvatarCommand): Promise<void>
  info(scope: string, message: string): void
  report(scope: string, message: string, error?: unknown): void
}

export function createAvatarClickGesture(deps: AvatarClickGestureDeps): (kind: AvatarViewGesture) => void {
  return (kind) => {
    const decks = deps.decks()
    const attached = deps.attached()
    if (kind === 'double') {
      const waiting = selectAvatarAttentionDeck(decks, attached)
      if (waiting === null) {
        deps.info('avatar-focus', 'Avatar double-click ignored because no attached Deck waits on the operator')
        return
      }
      void deps.send(waiting, 'open_question').catch((error: unknown) =>
        deps.report('avatar-focus', 'Avatar double-click open question gesture failed', error)
      )
      return
    }
    const target = selectAvatarFocusDeck(decks, attached)
    if (target === null) {
      deps.info('avatar-focus', 'Avatar click ignored because no attached Deck produces an urgent face')
      return
    }
    void deps.send(target, 'focus').catch((error: unknown) => deps.report('avatar-focus', 'Avatar click focus gesture failed', error))
  }
}
