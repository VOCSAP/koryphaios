import type { AvatarFace } from '@shared/avatar-state'
import type { AvatarViewState } from '@shared/avatar-view'
import { motionAttributes, motionPlan, type AvatarMotionInput } from './motion'
import { AVATAR_SKINS, avatarFaceText, avatarThemeVars } from './skins'

export interface AvatarShellProps {
  view: AvatarViewState
  previous: AvatarFace | null
  osReducedMotion: boolean
}

export function motionInput(view: AvatarViewState, osReducedMotion: boolean): AvatarMotionInput {
  const { motion, visible, dndActive } = view.presentation
  return { choice: motion, osReducedMotion, visible, dndActive }
}

export function AvatarShell({ view, previous, osReducedMotion }: AvatarShellProps): React.JSX.Element {
  const { summary, presentation } = view
  const motion = motionAttributes(motionPlan(motionInput(view, osReducedMotion), previous, summary.face))
  const style = { ...avatarThemeVars(presentation.theme), ...motion.vars } as React.CSSProperties
  const Skin = AVATAR_SKINS.mask
  return (
    <div className="avatar-root" style={style} data-face={summary.face} data-face-key={avatarFaceText(summary).key} {...motion.data}>
      {/* Keyed by face: the one-shot enter animation restarts only on a fresh element. */}
      <Skin key={summary.face} summary={summary} />
    </div>
  )
}
