import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { reportError } from './log'
import type { AvatarDndChoice, AvatarDndState } from './avatar-tray-menu'

export const AVATAR_APPEARANCE_FILE = 'avatar-appearance.json'

export type AvatarMotion = 'continuous' | 'transitions' | 'none'
export type AvatarSize = 's' | 'm' | 'l'
export type AvatarFrame = 'normal' | 'full'

export interface AvatarWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface AvatarScreenPosition {
  workArea: AvatarWorkArea
  x: number
  y: number
}

export interface AvatarAppearance {
  version: 1
  visible: boolean
  alwaysOnTop: boolean
  positionLocked: boolean
  size: AvatarSize
  frame: AvatarFrame
  idleOpacity: number
  motion: AvatarMotion
  dndUntil: number | null
  dndChoice: AvatarDndChoice | null
  positions: Record<string, AvatarScreenPosition>
}

export interface AvatarAppearanceDependencies {
  reportError(scope: string, message: string, error?: unknown): void
}

const defaultAvatarAppearanceDependencies: AvatarAppearanceDependencies = { reportError }

function emptyPositions(): Record<string, AvatarScreenPosition> {
  return Object.create(null) as Record<string, AvatarScreenPosition>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readWorkArea(value: unknown): AvatarWorkArea | null {
  if (!isRecord(value)) return null
  const { x, y, width, height } = value
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function readPosition(value: unknown): AvatarScreenPosition | null {
  if (!isRecord(value)) return null
  const workArea = readWorkArea(value.workArea)
  if (!workArea || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null
  return { workArea, x: value.x, y: value.y }
}

function defaultAppearance(): AvatarAppearance {
  return {
    version: 1,
    visible: true,
    alwaysOnTop: true,
    positionLocked: false,
    size: 'm',
    frame: 'normal',
    idleOpacity: 1,
    motion: 'continuous',
    dndUntil: null,
    dndChoice: null,
    positions: emptyPositions()
  }
}

function readAppearance(value: unknown, dependencies: AvatarAppearanceDependencies): AvatarAppearance | null {
  if (!isRecord(value)) return null
  const appearance = defaultAppearance()
  if (value.version !== 1) return null
  if (typeof value.visible !== 'boolean' || typeof value.alwaysOnTop !== 'boolean' || typeof value.positionLocked !== 'boolean') return null
  if (value.size !== 's' && value.size !== 'm' && value.size !== 'l') return null
  const frame = value.frame === undefined ? 'normal' : value.frame
  if (frame !== 'normal' && frame !== 'full') return null
  if (!isFiniteNumber(value.idleOpacity) || value.idleOpacity < 0 || value.idleOpacity > 1) return null
  if (value.motion !== 'continuous' && value.motion !== 'transitions' && value.motion !== 'none') return null
  if (value.dndUntil !== null && !isFiniteNumber(value.dndUntil)) return null
  const dndChoice = value.dndChoice === undefined ? null : value.dndChoice
  if (dndChoice !== null && dndChoice !== '30m' && dndChoice !== '1h' && dndChoice !== 'tomorrow') return null
  if (!isRecord(value.positions)) return null

  appearance.visible = value.visible
  appearance.alwaysOnTop = value.alwaysOnTop
  appearance.positionLocked = value.positionLocked
  appearance.size = value.size
  appearance.frame = frame
  appearance.idleOpacity = value.idleOpacity
  appearance.motion = value.motion
  appearance.dndUntil = value.dndUntil
  appearance.dndChoice = dndChoice as AvatarDndChoice | null
  for (const [screenId, position] of Object.entries(value.positions)) {
    const parsed = readPosition(position)
    if (parsed) appearance.positions[screenId] = parsed
    else dependencies.reportError('avatar-appearance', `avatar position ignored for screen ${JSON.stringify(screenId)}`)
  }
  return appearance
}

export function readAvatarAppearance(
  file: string,
  dependencies: AvatarAppearanceDependencies = defaultAvatarAppearanceDependencies
): AvatarAppearance {
  let parsed: unknown
  try {
    if (!existsSync(file)) return defaultAppearance()
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const appearance = readAppearance(parsed, dependencies)
    if (appearance) return appearance
    throw new Error('appearance data is invalid')
  } catch (error) {
    dependencies.reportError('avatar-appearance', `appearance unreadable (${file})`, error)
    // An existing file means the operator has used the avatar: never resurrect a window they may have hidden.
    const visible = isRecord(parsed) && typeof parsed.visible === 'boolean' ? parsed.visible : false
    return { ...defaultAppearance(), visible }
  }
}

export function avatarAppearanceDnd(appearance: AvatarAppearance): AvatarDndState | null {
  if (appearance.dndUntil === null) return null
  return { choice: appearance.dndChoice ?? '30m', until: appearance.dndUntil }
}

export function writeAvatarAppearance(
  file: string,
  snapshot: AvatarAppearance,
  dependencies: AvatarAppearanceDependencies = defaultAvatarAppearanceDependencies
): void {
  const next = readAppearance(snapshot, dependencies)
  if (!next) throw new Error('Avatar appearance is invalid')

  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    dependencies.reportError('avatar-appearance', `cannot write ${file}`, error)
    throw new Error('Avatar appearance could not be written')
  }
}
