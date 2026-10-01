import { useEffect, useReducer } from 'react'
import type { AvatarFace } from '@shared/avatar-state'
import type { AvatarViewApi, AvatarViewState } from '@shared/avatar-view'
import { AvatarShell, motionInput } from './AvatarShell'
import { motionMode, type AvatarMotionMode } from './motion'
import { usePointerGesture } from './pointer-gesture'

export function isNewerView(next: AvatarViewState, current: AvatarViewState): boolean {
  if (next.generation !== current.generation) return next.generation > current.generation
  return next.revision > current.revision
}

export interface AvatarRendered {
  view: AvatarViewState
  face: AvatarFace
  mode: AvatarMotionMode
  previous: AvatarFace | null
}

/**
 * `previous` advances only when the face or the motion mode changes, so a
 * heartbeat neither replays nor cuts a running enter animation, and a face
 * applied while hidden or in DND is the one a later show starts from.
 */
export function advanceRendered(current: AvatarRendered | null, view: AvatarViewState, osReducedMotion: boolean): AvatarRendered {
  const face = view.summary.face
  const mode = motionMode(motionInput(view, osReducedMotion))
  if (current === null) return { view, face, mode, previous: null }
  const settled = current.face === face && current.mode === mode
  return { view, face, mode, previous: settled ? current.previous : current.face }
}

export interface AvatarContainerState {
  osReducedMotion: boolean
  rendered: AvatarRendered | null
}

export type AvatarContainerAction = { kind: 'view'; view: AvatarViewState } | { kind: 'os'; reducedMotion: boolean }

export function avatarContainerReducer(state: AvatarContainerState, action: AvatarContainerAction): AvatarContainerState {
  if (action.kind === 'os') {
    if (action.reducedMotion === state.osReducedMotion) return state
    const rendered = state.rendered && advanceRendered(state.rendered, state.rendered.view, action.reducedMotion)
    return { osReducedMotion: action.reducedMotion, rendered }
  }
  if (state.rendered !== null && !isNewerView(action.view, state.rendered.view)) return state
  return { ...state, rendered: advanceRendered(state.rendered, action.view, state.osReducedMotion) }
}

export interface AvatarAppProps {
  api: AvatarViewApi
  reducedMotion: MediaQueryList | null
}

export function AvatarApp({ api, reducedMotion }: AvatarAppProps): React.JSX.Element | null {
  const [state, dispatch] = useReducer(avatarContainerReducer, reducedMotion, (query): AvatarContainerState => ({
    osReducedMotion: query?.matches ?? false,
    rendered: null
  }))

  useEffect(() => {
    if (reducedMotion === null) return
    dispatch({ kind: 'os', reducedMotion: reducedMotion.matches })
    const onChange = (event: MediaQueryListEvent): void => dispatch({ kind: 'os', reducedMotion: event.matches })
    reducedMotion.addEventListener('change', onChange)
    return () => reducedMotion.removeEventListener('change', onChange)
  }, [reducedMotion])

  useEffect(() => {
    const unsubscribe = api.onState((view) => dispatch({ kind: 'view', view }))
    api.getState().then(
      (view) => dispatch({ kind: 'view', view }),
      (error: unknown) => api.reportError(`avatar getState failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2048))
    )
    return unsubscribe
  }, [api])

  const move = usePointerGesture(api, state.rendered?.view ?? null)

  if (state.rendered === null) return null
  return <AvatarShell view={state.rendered.view} previous={state.rendered.previous} osReducedMotion={state.osReducedMotion} move={move} />
}
