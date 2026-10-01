import type { AvatarViewState } from '../shared/avatar-view'
import type { AvatarAppearance } from './avatar-appearance'
import {
  AvatarAllocationError,
  createAvatarNativeAdapter,
  type AvatarBrowserWindow,
  type AvatarViewWindowEndpoint,
  type AvatarWindowConstructionOptions
} from './avatar-window'
import {
  createAvatarMachineState,
  isEffectLive,
  reduce,
  selectCurrentToken,
  selectIsRetiring,
  type AvatarEffect,
  type AvatarEvent,
  type AvatarGeometry,
  type AvatarMachineConfig,
  type AvatarMachineState,
  type AvatarPublication,
  type AvatarReply
} from './avatar-window-state'

export interface AvatarWindowControllerOptions {
  available: boolean
  preload: string
  html: string
  createWindow(options: AvatarWindowConstructionOptions): AvatarBrowserWindow
  appearance: AvatarAppearance
  geometry: AvatarGeometry
  config?: Partial<AvatarMachineConfig>
  buildEnvelope(publication: AvatarPublication): AvatarViewState
  publishTray(envelope: AvatarViewState): void
  writeSnapshot(appearance: AvatarAppearance): void
  reportError(scope: string, message: string, error?: unknown): void
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface AvatarWindowController {
  dispatch(event: AvatarEvent): AvatarReply
  snapshot(): AvatarMachineState
  currentWindow(): AvatarViewWindowEndpoint | null
  loadingWindow(): AvatarViewWindowEndpoint | null
  getState(generation: number): AvatarViewState | Promise<AvatarViewState>
  setPosition(x: number, y: number): void
  setPointerInside(inside: boolean): void
  shutdown(): void
}

const NONE: AvatarReply = { kind: 'none' }

interface InitialRequest {
  token: number
  resolve(state: AvatarViewState): void
  reject(error: Error): void
}

export function createAvatarWindowController(options: AvatarWindowControllerOptions): AvatarWindowController {
  let state = createAvatarMachineState({
    available: options.available,
    appearance: options.appearance,
    geometry: options.geometry,
    config: options.config
  })
  const queue: AvatarEvent[] = []
  const timers = new Map<number, unknown>()
  let running = false
  let disposed = false
  let lastEnvelope: AvatarViewState | null = null
  let envelopeRevision = -1
  let initialRequest: InitialRequest | null = null

  const native = createAvatarNativeAdapter({
    preload: options.preload,
    html: options.html,
    createWindow: options.createWindow,
    windowSize: options.geometry.size,
    callbacks: {
      rendererGone: (token) => {
        dispatch({ kind: 'RendererGone', token })
      },
      closeRequested: (token) => {
        if (selectIsRetiring(state, token)) return false
        dispatch({ kind: 'NativeCloseRequested', token })
        return true
      },
      closed: (token) => {
        dispatch({ kind: 'NativeClosed', token })
      }
    }
  })

  const attempt = (action: () => void, message: string): boolean => {
    try {
      action()
      return true
    } catch (error) {
      options.reportError('avatar-window', message, error)
      return false
    }
  }

  const envelopeFor = (publication: AvatarPublication): AvatarViewState => {
    if (lastEnvelope === null || publication.revision !== envelopeRevision) {
      lastEnvelope = options.buildEnvelope(publication)
      envelopeRevision = publication.revision
    }
    return lastEnvelope
  }

  const settle = (event: AvatarEvent): void => {
    processEvent(event)
  }

  const perform = (effect: AvatarEffect): void => {
    switch (effect.kind) {
      case 'allocate': {
        let outcome: 'ok' | 'setupFailed' | 'failed' = 'ok'
        try {
          native.allocate(effect.token, state.appearance.alwaysOnTop)
        } catch (error) {
          options.reportError('avatar-window', 'Avatar window could not be created', error)
          outcome = error instanceof AvatarAllocationError ? 'setupFailed' : 'failed'
        }
        if (outcome === 'failed') {
          settle({ kind: 'AllocationFailed', token: effect.token })
          return
        }
        settle({ kind: 'Allocated', token: effect.token })
        if (outcome === 'setupFailed') settle({ kind: 'LoadFailed', token: effect.token })
        return
      }
      case 'load': {
        const token = effect.token
        let loading: Promise<void> | null = null
        try {
          loading = native.load(token)
        } catch (error) {
          options.reportError('avatar-window', 'Avatar renderer could not load', error)
        }
        if (loading === null) {
          settle({ kind: 'LoadFailed', token })
          return
        }
        loading.then(
          () => {
            dispatch({ kind: 'LoadSucceeded', token })
          },
          (error: unknown) => {
            options.reportError('avatar-window', 'Avatar renderer could not load', error)
            dispatch({ kind: 'LoadFailed', token })
          }
        )
        return
      }
      case 'prepare': {
        const { token, op, placement } = effect
        const ok = attempt(() => native.prepare(token, placement.x, placement.y, effect.size, effect.alwaysOnTop), 'Avatar window preparation failed')
        settle(ok ? { kind: 'PrepareSucceeded', token, op, placement } : { kind: 'PrepareFailed', token, op })
        return
      }
      case 'publish': {
        const { token, op, scope } = effect
        const ok = attempt(() => {
          const envelope = envelopeFor(effect.snapshot)
          if (scope === 'tray') {
            options.publishTray(envelope)
            return
          }
          if (token === null) throw new Error('Avatar publication requires a window token')
          native.send(token, envelope)
        }, `Avatar ${scope} publication failed`)
        if (scope === 'tray') settle({ kind: ok ? 'TrayPublished' : 'TrayPublishFailed', op })
        else if (token !== null) settle({ kind: scope === 'promotion' ? (ok ? 'PromotionPublished' : 'PromotionPublishFailed') : ok ? 'ViewPublished' : 'ViewPublishFailed', token, op })
        return
      }
      case 'show': {
        const { token, op } = effect
        const ok = attempt(() => native.show(token), 'Avatar window could not be shown')
        settle({ kind: ok ? 'ShowSucceeded' : 'ShowFailed', token, op })
        return
      }
      case 'hide': {
        const { token, op } = effect
        const ok = attempt(() => native.hide(token), 'Avatar window could not be hidden')
        settle({ kind: ok ? 'NativeOptionSucceeded' : 'NativeOptionFailed', token, op })
        return
      }
      case 'setPointerMode': {
        const { token, op } = effect
        const ok = attempt(() => native.setPointerMode(token, effect.inside), 'Avatar pointer mode could not be set')
        settle({ kind: ok ? 'NativeOptionSucceeded' : 'NativeOptionFailed', token, op })
        return
      }
      case 'setAlwaysOnTop': {
        const { token, op } = effect
        const ok = attempt(() => native.setAlwaysOnTop(token, effect.alwaysOnTop), 'Avatar always-on-top could not be set')
        settle({ kind: ok ? 'NativeOptionSucceeded' : 'NativeOptionFailed', token, op })
        return
      }
      case 'setNativePosition': {
        const { token, op, placement } = effect
        const ok = attempt(() => native.setPosition(token, placement.x, placement.y), 'cannot move Avatar window')
        settle(ok ? { kind: 'MoveSucceeded', token, op, placement } : { kind: 'MoveFailed', token, op })
        return
      }
      case 'destroy': {
        const { token, op } = effect
        const ok = attempt(() => native.destroy(token), 'Avatar window could not be destroyed')
        settle({ kind: ok ? 'DestroyReturned' : 'DestroyFailed', token, op })
        return
      }
      case 'checkDestroyed': {
        const { token, op } = effect
        let destroyed = false
        const ok = attempt(() => {
          destroyed = native.isDestroyed(token)
          if (destroyed) native.release(token)
        }, 'Avatar window destruction could not be verified')
        settle(ok ? { kind: 'CheckDestroyedSucceeded', token, op, destroyed } : { kind: 'CheckDestroyedFailed', token, op })
        return
      }
      case 'writeSnapshot': {
        const { writeId, revision } = effect
        const ok = attempt(() => options.writeSnapshot(effect.appearance), 'Avatar appearance could not be written')
        settle(ok ? { kind: 'PersistSucceeded', writeId, revision } : { kind: 'PersistFailed', writeId })
        return
      }
      case 'armTimer': {
        const { timerId, timer, token, epoch } = effect
        const handle = options.setTimeout(() => {
          timers.delete(timerId)
          if (disposed) return
          dispatch(timerEvent(timer, timerId, token, epoch))
        }, effect.delayMs)
        timers.set(timerId, handle)
        return
      }
      case 'cancelTimer': {
        if (!timers.has(effect.timerId)) return
        options.clearTimeout(timers.get(effect.timerId))
        timers.delete(effect.timerId)
        return
      }
      case 'resolveInitialState': {
        const request = initialRequest
        if (request === null || request.token !== effect.token) return
        initialRequest = null
        if (lastEnvelope !== null && selectCurrentToken(state) === effect.token) request.resolve(lastEnvelope)
        else request.reject(new Error('AvatarView window is not current'))
        return
      }
      case 'rejectInitialState': {
        const request = initialRequest
        if (request === null || request.token !== effect.token) return
        initialRequest = null
        request.reject(new Error('AvatarView initial state was invalidated'))
        return
      }
      case 'trace':
        options.reportError('avatar-window', effect.message)
        return
      default:
        return assertNever(effect)
    }
  }

  const processEvent = (event: AvatarEvent): AvatarReply => {
    const result = reduce(state, event)
    state = result.state
    for (const effect of result.effects) {
      if (!isEffectLive(state, effect)) continue
      try {
        perform(effect)
      } catch (error) {
        options.reportError('avatar-window', `Avatar effect ${effect.kind} failed outside its failure path`, error)
      }
    }
    return result.reply
  }

  const dispatch = (event: AvatarEvent): AvatarReply => {
    if (running) {
      queue.push(event)
      return NONE
    }
    running = true
    try {
      return processEvent(event)
    } finally {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        try {
          processEvent(next)
        } catch (error) {
          options.reportError('avatar-window', 'Avatar queued event failed', error)
        }
      }
      running = false
    }
  }

  const requireReply = (event: AvatarEvent): void => {
    const reply = dispatch(event)
    if (reply.kind === 'rejected') throw new Error(reply.reason)
  }

  const currentSnapshot = (generation: number): AvatarViewState => {
    if (lastEnvelope === null || selectCurrentToken(state) !== generation) throw new Error('AvatarView window is not current')
    return lastEnvelope
  }

  return {
    dispatch,
    snapshot: () => state,
    currentWindow() {
      const token = selectCurrentToken(state)
      return token === null ? null : native.endpoint(token)
    },
    loadingWindow() {
      const lifecycle = state.lifecycle
      return lifecycle.kind === 'loading' && lifecycle.step === 'document' ? native.endpoint(lifecycle.token) : null
    },
    getState(generation) {
      const reply = dispatch({ kind: 'InitialStateRequested', token: generation })
      if (reply.kind === 'rejected') throw new Error(reply.reason)
      if (reply.kind === 'accepted') return currentSnapshot(generation)
      if (reply.kind !== 'deferred') throw new Error('AvatarView initial state could not be scheduled')
      return new Promise<AvatarViewState>((resolve, reject) => {
        initialRequest = { token: generation, resolve, reject }
      }).then((envelope) => {
        if (selectCurrentToken(state) !== generation) throw new Error('AvatarView window is not current')
        return envelope
      })
    },
    setPosition(x, y) {
      requireReply({ kind: 'PositionRequested', x, y })
    },
    setPointerInside(inside) {
      requireReply({ kind: 'PointerChanged', inside })
    },
    shutdown() {
      dispatch({ kind: 'QuitRequested' })
      disposed = true
      for (const handle of timers.values()) options.clearTimeout(handle)
      timers.clear()
    }
  }
}

function timerEvent(timer: 'move' | 'persist' | 'loadWatchdog' | 'destroyWatchdog', timerId: number, token: number | null, epoch: number | null): AvatarEvent {
  switch (timer) {
    case 'move':
      return { kind: 'MoveDue', timerId, token: token ?? 0, epoch: epoch ?? 0 }
    case 'persist':
      return { kind: 'PersistDue', timerId }
    case 'loadWatchdog':
      return { kind: 'LoadWatchdogExpired', timerId, token: token ?? 0 }
    case 'destroyWatchdog':
      return { kind: 'DestroyWatchdogExpired', timerId, token: token ?? 0 }
    default:
      return assertNever(timer)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unclassified Avatar controller variant: ${JSON.stringify(value)}`)
}
