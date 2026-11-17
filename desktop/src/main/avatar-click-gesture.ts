import type { AvatarCommand } from '../shared/avatar-protocol'
import { selectAvatarAttentionDeck, type AvatarDeckIdentity, type AvatarDeckStatus } from '../shared/avatar-state'
import type { AvatarViewGesture } from '../shared/avatar-view'

export interface AvatarClickGestureDeps {
  decks(): readonly AvatarDeckStatus[]
  attached(): readonly AvatarDeckIdentity[]
  send(identity: AvatarDeckIdentity, command: AvatarCommand): Promise<void>
  openBubble(): void
  info(scope: string, message: string): void
  report(scope: string, message: string, error?: unknown): void
}

export function createAvatarClickGesture(deps: AvatarClickGestureDeps): (kind: AvatarViewGesture) => void {
  return (kind) => {
    if (kind === 'single') {
      deps.openBubble()
      return
    }
    const waiting = selectAvatarAttentionDeck(deps.decks(), deps.attached())
    if (waiting === null) {
      deps.info('avatar-focus', 'Avatar double-click ignored because no attached Deck waits on the operator')
      return
    }
    void deps.send(waiting, 'open_question').catch((error: unknown) =>
      deps.report('avatar-focus', 'Avatar double-click open question gesture failed', error)
    )
  }
}
