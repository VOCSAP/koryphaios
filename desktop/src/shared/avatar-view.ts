import type { AvatarDeckCounters, AvatarFace } from './avatar-state'

export interface AvatarViewDeckIdentity {
  deckRunId: string
  broker_url: string
}

export interface AvatarViewDeckStatus {
  identity: AvatarViewDeckIdentity
  counters: AvatarDeckCounters
  unread: number
  suspect: boolean
  brokerReachable: boolean
  torchOut: boolean
}

export interface AvatarViewFaceCopy {
  title: string
  ariaLabel: string
}

export interface AvatarViewSummary {
  face: AvatarFace
  faceCopy: AvatarViewFaceCopy
  counters: AvatarDeckCounters
  unread: number
  decks: AvatarViewDeckStatus[]
}

export interface AvatarViewPosition {
  x: number
  y: number
}

export type AvatarViewTheme = 'dark' | 'light'

export interface AvatarViewPresentation {
  position: AvatarViewPosition | null
  theme: AvatarViewTheme
  motion: 'continuous' | 'transitions' | 'none'
  dndActive: boolean
  visible: boolean
  alwaysOnTop: boolean
  positionLocked: boolean
  size: 's' | 'm' | 'l'
  idleOpacity: number
}

export interface AvatarViewState {
  generation: number
  revision: number
  summary: AvatarViewSummary
  presentation: AvatarViewPresentation
}

export const AVATAR_VIEW_CHANNELS = {
  getState: 'avatar-view:get-state',
  state: 'avatar-view:state',
  setPosition: 'avatar-view:set-position',
  setPointerInside: 'avatar-view:pointer-inside',
  reportError: 'avatar-view:report-error'
} as const

export interface AvatarViewApi {
  getState(): Promise<AvatarViewState>
  onState(callback: (state: AvatarViewState) => void): () => void
  setPosition(x: number, y: number): Promise<void>
  setPointerInside(inside: boolean): Promise<void>
  reportError(message: string): void
}
