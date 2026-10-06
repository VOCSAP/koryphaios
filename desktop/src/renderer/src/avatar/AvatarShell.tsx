import type { AvatarFace } from '@shared/avatar-state'
import type { AvatarViewState } from '@shared/avatar-view'
import { motionAttributes, motionPlan, type AvatarMotionInput } from './motion'
import type { AvatarMoveMode } from './pointer-gesture'
import { AVATAR_SKINS, avatarThemeVars } from './skins'

export interface AvatarShellProps {
  view: AvatarViewState
  previous: AvatarFace | null
  osReducedMotion: boolean
  move?: AvatarMoveMode
}

export function motionInput(view: AvatarViewState, osReducedMotion: boolean): AvatarMotionInput {
  const { motion, visible, dndActive } = view.presentation
  return { choice: motion, osReducedMotion, visible, dndActive }
}

export function AvatarShell({ view, previous, osReducedMotion, move }: AvatarShellProps): React.JSX.Element {
  const { summary, presentation } = view
  const motion = motionAttributes(motionPlan(motionInput(view, osReducedMotion), previous, summary.face))
  const style = { ...avatarThemeVars(presentation.theme), ...motion.vars } as React.CSSProperties
  const Skin = AVATAR_SKINS.mask
  return (
    // role img: aria-label is not announced on a generic div, and the character is one picture.
    <div
      className="avatar-root"
      role="img"
      aria-label={summary.faceCopy.ariaLabel}
      style={style}
      data-face={summary.face}
      data-move={move}
      data-frame={presentation.frame}
      {...motion.data}
    >
      <div className="avatar-frame">
        {/* Keyed by face: the one-shot enter animation restarts only on a fresh element. */}
        <Skin key={summary.face} summary={summary} />
      </div>
    </div>
  )
}
