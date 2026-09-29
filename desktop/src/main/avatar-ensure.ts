import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { join } from 'node:path'
import type { AvatarRendezvous } from './avatar-registry'

export const AVATAR_ENSURE_ATTEMPTS = 75
export const AVATAR_ENSURE_POLL_MS = 200

const DECK_ONLY_ENV_PREFIXES = ['CLAUDE_PEERS_DESK_', 'CLAUDE_PEERS_FORCE_GROUP']
const EXCLUDED_ENV_KEYS = new Set(['ELECTRON_RUN_AS_NODE', 'CLAUDE_PEERS_BROKER_TOKEN'])

export interface AvatarLaunchCommand {
  command: string
  args: string[]
  options: {
    cwd: string
    env: Record<string, string>
    detached: true
    stdio: 'ignore'
    windowsHide: true
  }
}

export interface AvatarLaunchInput {
  execPath: string
  mainDir: string
  env: Record<string, string | undefined>
  homeDir: string
  isPackaged: boolean
}

/** mainDir is the Deck's own compiled main directory (out/main), whose grandparent is the app root. */
export function avatarLaunchCommand(input: AvatarLaunchInput): AvatarLaunchCommand {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined || EXCLUDED_ENV_KEYS.has(key)) continue
    if (DECK_ONLY_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  return {
    command: input.execPath,
    args: input.isPackaged ? ['--avatar'] : [join(input.mainDir, '..', '..'), '--avatar'],
    options: { cwd: input.homeDir, env, detached: true, stdio: 'ignore', windowsHide: true }
  }
}

export function spawnDetachedAvatar(
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess,
  launch: AvatarLaunchCommand,
  report: (scope: string, message: string, error?: unknown) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(launch.command, launch.args, launch.options)
    child.once('error', reject)
    child.once('spawn', () => {
      child.off('error', reject)
      child.on('error', (error) => report('avatar', 'Avatar process error', error))
      child.unref()
      resolve()
    })
  })
}

export type AvatarEnsureOutcome =
  | { action: 'disabled' }
  | { action: 'already-running' }
  | { action: 'started' }
  | { action: 'no-rendezvous'; waitedMs: number }
  | { action: 'failed'; reason: string }

export interface AvatarEnsureDeps {
  autoAttachEnabled(): boolean
  rendezvous(): AvatarRendezvous | null
  launch(): AvatarLaunchCommand
  /** Resolves on the child's 'spawn' event and rejects on its 'error' event (ENOENT, EACCES arrive there, not as a throw). */
  spawn(launch: AvatarLaunchCommand): Promise<void>
  sleep(ms: number): Promise<void>
}

export async function ensureAvatar(deps: AvatarEnsureDeps): Promise<AvatarEnsureOutcome> {
  if (!deps.autoAttachEnabled()) return { action: 'disabled' }
  if (deps.rendezvous()) return { action: 'already-running' }
  const launch = deps.launch()
  try {
    await deps.spawn(launch)
  } catch (error) {
    return { action: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  for (let attempt = 0; attempt < AVATAR_ENSURE_ATTEMPTS; attempt += 1) {
    await deps.sleep(AVATAR_ENSURE_POLL_MS)
    if (deps.rendezvous()) return { action: 'started' }
  }
  return { action: 'no-rendezvous', waitedMs: AVATAR_ENSURE_ATTEMPTS * AVATAR_ENSURE_POLL_MS }
}
