import type { AvatarViewApi } from '@shared/avatar-view'

// The web tsconfig types window.api as the Deck bridge; the avatar preload exposes this one instead.
export type AvatarWindow = Omit<Window, 'api'> & { readonly api: AvatarViewApi }
