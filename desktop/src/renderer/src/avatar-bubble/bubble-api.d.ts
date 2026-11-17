import type { AvatarBubbleApi } from '@shared/avatar-bubble-view'

// The web tsconfig types window.api as the Deck bridge; the bubble preload exposes this one instead.
export type AvatarBubbleWindow = Omit<Window, 'api'> & { readonly api: AvatarBubbleApi }
