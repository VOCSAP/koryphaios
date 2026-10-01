import type { AvatarFace } from '@shared/avatar-state'
import { FACE_GEOMETRY } from '@shared/avatar-mask-geometry'

export type AvatarMotionChoice = 'continuous' | 'transitions' | 'none'

export interface AvatarMotionInput {
  choice: AvatarMotionChoice
  osReducedMotion: boolean
  visible: boolean
  dndActive: boolean
}

export type AvatarMotionMode = 'suspended' | 'reduced' | AvatarMotionChoice

export interface AvatarLoop {
  durationMs: number
  /** CSS steps() count: the loop repaints `steps` times per period, not at 60 fps. */
  steps: number
}

export interface AvatarMotionPlan {
  mode: AvatarMotionMode
  loop: AvatarLoop | null
  transition: 'none' | 'fade' | 'animate'
  transitionMs: number
  halo: boolean
}

export const MOTION_LIMITS = {
  fadeMs: 200,
  transitionMs: 1000,
  enterMs: 600,
  maxStepsPerSecond: 4
} as const

// A transparent always-on-top window recomposites on every frame it animates,
// so continuous motion is stepped: a few repaints per second, never 60 fps.
export const FACE_LOOPS = {
  panne: null,
  reclame: { durationMs: 2000, steps: 8 },
  perdu: { durationMs: 10000, steps: 10 },
  courrier: { durationMs: 10000, steps: 10 },
  travaille: { durationMs: 1500, steps: 3 },
  endormi: { durationMs: 4000, steps: 8 },
  seul: null
} as const satisfies Record<AvatarFace, AvatarLoop | null>

export function motionMode(input: AvatarMotionInput): AvatarMotionMode {
  if (!input.visible || input.dndActive) return 'suspended'
  if (input.osReducedMotion) return 'reduced'
  return input.choice
}

/** `previous`: the face before the last face or mode change, null on first paint. */
export function motionPlan(input: AvatarMotionInput, previous: AvatarFace | null, face: AvatarFace): AvatarMotionPlan {
  const mode = motionMode(input)
  const changed = previous !== null && previous !== face
  const halo = FACE_GEOMETRY[face].halo && !input.dndActive
  switch (mode) {
    case 'suspended':
    case 'none':
      return { mode, loop: null, transition: 'none', transitionMs: 0, halo }
    case 'reduced':
      return { mode, loop: null, transition: changed ? 'fade' : 'none', transitionMs: changed ? MOTION_LIMITS.fadeMs : 0, halo }
    case 'transitions':
      return { mode, loop: null, transition: changed ? 'animate' : 'none', transitionMs: changed ? MOTION_LIMITS.enterMs : 0, halo }
    case 'continuous':
      return { mode, loop: FACE_LOOPS[face], transition: changed ? 'animate' : 'none', transitionMs: changed ? MOTION_LIMITS.enterMs : 0, halo }
  }
}

export function motionAttributes(plan: AvatarMotionPlan): { data: Record<string, string>; vars: Record<string, string> } {
  return {
    data: {
      'data-loop': plan.loop === null ? 'off' : 'on',
      'data-transition': plan.transition,
      'data-halo': plan.halo ? 'on' : 'off'
    },
    vars: {
      '--avatar-loop-ms': `${plan.loop?.durationMs ?? 0}ms`,
      '--avatar-loop-steps': String(plan.loop?.steps ?? 1),
      '--avatar-transition-ms': `${plan.transitionMs}ms`
    }
  }
}
