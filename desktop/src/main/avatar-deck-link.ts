import { basename, join, resolve } from 'node:path'
import type { SessionRuntime } from '../shared/types'
import type { AvatarClientOptions } from './avatar-client'
import { readAvatarRegistry } from './avatar-registry'
import { AVATAR_SETTINGS_FILE, avatarAutoAttachEnabled } from './avatar-settings'

const MAX_DECK_NAME_LENGTH = 64
export const AVATAR_DETACH_QUIT_BUDGET_MS = 3_000

export interface DeckAvatarWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface DeckAvatarLinkDeps {
  deckRunId: string
  projectDir: string
  projectKey: string
  stateDir: string
  brokerUrl: string
  sessions(): SessionRuntime[]
  window(): DeckAvatarWindow | null
  workspaceName(): string | null
}

// C0 and C1 controls, bidi embeddings/overrides and bidi isolates: invisible, and able to disguise a Tray label.
const INVISIBLE_CODE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x202a, 0x202e],
  [0x2066, 0x2069]
]

function withoutInvisibleControls(name: string): string {
  return Array.from(name)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return !INVISIBLE_CODE_POINTS.some(([low, high]) => code >= low && code <= high)
    })
    .join('')
}

function boundedDeckName(name: string): string {
  const cut = withoutInvisibleControls(name).slice(0, MAX_DECK_NAME_LENGTH)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** The first candidate that is a string still non-blank once bounded; the workspace name comes from a repository file. */
function deckNameFrom(candidates: readonly unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const name = boundedDeckName(candidate)
    if (name.trim()) return name
  }
  return 'Deck'
}

export async function boundedAvatarDetach(
  detach: Promise<void>,
  wait: (ms: number) => Promise<void>,
  report: (scope: string, message: string) => void
): Promise<void> {
  const outcome = await Promise.race([
    detach.then(() => 'detached' as const),
    wait(AVATAR_DETACH_QUIT_BUDGET_MS).then(() => 'expired' as const)
  ])
  if (outcome === 'expired') {
    report('avatar-client', `Avatar detach still pending after ${AVATAR_DETACH_QUIT_BUDGET_MS} ms, quitting anyway`)
  }
}

export async function focusDeckWindow(window: DeckAvatarWindow | null): Promise<void> {
  if (!window || window.isDestroyed()) throw new Error('the Deck window is not available')
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function deckAvatarClientOptions(
  deps: DeckAvatarLinkDeps
): Pick<AvatarClientOptions, 'deck' | 'autoAttachEnabled' | 'rendezvous' | 'sessions' | 'focus'> {
  const projectDir = resolve(deps.projectDir)
  const settingsFile = join(deps.stateDir, AVATAR_SETTINGS_FILE)
  return {
    deck: () => ({
      deckRunId: deps.deckRunId,
      deckPid: process.pid,
      broker_url: deps.brokerUrl,
      projectDir,
      deckName: deckNameFrom([deps.workspaceName(), basename(projectDir), projectDir])
    }),
    autoAttachEnabled: () => avatarAutoAttachEnabled(settingsFile, deps.projectKey),
    rendezvous: () => readAvatarRegistry(deps.stateDir),
    sessions: deps.sessions,
    focus: () => focusDeckWindow(deps.window())
  }
}
