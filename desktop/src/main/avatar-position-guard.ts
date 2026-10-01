import type { AvatarAppearance } from './avatar-appearance'

export function canMoveAvatarAppearance(appearance: AvatarAppearance): boolean {
  return appearance.visible && !appearance.positionLocked
}

export function assertAvatarPositionMovable(appearance: AvatarAppearance): void {
  if (!appearance.visible) throw new Error('Avatar is hidden')
  if (appearance.positionLocked) throw new Error('Avatar position is locked')
}
