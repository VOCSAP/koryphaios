import type { AvatarAttachRequest } from '../shared/avatar-protocol'
import { uniqueAvatarDeckLabels } from '../shared/avatar-label'
import type { AvatarDeckIdentity, AvatarDeckStatus, AvatarSummary } from '../shared/avatar-state'

export type AvatarDndChoice = '30m' | '1h' | 'tomorrow'

export interface AvatarDndState {
  choice: AvatarDndChoice
  until: number
}

export type AvatarTrayAction =
  | { kind: 'deck-focus'; identity: AvatarDeckIdentity }
  | { kind: 'dnd'; choice: AvatarDndChoice }
  | { kind: 'quit' }

export interface AvatarTrayMenuItem {
  type?: 'separator' | 'radio'
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

function formatCounters(counters: AvatarDeckStatus['counters'], unread: number): string {
  return `${counters.working} working | ${counters.waiting} waiting | ${unread} unread`
}

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

function deckMenuItem(deck: AvatarAttachRequest, status: AvatarDeckStatus, label: string): AvatarTrayMenuItem {
  return {
    label,
    submenu: [
      { label: `Project: ${deck.projectDir}`, enabled: false },
      { label: `Broker: ${deck.broker_url}`, enabled: false },
      { label: formatCounters(status.counters, status.unread), enabled: false },
      { type: 'separator' },
      {
        label: 'Bring Deck to front',
        action: { kind: 'deck-focus', identity: { deckRunId: deck.deckRunId, broker_url: deck.broker_url } }
      }
    ]
  }
}

function dndMenuItem(dnd: AvatarDndState | null, now: number): AvatarTrayMenuItem {
  const active = dnd !== null && !avatarTrayMayRebound(dnd, now) ? dnd.choice : null
  return {
    label: 'Do not disturb',
    submenu: [
      { label: '30 minutes', type: 'radio', checked: active === '30m', action: { kind: 'dnd', choice: '30m' } },
      { label: '1 hour', type: 'radio', checked: active === '1h', action: { kind: 'dnd', choice: '1h' } },
      { label: 'Until tomorrow', type: 'radio', checked: active === 'tomorrow', action: { kind: 'dnd', choice: 'tomorrow' } }
    ]
  }
}

export function buildAvatarTrayMenu(
  summary: AvatarSummary,
  attached: readonly AvatarAttachRequest[],
  dnd: AvatarDndState | null,
  now: number
): AvatarTrayMenu {
  const statuses = new Map(summary.decks.map((deck) => [deckKey(deck.identity), deck]))
  const labels = uniqueAvatarDeckLabels(attached.map((deck) => deck.deckName))
  const decks = attached.flatMap((deck, index) => {
    const status = statuses.get(deckKey({ deckRunId: deck.deckRunId, broker_url: deck.broker_url }))
    const label = labels[index]
    return status === undefined || label === undefined ? [] : [deckMenuItem(deck, status, label)]
  })

  return {
    tooltip: `Koryphaios Avatar: ${summary.face} | ${summary.decks.length} Decks | ${formatCounters(summary.counters, summary.unread)}`,
    items: [
      { label: formatCounters(summary.counters, summary.unread), enabled: false },
      ...(decks.length > 0 ? [{ type: 'separator' } as AvatarTrayMenuItem, ...decks, { type: 'separator' } as AvatarTrayMenuItem] : []),
      dndMenuItem(dnd, now),
      { type: 'separator' },
      { label: 'Quit Avatar', action: { kind: 'quit' } }
    ]
  }
}
