import type { AvatarAppearance, AvatarScreenPosition, AvatarWorkArea } from './avatar-appearance'
import { AVATAR_WINDOW_SIZES, clampAvatarPlacement, restoreAvatarPlacement, type AvatarDisplay, type AvatarWindowSize } from './avatar-window-placement'

export type AvatarDestination = 'absent' | 'replacement' | 'stop'
export type AvatarRetirementPhase = 'allocating' | 'destroying' | 'checking' | 'blocked'

export type AvatarLifecycle =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'loading'; readonly token: number; readonly step: 'allocating' | 'document' }
  | { readonly kind: 'promoting'; readonly token: number; readonly step: 'prepare'; readonly recordsPlacement: boolean }
  | { readonly kind: 'promoting'; readonly token: number; readonly step: 'publish' | 'show' }
  | { readonly kind: 'ready'; readonly token: number }
  | {
      readonly kind: 'retiring'
      readonly token: number
      readonly retirementId: number
      readonly destination: AvatarDestination
      readonly phase: AvatarRetirementPhase
      readonly retryProbe: boolean
      readonly retryBudget: 0 | 1
    }
  | { readonly kind: 'stopped' }

export type AvatarLifecycleKind = AvatarLifecycle['kind']

export interface AvatarMachineConfig {
  readonly moveDelayMs: number
  readonly persistDelayMs: number
  readonly destroyWatchdogMs: number
  readonly loadWatchdogMs: number
}

export const DEFAULT_AVATAR_MACHINE_CONFIG: AvatarMachineConfig = {
  moveDelayMs: 16,
  persistDelayMs: 500,
  destroyWatchdogMs: 2_000,
  loadWatchdogMs: 15_000
}

export interface AvatarGeometry {
  readonly displays: readonly AvatarDisplay[]
}

export interface AvatarAppliedPlacement {
  readonly screenId: string
  readonly workArea: AvatarWorkArea
  readonly x: number
  readonly y: number
}

export interface AvatarRequestedMove {
  readonly token: number
  readonly epoch: number
  readonly placement: AvatarAppliedPlacement
}

export interface AvatarAppliedMove {
  readonly token: number
  readonly placement: AvatarAppliedPlacement
}

export type AvatarPermitSpecies =
  | 'prepare'
  | 'promotion'
  | 'show'
  | 'nativeOption'
  | 'tray'
  | 'view'
  | 'move'
  | 'destroy'
  | 'checkDestroyed'

export interface AvatarPermit {
  readonly token: number | null
  readonly op: number
  readonly species: AvatarPermitSpecies
}

export type AvatarTimerKind = 'move' | 'persist' | 'loadWatchdog' | 'destroyWatchdog'

export interface AvatarTimer {
  readonly id: number
  readonly token: number | null
  readonly epoch: number | null
}

export type AvatarTimers = Readonly<Record<AvatarTimerKind, AvatarTimer | null>>

export interface AvatarMachineState {
  readonly config: AvatarMachineConfig
  readonly appearance: AvatarAppearance
  readonly appearanceRevision: number
  readonly persistedRevision: number
  readonly lifecycle: AvatarLifecycle
  readonly lastToken: number
  readonly nextOp: number
  readonly nextTimerId: number
  readonly nextWriteId: number
  readonly retirements: number
  readonly moveEpoch: number
  readonly requested: AvatarRequestedMove | null
  readonly applied: AvatarAppliedMove | null
  readonly pointerInside: boolean
  readonly viewRevision: number
  readonly geometry: AvatarGeometry
  readonly permits: readonly AvatarPermit[]
  readonly timers: AvatarTimers
  readonly write: { readonly writeId: number; readonly revision: number } | null
  readonly initialWaiter: number | null
}

const APPEARANCE_FIELD_OWNER = {
  version: 'fixed',
  visible: 'transition',
  positionLocked: 'transition',
  positions: 'transition',
  alwaysOnTop: 'patch',
  size: 'patch',
  idleOpacity: 'patch',
  motion: 'patch',
  dndUntil: 'patch',
  dndChoice: 'patch'
} as const satisfies Record<keyof AvatarAppearance, 'fixed' | 'transition' | 'patch'>

type PatchKey = { [K in keyof typeof APPEARANCE_FIELD_OWNER]: (typeof APPEARANCE_FIELD_OWNER)[K] extends 'patch' ? K : never }[keyof typeof APPEARANCE_FIELD_OWNER]

export type AvatarAppearancePatch = Partial<Pick<AvatarAppearance, PatchKey>>

const PATCH_KEYS = (Object.keys(APPEARANCE_FIELD_OWNER) as (keyof AvatarAppearance)[]).filter(
  (key): key is PatchKey => APPEARANCE_FIELD_OWNER[key] === 'patch'
)

export type AvatarEvent =
  | { readonly kind: 'ShowRequested' }
  | { readonly kind: 'RestoreRequested' }
  | { readonly kind: 'HideRequested' }
  | { readonly kind: 'LockChanged'; readonly value: boolean }
  | { readonly kind: 'ReloadRequested' }
  | { readonly kind: 'QuitRequested' }
  | { readonly kind: 'AppearanceChanged'; readonly patch: AvatarAppearancePatch }
  | { readonly kind: 'PositionRequested'; readonly x: number; readonly y: number }
  | { readonly kind: 'PointerChanged'; readonly inside: boolean }
  | { readonly kind: 'RefreshRequested' }
  | { readonly kind: 'GeometryChanged'; readonly geometry: AvatarGeometry }
  | { readonly kind: 'InitialStateRequested'; readonly token: number }
  | { readonly kind: 'Allocated'; readonly token: number }
  | { readonly kind: 'AllocationFailed'; readonly token: number }
  | { readonly kind: 'LoadSucceeded'; readonly token: number }
  | { readonly kind: 'LoadFailed'; readonly token: number }
  | { readonly kind: 'LoadWatchdogExpired'; readonly timerId: number; readonly token: number }
  | { readonly kind: 'PrepareSucceeded'; readonly token: number; readonly op: number; readonly placement: AvatarAppliedPlacement }
  | { readonly kind: 'PrepareFailed'; readonly token: number; readonly op: number }
  | { readonly kind: 'PromotionPublished'; readonly token: number; readonly op: number }
  | { readonly kind: 'PromotionPublishFailed'; readonly token: number; readonly op: number }
  | { readonly kind: 'ShowSucceeded'; readonly token: number; readonly op: number }
  | { readonly kind: 'ShowFailed'; readonly token: number; readonly op: number }
  | { readonly kind: 'NativeOptionSucceeded'; readonly token: number; readonly op: number }
  | { readonly kind: 'NativeOptionFailed'; readonly token: number; readonly op: number }
  | { readonly kind: 'TrayPublished'; readonly op: number }
  | { readonly kind: 'TrayPublishFailed'; readonly op: number }
  | { readonly kind: 'ViewPublished'; readonly token: number; readonly op: number }
  | { readonly kind: 'ViewPublishFailed'; readonly token: number; readonly op: number }
  | { readonly kind: 'MoveDue'; readonly timerId: number; readonly token: number; readonly epoch: number }
  | { readonly kind: 'MoveSucceeded'; readonly token: number; readonly op: number; readonly placement: AvatarAppliedPlacement }
  | { readonly kind: 'MoveFailed'; readonly token: number; readonly op: number }
  | { readonly kind: 'PersistDue'; readonly timerId: number }
  | { readonly kind: 'PersistSucceeded'; readonly writeId: number; readonly revision: number }
  | { readonly kind: 'PersistFailed'; readonly writeId: number }
  | { readonly kind: 'RendererGone'; readonly token: number }
  | { readonly kind: 'NativeCloseRequested'; readonly token: number }
  | { readonly kind: 'NativeClosed'; readonly token: number }
  | { readonly kind: 'DestroyReturned'; readonly token: number; readonly op: number }
  | { readonly kind: 'DestroyFailed'; readonly token: number; readonly op: number }
  | { readonly kind: 'DestroyWatchdogExpired'; readonly timerId: number; readonly token: number }
  | { readonly kind: 'CheckDestroyedSucceeded'; readonly token: number; readonly op: number; readonly destroyed: boolean }
  | { readonly kind: 'CheckDestroyedFailed'; readonly token: number; readonly op: number }

export type AvatarEventKind = AvatarEvent['kind']

export interface AvatarPublication {
  readonly revision: number
  readonly generation: number | null
  readonly appearance: AvatarAppearance
  readonly position: AvatarAppliedPlacement | null
}

export type AvatarEffect =
  | { readonly kind: 'allocate'; readonly token: number }
  | { readonly kind: 'load'; readonly token: number }
  | {
      readonly kind: 'prepare'
      readonly token: number
      readonly op: number
      readonly placement: AvatarAppliedPlacement
      readonly size: AvatarWindowSize
      readonly alwaysOnTop: boolean
    }
  | {
      readonly kind: 'publish'
      readonly scope: 'tray' | 'view' | 'promotion'
      readonly token: number | null
      readonly op: number
      readonly snapshot: AvatarPublication
    }
  | { readonly kind: 'show'; readonly token: number; readonly op: number }
  | { readonly kind: 'hide'; readonly token: number; readonly op: number }
  | { readonly kind: 'setPointerMode'; readonly token: number; readonly op: number; readonly inside: boolean }
  | { readonly kind: 'setAlwaysOnTop'; readonly token: number; readonly op: number; readonly alwaysOnTop: boolean }
  | { readonly kind: 'setNativePosition'; readonly token: number; readonly op: number; readonly placement: AvatarAppliedPlacement }
  | { readonly kind: 'destroy'; readonly token: number; readonly op: number }
  | { readonly kind: 'checkDestroyed'; readonly token: number; readonly op: number }
  | { readonly kind: 'writeSnapshot'; readonly writeId: number; readonly revision: number; readonly appearance: AvatarAppearance }
  | {
      readonly kind: 'armTimer'
      readonly timer: AvatarTimerKind
      readonly timerId: number
      readonly delayMs: number
      readonly token: number | null
      readonly epoch: number | null
    }
  | { readonly kind: 'cancelTimer'; readonly timerId: number }
  | { readonly kind: 'resolveInitialState'; readonly token: number }
  | { readonly kind: 'rejectInitialState'; readonly token: number }
  | { readonly kind: 'trace'; readonly message: string }

export type AvatarReply =
  | { readonly kind: 'none' }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'rejected'; readonly reason: string }

export interface AvatarReduction {
  readonly state: AvatarMachineState
  readonly effects: readonly AvatarEffect[]
  readonly reply: AvatarReply
}

export interface AvatarMachineInit {
  readonly available: boolean
  readonly appearance: AvatarAppearance
  readonly geometry: AvatarGeometry
  readonly config?: Partial<AvatarMachineConfig>
}

export function createAvatarMachineState(init: AvatarMachineInit): AvatarMachineState {
  return {
    config: { ...DEFAULT_AVATAR_MACHINE_CONFIG, ...init.config },
    appearance: init.appearance,
    appearanceRevision: 0,
    persistedRevision: 0,
    lifecycle: init.available ? { kind: 'absent' } : { kind: 'unavailable' },
    lastToken: 0,
    nextOp: 1,
    nextTimerId: 1,
    nextWriteId: 1,
    retirements: 0,
    moveEpoch: 0,
    requested: null,
    applied: null,
    pointerInside: false,
    viewRevision: 0,
    geometry: init.geometry,
    permits: [],
    timers: { move: null, persist: null, loadWatchdog: null, destroyWatchdog: null },
    write: null,
    initialWaiter: null
  }
}

export function selectCurrentToken(state: AvatarMachineState): number | null {
  const lifecycle = state.lifecycle
  return lifecycle.kind === 'promoting' || lifecycle.kind === 'ready' ? lifecycle.token : null
}

/** What the operator sees, not what they asked for: after a crash `visible` stays true with no window. */
export function selectWindowShown(state: AvatarMachineState): boolean {
  const kind = state.lifecycle.kind
  return state.appearance.visible && (kind === 'loading' || kind === 'promoting' || kind === 'ready')
}

export function selectIsRetiring(state: AvatarMachineState, token: number): boolean {
  return state.lifecycle.kind === 'retiring' && state.lifecycle.token === token
}

export function selectMoveRefusal(state: AvatarMachineState): string | null {
  if (!state.appearance.visible) return 'Avatar is hidden'
  if (state.appearance.positionLocked) return 'Avatar position is locked'
  if (state.lifecycle.kind !== 'ready') return 'Avatar window is unavailable'
  return null
}

export function selectCanMove(state: AvatarMachineState): boolean {
  return selectMoveRefusal(state) === null
}

export function selectDirty(state: AvatarMachineState): boolean {
  return state.appearanceRevision > state.persistedRevision
}

export function selectPublication(state: AvatarMachineState): AvatarPublication {
  const token = selectCurrentToken(state)
  const applied = state.applied
  return {
    revision: state.viewRevision,
    generation: token,
    appearance: state.appearance,
    position: token !== null && applied !== null && applied.token === token ? applied.placement : null
  }
}

function hasPermit(state: AvatarMachineState, token: number | null, op: number, species: AvatarPermitSpecies): boolean {
  return state.permits.some((permit) => permit.token === token && permit.op === op && permit.species === species)
}

export function isEffectLive(state: AvatarMachineState, effect: AvatarEffect): boolean {
  const lifecycle = state.lifecycle
  switch (effect.kind) {
    case 'allocate':
      return (
        (lifecycle.kind === 'loading' && lifecycle.token === effect.token && lifecycle.step === 'allocating') ||
        (lifecycle.kind === 'retiring' && lifecycle.token === effect.token && lifecycle.phase === 'allocating')
      )
    case 'load':
      return lifecycle.kind === 'loading' && lifecycle.token === effect.token && lifecycle.step === 'document'
    case 'prepare':
      return hasPermit(state, effect.token, effect.op, 'prepare')
    case 'publish':
      return hasPermit(state, effect.token, effect.op, effect.scope === 'promotion' ? 'promotion' : effect.scope)
    case 'show':
      return hasPermit(state, effect.token, effect.op, 'show')
    case 'hide':
    case 'setPointerMode':
    case 'setAlwaysOnTop':
      return hasPermit(state, effect.token, effect.op, 'nativeOption')
    case 'setNativePosition':
      return hasPermit(state, effect.token, effect.op, 'move')
    case 'destroy':
      return hasPermit(state, effect.token, effect.op, 'destroy')
    case 'checkDestroyed':
      return hasPermit(state, effect.token, effect.op, 'checkDestroyed')
    case 'writeSnapshot':
      return state.write !== null && state.write.writeId === effect.writeId
    case 'armTimer':
      return state.timers[effect.timer]?.id === effect.timerId
    case 'cancelTimer':
    case 'resolveInitialState':
    case 'rejectInitialState':
    case 'trace':
      return true
    default:
      return assertNever(effect)
  }
}

interface Draft {
  s: AvatarMachineState
  effects: AvatarEffect[]
  reply: AvatarReply
}

const NONE: AvatarReply = { kind: 'none' }
const ACCEPTED: AvatarReply = { kind: 'accepted' }
const DEFERRED: AvatarReply = { kind: 'deferred' }

function assertNever(value: never): never {
  throw new Error(`Unclassified Avatar window variant: ${JSON.stringify(value)}`)
}

function set(d: Draft, patch: Partial<AvatarMachineState>): void {
  d.s = { ...d.s, ...patch }
}

function emit(d: Draft, effect: AvatarEffect): void {
  d.effects.push(effect)
}

function trace(d: Draft, message: string): void {
  emit(d, { kind: 'trace', message })
}

function reject(d: Draft, reason: string): void {
  d.reply = { kind: 'rejected', reason }
}

function grant(d: Draft, token: number | null, species: AvatarPermitSpecies): number {
  const op = d.s.nextOp
  set(d, { nextOp: op + 1, permits: [...d.s.permits, { token, op, species }] })
  return op
}

function grantNewest(d: Draft, token: number | null, species: AvatarPermitSpecies): number {
  set(d, { permits: d.s.permits.filter((permit) => !(permit.token === token && permit.species === species)) })
  return grant(d, token, species)
}

function settle(d: Draft, token: number | null, op: number, species: AvatarPermitSpecies): boolean {
  if (!hasPermit(d.s, token, op, species)) return false
  set(d, { permits: d.s.permits.filter((permit) => !(permit.token === token && permit.op === op && permit.species === species)) })
  return true
}

function dropPermits(d: Draft, token: number, species?: AvatarPermitSpecies): void {
  set(d, { permits: d.s.permits.filter((permit) => permit.token !== token || (species !== undefined && permit.species !== species)) })
}

function arm(d: Draft, timer: AvatarTimerKind, delayMs: number, token: number | null, epoch: number | null): void {
  const timerId = d.s.nextTimerId
  set(d, { nextTimerId: timerId + 1, timers: { ...d.s.timers, [timer]: { id: timerId, token, epoch } } })
  emit(d, { kind: 'armTimer', timer, timerId, delayMs, token, epoch })
}

function disarm(d: Draft, timer: AvatarTimerKind): void {
  const current = d.s.timers[timer]
  if (current === null) return
  set(d, { timers: { ...d.s.timers, [timer]: null } })
  emit(d, { kind: 'cancelTimer', timerId: current.id })
}

function consumeTimer(d: Draft, timer: AvatarTimerKind): void {
  set(d, { timers: { ...d.s.timers, [timer]: null } })
}

function timerMatches(state: AvatarMachineState, timer: AvatarTimerKind, timerId: number): boolean {
  return state.timers[timer]?.id === timerId
}

function changeAppearance(d: Draft, patch: Partial<AvatarAppearance>): boolean {
  const current = d.s.appearance
  const keys = Object.keys(patch) as (keyof AvatarAppearance)[]
  if (!keys.some((key) => patch[key] !== current[key])) return false
  set(d, { appearance: { ...current, ...patch }, appearanceRevision: d.s.appearanceRevision + 1 })
  return true
}

function requestWrite(d: Draft): void {
  if (d.s.write !== null || !selectDirty(d.s)) return
  const writeId = d.s.nextWriteId
  const revision = d.s.appearanceRevision
  set(d, { nextWriteId: writeId + 1, write: { writeId, revision } })
  emit(d, { kind: 'writeSnapshot', writeId, revision, appearance: d.s.appearance })
}

function armPersist(d: Draft): void {
  if (d.s.timers.persist !== null || d.s.lifecycle.kind === 'stopped') return
  arm(d, 'persist', d.s.config.persistDelayMs, null, null)
}

function publish(d: Draft): void {
  set(d, { viewRevision: d.s.viewRevision + 1 })
  const snapshot = selectPublication(d.s)
  emit(d, { kind: 'publish', scope: 'tray', token: null, op: grantNewest(d, null, 'tray'), snapshot })
  const token = selectCurrentToken(d.s)
  if (token !== null) emit(d, { kind: 'publish', scope: 'view', token, op: grantNewest(d, token, 'view'), snapshot })
}

function commit(d: Draft, changed: boolean): void {
  if (!changed) return
  requestWrite(d)
  publish(d)
}

function invalidateMoves(d: Draft): void {
  disarm(d, 'move')
  set(d, { moveEpoch: d.s.moveEpoch + 1, requested: null })
}

function recordPlacement(d: Draft, placement: AvatarAppliedPlacement, onlyIfStored: boolean): void {
  const current = d.s.appearance.positions[placement.screenId]
  const area = placement.workArea
  if (current === undefined && onlyIfStored && Object.keys(d.s.appearance.positions).length === 0) return
  if (
    current !== undefined &&
    current.x === placement.x &&
    current.y === placement.y &&
    current.workArea.x === area.x &&
    current.workArea.y === area.y &&
    current.workArea.width === area.width &&
    current.workArea.height === area.height
  ) {
    return
  }
  const positions = Object.assign(Object.create(null), d.s.appearance.positions) as Record<string, AvatarScreenPosition>
  positions[placement.screenId] = { workArea: area, x: placement.x, y: placement.y }
  set(d, { appearance: { ...d.s.appearance, positions }, appearanceRevision: d.s.appearanceRevision + 1 })
  armPersist(d)
}

function nearestDisplay(displays: readonly AvatarDisplay[], x: number, y: number): AvatarDisplay | undefined {
  let best: AvatarDisplay | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const area = display.workArea
    const dx = Math.max(area.x - x, 0, x - (area.x + area.width))
    const dy = Math.max(area.y - y, 0, y - (area.y + area.height))
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      best = display
      bestDistance = distance
    }
  }
  return best
}

function placeAt(geometry: AvatarGeometry, size: AvatarWindowSize, x: number, y: number): AvatarAppliedPlacement | null {
  const display = nearestDisplay(geometry.displays, x, y)
  if (!display) return null
  const clamped = clampAvatarPlacement({ x, y }, display.workArea, size)
  return { screenId: display.id, workArea: display.workArea, x: clamped.x, y: clamped.y }
}

function startAllocation(d: Draft): void {
  const token = d.s.lastToken + 1
  set(d, { lastToken: token, lifecycle: { kind: 'loading', token, step: 'allocating' }, applied: null, pointerInside: false })
  emit(d, { kind: 'allocate', token })
  arm(d, 'loadWatchdog', d.s.config.loadWatchdogMs, token, null)
}

function startDestroy(d: Draft, token: number): void {
  const op = grantNewest(d, token, 'destroy')
  emit(d, { kind: 'destroy', token, op })
  disarm(d, 'destroyWatchdog')
  arm(d, 'destroyWatchdog', d.s.config.destroyWatchdogMs, token, null)
}

function startProbe(d: Draft, token: number): void {
  const op = grantNewest(d, token, 'checkDestroyed')
  emit(d, { kind: 'checkDestroyed', token, op })
}

function rejectInitialWaiter(d: Draft, token: number): void {
  if (d.s.initialWaiter !== token) return
  set(d, { initialWaiter: null })
  emit(d, { kind: 'rejectInitialState', token })
}

function retire(d: Draft, destination: AvatarDestination): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'loading' && lifecycle.kind !== 'promoting' && lifecycle.kind !== 'ready') return
  const token = lifecycle.token
  invalidateMoves(d)
  disarm(d, 'loadWatchdog')
  dropPermits(d, token)
  rejectInitialWaiter(d, token)
  const phase: AvatarRetirementPhase = lifecycle.kind === 'loading' && lifecycle.step === 'allocating' ? 'allocating' : 'destroying'
  const retirementId = d.s.retirements + 1
  set(d, {
    retirements: retirementId,
    pointerInside: false,
    lifecycle: { kind: 'retiring', token, retirementId, destination, phase, retryProbe: false, retryBudget: 0 }
  })
  if (phase === 'destroying') startDestroy(d, token)
}

function enterStopped(d: Draft): void {
  disarm(d, 'move')
  disarm(d, 'persist')
  disarm(d, 'loadWatchdog')
  disarm(d, 'destroyWatchdog')
  set(d, { lifecycle: { kind: 'stopped' }, requested: null, pointerInside: false })
}

function acknowledgeDisappearance(d: Draft): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'retiring') return
  disarm(d, 'destroyWatchdog')
  dropPermits(d, lifecycle.token)
  if (lifecycle.destination === 'stop') enterStopped(d)
  else if (lifecycle.destination === 'replacement') startAllocation(d)
  else set(d, { lifecycle: { kind: 'absent' } })
}

function loseResource(d: Draft, token: number): void {
  invalidateMoves(d)
  disarm(d, 'loadWatchdog')
  dropPermits(d, token)
  rejectInitialWaiter(d, token)
  set(d, { pointerInside: false, lifecycle: { kind: 'absent' } })
}

function retryCleanup(d: Draft): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'retiring' || lifecycle.phase !== 'blocked') return
  disarm(d, 'destroyWatchdog')
  set(d, { lifecycle: { ...lifecycle, phase: 'checking', retryProbe: true, retryBudget: 1 } })
  startProbe(d, lifecycle.token)
}

function beginPrepare(d: Draft, token: number, recordsPlacement = true): void {
  dropPermits(d, token)
  set(d, { lifecycle: { kind: 'promoting', token, step: 'prepare', recordsPlacement }, applied: null, pointerInside: false })
  const geometry = d.s.geometry
  if (geometry.displays.length === 0) {
    trace(d, 'Avatar placement requires an available display')
    retire(d, 'absent')
    return
  }
  const restored = restoreAvatarPlacement(geometry.displays, d.s.appearance.positions, AVATAR_WINDOW_SIZES[d.s.appearance.size])
  const display = geometry.displays.find((candidate) => candidate.id === restored.screenId)
  if (!display) {
    trace(d, 'Avatar placement display is unknown')
    retire(d, 'absent')
    return
  }
  const placement: AvatarAppliedPlacement = { screenId: display.id, workArea: display.workArea, x: restored.x, y: restored.y }
  const op = grant(d, token, 'prepare')
  emit(d, {
    kind: 'prepare',
    token,
    op,
    placement,
    size: { width: restored.width, height: restored.height },
    alwaysOnTop: d.s.appearance.alwaysOnTop
  })
}

function applyHide(d: Draft): void {
  const lifecycle = d.s.lifecycle
  const changed = changeAppearance(d, { visible: false })
  if (lifecycle.kind === 'loading' || lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') {
    invalidateMoves(d)
    set(d, { pointerInside: false })
  }
  if (lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') {
    dropPermits(d, lifecycle.token, 'show')
    if (lifecycle.kind === 'promoting' && lifecycle.step === 'show') set(d, { lifecycle: { kind: 'ready', token: lifecycle.token } })
  }
  commit(d, changed)
  if (lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') {
    emit(d, { kind: 'setPointerMode', token: lifecycle.token, op: grant(d, lifecycle.token, 'nativeOption'), inside: false })
    emit(d, { kind: 'hide', token: lifecycle.token, op: grant(d, lifecycle.token, 'nativeOption') })
  }
}

function flush(d: Draft): void {
  requestWrite(d)
}

function onShow(d: Draft): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'unavailable' || lifecycle.kind === 'stopped') return reject(d, 'Avatar window is unavailable')
  if (lifecycle.kind === 'retiring' && lifecycle.destination === 'stop') return reject(d, 'Avatar is stopping')
  const changed = changeAppearance(d, { visible: true })
  d.reply = ACCEPTED
  switch (lifecycle.kind) {
    case 'absent':
      commit(d, changed)
      startAllocation(d)
      return
    case 'loading':
    case 'promoting':
      commit(d, changed)
      return
    case 'ready':
      requestWrite(d)
      publish(d)
      emit(d, { kind: 'show', token: lifecycle.token, op: grant(d, lifecycle.token, 'show') })
      return
    case 'retiring':
      commit(d, changed)
      set(d, { lifecycle: { ...lifecycle, destination: 'replacement' } })
      retryCleanup(d)
      return
    default:
      return assertNever(lifecycle)
  }
}

function onRestore(d: Draft): void {
  if (d.s.lifecycle.kind !== 'absent' || !d.s.appearance.visible || d.s.lastToken !== 0) return
  d.reply = ACCEPTED
  startAllocation(d)
}

function onHide(d: Draft): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'stopped') return reject(d, 'Avatar window is stopped')
  if (lifecycle.kind === 'retiring' && lifecycle.destination === 'stop') return reject(d, 'Avatar is stopping')
  d.reply = ACCEPTED
  applyHide(d)
}

function onLock(d: Draft, value: boolean): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'stopped') return reject(d, 'Avatar window is stopped')
  if (lifecycle.kind === 'retiring' && lifecycle.destination === 'stop') return reject(d, 'Avatar is stopping')
  d.reply = ACCEPTED
  const changed = changeAppearance(d, { positionLocked: value })
  if (changed) invalidateMoves(d)
  commit(d, changed)
}

function onReload(d: Draft): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'unavailable' || lifecycle.kind === 'stopped') return reject(d, 'Avatar window is unavailable')
  if (lifecycle.kind === 'retiring' && lifecycle.destination === 'stop') return reject(d, 'Avatar is stopping')
  d.reply = ACCEPTED
  switch (lifecycle.kind) {
    case 'absent':
      startAllocation(d)
      return
    case 'loading':
    case 'promoting':
    case 'ready':
      retire(d, 'replacement')
      return
    case 'retiring':
      set(d, { lifecycle: { ...lifecycle, destination: 'replacement' } })
      retryCleanup(d)
      return
    default:
      return assertNever(lifecycle)
  }
}

function onQuit(d: Draft): void {
  const lifecycle = d.s.lifecycle
  d.reply = ACCEPTED
  switch (lifecycle.kind) {
    case 'stopped':
      d.reply = NONE
      return
    case 'unavailable':
    case 'absent':
      flush(d)
      enterStopped(d)
      return
    case 'loading':
    case 'promoting':
    case 'ready':
      retire(d, 'stop')
      disarm(d, 'persist')
      flush(d)
      return
    case 'retiring':
      set(d, { lifecycle: { ...lifecycle, destination: 'stop' } })
      disarm(d, 'persist')
      flush(d)
      return
    default:
      return assertNever(lifecycle)
  }
}

function pickPatch(patch: AvatarAppearancePatch): Partial<AvatarAppearance> {
  const picked: Record<string, unknown> = {}
  for (const key of PATCH_KEYS) {
    if (Object.hasOwn(patch, key) && patch[key] !== undefined) picked[key] = patch[key]
  }
  return picked as Partial<AvatarAppearance>
}

// The stored corners stay the unclamped intent, so the edge clamp of a large size is undone by a smaller one.
function anchorAtCenter(
  positions: Readonly<Record<string, AvatarScreenPosition>>,
  from: AvatarWindowSize,
  to: AvatarWindowSize
): Record<string, AvatarScreenPosition> {
  const anchored = Object.create(null) as Record<string, AvatarScreenPosition>
  for (const [screenId, position] of Object.entries(positions)) {
    anchored[screenId] = {
      workArea: position.workArea,
      x: position.x - (to.width - from.width) / 2,
      y: position.y - (to.height - from.height) / 2
    }
  }
  return anchored
}

function onAppearance(d: Draft, patch: AvatarAppearancePatch): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'stopped') return reject(d, 'Avatar window is stopped')
  if (lifecycle.kind === 'retiring' && lifecycle.destination === 'stop') return reject(d, 'Avatar is stopping')
  d.reply = ACCEPTED
  const picked = pickPatch(patch)
  const alwaysOnTopChanged = picked.alwaysOnTop !== undefined && picked.alwaysOnTop !== d.s.appearance.alwaysOnTop
  const resized = picked.size !== undefined && picked.size !== d.s.appearance.size ? picked.size : null
  const changed = changeAppearance(
    d,
    resized === null ? picked : { ...picked, positions: anchorAtCenter(d.s.appearance.positions, AVATAR_WINDOW_SIZES[d.s.appearance.size], AVATAR_WINDOW_SIZES[resized]) }
  )
  commit(d, changed)
  if (resized !== null && (lifecycle.kind === 'promoting' || lifecycle.kind === 'ready')) {
    invalidateMoves(d)
    beginPrepare(d, lifecycle.token, false)
  } else if (alwaysOnTopChanged && (lifecycle.kind === 'promoting' || lifecycle.kind === 'ready')) {
    emit(d, {
      kind: 'setAlwaysOnTop',
      token: lifecycle.token,
      op: grant(d, lifecycle.token, 'nativeOption'),
      alwaysOnTop: d.s.appearance.alwaysOnTop
    })
  }
}

function onPosition(d: Draft, x: number, y: number): void {
  const refusal = selectMoveRefusal(d.s)
  if (refusal !== null) return reject(d, refusal)
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'ready') return reject(d, 'Avatar window is unavailable')
  if (!Number.isFinite(x) || !Number.isFinite(y)) return reject(d, 'Avatar position requires finite numbers')
  const placement = placeAt(d.s.geometry, AVATAR_WINDOW_SIZES[d.s.appearance.size], x, y)
  if (placement === null) return reject(d, 'Avatar placement requires an available display')
  set(d, { requested: { token: lifecycle.token, epoch: d.s.moveEpoch, placement } })
  if (d.s.timers.move === null) arm(d, 'move', d.s.config.moveDelayMs, lifecycle.token, d.s.moveEpoch)
  d.reply = ACCEPTED
}

function onPointer(d: Draft, inside: boolean): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'ready') return reject(d, 'Avatar window is unavailable')
  if (!d.s.appearance.visible) return reject(d, 'Avatar is hidden')
  d.reply = ACCEPTED
  if (inside === d.s.pointerInside) return
  set(d, { pointerInside: inside })
  emit(d, { kind: 'setPointerMode', token: lifecycle.token, op: grant(d, lifecycle.token, 'nativeOption'), inside })
}

function onRefresh(d: Draft): void {
  if (d.s.lifecycle.kind === 'stopped') return
  publish(d)
}

function onGeometry(d: Draft, geometry: AvatarGeometry): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'stopped') return
  set(d, { geometry })
  if (lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') {
    invalidateMoves(d)
    beginPrepare(d, lifecycle.token)
  }
}

function onInitialState(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'ready' && lifecycle.token === token) {
    d.reply = ACCEPTED
    return
  }
  if (lifecycle.kind === 'promoting' && lifecycle.token === token && lifecycle.step === 'show') {
    d.reply = ACCEPTED
    return
  }
  if ((lifecycle.kind === 'loading' || lifecycle.kind === 'promoting') && lifecycle.token === token) {
    if (d.s.initialWaiter !== null) return reject(d, 'Avatar initial state is already awaited')
    set(d, { initialWaiter: token })
    d.reply = DEFERRED
    return
  }
  reject(d, 'Avatar window is not current')
}

function onAllocated(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'loading' && lifecycle.token === token && lifecycle.step === 'allocating') {
    set(d, { lifecycle: { kind: 'loading', token, step: 'document' } })
    emit(d, { kind: 'load', token })
    return
  }
  if (lifecycle.kind === 'retiring' && lifecycle.token === token && lifecycle.phase === 'allocating') {
    set(d, { lifecycle: { ...lifecycle, phase: 'destroying' } })
    startDestroy(d, token)
  }
}

function onAllocationFailed(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'loading' && lifecycle.token === token && lifecycle.step === 'allocating') {
    trace(d, 'Avatar window could not be allocated')
    loseResource(d, token)
    return
  }
  if (lifecycle.kind === 'retiring' && lifecycle.token === token && lifecycle.phase === 'allocating') {
    trace(d, 'Avatar window could not be allocated')
    acknowledgeDisappearance(d)
  }
}

function onLoadSucceeded(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'loading' || lifecycle.token !== token || lifecycle.step !== 'document') return
  disarm(d, 'loadWatchdog')
  beginPrepare(d, token)
}

function onLoadFailed(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'loading' && lifecycle.token === token && lifecycle.step === 'document') {
    trace(d, 'Avatar renderer could not load')
    retire(d, 'absent')
    return
  }
  if (lifecycle.kind === 'retiring' && lifecycle.token === token) trace(d, 'Avatar renderer could not load')
}

function onLoadWatchdog(d: Draft, timerId: number, token: number): void {
  const lifecycle = d.s.lifecycle
  if (!timerMatches(d.s, 'loadWatchdog', timerId) || lifecycle.kind !== 'loading' || lifecycle.token !== token) return
  consumeTimer(d, 'loadWatchdog')
  trace(d, 'Avatar renderer load timed out')
  retire(d, 'absent')
}

function promotingStep(state: AvatarMachineState, token: number, step: 'prepare' | 'publish' | 'show'): boolean {
  const lifecycle = state.lifecycle
  return lifecycle.kind === 'promoting' && lifecycle.token === token && lifecycle.step === step
}

function onPrepareSucceeded(d: Draft, token: number, op: number, placement: AvatarAppliedPlacement): void {
  const lifecycle = d.s.lifecycle
  if (!promotingStep(d.s, token, 'prepare') || !settle(d, token, op, 'prepare')) return
  set(d, { applied: { token, placement }, lifecycle: { kind: 'promoting', token, step: 'publish' } })
  if (lifecycle.kind === 'promoting' && lifecycle.step === 'prepare' && lifecycle.recordsPlacement) recordPlacement(d, placement, true)
  set(d, { viewRevision: d.s.viewRevision + 1 })
  emit(d, { kind: 'publish', scope: 'promotion', token, op: grant(d, token, 'promotion'), snapshot: selectPublication(d.s) })
}

function failHeld(d: Draft, token: number, message: string): void {
  trace(d, message)
  const lifecycle = d.s.lifecycle
  if ((lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') && lifecycle.token === token) retire(d, 'absent')
}

function onPrepareFailed(d: Draft, token: number, op: number): void {
  if (!promotingStep(d.s, token, 'prepare') || !settle(d, token, op, 'prepare')) return
  failHeld(d, token, 'Avatar window preparation failed')
}

function onPromotionPublished(d: Draft, token: number, op: number): void {
  if (!promotingStep(d.s, token, 'publish') || !settle(d, token, op, 'promotion')) return
  if (d.s.initialWaiter === token) {
    set(d, { initialWaiter: null })
    emit(d, { kind: 'resolveInitialState', token })
  }
  if (d.s.appearance.visible) {
    set(d, { lifecycle: { kind: 'promoting', token, step: 'show' } })
    emit(d, { kind: 'show', token, op: grant(d, token, 'show') })
  } else {
    set(d, { lifecycle: { kind: 'ready', token } })
  }
}

function onPromotionPublishFailed(d: Draft, token: number, op: number): void {
  if (!promotingStep(d.s, token, 'publish') || !settle(d, token, op, 'promotion')) return
  failHeld(d, token, 'Avatar promotion snapshot could not be published')
}

function onShowSucceeded(d: Draft, token: number, op: number): void {
  if (!settle(d, token, op, 'show')) return
  if (promotingStep(d.s, token, 'show')) set(d, { lifecycle: { kind: 'ready', token } })
}

function onShowFailed(d: Draft, token: number, op: number): void {
  if (!settle(d, token, op, 'show')) return
  failHeld(d, token, 'Avatar window could not be shown')
}

function onNativeOptionSucceeded(d: Draft, token: number, op: number): void {
  settle(d, token, op, 'nativeOption')
}

function onNativeOptionFailed(d: Draft, token: number, op: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'retiring' && lifecycle.token === token) {
    trace(d, 'Avatar native option failed while retiring')
    return
  }
  if (!settle(d, token, op, 'nativeOption')) return
  failHeld(d, token, 'Avatar native option failed')
}

function onViewResult(d: Draft, token: number, op: number, ok: boolean): void {
  if (!settle(d, token, op, 'view')) return
  if (!ok) trace(d, 'Avatar view snapshot could not be published')
}

function onTrayResult(d: Draft, op: number, ok: boolean): void {
  if (d.s.lifecycle.kind === 'stopped' || !settle(d, null, op, 'tray')) return
  if (!ok) trace(d, 'Avatar tray could not be refreshed')
}

function onMoveDue(d: Draft, timerId: number, token: number, epoch: number): void {
  const lifecycle = d.s.lifecycle
  const timer = d.s.timers.move
  if (lifecycle.kind !== 'ready' || timer === null || timer.id !== timerId || timer.token !== token || timer.epoch !== epoch) return
  if (lifecycle.token !== token || epoch !== d.s.moveEpoch) return
  consumeTimer(d, 'move')
  const request = d.s.requested
  if (request === null || request.token !== token || request.epoch !== epoch || !selectCanMove(d.s)) return
  set(d, { requested: null })
  emit(d, { kind: 'setNativePosition', token, op: grant(d, token, 'move'), placement: request.placement })
}

function onMoveSucceeded(d: Draft, token: number, op: number, placement: AvatarAppliedPlacement): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'ready' || lifecycle.token !== token || !settle(d, token, op, 'move')) return
  set(d, { applied: { token, placement } })
  recordPlacement(d, placement, false)
  publish(d)
}

function onMoveFailed(d: Draft, token: number, op: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind !== 'ready' || lifecycle.token !== token || !settle(d, token, op, 'move')) return
  trace(d, 'Avatar window could not be moved')
}

function onPersistDue(d: Draft, timerId: number): void {
  if (d.s.lifecycle.kind === 'stopped' || !timerMatches(d.s, 'persist', timerId)) return
  consumeTimer(d, 'persist')
  requestWrite(d)
}

function onPersistSucceeded(d: Draft, writeId: number, revision: number): void {
  if (d.s.lifecycle.kind === 'stopped' || d.s.write === null || d.s.write.writeId !== writeId) return
  set(d, { write: null, persistedRevision: Math.max(d.s.persistedRevision, revision) })
  if (selectDirty(d.s)) armPersist(d)
}

function onPersistFailed(d: Draft, writeId: number): void {
  if (d.s.lifecycle.kind === 'stopped' || d.s.write === null || d.s.write.writeId !== writeId) return
  set(d, { write: null })
  trace(d, 'Avatar appearance could not be written')
}

function onRendererGone(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'retiring' && lifecycle.token === token) {
    trace(d, 'Avatar renderer crashed while retiring')
    return
  }
  if ((lifecycle.kind === 'loading' || lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') && lifecycle.token === token) {
    trace(d, 'Avatar renderer crashed')
    retire(d, 'absent')
  }
}

function onNativeCloseRequested(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if ((lifecycle.kind === 'loading' || lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') && lifecycle.token === token) {
    d.reply = ACCEPTED
    applyHide(d)
  }
}

function onNativeClosed(d: Draft, token: number): void {
  const lifecycle = d.s.lifecycle
  if (lifecycle.kind === 'retiring' && lifecycle.token === token && lifecycle.phase !== 'allocating') {
    acknowledgeDisappearance(d)
    return
  }
  if ((lifecycle.kind === 'loading' || lifecycle.kind === 'promoting' || lifecycle.kind === 'ready') && lifecycle.token === token) {
    trace(d, 'Avatar window closed unexpectedly')
    loseResource(d, token)
  }
}

function retiringToken(state: AvatarMachineState, token: number): Extract<AvatarLifecycle, { kind: 'retiring' }> | null {
  const lifecycle = state.lifecycle
  return lifecycle.kind === 'retiring' && lifecycle.token === token ? lifecycle : null
}

function onDestroyReturned(d: Draft, token: number, op: number): void {
  if (retiringToken(d.s, token) === null) return
  settle(d, token, op, 'destroy')
}

function onDestroyFailed(d: Draft, token: number, op: number): void {
  const lifecycle = retiringToken(d.s, token)
  if (lifecycle === null || !settle(d, token, op, 'destroy')) return
  trace(d, 'Avatar window destroy failed')
  set(d, { lifecycle: { ...lifecycle, phase: 'checking' } })
  startProbe(d, token)
}

function onDestroyWatchdog(d: Draft, timerId: number, token: number): void {
  const lifecycle = retiringToken(d.s, token)
  if (lifecycle === null || !timerMatches(d.s, 'destroyWatchdog', timerId)) return
  consumeTimer(d, 'destroyWatchdog')
  if (lifecycle.phase !== 'destroying' && lifecycle.phase !== 'blocked') return
  trace(d, 'Avatar window destroy did not report closure in time')
  set(d, { lifecycle: { ...lifecycle, phase: 'checking' } })
  startProbe(d, token)
}

function onCheckDestroyedSucceeded(d: Draft, token: number, op: number, destroyed: boolean): void {
  const lifecycle = retiringToken(d.s, token)
  if (lifecycle === null || !settle(d, token, op, 'checkDestroyed')) return
  if (destroyed) {
    acknowledgeDisappearance(d)
    return
  }
  if (lifecycle.retryProbe && lifecycle.retryBudget === 1) {
    set(d, { lifecycle: { ...lifecycle, phase: 'destroying', retryProbe: false, retryBudget: 0 } })
    trace(d, 'Avatar window still alive, destroying once more')
    startDestroy(d, token)
    return
  }
  trace(d, 'Avatar window is still not confirmed destroyed')
  set(d, { lifecycle: { ...lifecycle, phase: 'blocked', retryProbe: false } })
}

function onCheckDestroyedFailed(d: Draft, token: number, op: number): void {
  const lifecycle = retiringToken(d.s, token)
  if (lifecycle === null || !settle(d, token, op, 'checkDestroyed')) return
  trace(d, 'Avatar window destruction could not be verified')
  set(d, { lifecycle: { ...lifecycle, phase: 'blocked', retryProbe: false } })
}

export function reduce(state: AvatarMachineState, event: AvatarEvent): AvatarReduction {
  const d: Draft = { s: state, effects: [], reply: NONE }
  switch (event.kind) {
    case 'ShowRequested':
      onShow(d)
      break
    case 'RestoreRequested':
      onRestore(d)
      break
    case 'HideRequested':
      onHide(d)
      break
    case 'LockChanged':
      onLock(d, event.value)
      break
    case 'ReloadRequested':
      onReload(d)
      break
    case 'QuitRequested':
      onQuit(d)
      break
    case 'AppearanceChanged':
      onAppearance(d, event.patch)
      break
    case 'PositionRequested':
      onPosition(d, event.x, event.y)
      break
    case 'PointerChanged':
      onPointer(d, event.inside)
      break
    case 'RefreshRequested':
      onRefresh(d)
      break
    case 'GeometryChanged':
      onGeometry(d, event.geometry)
      break
    case 'InitialStateRequested':
      onInitialState(d, event.token)
      break
    case 'Allocated':
      onAllocated(d, event.token)
      break
    case 'AllocationFailed':
      onAllocationFailed(d, event.token)
      break
    case 'LoadSucceeded':
      onLoadSucceeded(d, event.token)
      break
    case 'LoadFailed':
      onLoadFailed(d, event.token)
      break
    case 'LoadWatchdogExpired':
      onLoadWatchdog(d, event.timerId, event.token)
      break
    case 'PrepareSucceeded':
      onPrepareSucceeded(d, event.token, event.op, event.placement)
      break
    case 'PrepareFailed':
      onPrepareFailed(d, event.token, event.op)
      break
    case 'PromotionPublished':
      onPromotionPublished(d, event.token, event.op)
      break
    case 'PromotionPublishFailed':
      onPromotionPublishFailed(d, event.token, event.op)
      break
    case 'ShowSucceeded':
      onShowSucceeded(d, event.token, event.op)
      break
    case 'ShowFailed':
      onShowFailed(d, event.token, event.op)
      break
    case 'NativeOptionSucceeded':
      onNativeOptionSucceeded(d, event.token, event.op)
      break
    case 'NativeOptionFailed':
      onNativeOptionFailed(d, event.token, event.op)
      break
    case 'TrayPublished':
      onTrayResult(d, event.op, true)
      break
    case 'TrayPublishFailed':
      onTrayResult(d, event.op, false)
      break
    case 'ViewPublished':
      onViewResult(d, event.token, event.op, true)
      break
    case 'ViewPublishFailed':
      onViewResult(d, event.token, event.op, false)
      break
    case 'MoveDue':
      onMoveDue(d, event.timerId, event.token, event.epoch)
      break
    case 'MoveSucceeded':
      onMoveSucceeded(d, event.token, event.op, event.placement)
      break
    case 'MoveFailed':
      onMoveFailed(d, event.token, event.op)
      break
    case 'PersistDue':
      onPersistDue(d, event.timerId)
      break
    case 'PersistSucceeded':
      onPersistSucceeded(d, event.writeId, event.revision)
      break
    case 'PersistFailed':
      onPersistFailed(d, event.writeId)
      break
    case 'RendererGone':
      onRendererGone(d, event.token)
      break
    case 'NativeCloseRequested':
      onNativeCloseRequested(d, event.token)
      break
    case 'NativeClosed':
      onNativeClosed(d, event.token)
      break
    case 'DestroyReturned':
      onDestroyReturned(d, event.token, event.op)
      break
    case 'DestroyFailed':
      onDestroyFailed(d, event.token, event.op)
      break
    case 'DestroyWatchdogExpired':
      onDestroyWatchdog(d, event.timerId, event.token)
      break
    case 'CheckDestroyedSucceeded':
      onCheckDestroyedSucceeded(d, event.token, event.op, event.destroyed)
      break
    case 'CheckDestroyedFailed':
      onCheckDestroyedFailed(d, event.token, event.op)
      break
    default:
      return assertNever(event)
  }
  return { state: d.s, effects: d.effects, reply: d.reply }
}

export type AvatarCell = 'T' | 'I' | 'X'

function row(
  unavailable: AvatarCell,
  absent: AvatarCell,
  loading: AvatarCell,
  promoting: AvatarCell,
  ready: AvatarCell,
  retiring: AvatarCell,
  stopped: AvatarCell
): Record<AvatarLifecycleKind, AvatarCell> {
  return { unavailable, absent, loading, promoting, ready, retiring, stopped }
}

export const AVATAR_EVENT_CLASSIFICATION: Readonly<Record<AvatarEventKind, Readonly<Record<AvatarLifecycleKind, AvatarCell>>>> = {
  ShowRequested: row('X', 'T', 'T', 'T', 'T', 'T', 'X'),
  RestoreRequested: row('I', 'T', 'I', 'I', 'I', 'I', 'I'),
  HideRequested: row('T', 'T', 'T', 'T', 'T', 'T', 'X'),
  LockChanged: row('T', 'T', 'T', 'T', 'T', 'T', 'X'),
  ReloadRequested: row('X', 'T', 'T', 'T', 'T', 'T', 'X'),
  QuitRequested: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  AppearanceChanged: row('T', 'T', 'T', 'T', 'T', 'T', 'X'),
  PositionRequested: row('X', 'X', 'X', 'X', 'T', 'X', 'X'),
  PointerChanged: row('X', 'X', 'X', 'X', 'T', 'X', 'X'),
  RefreshRequested: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  GeometryChanged: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  InitialStateRequested: row('X', 'X', 'T', 'T', 'T', 'X', 'X'),
  Allocated: row('I', 'I', 'T', 'I', 'I', 'T', 'I'),
  AllocationFailed: row('I', 'I', 'T', 'I', 'I', 'T', 'I'),
  LoadSucceeded: row('I', 'I', 'T', 'I', 'I', 'I', 'I'),
  LoadFailed: row('I', 'I', 'T', 'I', 'I', 'I', 'I'),
  LoadWatchdogExpired: row('I', 'I', 'T', 'I', 'I', 'I', 'I'),
  PrepareSucceeded: row('I', 'I', 'I', 'T', 'I', 'I', 'I'),
  PrepareFailed: row('I', 'I', 'I', 'T', 'I', 'I', 'I'),
  PromotionPublished: row('I', 'I', 'I', 'T', 'I', 'I', 'I'),
  PromotionPublishFailed: row('I', 'I', 'I', 'T', 'I', 'I', 'I'),
  ShowSucceeded: row('I', 'I', 'I', 'T', 'T', 'I', 'I'),
  ShowFailed: row('I', 'I', 'I', 'T', 'T', 'I', 'I'),
  NativeOptionSucceeded: row('I', 'I', 'I', 'T', 'T', 'I', 'I'),
  NativeOptionFailed: row('I', 'I', 'I', 'T', 'T', 'I', 'I'),
  TrayPublished: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  TrayPublishFailed: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  ViewPublished: row('I', 'I', 'I', 'T', 'T', 'I', 'I'),
  ViewPublishFailed: row('I', 'I', 'I', 'T', 'T', 'I', 'I'),
  MoveDue: row('I', 'I', 'I', 'I', 'T', 'I', 'I'),
  MoveSucceeded: row('I', 'I', 'I', 'I', 'T', 'I', 'I'),
  MoveFailed: row('I', 'I', 'I', 'I', 'T', 'I', 'I'),
  PersistDue: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  PersistSucceeded: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  PersistFailed: row('T', 'T', 'T', 'T', 'T', 'T', 'I'),
  RendererGone: row('I', 'I', 'T', 'T', 'T', 'I', 'I'),
  NativeCloseRequested: row('I', 'I', 'T', 'T', 'T', 'I', 'I'),
  NativeClosed: row('I', 'I', 'T', 'T', 'T', 'T', 'I'),
  DestroyReturned: row('I', 'I', 'I', 'I', 'I', 'T', 'I'),
  DestroyFailed: row('I', 'I', 'I', 'I', 'I', 'T', 'I'),
  DestroyWatchdogExpired: row('I', 'I', 'I', 'I', 'I', 'T', 'I'),
  CheckDestroyedSucceeded: row('I', 'I', 'I', 'I', 'I', 'T', 'I'),
  CheckDestroyedFailed: row('I', 'I', 'I', 'I', 'I', 'T', 'I')
}
