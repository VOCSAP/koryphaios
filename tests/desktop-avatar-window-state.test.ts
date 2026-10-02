import { describe, expect, test } from 'bun:test'
import type { AvatarAppearance } from '../desktop/src/main/avatar-appearance.ts'
import { AVATAR_WINDOW_SIZES } from '../desktop/src/main/avatar-window-placement.ts'
import {
  AVATAR_EVENT_CLASSIFICATION,
  createAvatarMachineState,
  isEffectLive,
  reduce,
  selectCanMove,
  selectCurrentToken,
  selectIsRetiring,
  selectMoveRefusal,
  type AvatarAppliedPlacement,
  type AvatarCell,
  type AvatarEffect,
  type AvatarEvent,
  type AvatarEventKind,
  type AvatarGeometry,
  type AvatarLifecycleKind,
  type AvatarMachineState,
  type AvatarReply,
  type AvatarTimerKind
} from '../desktop/src/main/avatar-window-state.ts'

const DISPLAY_A = { id: '1', workArea: { x: 0, y: 0, width: 1000, height: 800 } }
const DISPLAY_B = { id: '2', workArea: { x: 1000, y: 0, width: 1000, height: 800 } }
const GEOMETRY: AvatarGeometry = { displays: [DISPLAY_A, DISPLAY_B] }
const MEDIUM = AVATAR_WINDOW_SIZES.m

function appearance(patch: Partial<AvatarAppearance> = {}): AvatarAppearance {
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
    positions: Object.create(null) as AvatarAppearance['positions'],
    ...patch
  }
}

function at(x: number, y: number, display = DISPLAY_A): AvatarAppliedPlacement {
  return { screenId: display.id, workArea: display.workArea, x, y }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  return value
}

type Failure = 'allocate' | 'load' | 'prepare' | 'promotion' | 'show' | 'view' | 'tray' | 'nativeOption' | 'move' | 'write'
type Hold = Failure | 'destroy' | 'probe'
type DestroyMode = 'closed' | 'silent' | 'throw'

interface HarnessInit {
  available?: boolean
  appearance?: Partial<AvatarAppearance>
  geometry?: AvatarGeometry
}

class Harness {
  state: AvatarMachineState
  readonly executed: AvatarEffect[] = []
  readonly skipped: AvatarEffect[] = []
  readonly traces: string[] = []
  readonly writes: AvatarAppearance[] = []
  readonly nativeMoves: AvatarAppliedPlacement[] = []
  readonly alive = new Set<number>()
  readonly displayed = new Set<number>()
  readonly allocations: number[] = []
  readonly initialResolved: number[] = []
  readonly initialRejected: number[] = []
  readonly pending: AvatarEffect[] = []
  readonly timers = new Map<number, { kind: AvatarTimerKind; token: number | null; epoch: number | null }>()
  readonly held = new Set<Hold>()
  readonly failures = new Set<Failure>()
  destroyMode: DestroyMode = 'closed'
  probe: 'auto' | 'false' | 'throw' = 'auto'
  maxAlive = 0
  shows = 0
  hides = 0

  constructor(init: HarnessInit = {}) {
    this.state = deepFreeze(
      createAvatarMachineState({
        available: init.available ?? true,
        appearance: appearance(init.appearance),
        geometry: init.geometry ?? GEOMETRY
      })
    )
  }

  hold(...kinds: Hold[]): this {
    for (const kind of kinds) this.held.add(kind)
    return this
  }

  release(kind: Hold): this {
    this.held.delete(kind)
    return this
  }

  fail(...kinds: Failure[]): this {
    for (const kind of kinds) this.failures.add(kind)
    return this
  }

  patch(patch: Partial<AvatarMachineState>): void {
    this.state = deepFreeze({ ...this.state, ...patch })
  }

  dispatch(event: AvatarEvent): AvatarReply {
    const before = deepFreeze(this.state)
    const result = reduce(before, event)
    expect(reduce(before, event)).toEqual(result)
    this.state = deepFreeze(result.state)
    assertInvariants(this.state)
    for (const effect of result.effects) this.execute(effect)
    return result.reply
  }

  fire(kind: AvatarTimerKind): void {
    const entries = [...this.timers].filter(([, timer]) => timer.kind === kind)
    const last = entries[entries.length - 1]
    if (!last) throw new Error(`no ${kind} timer armed`)
    const [timerId, timer] = last
    this.timers.delete(timerId)
    this.dispatch(timerEvent(timerId, timer))
  }

  fireStale(timerId: number, timer: { kind: AvatarTimerKind; token: number | null; epoch: number | null }): AvatarReply {
    return this.dispatch(timerEvent(timerId, timer))
  }

  timerOf(kind: AvatarTimerKind): { id: number; kind: AvatarTimerKind; token: number | null; epoch: number | null } {
    const found = [...this.timers].filter(([, timer]) => timer.kind === kind).pop()
    if (!found) throw new Error(`no ${kind} timer armed`)
    return { id: found[0], ...found[1] }
  }

  lastExecuted<K extends AvatarEffect['kind']>(kind: K): Extract<AvatarEffect, { kind: K }> {
    const found = [...this.executed].reverse().find((effect) => effect.kind === kind)
    if (!found) throw new Error(`no ${kind} effect executed`)
    return found as Extract<AvatarEffect, { kind: K }>
  }

  count(kind: AvatarEffect['kind']): number {
    return this.executed.filter((effect) => effect.kind === kind).length
  }

  get token(): number {
    const lifecycle = this.state.lifecycle
    if (!('token' in lifecycle)) throw new Error(`lifecycle ${lifecycle.kind} holds no token`)
    return lifecycle.token
  }

  get kind(): AvatarLifecycleKind {
    return this.state.lifecycle.kind
  }

  private execute(effect: AvatarEffect): void {
    if (!isEffectLive(this.state, effect)) {
      this.skipped.push(effect)
      return
    }
    this.executed.push(effect)
    switch (effect.kind) {
      case 'allocate':
        if (this.parked('allocate', effect)) return
        if (this.failures.has('allocate')) {
          this.dispatch({ kind: 'AllocationFailed', token: effect.token })
          return
        }
        this.alive.add(effect.token)
        this.allocations.push(effect.token)
        this.maxAlive = Math.max(this.maxAlive, this.alive.size)
        this.dispatch({ kind: 'Allocated', token: effect.token })
        return
      case 'load':
        if (this.parked('load', effect)) return
        this.dispatch(this.failures.has('load') ? { kind: 'LoadFailed', token: effect.token } : { kind: 'LoadSucceeded', token: effect.token })
        return
      case 'prepare':
        if (this.parked('prepare', effect)) return
        this.dispatch(
          this.failures.has('prepare')
            ? { kind: 'PrepareFailed', token: effect.token, op: effect.op }
            : { kind: 'PrepareSucceeded', token: effect.token, op: effect.op, placement: effect.placement }
        )
        return
      case 'publish':
        if (effect.scope === 'promotion') {
          if (this.parked('promotion', effect)) return
          this.dispatch({ kind: this.failures.has('promotion') ? 'PromotionPublishFailed' : 'PromotionPublished', token: effect.token!, op: effect.op })
        } else if (effect.scope === 'view') {
          if (this.parked('view', effect)) return
          this.dispatch({ kind: this.failures.has('view') ? 'ViewPublishFailed' : 'ViewPublished', token: effect.token!, op: effect.op })
        } else {
          if (this.parked('tray', effect)) return
          this.dispatch({ kind: this.failures.has('tray') ? 'TrayPublishFailed' : 'TrayPublished', op: effect.op })
        }
        return
      case 'show':
        this.shows += 1
        if (!this.failures.has('show')) this.displayed.add(effect.token)
        if (this.parked('show', effect)) return
        this.dispatch({ kind: this.failures.has('show') ? 'ShowFailed' : 'ShowSucceeded', token: effect.token, op: effect.op })
        return
      case 'hide':
        this.hides += 1
        this.displayed.delete(effect.token)
        this.optionResult(effect)
        return
      case 'setPointerMode':
      case 'setAlwaysOnTop':
        this.optionResult(effect)
        return
      case 'setNativePosition':
        this.nativeMoves.push(effect.placement)
        if (this.parked('move', effect)) return
        this.dispatch(
          this.failures.has('move')
            ? { kind: 'MoveFailed', token: effect.token, op: effect.op }
            : { kind: 'MoveSucceeded', token: effect.token, op: effect.op, placement: effect.placement }
        )
        return
      case 'destroy':
        if (this.parked('destroy', effect)) return
        if (this.destroyMode === 'throw') {
          this.dispatch({ kind: 'DestroyFailed', token: effect.token, op: effect.op })
          return
        }
        if (this.destroyMode === 'closed') {
          this.alive.delete(effect.token)
          this.displayed.delete(effect.token)
        }
        this.dispatch({ kind: 'DestroyReturned', token: effect.token, op: effect.op })
        if (this.destroyMode === 'closed') this.dispatch({ kind: 'NativeClosed', token: effect.token })
        return
      case 'checkDestroyed':
        if (this.parked('probe', effect)) return
        if (this.probe === 'throw') this.dispatch({ kind: 'CheckDestroyedFailed', token: effect.token, op: effect.op })
        else {
          const destroyed = this.probe === 'auto' ? !this.alive.has(effect.token) : false
          this.dispatch({ kind: 'CheckDestroyedSucceeded', token: effect.token, op: effect.op, destroyed })
        }
        return
      case 'writeSnapshot':
        this.writes.push(effect.appearance)
        if (this.parked('write', effect)) return
        this.dispatch(
          this.failures.has('write')
            ? { kind: 'PersistFailed', writeId: effect.writeId }
            : { kind: 'PersistSucceeded', writeId: effect.writeId, revision: effect.revision }
        )
        return
      case 'armTimer':
        this.timers.set(effect.timerId, { kind: effect.timer, token: effect.token, epoch: effect.epoch })
        return
      case 'cancelTimer':
        this.timers.delete(effect.timerId)
        return
      case 'resolveInitialState':
        this.initialResolved.push(effect.token)
        return
      case 'rejectInitialState':
        this.initialRejected.push(effect.token)
        return
      case 'trace':
        this.traces.push(effect.message)
        return
    }
  }

  private optionResult(effect: AvatarEffect & { token: number; op: number }): void {
    if (this.parked('nativeOption', effect)) return
    this.dispatch({ kind: this.failures.has('nativeOption') ? 'NativeOptionFailed' : 'NativeOptionSucceeded', token: effect.token, op: effect.op })
  }

  private parked(kind: Hold, effect: AvatarEffect): boolean {
    if (!this.held.has(kind)) return false
    this.pending.push(effect)
    return true
  }

  deliverOne(): boolean {
    const effect = this.pending.shift()
    if (!effect) return false
    switch (effect.kind) {
      case 'allocate':
        this.alive.add(effect.token)
        this.allocations.push(effect.token)
        this.maxAlive = Math.max(this.maxAlive, this.alive.size)
        this.dispatch({ kind: 'Allocated', token: effect.token })
        return true
      case 'destroy':
        if (this.destroyMode === 'closed') {
          this.alive.delete(effect.token)
          this.displayed.delete(effect.token)
        }
        this.dispatch(this.destroyMode === 'throw' ? { kind: 'DestroyFailed', token: effect.token, op: effect.op } : { kind: 'DestroyReturned', token: effect.token, op: effect.op })
        if (this.destroyMode === 'closed') this.dispatch({ kind: 'NativeClosed', token: effect.token })
        return true
      default:
        this.answer(effect)
        return true
    }
  }

  private answer(effect: AvatarEffect): void {
    switch (effect.kind) {
      case 'load':
        this.dispatch(this.failures.has('load') ? { kind: 'LoadFailed', token: effect.token } : { kind: 'LoadSucceeded', token: effect.token })
        return
      case 'prepare':
        this.dispatch(
          this.failures.has('prepare')
            ? { kind: 'PrepareFailed', token: effect.token, op: effect.op }
            : { kind: 'PrepareSucceeded', token: effect.token, op: effect.op, placement: effect.placement }
        )
        return
      case 'publish':
        if (effect.scope === 'promotion') this.dispatch({ kind: this.failures.has('promotion') ? 'PromotionPublishFailed' : 'PromotionPublished', token: effect.token!, op: effect.op })
        else if (effect.scope === 'view') this.dispatch({ kind: this.failures.has('view') ? 'ViewPublishFailed' : 'ViewPublished', token: effect.token!, op: effect.op })
        else this.dispatch({ kind: this.failures.has('tray') ? 'TrayPublishFailed' : 'TrayPublished', op: effect.op })
        return
      case 'show':
        this.dispatch({ kind: this.failures.has('show') ? 'ShowFailed' : 'ShowSucceeded', token: effect.token, op: effect.op })
        return
      case 'hide':
      case 'setPointerMode':
      case 'setAlwaysOnTop':
        this.dispatch({ kind: this.failures.has('nativeOption') ? 'NativeOptionFailed' : 'NativeOptionSucceeded', token: effect.token, op: effect.op })
        return
      case 'setNativePosition':
        this.dispatch(
          this.failures.has('move')
            ? { kind: 'MoveFailed', token: effect.token, op: effect.op }
            : { kind: 'MoveSucceeded', token: effect.token, op: effect.op, placement: effect.placement }
        )
        return
      case 'checkDestroyed':
        if (this.probe === 'throw') this.dispatch({ kind: 'CheckDestroyedFailed', token: effect.token, op: effect.op })
        else this.dispatch({ kind: 'CheckDestroyedSucceeded', token: effect.token, op: effect.op, destroyed: this.probe === 'auto' ? !this.alive.has(effect.token) : false })
        return
      case 'writeSnapshot':
        this.dispatch(
          this.failures.has('write')
            ? { kind: 'PersistFailed', writeId: effect.writeId }
            : { kind: 'PersistSucceeded', writeId: effect.writeId, revision: effect.revision }
        )
        return
      default:
        return
    }
  }
}

function timerEvent(timerId: number, timer: { kind: AvatarTimerKind; token: number | null; epoch: number | null }): AvatarEvent {
  switch (timer.kind) {
    case 'move':
      return { kind: 'MoveDue', timerId, token: timer.token ?? 0, epoch: timer.epoch ?? 0 }
    case 'persist':
      return { kind: 'PersistDue', timerId }
    case 'loadWatchdog':
      return { kind: 'LoadWatchdogExpired', timerId, token: timer.token ?? 0 }
    case 'destroyWatchdog':
      return { kind: 'DestroyWatchdogExpired', timerId, token: timer.token ?? 0 }
  }
}

function assertInvariants(state: AvatarMachineState): void {
  const lifecycle = state.lifecycle
  const token = 'token' in lifecycle ? lifecycle.token : null
  for (const permit of state.permits) {
    if (permit.token !== null) expect(permit.token === token, `permit ${permit.species} must belong to the held token`).toBe(true)
    if (lifecycle.kind !== 'retiring') {
      expect(['destroy', 'checkDestroyed'], `${permit.species} permit outside retiring`).not.toContain(permit.species)
    }
  }
  expect(state.permits.filter((permit) => permit.species === 'destroy').length).toBeLessThanOrEqual(1)
  if (state.requested !== null) {
    expect(lifecycle.kind, 'a pending move requires a ready window').toBe('ready')
    expect(state.appearance.visible).toBe(true)
    expect(state.appearance.positionLocked).toBe(false)
    expect(state.requested.token === token).toBe(true)
    expect(state.requested.epoch).toBe(state.moveEpoch)
  }
  if (state.timers.move !== null) expect(lifecycle.kind).toBe('ready')
  if (state.pointerInside) {
    expect(lifecycle.kind).toBe('ready')
    expect(state.appearance.visible).toBe(true)
  }
  if (state.initialWaiter !== null) {
    expect(['loading', 'promoting']).toContain(lifecycle.kind)
    expect(state.initialWaiter === token).toBe(true)
  }
  expect(state.appearanceRevision).toBeGreaterThanOrEqual(state.persistedRevision)
  if (selectCanMove(state)) expect(lifecycle.kind).toBe('ready')
}

function readyHarness(init: HarnessInit = {}): Harness {
  const harness = new Harness(init)
  harness.dispatch({ kind: 'ShowRequested' })
  expect(harness.kind).toBe('ready')
  return harness
}

function lastWrite(harness: Harness): AvatarAppearance {
  const write = harness.writes[harness.writes.length - 1]
  if (!write) throw new Error('no snapshot written')
  return write
}

describe('lifecycle reduction, cases a to g', () => {
  test('a: reload during load retires g1, late load resolution is ignored, g2 starts only after g1 disappears', () => {
    const h = new Harness().hold('load')
    h.dispatch({ kind: 'ShowRequested' })
    const g1 = h.token
    expect(h.kind).toBe('loading')
    h.destroyMode = 'closed'
    h.dispatch({ kind: 'ReloadRequested' })
    expect(h.allocations).toEqual([g1, g1 + 1])
    expect(h.kind).toBe('loading')
    expect(h.token).toBe(g1 + 1)
    const before = h.state
    const late = h.dispatch({ kind: 'LoadSucceeded', token: g1 })
    expect(late).toEqual({ kind: 'none' })
    expect(h.state).toBe(before)
    expect(h.count('prepare')).toBe(0)
    expect(h.shows).toBe(0)
    expect(h.maxAlive).toBe(1)
  })

  test('a: reload while the old window is still being destroyed creates nothing until it is gone', () => {
    const h = new Harness().hold('load', 'destroy')
    h.dispatch({ kind: 'ShowRequested' })
    const g1 = h.token
    h.dispatch({ kind: 'ReloadRequested' })
    expect(h.kind).toBe('retiring')
    expect(h.allocations).toEqual([g1])
    h.dispatch({ kind: 'LoadSucceeded', token: g1 })
    expect(h.allocations).toEqual([g1])
    expect(h.count('prepare')).toBe(0)
    h.alive.delete(g1)
    h.dispatch({ kind: 'NativeClosed', token: g1 })
    expect(h.allocations).toEqual([g1, g1 + 1])
    expect(h.maxAlive).toBe(1)
  })

  test('a: quit during load never allocates again and ignores the late load', () => {
    const h = new Harness().hold('load')
    h.dispatch({ kind: 'ShowRequested' })
    const g1 = h.token
    h.dispatch({ kind: 'QuitRequested' })
    expect(h.kind).toBe('stopped')
    h.dispatch({ kind: 'LoadSucceeded', token: g1 })
    h.dispatch({ kind: 'ReloadRequested' })
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.allocations).toEqual([g1])
    expect(h.count('prepare')).toBe(0)
    expect(h.timers.size).toBe(0)
  })

  test('b: a crash reported by the previous window leaves the loading replacement untouched', () => {
    const h = readyHarness()
    const g1 = h.token
    h.hold('load')
    h.dispatch({ kind: 'ReloadRequested' })
    const g2 = h.token
    expect(g2).toBe(g1 + 1)
    const loadWatchdog = h.state.timers.loadWatchdog
    const before = h.state
    const reply = h.dispatch({ kind: 'RendererGone', token: g1 })
    expect(reply).toEqual({ kind: 'none' })
    expect(h.state).toBe(before)
    expect(h.state.timers.loadWatchdog).toBe(loadWatchdog)
    h.release('load')
    h.dispatch({ kind: 'LoadSucceeded', token: g2 })
    expect(h.kind).toBe('ready')
    expect(h.token).toBe(g2)
  })

  test('c: a failed promotion publication retires the window at once and a later Show creates g2', () => {
    const h = new Harness().fail('promotion')
    h.dispatch({ kind: 'ShowRequested' })
    const g1 = h.lastExecuted('allocate').token
    expect(h.kind).toBe('absent')
    expect(selectCurrentToken(h.state)).toBeNull()
    expect(h.alive.size).toBe(0)
    expect(h.shows).toBe(0)
    h.failures.clear()
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.allocations).toEqual([g1, g1 + 1])
    expect(h.kind).toBe('ready')
    expect(h.maxAlive).toBe(1)
  })

  test('c: a failed show retires the window at once and a later Show creates g2', () => {
    const h = new Harness().fail('show')
    h.dispatch({ kind: 'ShowRequested' })
    const g1 = h.lastExecuted('allocate').token
    expect(h.kind).toBe('absent')
    expect(h.state.appearance.visible).toBe(true)
    expect(h.alive.size).toBe(0)
    h.failures.clear()
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.allocations).toEqual([g1, g1 + 1])
    expect(h.kind).toBe('ready')
  })

  test('c: current() is null from the very reduction that reports the failure', () => {
    const h = new Harness().hold('promotion', 'destroy')
    h.dispatch({ kind: 'ShowRequested' })
    const token = h.token
    const op = h.state.permits.find((permit) => permit.species === 'promotion')!.op
    const result = reduce(h.state, { kind: 'PromotionPublishFailed', token, op })
    expect(selectCurrentToken(result.state)).toBeNull()
    expect(selectIsRetiring(result.state, token)).toBe(true)
    expect(result.effects.some((effect) => effect.kind === 'destroy' && effect.token === token)).toBe(true)
  })

  describe('c, named limit: failure then a destroy that cannot be attested', () => {
    function stuck(): Harness {
      const h = new Harness().fail('show')
      h.destroyMode = 'throw'
      h.probe = 'false'
      h.dispatch({ kind: 'ShowRequested' })
      expect(h.kind).toBe('retiring')
      return h
    }

    test('stays revoked with zero new allocation, even after the first probe', () => {
      const h = stuck()
      const g1 = h.token
      expect(selectCurrentToken(h.state)).toBeNull()
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked', destination: 'absent' })
      expect(h.traces.length).toBeGreaterThan(0)
      expect(h.allocations).toEqual([g1])
      h.dispatch({ kind: 'ShowRequested' })
      expect(h.allocations).toEqual([g1])
    })

    test('branch 1: the watchdog finds it destroyed, the crash-only retirement returns to absent without relaunch', () => {
      const h = new Harness().fail('show')
      h.destroyMode = 'silent'
      h.dispatch({ kind: 'ShowRequested' })
      const g1 = h.token
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'destroying' })
      h.alive.delete(g1)
      h.fire('destroyWatchdog')
      expect(h.kind).toBe('absent')
      expect(h.allocations).toEqual([g1])
    })

    test('branch 1 after a destroy that threw and a first probe that said alive: the 2 s watchdog probes once more and acknowledges', () => {
      const h = new Harness().fail('show')
      h.destroyMode = 'throw'
      h.dispatch({ kind: 'ShowRequested' })
      const g1 = h.token
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked' })
      expect(h.timers.size).toBe(1)
      const probes = h.count('checkDestroyed')
      h.alive.delete(g1)
      h.fire('destroyWatchdog')
      expect(h.count('checkDestroyed')).toBe(probes + 1)
      expect(h.kind).toBe('absent')
      expect(h.allocations).toEqual([g1])
      h.failures.clear()
      h.dispatch({ kind: 'ShowRequested' })
      expect(h.allocations).toEqual([g1, g1 + 1])
      expect(h.maxAlive).toBe(1)
    })

    test('the watchdog after a destroy that threw probes once, never loops and never destroys again', () => {
      const h = new Harness().fail('show')
      h.destroyMode = 'throw'
      h.dispatch({ kind: 'ShowRequested' })
      const destroys = h.count('destroy')
      const probes = h.count('checkDestroyed')
      h.fire('destroyWatchdog')
      expect(h.count('checkDestroyed')).toBe(probes + 1)
      expect(h.count('destroy')).toBe(destroys)
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked' })
      expect([...h.timers.values()].filter((timer) => timer.kind === 'destroyWatchdog')).toEqual([])
    })

    test('a destroy that returned while the window is still alive keeps the barrier at the watchdog and creates nothing', () => {
      const h = readyHarness()
      const g1 = h.token
      h.destroyMode = 'silent'
      h.dispatch({ kind: 'ReloadRequested' })
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'destroying' })
      h.fire('destroyWatchdog')
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked' })
      expect(h.alive.has(g1)).toBe(true)
      expect(h.allocations).toEqual([g1])
      expect(h.maxAlive).toBe(1)
    })

    test('branch 2: an explicit replacement request waits, then the watchdog confirmation allows it', () => {
      const h = new Harness().fail('show')
      h.destroyMode = 'silent'
      h.dispatch({ kind: 'ShowRequested' })
      const g1 = h.token
      h.failures.clear()
      h.dispatch({ kind: 'ReloadRequested' })
      expect(h.allocations).toEqual([g1])
      h.alive.delete(g1)
      h.fire('destroyWatchdog')
      expect(h.allocations).toEqual([g1, g1 + 1])
      expect(h.maxAlive).toBe(1)
    })

    test('branch 3: each explicit command retries cleanup with at most one extra destroy and never allocates', () => {
      const h = stuck()
      const g1 = h.token
      const destroysBefore = h.count('destroy')
      h.dispatch({ kind: 'ShowRequested' })
      expect(h.count('destroy')).toBe(destroysBefore + 1)
      expect(h.allocations).toEqual([g1])
      h.dispatch({ kind: 'ReloadRequested' })
      expect(h.count('destroy')).toBe(destroysBefore + 2)
      expect(h.allocations).toEqual([g1])
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked', retryBudget: 0 })
    })

    test('a retry coalesces while its probe is still outstanding', () => {
      const h = stuck()
      h.hold('probe')
      h.dispatch({ kind: 'ShowRequested' })
      const destroys = h.count('destroy')
      h.dispatch({ kind: 'ShowRequested' })
      h.dispatch({ kind: 'ReloadRequested' })
      expect(h.count('destroy')).toBe(destroys)
      expect(h.count('checkDestroyed')).toBe(2)
    })

    test('a probe that finally reports the window gone releases the barrier and honours the replacement', () => {
      const h = stuck()
      const g1 = h.token
      h.alive.delete(g1)
      h.probe = 'auto'
      h.dispatch({ kind: 'ReloadRequested' })
      expect(h.allocations).toEqual([g1, g1 + 1])
    })

    test('a probe that throws keeps the barrier closed and keeps the destination', () => {
      const h = new Harness().fail('show')
      h.destroyMode = 'throw'
      h.probe = 'throw'
      h.dispatch({ kind: 'ShowRequested' })
      expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', phase: 'blocked' })
      expect(h.allocations.length).toBe(1)
    })
  })

  test('d: a user close hides, writes visible:false, and rejects every later position', () => {
    const h = readyHarness()
    const g1 = h.token
    const reply = h.dispatch({ kind: 'NativeCloseRequested', token: g1 })
    expect(reply).toEqual({ kind: 'accepted' })
    expect(h.state.appearance.visible).toBe(false)
    expect(lastWrite(h).visible).toBe(false)
    expect(h.hides).toBe(1)
    expect(h.kind).toBe('ready')
    const rejected = h.dispatch({ kind: 'PositionRequested', x: 10, y: 10 })
    expect(rejected).toEqual({ kind: 'rejected', reason: 'Avatar is hidden' })
    expect(h.state.timers.move).toBeNull()
    expect(h.nativeMoves).toEqual([])
    expect(Object.keys(lastWrite(h).positions)).toEqual([])
  })

  test('e: a request revoked by hide cannot be resurrected by a stale timer, even after show', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    const stale = h.timerOf('move')
    h.dispatch({ kind: 'HideRequested' })
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.fireStale(stale.id, stale)).toEqual({ kind: 'none' })
    expect(h.nativeMoves).toEqual([])
    for (const write of h.writes) expect(Object.keys(write.positions)).toEqual([])
  })

  test('e: a request revoked by lock cannot be resurrected by a stale timer, even after unlock', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    const stale = h.timerOf('move')
    h.dispatch({ kind: 'LockChanged', value: true })
    h.dispatch({ kind: 'LockChanged', value: false })
    h.fireStale(stale.id, stale)
    expect(h.nativeMoves).toEqual([])
    expect(h.state.requested).toBeNull()
    h.dispatch({ kind: 'PositionRequested', x: 300, y: 300 })
    h.fire('move')
    expect(h.nativeMoves).toEqual([at(300, 300)])
  })

  test('f: an applied P1 is written after hide, a refused P2 is never written', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.fire('move')
    expect(h.nativeMoves).toEqual([at(100, 200)])
    h.dispatch({ kind: 'HideRequested' })
    expect(h.dispatch({ kind: 'PositionRequested', x: 500, y: 500 }).kind).toBe('rejected')
    h.fire('persist')
    h.dispatch({ kind: 'QuitRequested' })
    const everything = h.writes.map((write) => write.positions['1'])
    expect(everything.length).toBeGreaterThan(0)
    for (const position of everything) expect(position).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
    expect(lastWrite(h).visible).toBe(false)
  })

  test('f: a P2 admitted but never applied is dropped by hide, the flush writes P1 only', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.fire('move')
    h.dispatch({ kind: 'PositionRequested', x: 400, y: 400 })
    h.dispatch({ kind: 'LockChanged', value: true })
    h.dispatch({ kind: 'QuitRequested' })
    expect(lastWrite(h).positionLocked).toBe(true)
    expect(lastWrite(h).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
  })

  test('f: a native failure of P2 after P1 keeps P1 and never persists P2', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.fire('move')
    h.fail('move')
    h.dispatch({ kind: 'PositionRequested', x: 400, y: 400 })
    h.fire('move')
    h.dispatch({ kind: 'QuitRequested' })
    expect(h.state.applied?.placement).toEqual(at(100, 200))
    expect(lastWrite(h).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
    expect(h.traces).toContain('Avatar window could not be moved')
  })

  test('f: a position request alone never creates a debt', () => {
    const h = readyHarness()
    const before = h.state.appearanceRevision
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    expect(h.state.appearanceRevision).toBe(before)
    expect(Object.keys(h.state.appearance.positions)).toEqual([])
  })

  test('g: a reload destroys without turning the close into a hide, for either initial intent', () => {
    for (const visible of [true, false]) {
      const h = new Harness({ appearance: { visible } })
      h.dispatch({ kind: visible ? 'ShowRequested' : 'ReloadRequested' })
      expect(h.kind).toBe('ready')
      const g1 = h.token
      h.hold('destroy')
      h.dispatch({ kind: 'ReloadRequested' })
      expect(selectIsRetiring(h.state, g1)).toBe(true)
      const writes = h.writes.length
      const reply = h.dispatch({ kind: 'NativeCloseRequested', token: g1 })
      expect(reply).toEqual({ kind: 'none' })
      expect(h.state.appearance.visible).toBe(visible)
      expect(h.writes.length).toBe(writes)
      expect(h.hides).toBe(0)
    }
  })

  test('g: a quit does not turn the destroy into a hide either', () => {
    const h = readyHarness()
    const g1 = h.token
    h.hold('destroy')
    h.dispatch({ kind: 'QuitRequested' })
    h.dispatch({ kind: 'NativeCloseRequested', token: g1 })
    expect(h.state.appearance.visible).toBe(true)
  })

  test('h: a startup restore allocates once for a visible avatar and leaves the preference untouched', () => {
    const h = new Harness()
    const before = h.state
    const result = reduce(before, { kind: 'RestoreRequested' })

    expect(result.reply.kind).toBe('accepted')
    expect(result.state.lifecycle.kind).toBe('loading')
    expect(result.effects.filter((effect) => effect.kind === 'allocate')).toHaveLength(1)
    expect(result.effects.filter((effect) => effect.kind === 'writeSnapshot'), 'a restore must not rewrite the stored preference').toEqual([])
    expect(result.effects.filter((effect) => effect.kind === 'publish'), 'a restore publishes nothing before the window exists').toEqual([])
    expect(result.state.appearance).toEqual(before.appearance)
    expect(result.state.appearanceRevision).toBe(before.appearanceRevision)
  })

  test('h: a startup restore of a hidden avatar keeps it hidden and does nothing', () => {
    const h = new Harness({ appearance: { visible: false } })
    const before = h.state
    const result = reduce(before, { kind: 'RestoreRequested' })

    expect(result.reply.kind).toBe('none')
    expect(sameState(result.state, before), 'visible:false must survive a restore').toBe(true)
    expect(result.effects).toEqual([])
  })

  test('h: without a window platform the restore is silent, neither refused nor traced', () => {
    const h = new Harness({ available: false })
    const result = reduce(h.state, { kind: 'RestoreRequested' })

    expect(result.reply.kind).toBe('none')
    expect(result.effects).toEqual([])
  })

  test('h: a second restore after a crash allocates nothing', () => {
    const h = new Harness()
    h.dispatch({ kind: 'RestoreRequested' })
    expect(h.kind).toBe('ready')
    const first = h.allocations.length
    h.dispatch({ kind: 'RendererGone', token: liveToken(h) })
    expect(h.kind).toBe('absent')

    expect(h.dispatch({ kind: 'RestoreRequested' }).kind).toBe('none')
    expect(h.allocations, 'only an explicit Show may bring the avatar back after a crash').toHaveLength(first)
    expect(h.kind).toBe('absent')
    h.dispatch({ kind: 'GeometryChanged', geometry: { displays: [DISPLAY_B] } })
    expect(h.allocations, 'a topology change does not bring a crashed avatar back either').toHaveLength(first)
    expect(h.kind).toBe('absent')
  })

  test('move then crash then Show applies the same P to the next window', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 123, y: 234 })
    h.fire('move')
    h.fire('persist')
    const g1 = h.token
    h.dispatch({ kind: 'RendererGone', token: g1 })
    expect(h.kind).toBe('absent')
    expect(h.state.appearance.visible).toBe(true)
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.token).toBe(g1 + 1)
    expect(h.state.applied).toEqual({ token: g1 + 1, placement: at(123, 234) })
    expect(h.lastExecuted('prepare').placement).toEqual(at(123, 234))
  })

  test('the first snapshot of a window is published before show', () => {
    const h = new Harness()
    h.dispatch({ kind: 'ShowRequested' })
    const order = h.executed.map((effect) => (effect.kind === 'publish' ? `publish:${effect.scope}` : effect.kind))
    expect(order.indexOf('publish:promotion')).toBeGreaterThan(order.indexOf('prepare'))
    expect(order.indexOf('show')).toBeGreaterThan(order.indexOf('publish:promotion'))
  })

  test('a hidden window is promoted without a show and a later Show reveals it', () => {
    const h = new Harness({ appearance: { visible: false } })
    h.dispatch({ kind: 'ReloadRequested' })
    expect(h.kind).toBe('ready')
    expect(h.shows).toBe(0)
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.shows).toBe(1)
    expect(h.state.appearance.visible).toBe(true)
  })

  test('hide after a geometry change hides the window that is being re-prepared', () => {
    const h = readyHarness()
    const g = h.token
    expect(h.displayed.has(g)).toBe(true)
    h.hold('prepare')
    h.dispatch({ kind: 'GeometryChanged', geometry: { displays: [DISPLAY_B] } })
    expect(h.state.lifecycle).toMatchObject({ kind: 'promoting', token: g, step: 'prepare' })
    h.dispatch({ kind: 'HideRequested' })
    expect(h.displayed.has(g)).toBe(false)
    h.release('prepare')
    const op = h.state.permits.find((permit) => permit.species === 'prepare')!.op
    h.dispatch({ kind: 'PrepareSucceeded', token: g, op, placement: h.lastExecuted('prepare').placement })
    expect(h.kind).toBe('ready')
    expect(h.displayed.has(g)).toBe(false)
    expect(h.state.appearance.visible).toBe(false)
  })

  test('hide revokes a show that is still permitted on a ready window', () => {
    const h = readyHarness()
    const g = h.token
    h.hold('show')
    h.dispatch({ kind: 'ShowRequested' })
    const op = h.state.permits.find((permit) => permit.species === 'show')!.op
    h.dispatch({ kind: 'HideRequested' })
    expect(h.state.permits.some((permit) => permit.species === 'show')).toBe(false)
    expect(h.displayed.has(g)).toBe(false)
    const before = h.state
    expect(h.dispatch({ kind: 'ShowSucceeded', token: g, op })).toEqual({ kind: 'none' })
    expect(h.state).toBe(before)
  })

  test('hide before the show of a promotion revokes the show and finishes hidden', () => {
    const h = new Harness().hold('show')
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.state.lifecycle).toMatchObject({ kind: 'promoting', step: 'show' })
    h.dispatch({ kind: 'HideRequested' })
    expect(h.kind).toBe('ready')
    h.release('show')
    expect(h.state.permits.some((permit) => permit.species === 'show')).toBe(false)
    expect(h.shows).toBe(1)
    expect(h.state.appearance.visible).toBe(false)
  })
})

describe('position, restoration and persistence rules', () => {
  test('refuses a move for a hidden avatar before considering its lock or its window', () => {
    const ready = readyHarness().state
    const withAppearance = (patch: Partial<AvatarAppearance>): AvatarMachineState => ({ ...ready, appearance: { ...ready.appearance, ...patch } })
    expect(selectMoveRefusal(ready)).toBeNull()
    expect(selectCanMove(ready)).toBe(true)
    expect(selectMoveRefusal(withAppearance({ visible: false }))).toBe('Avatar is hidden')
    expect(selectMoveRefusal(withAppearance({ positionLocked: true }))).toBe('Avatar position is locked')
    expect(selectMoveRefusal(withAppearance({ visible: false, positionLocked: true }))).toBe('Avatar is hidden')
    expect(selectMoveRefusal({ ...ready, lifecycle: { kind: 'absent' } })).toBe('Avatar window is unavailable')
    expect(selectCanMove({ ...ready, lifecycle: { kind: 'absent' } })).toBe(false)
  })

  test('a move acknowledged for a past window never becomes a debt', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.hold('move')
    h.fire('move')
    const g1 = h.token
    const op = h.state.permits.find((permit) => permit.species === 'move')!.op
    h.dispatch({ kind: 'RendererGone', token: g1 })
    const before = h.state
    h.dispatch({ kind: 'MoveSucceeded', token: g1, op, placement: at(100, 200) })
    expect(h.state).toBe(before)
    expect(Object.keys(h.state.appearance.positions)).toEqual([])
  })

  test('applied is reset by every new token while the remembered positions survive', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.fire('move')
    expect(h.state.applied?.token).toBe(h.token)
    h.dispatch({ kind: 'ReloadRequested' })
    expect(h.state.applied?.token).toBe(h.token)
    expect(h.state.applied?.placement).toEqual(at(100, 200))
    expect(h.state.appearance.positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
  })

  test('restoration of an identical stored position writes nothing', () => {
    const positions = Object.assign(Object.create(null), { '1': { workArea: DISPLAY_A.workArea, x: 100, y: 200 } })
    const h = readyHarness({ appearance: { positions } })
    expect(h.state.appearanceRevision).toBe(0)
    expect(h.writes).toEqual([])
  })

  test('a clamped restoration updates only the selected screen, after success, and leaves the other entry intact', () => {
    const other = { workArea: DISPLAY_B.workArea, x: 1500, y: 100 }
    const positions = Object.assign(Object.create(null), {
      '1': { workArea: DISPLAY_A.workArea, x: 5000, y: 5000 },
      '2': other
    })
    const h = readyHarness({ appearance: { positions } })
    expect(h.state.appearance.positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 1000 - MEDIUM.width, y: 800 - MEDIUM.height })
    expect(h.state.appearance.positions['2']).toBe(other)
    expect(h.state.timers.persist).not.toBeNull()
  })

  test('a restoration on a screen without entry, while another remembered screen is absent, creates a debt on the selected screen only', () => {
    const absent = { workArea: { x: 5000, y: 0, width: 800, height: 600 }, x: 5100, y: 50 }
    const positions = Object.assign(Object.create(null), { '9': absent })
    const h = readyHarness({ appearance: { positions } })
    const centered = { workArea: DISPLAY_A.workArea, x: (1000 - MEDIUM.width) / 2, y: (800 - MEDIUM.height) / 2 }
    expect(h.state.appearance.positions['1']).toEqual(centered)
    expect(h.state.appearance.positions['9']).toBe(absent)
    expect(h.state.appearanceRevision).toBe(1)
    expect(h.state.timers.persist).not.toBeNull()
    h.fire('persist')
    expect(lastWrite(h).positions['9']).toBe(absent)
    expect(lastWrite(h).positions['1']).toEqual(centered)
  })

  test('a restoration with no stored position is applied but not persisted', () => {
    const h = readyHarness()
    expect(h.state.applied?.placement).toEqual(at((1000 - MEDIUM.width) / 2, (800 - MEDIUM.height) / 2))
    expect(Object.keys(h.state.appearance.positions)).toEqual([])
    expect(h.state.appearanceRevision).toBe(0)
  })

  test('with no display, preparation fails, is traced and the window is retired', () => {
    const h = new Harness({ geometry: { displays: [] } })
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.kind).toBe('absent')
    expect(h.traces).toContain('Avatar placement requires an available display')
    expect(h.alive.size).toBe(0)
  })

  test('a geometry change re-prepares the same token before any move and drops the pending request', () => {
    const h = readyHarness()
    const g = h.token
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    const stale = h.timerOf('move')
    h.hold('prepare')
    h.dispatch({ kind: 'GeometryChanged', geometry: { displays: [DISPLAY_B] } })
    expect(h.state.lifecycle).toMatchObject({ kind: 'promoting', token: g, step: 'prepare' })
    expect(h.state.applied).toBeNull()
    expect(h.state.requested).toBeNull()
    expect(h.dispatch({ kind: 'PositionRequested', x: 1, y: 1 }).kind).toBe('rejected')
    h.fireStale(stale.id, stale)
    expect(h.nativeMoves).toEqual([])
    h.release('prepare')
    h.dispatch({ kind: 'PrepareSucceeded', token: g, op: h.state.permits.find((permit) => permit.species === 'prepare')!.op, placement: h.lastExecuted('prepare').placement })
    expect(h.lastExecuted('prepare').placement.screenId).toBe('2')
  })

  test('a position request is clamped with the window size on the nearest display', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 5000, y: -50 })
    h.fire('move')
    expect(h.nativeMoves).toEqual([at(2000 - MEDIUM.width, 0, DISPLAY_B)])
  })

  test('a size change re-prepares the window at the table size and drops the pending move', () => {
    const h = readyHarness()
    const g = h.token
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.hold('prepare')
    expect(h.dispatch({ kind: 'AppearanceChanged', patch: { size: 'l' } }).kind).toBe('accepted')
    expect(h.state.lifecycle).toMatchObject({ kind: 'promoting', token: g, step: 'prepare' })
    expect(h.state.requested, 'a move computed for the old size would land clamped to it').toBeNull()
    expect(h.lastExecuted('prepare').size).toEqual(AVATAR_WINDOW_SIZES.l)
  })

  test('the same size chosen again re-prepares nothing', () => {
    const h = readyHarness()
    const prepares = h.count('prepare')
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 'm' } })
    expect(h.count('prepare')).toBe(prepares)
  })

  test('a size chosen while hidden is kept and applied by the next preparation', () => {
    const h = new Harness({ appearance: { visible: false } })
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 's' } })
    expect(h.count('prepare'), 'no window exists to resize').toBe(0)
    h.dispatch({ kind: 'ShowRequested' })
    expect(h.lastExecuted('prepare').size).toEqual(AVATAR_WINDOW_SIZES.s)
  })

  test('a display change keeps the chosen size', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 'l' } })
    h.dispatch({ kind: 'GeometryChanged', geometry: { displays: [DISPLAY_B] } })
    expect(h.lastExecuted('prepare').size, 'a display change must not bring the window back to a fixed size').toEqual(AVATAR_WINDOW_SIZES.l)
  })

  test('each size clamps a move with its own width', () => {
    for (const size of ['s', 'm', 'l'] as const) {
      const h = readyHarness({ appearance: { size } })
      h.dispatch({ kind: 'PositionRequested', x: 5000, y: -50 })
      h.fire('move')
      expect(h.nativeMoves, `size ${size}`).toEqual([at(2000 - AVATAR_WINDOW_SIZES[size].width, 0, DISPLAY_B)])
    }
  })

  test('a size change keeps the centre of the window where it was', () => {
    const positions = Object.assign(Object.create(null), { '1': { workArea: DISPLAY_A.workArea, x: 100, y: 200 } })
    const h = readyHarness({ appearance: { positions } })
    const centre = (x: number, y: number, size: 's' | 'm' | 'l') => [x + AVATAR_WINDOW_SIZES[size].width / 2, y + AVATAR_WINDOW_SIZES[size].height / 2]
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 'l' } })
    const placed = h.lastExecuted('prepare').placement
    expect(centre(placed.x, placed.y, 'l'), 'the top-left corner must not be the anchor').toEqual(centre(100, 200, 'm'))
  })

  test('near an edge the clamp wins over the centre, and is not written', () => {
    const positions = Object.assign(Object.create(null), { '1': { workArea: DISPLAY_A.workArea, x: 830, y: 300 } })
    const h = readyHarness({ appearance: { positions } })
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 'l' } })
    expect(h.lastExecuted('prepare').placement).toEqual(at(1000 - AVATAR_WINDOW_SIZES.l.width, 270))
    expect(h.kind).toBe('ready')
    expect(h.state.appearance.positions['1'], 'a resize must not store the clamped corner').toEqual({ workArea: DISPLAY_A.workArea, x: 800, y: 270 })
  })

  test('a large size pushed against an edge then a small one returns to the intended centre', () => {
    const positions = Object.assign(Object.create(null), { '1': { workArea: DISPLAY_A.workArea, x: 830, y: 300 } })
    const h = readyHarness({ appearance: { positions } })
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 'l' } })
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 's' } })
    const placed = h.lastExecuted('prepare').placement
    expect([placed.x + AVATAR_WINDOW_SIZES.s.width / 2, placed.y + AVATAR_WINDOW_SIZES.s.height / 2]).toEqual([830 + MEDIUM.width / 2, 300 + MEDIUM.height / 2])
    expect(lastWrite(h).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: placed.x, y: placed.y })
  })

  test('a size chosen while the window is ready but hidden prepares it at that size and shows nothing', () => {
    const h = new Harness({ appearance: { visible: false } })
    h.dispatch({ kind: 'ReloadRequested' })
    expect(h.kind).toBe('ready')
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 's' } })
    expect(h.lastExecuted('prepare').size).toEqual(AVATAR_WINDOW_SIZES.s)
    expect(h.kind).toBe('ready')
    expect(h.shows, 'a resize must not reveal a hidden avatar').toBe(0)
  })

  test('a frame change is stored and published without any native effect', () => {
    const h = readyHarness()
    const native = h.executed.length
    const writes = h.writes.length
    h.dispatch({ kind: 'AppearanceChanged', patch: { frame: 'full' } })
    expect(h.state.appearance.frame).toBe('full')
    const kinds = h.executed.slice(native).map((effect) => effect.kind)
    expect(new Set(kinds), 'the frame is drawn by the renderer: the window keeps its size and options').toEqual(new Set(['writeSnapshot', 'publish']))
    expect(h.writes.length).toBe(writes + 1)
    h.dispatch({ kind: 'AppearanceChanged', patch: { frame: 'full' } })
    expect(h.writes.length, 'the same frame chosen again writes nothing').toBe(writes + 1)
  })

  test('a patch changing size and always on top carries both in one preparation', () => {
    const h = readyHarness()
    const separate = h.count('setAlwaysOnTop')
    h.dispatch({ kind: 'AppearanceChanged', patch: { size: 'l', alwaysOnTop: false } })
    expect(h.lastExecuted('prepare')).toMatchObject({ size: AVATAR_WINDOW_SIZES.l, alwaysOnTop: false })
    expect(h.count('setAlwaysOnTop'), 'the preparation already applies always on top').toBe(separate)
  })

  test('requests are coalesced onto one move timer and the latest placement wins', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 1, y: 2 })
    h.dispatch({ kind: 'PositionRequested', x: 3, y: 4 })
    h.dispatch({ kind: 'PositionRequested', x: 5, y: 6 })
    expect([...h.timers.values()].filter((timer) => timer.kind === 'move').length).toBe(1)
    h.fire('move')
    expect(h.nativeMoves).toEqual([at(5, 6)])
  })

  test('a persistence failure keeps the debt, does not loop, and a later change retries', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.fire('move')
    h.fail('write')
    h.fire('persist')
    expect(h.writes.length).toBe(1)
    expect(h.state.write).toBeNull()
    expect(h.state.persistedRevision).toBeLessThan(h.state.appearanceRevision)
    expect(h.state.appearance.visible).toBe(true)
    h.failures.clear()
    h.dispatch({ kind: 'LockChanged', value: true })
    expect(h.writes.length).toBe(2)
    expect(lastWrite(h).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
    expect(h.state.persistedRevision).toBe(h.state.appearanceRevision)
  })

  test('only one snapshot write is in flight and the newer revision stays dirty', () => {
    const h = readyHarness()
    h.hold('write')
    h.dispatch({ kind: 'LockChanged', value: true })
    h.dispatch({ kind: 'LockChanged', value: false })
    expect(h.count('writeSnapshot')).toBe(1)
    const write = h.state.write!
    h.release('write')
    h.dispatch({ kind: 'PersistSucceeded', writeId: write.writeId, revision: write.revision })
    expect(h.state.persistedRevision).toBe(write.revision)
    expect(h.state.timers.persist).not.toBeNull()
    h.fire('persist')
    expect(lastWrite(h).positionLocked).toBe(false)
  })

  test('quit flushes applied positions without moving', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'PositionRequested', x: 100, y: 200 })
    h.fire('move')
    h.dispatch({ kind: 'PositionRequested', x: 300, y: 300 })
    h.dispatch({ kind: 'QuitRequested' })
    expect(h.nativeMoves).toEqual([at(100, 200)])
    expect(lastWrite(h).positions['1']).toEqual({ workArea: DISPLAY_A.workArea, x: 100, y: 200 })
    expect(h.timers.size).toBe(0)
  })

  test('appearance patches cannot smuggle visible, lock or positions', () => {
    const h = readyHarness()
    const before = h.state.appearance
    h.dispatch({
      kind: 'AppearanceChanged',
      patch: { visible: false, positionLocked: true, positions: { x: { workArea: DISPLAY_A.workArea, x: 1, y: 1 } }, idleOpacity: 0.5 } as never
    })
    expect(h.state.appearance.idleOpacity).toBe(0.5)
    expect(h.state.appearance.visible).toBe(before.visible)
    expect(h.state.appearance.positionLocked).toBe(before.positionLocked)
    expect(h.state.appearance.positions).toBe(before.positions)
  })

  test('an always-on-top change reaches the native window through a permitted effect', () => {
    const h = readyHarness()
    h.dispatch({ kind: 'AppearanceChanged', patch: { alwaysOnTop: false } })
    expect(h.lastExecuted('setAlwaysOnTop').alwaysOnTop).toBe(false)
  })

  test('a failing native option retires the window', () => {
    const h = readyHarness().fail('nativeOption')
    h.dispatch({ kind: 'AppearanceChanged', patch: { alwaysOnTop: false } })
    expect(h.kind).toBe('absent')
    expect(selectCurrentToken(h.state)).toBeNull()
  })

  test('pointer interactivity needs a ready visible window and is reset by hide', () => {
    const h = readyHarness()
    expect(h.dispatch({ kind: 'PointerChanged', inside: true })).toEqual({ kind: 'accepted' })
    expect(h.state.pointerInside).toBe(true)
    h.dispatch({ kind: 'HideRequested' })
    expect(h.state.pointerInside).toBe(false)
    expect(h.dispatch({ kind: 'PointerChanged', inside: true })).toEqual({ kind: 'rejected', reason: 'Avatar is hidden' })
    expect(h.state.pointerInside).toBe(false)
  })

  test('a single initial state request is held per token and resolved by the promotion snapshot', () => {
    const h = new Harness().hold('load')
    h.dispatch({ kind: 'ShowRequested' })
    const g = h.token
    expect(h.dispatch({ kind: 'InitialStateRequested', token: g })).toEqual({ kind: 'deferred' })
    expect(h.dispatch({ kind: 'InitialStateRequested', token: g }).kind).toBe('rejected')
    h.release('load')
    h.dispatch({ kind: 'LoadSucceeded', token: g })
    expect(h.initialResolved).toEqual([g])
    expect(h.dispatch({ kind: 'InitialStateRequested', token: g })).toEqual({ kind: 'accepted' })
  })

  test('invalidation rejects the held initial state request and frees the slot', () => {
    const h = new Harness().hold('load')
    h.dispatch({ kind: 'ShowRequested' })
    const g1 = h.token
    h.dispatch({ kind: 'InitialStateRequested', token: g1 })
    h.dispatch({ kind: 'ReloadRequested' })
    expect(h.initialRejected).toEqual([g1])
    expect(h.state.initialWaiter).toBeNull()
    expect(h.dispatch({ kind: 'InitialStateRequested', token: g1 }).kind).toBe('rejected')
    expect(h.dispatch({ kind: 'InitialStateRequested', token: g1 + 1 })).toEqual({ kind: 'deferred' })
  })

  test('the load watchdog retires a window that never loads, with no relaunch', () => {
    const h = new Harness().hold('load')
    h.dispatch({ kind: 'ShowRequested' })
    const g1 = h.token
    h.fire('loadWatchdog')
    expect(h.kind).toBe('absent')
    expect(h.allocations).toEqual([g1])
    expect(h.traces).toContain('Avatar renderer load timed out')
  })

  test('commands are refused while stopping and when stopped', () => {
    const h = readyHarness()
    h.hold('destroy')
    h.dispatch({ kind: 'QuitRequested' })
    for (const event of [{ kind: 'ShowRequested' }, { kind: 'HideRequested' }, { kind: 'ReloadRequested' }, { kind: 'LockChanged', value: true }] as AvatarEvent[]) {
      expect(h.dispatch(event).kind).toBe('rejected')
    }
    expect(h.state.lifecycle).toMatchObject({ kind: 'retiring', destination: 'stop' })
    h.alive.clear()
    h.dispatch({ kind: 'NativeClosed', token: h.token })
    expect(h.kind).toBe('stopped')
    expect(h.dispatch({ kind: 'ShowRequested' }).kind).toBe('rejected')
  })
})

type LC = AvatarLifecycleKind
const LIFECYCLES: readonly LC[] = ['unavailable', 'absent', 'loading', 'promoting', 'ready', 'retiring', 'stopped']

function make(lifecycle: LC, variant = ''): Harness {
  const h = new Harness({ available: lifecycle !== 'unavailable' })
  switch (lifecycle) {
    case 'unavailable':
    case 'absent':
      break
    case 'loading':
      h.hold(variant === 'allocating' ? 'allocate' : 'load')
      h.dispatch({ kind: 'ShowRequested' })
      break
    case 'promoting':
      h.hold(variant === 'publish' ? 'promotion' : variant === 'show' ? 'show' : 'prepare')
      h.dispatch({ kind: 'ShowRequested' })
      break
    case 'ready':
      h.dispatch({ kind: 'ShowRequested' })
      break
    case 'retiring':
      if (variant === 'allocating') {
        h.hold('allocate')
        h.dispatch({ kind: 'ShowRequested' })
      } else {
        h.dispatch({ kind: 'ShowRequested' })
        if (variant === 'checking') {
          h.destroyMode = 'throw'
          h.hold('probe')
        } else if (variant === 'blocked') {
          h.destroyMode = 'throw'
          h.probe = 'false'
        } else h.hold('destroy')
      }
      h.dispatch({ kind: 'ReloadRequested' })
      break
    case 'stopped':
      h.dispatch({ kind: 'QuitRequested' })
      break
  }
  if (lifecycle === 'promoting' && variant === 'optionHeld') {
    h.hold('nativeOption')
    h.dispatch({ kind: 'AppearanceChanged', patch: { alwaysOnTop: false } })
  }
  if (lifecycle === 'ready') {
    if (variant === 'showHeld') {
      h.hold('show')
      h.dispatch({ kind: 'ShowRequested' })
    } else if (variant === 'pointerHeld') {
      h.hold('nativeOption')
      h.dispatch({ kind: 'PointerChanged', inside: true })
    } else if (variant === 'moveArmed') {
      h.dispatch({ kind: 'PositionRequested', x: 50, y: 60 })
    } else if (variant === 'moveInFlight') {
      h.hold('move')
      h.dispatch({ kind: 'PositionRequested', x: 50, y: 60 })
      h.fire('move')
    }
  }
  if (variant === 'viewHeld') {
    h.hold('view')
    h.dispatch({ kind: 'RefreshRequested' })
  }
  if (variant === 'trayHeld') {
    h.hold('tray')
    h.dispatch({ kind: 'RefreshRequested' })
  }
  return h
}

const VARIANT: Partial<Record<AvatarEventKind, Partial<Record<LC, string>>>> = {
  Allocated: { loading: 'allocating', retiring: 'allocating' },
  AllocationFailed: { loading: 'allocating', retiring: 'allocating' },
  PrepareSucceeded: { promoting: 'prepare' },
  PrepareFailed: { promoting: 'prepare' },
  PromotionPublished: { promoting: 'publish' },
  PromotionPublishFailed: { promoting: 'publish' },
  ShowSucceeded: { promoting: 'show', ready: 'showHeld' },
  ShowFailed: { promoting: 'show', ready: 'showHeld' },
  NativeOptionSucceeded: { promoting: 'optionHeld', ready: 'pointerHeld' },
  NativeOptionFailed: { promoting: 'optionHeld', ready: 'pointerHeld' },
  ViewPublished: { promoting: 'viewHeld', ready: 'viewHeld' },
  ViewPublishFailed: { promoting: 'viewHeld', ready: 'viewHeld' },
  MoveDue: { ready: 'moveArmed' },
  MoveSucceeded: { ready: 'moveInFlight' },
  MoveFailed: { ready: 'moveInFlight' },
  CheckDestroyedSucceeded: { retiring: 'checking' },
  CheckDestroyedFailed: { retiring: 'checking' }
}

const STALE = 777

function liveToken(h: Harness): number {
  return 'token' in h.state.lifecycle ? h.state.lifecycle.token : STALE
}

function liveOp(h: Harness, species: string): number {
  return [...h.state.permits].reverse().find((permit) => permit.species === species)?.op ?? STALE
}

function livePlacement(h: Harness): AvatarAppliedPlacement {
  return h.executed.some((effect) => effect.kind === 'prepare') ? h.lastExecuted('prepare').placement : at(1, 1)
}

const EVENT: Record<AvatarEventKind, (h: Harness) => AvatarEvent> = {
  ShowRequested: () => ({ kind: 'ShowRequested' }),
  RestoreRequested: () => ({ kind: 'RestoreRequested' }),
  HideRequested: () => ({ kind: 'HideRequested' }),
  LockChanged: () => ({ kind: 'LockChanged', value: true }),
  ReloadRequested: () => ({ kind: 'ReloadRequested' }),
  QuitRequested: () => ({ kind: 'QuitRequested' }),
  AppearanceChanged: () => ({ kind: 'AppearanceChanged', patch: { idleOpacity: 0.5 } }),
  PositionRequested: () => ({ kind: 'PositionRequested', x: 50, y: 60 }),
  PointerChanged: () => ({ kind: 'PointerChanged', inside: true }),
  RefreshRequested: () => ({ kind: 'RefreshRequested' }),
  GeometryChanged: () => ({ kind: 'GeometryChanged', geometry: { displays: [DISPLAY_B] } }),
  InitialStateRequested: (h) => ({ kind: 'InitialStateRequested', token: liveToken(h) }),
  Allocated: (h) => ({ kind: 'Allocated', token: liveToken(h) }),
  AllocationFailed: (h) => ({ kind: 'AllocationFailed', token: liveToken(h) }),
  LoadSucceeded: (h) => ({ kind: 'LoadSucceeded', token: liveToken(h) }),
  LoadFailed: (h) => ({ kind: 'LoadFailed', token: liveToken(h) }),
  LoadWatchdogExpired: (h) => ({ kind: 'LoadWatchdogExpired', timerId: h.state.timers.loadWatchdog?.id ?? STALE, token: liveToken(h) }),
  PrepareSucceeded: (h) => ({ kind: 'PrepareSucceeded', token: liveToken(h), op: liveOp(h, 'prepare'), placement: livePlacement(h) }),
  PrepareFailed: (h) => ({ kind: 'PrepareFailed', token: liveToken(h), op: liveOp(h, 'prepare') }),
  PromotionPublished: (h) => ({ kind: 'PromotionPublished', token: liveToken(h), op: liveOp(h, 'promotion') }),
  PromotionPublishFailed: (h) => ({ kind: 'PromotionPublishFailed', token: liveToken(h), op: liveOp(h, 'promotion') }),
  ShowSucceeded: (h) => ({ kind: 'ShowSucceeded', token: liveToken(h), op: liveOp(h, 'show') }),
  ShowFailed: (h) => ({ kind: 'ShowFailed', token: liveToken(h), op: liveOp(h, 'show') }),
  NativeOptionSucceeded: (h) => ({ kind: 'NativeOptionSucceeded', token: liveToken(h), op: liveOp(h, 'nativeOption') }),
  NativeOptionFailed: (h) => ({ kind: 'NativeOptionFailed', token: liveToken(h), op: liveOp(h, 'nativeOption') }),
  TrayPublished: (h) => ({ kind: 'TrayPublished', op: liveOp(h, 'tray') }),
  TrayPublishFailed: (h) => ({ kind: 'TrayPublishFailed', op: liveOp(h, 'tray') }),
  ViewPublished: (h) => ({ kind: 'ViewPublished', token: liveToken(h), op: liveOp(h, 'view') }),
  ViewPublishFailed: (h) => ({ kind: 'ViewPublishFailed', token: liveToken(h), op: liveOp(h, 'view') }),
  MoveDue: (h) => ({ kind: 'MoveDue', timerId: h.state.timers.move?.id ?? STALE, token: liveToken(h), epoch: h.state.moveEpoch }),
  MoveSucceeded: (h) => ({ kind: 'MoveSucceeded', token: liveToken(h), op: liveOp(h, 'move'), placement: at(50, 60) }),
  MoveFailed: (h) => ({ kind: 'MoveFailed', token: liveToken(h), op: liveOp(h, 'move') }),
  PersistDue: () => ({ kind: 'PersistDue', timerId: 91 }),
  PersistSucceeded: () => ({ kind: 'PersistSucceeded', writeId: 90, revision: 1 }),
  PersistFailed: () => ({ kind: 'PersistFailed', writeId: 90 }),
  RendererGone: (h) => ({ kind: 'RendererGone', token: liveToken(h) }),
  NativeCloseRequested: (h) => ({ kind: 'NativeCloseRequested', token: liveToken(h) }),
  NativeClosed: (h) => ({ kind: 'NativeClosed', token: liveToken(h) }),
  DestroyReturned: (h) => ({ kind: 'DestroyReturned', token: liveToken(h), op: liveOp(h, 'destroy') }),
  DestroyFailed: (h) => ({ kind: 'DestroyFailed', token: liveToken(h), op: liveOp(h, 'destroy') }),
  DestroyWatchdogExpired: (h) => ({ kind: 'DestroyWatchdogExpired', timerId: h.state.timers.destroyWatchdog?.id ?? STALE, token: liveToken(h) }),
  CheckDestroyedSucceeded: (h) => ({ kind: 'CheckDestroyedSucceeded', token: liveToken(h), op: liveOp(h, 'checkDestroyed'), destroyed: true }),
  CheckDestroyedFailed: (h) => ({ kind: 'CheckDestroyedFailed', token: liveToken(h), op: liveOp(h, 'checkDestroyed') })
}

function arrange(kind: AvatarEventKind, lifecycle: LC): { h: Harness; event: AvatarEvent } {
  const retiringDefault = lifecycle === 'retiring' ? 'destroying' : ''
  const variant =
    VARIANT[kind]?.[lifecycle] ??
    (kind === 'TrayPublished' || kind === 'TrayPublishFailed' ? 'trayHeld' : retiringDefault)
  const h = make(lifecycle, variant)
  if (kind === 'PersistDue') h.patch({ timers: { ...h.state.timers, persist: { id: 91, token: null, epoch: null } } })
  if (kind === 'PersistSucceeded' || kind === 'PersistFailed') h.patch({ appearanceRevision: 1, write: { writeId: 90, revision: 1 } })
  return { h, event: EVENT[kind](h) }
}

function sameState(a: AvatarMachineState, b: AvatarMachineState): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

describe('lifecycle x event classification', () => {
  test('every event kind of the union has a row and a witness, and no witness is orphaned', () => {
    expect(Object.keys(EVENT).sort()).toEqual(Object.keys(AVATAR_EVENT_CLASSIFICATION).sort())
    for (const [kind, row] of Object.entries(AVATAR_EVENT_CLASSIFICATION)) {
      expect(Object.keys(row).sort(), `row ${kind} must classify every lifecycle`).toEqual([...LIFECYCLES].sort())
    }
  })

  for (const kind of Object.keys(AVATAR_EVENT_CLASSIFICATION) as AvatarEventKind[]) {
    test(`${kind}: each lifecycle behaves as classified`, () => {
      for (const lifecycle of LIFECYCLES) {
        const expected: AvatarCell = AVATAR_EVENT_CLASSIFICATION[kind][lifecycle]
        const { h, event } = arrange(kind, lifecycle)
        expect(h.kind, `${kind} witness must start in ${lifecycle}`).toBe(lifecycle)
        const before = h.state
        const result = reduce(before, event)
        const meaningful = result.effects.filter((effect) => effect.kind !== 'trace')
        const label = `${kind} in ${lifecycle}`
        if (expected === 'X') {
          expect(result.reply.kind, `${label}: a refusal must be observable`).toBe('rejected')
          expect(sameState(result.state, before), `${label}: a refusal must not change state`).toBe(true)
          expect(result.effects, `${label}: a refusal must emit nothing`).toEqual([])
        } else if (expected === 'I') {
          expect(result.reply.kind, `${label}: an ignored event must not reply`).toBe('none')
          expect(sameState(result.state, before), `${label}: an ignored event must not change state`).toBe(true)
          expect(meaningful, `${label}: an ignored event must have no effect`).toEqual([])
        } else {
          const acted = !sameState(result.state, before) || meaningful.length > 0 || result.reply.kind !== 'none'
          expect(acted, `${label}: a transition must change something`).toBe(true)
          expect(result.reply.kind, `${label}: a transition is not refused`).not.toBe('rejected')
        }
      }
    })
  }
})

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('invariants over random schedules', () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    test(`seed ${seed}: at most one live window and consistent bookkeeping after every event`, () => {
      const random = mulberry32(seed)
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
      const h = new Harness()
      const trail: string[] = []
      const failures: Failure[] = ['prepare', 'promotion', 'show', 'view', 'tray', 'nativeOption', 'move', 'write', 'load']
      for (let step = 0; step < 220 && h.kind !== 'stopped'; step += 1) {
        h.failures.clear()
        if (random() < 0.15) h.fail(pick(failures))
        h.destroyMode = pick<DestroyMode>(['closed', 'closed', 'silent', 'throw'])
        h.probe = pick(['auto', 'auto', 'false', 'throw'] as const)
        const lifecycle = h.state.lifecycle
        const token = 'token' in lifecycle ? lifecycle.token : STALE
        const choice = Math.floor(random() * 24)
        trail.push(`${choice}:${h.kind}:${[...h.held].join('+')}:${h.destroyMode}/${h.probe}`)
        switch (choice) {
          case 0: h.dispatch({ kind: 'ShowRequested' }); break
          case 1: h.dispatch({ kind: 'HideRequested' }); break
          case 2: h.dispatch({ kind: 'LockChanged', value: random() < 0.5 }); break
          case 3: h.dispatch({ kind: 'ReloadRequested' }); break
          case 4: h.dispatch({ kind: 'AppearanceChanged', patch: { alwaysOnTop: random() < 0.5, idleOpacity: random() } }); break
          case 5:
          case 6: h.dispatch({ kind: 'PositionRequested', x: Math.floor(random() * 2500) - 200, y: Math.floor(random() * 900) - 50 }); break
          case 7: h.dispatch({ kind: 'PointerChanged', inside: random() < 0.5 }); break
          case 8: h.dispatch({ kind: 'RefreshRequested' }); break
          case 9:
            h.dispatch({ kind: 'GeometryChanged', geometry: random() < 0.1 ? { displays: [] } : pick([GEOMETRY, { displays: [DISPLAY_B] }]) })
            break
          case 10: h.dispatch({ kind: 'NativeCloseRequested', token }); break
          case 11: if (random() < 0.4) h.dispatch({ kind: 'RendererGone', token }); break
          case 12: if (h.timers.size > 0) h.fire(pick([...h.timers.values()]).kind); break
          case 13: if (random() < 0.3) h.dispatch({ kind: 'InitialStateRequested', token }); break
          case 14: h.dispatch({ kind: 'NativeClosed', token: STALE }); break
          case 15:
            if (h.kind === 'retiring') {
              h.alive.delete(token)
              h.dispatch({ kind: 'NativeClosed', token })
            }
            break
          case 16: if (random() < 0.05) h.dispatch({ kind: 'QuitRequested' }); break
          case 18:
          case 19:
          case 20: {
            const kind = pick<Hold>(['allocate', 'load', 'prepare', 'promotion', 'show', 'nativeOption', 'view', 'tray', 'move', 'write', 'destroy', 'probe'])
            if (h.held.has(kind)) h.release(kind)
            else h.hold(kind)
            break
          }
          case 21:
          case 22:
          case 23: h.deliverOne(); break
          default: h.dispatch({ kind: 'RendererGone', token: STALE }); break
        }
        expect(h.maxAlive, trail.slice(-14).join(' | ')).toBeLessThanOrEqual(1)
        const held = h.state.lifecycle
        if ((held.kind === 'promoting' || held.kind === 'ready') && !h.state.appearance.visible) {
          expect(h.displayed.has(held.token), 'a held window must not stay displayed while visible is false').toBe(false)
          expect(h.state.permits.some((permit) => permit.species === 'show'), 'no show may stay permitted while visible is false').toBe(false)
        }
        if (h.kind === 'ready') expect(h.alive.has(h.token)).toBe(true)
        if (h.kind === 'loading' || h.kind === 'promoting') expect(h.alive.size).toBeLessThanOrEqual(1)
      }
    })
  }
})
