import type { AvatarAttachRequest } from '../shared/avatar-protocol'
import { uniqueAvatarDeckLabels } from '../shared/avatar-label'
import type { AvatarDeckIdentity } from '../shared/avatar-state'
import type { AvatarViewDeckStatus, AvatarViewSummary } from '../shared/avatar-view'
import type { AvatarAppearance } from './avatar-appearance'
import { AVATAR_TRAY_COPY } from './avatar-tray-copy'
import type { AvatarEvent } from './avatar-window-state'
import type { SupportedLocale } from './i18n'

export type AvatarDndChoice = '30m' | '1h' | 'tomorrow'

export interface AvatarDndState {
  choice: AvatarDndChoice
  until: number
}

export type AvatarTrayAppearance = Pick<AvatarAppearance, 'positionLocked' | 'alwaysOnTop' | 'motion' | 'size'>

export type AvatarTrayAction =
  | { kind: 'deck-focus'; identity: AvatarDeckIdentity }
  | { kind: 'dnd'; choice: AvatarDndChoice }
  | { kind: 'dnd-off' }
  | { kind: 'visible'; value: boolean }
  | { kind: 'lock'; value: boolean }
  | { kind: 'always-on-top'; value: boolean }
  | { kind: 'motion'; value: AvatarAppearance['motion'] }
  | { kind: 'size'; value: AvatarAppearance['size'] }
  | { kind: 'quit' }

export const AVATAR_TRAY_ACTION_KINDS = {
  'deck-focus': true,
  dnd: true,
  'dnd-off': true,
  visible: true,
  lock: true,
  'always-on-top': true,
  motion: true,
  size: true,
  quit: true
} as const satisfies Record<AvatarTrayAction['kind'], true>

export interface AvatarTrayMenuItem {
  type?: 'separator' | 'radio' | 'checkbox'
  label?: string
  enabled?: boolean
  checked?: boolean
  submenu?: AvatarTrayMenuItem[]
  action?: AvatarTrayAction
}

export interface AvatarTrayMenu {
  tooltip: string
  items: AvatarTrayMenuItem[]
}

function deckKey(identity: AvatarDeckIdentity): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url])
}

type TrayCopy = (typeof AVATAR_TRAY_COPY)[SupportedLocale]

function nextLocalMidnight(now: number): number {
  const tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)
  return tomorrow.getTime()
}

export function chooseAvatarDnd(choice: AvatarDndChoice, now: number): AvatarDndState {
  if (choice === '30m') return { choice, until: now + 30 * 60 * 1_000 }
  if (choice === '1h') return { choice, until: now + 60 * 60 * 1_000 }
  return { choice, until: nextLocalMidnight(now) }
}

export function avatarTrayMayRebound(dnd: AvatarDndState | null, now: number): boolean {
  return dnd === null || now >= dnd.until
}

export type AvatarTrayWindowAction = Extract<AvatarTrayAction, { kind: 'dnd-off' | 'visible' | 'lock' | 'always-on-top' | 'motion' | 'size' }>

export function avatarTrayEvent(action: AvatarTrayWindowAction): AvatarEvent {
  switch (action.kind) {
    case 'visible':
      return { kind: action.value ? 'ShowRequested' : 'HideRequested' }
    case 'lock':
      return { kind: 'LockChanged', value: action.value }
    case 'always-on-top':
      return { kind: 'AppearanceChanged', patch: { alwaysOnTop: action.value } }
    case 'motion':
      return { kind: 'AppearanceChanged', patch: { motion: action.value } }
    case 'size':
      return { kind: 'AppearanceChanged', patch: { size: action.value } }
    case 'dnd-off':
      return { kind: 'AppearanceChanged', patch: { dndUntil: null, dndChoice: null } }
  }
}

function deckMenuItem(copy: TrayCopy, deck: AvatarAttachRequest, status: AvatarViewDeckStatus, label: string): AvatarTrayMenuItem {
  return {
    label,
    submenu: [
      { label: copy.project(deck.projectDir), enabled: false },
      { label: copy.broker(deck.broker_url), enabled: false },
      { label: copy.counters({ ...status.counters, unread: status.unread }), enabled: false },
      { type: 'separator' },
      {
        label: copy.focusDeck,
        action: { kind: 'deck-focus', identity: { deckRunId: deck.deckRunId, broker_url: deck.broker_url } }
      }
    ]
  }
}

function dndMenuItem(copy: TrayCopy, dnd: AvatarDndState | null, now: number): AvatarTrayMenuItem {
  const active = dnd !== null && !avatarTrayMayRebound(dnd, now) ? dnd.choice : null
  return {
    label: copy.doNotDisturb,
    submenu: [
      { label: copy.dndOff, type: 'radio', checked: active === null, action: { kind: 'dnd-off' } },
      { label: copy.dnd30m, type: 'radio', checked: active === '30m', action: { kind: 'dnd', choice: '30m' } },
      { label: copy.dnd1h, type: 'radio', checked: active === '1h', action: { kind: 'dnd', choice: '1h' } },
      { label: copy.dndTomorrow, type: 'radio', checked: active === 'tomorrow', action: { kind: 'dnd', choice: 'tomorrow' } }
    ]
  }
}

function windowMenuItems(copy: TrayCopy, appearance: AvatarTrayAppearance, windowShown: boolean): AvatarTrayMenuItem[] {
  return [
    { label: copy.showAvatar, type: 'checkbox', checked: windowShown, action: { kind: 'visible', value: !windowShown } },
    { label: copy.lockPosition, type: 'checkbox', checked: appearance.positionLocked, action: { kind: 'lock', value: !appearance.positionLocked } },
    { label: copy.alwaysOnTop, type: 'checkbox', checked: appearance.alwaysOnTop, action: { kind: 'always-on-top', value: !appearance.alwaysOnTop } },
    {
      label: copy.motion,
      submenu: [
        { label: copy.motionContinuous, type: 'radio', checked: appearance.motion === 'continuous', action: { kind: 'motion', value: 'continuous' } },
        { label: copy.motionTransitions, type: 'radio', checked: appearance.motion === 'transitions', action: { kind: 'motion', value: 'transitions' } },
        { label: copy.motionNone, type: 'radio', checked: appearance.motion === 'none', action: { kind: 'motion', value: 'none' } }
      ]
    },
    {
      label: copy.size,
      submenu: [
        { label: copy.sizeSmall, type: 'radio', checked: appearance.size === 's', action: { kind: 'size', value: 's' } },
        { label: copy.sizeMedium, type: 'radio', checked: appearance.size === 'm', action: { kind: 'size', value: 'm' } },
        { label: copy.sizeLarge, type: 'radio', checked: appearance.size === 'l', action: { kind: 'size', value: 'l' } }
      ]
    }
  ]
}

export function buildAvatarTrayMenu(
  summary: AvatarViewSummary,
  attached: readonly AvatarAttachRequest[],
  dnd: AvatarDndState | null,
  now: number,
  appearance: AvatarTrayAppearance,
  windowShown: boolean,
  locale: SupportedLocale
): AvatarTrayMenu {
  const copy = AVATAR_TRAY_COPY[locale]
  const statuses = new Map(summary.decks.map((deck) => [deckKey(deck.identity), deck]))
  const labels = uniqueAvatarDeckLabels(attached.map((deck) => deck.deckName))
  const decks = attached.flatMap((deck, index) => {
    const status = statuses.get(deckKey({ deckRunId: deck.deckRunId, broker_url: deck.broker_url }))
    const label = labels[index]
    return status === undefined || label === undefined ? [] : [deckMenuItem(copy, deck, status, label)]
  })

  return {
    tooltip: summary.faceCopy.ariaLabel,
    items: [
      { label: copy.counters({ ...summary.counters, unread: summary.unread }), enabled: false },
      ...(decks.length > 0 ? [{ type: 'separator' } as AvatarTrayMenuItem, ...decks, { type: 'separator' } as AvatarTrayMenuItem] : []),
      ...windowMenuItems(copy, appearance, windowShown),
      dndMenuItem(copy, dnd, now),
      { type: 'separator' },
      { label: copy.quit, action: { kind: 'quit' } }
    ]
  }
}
