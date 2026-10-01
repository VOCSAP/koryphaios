import type { AvatarFace, AvatarSummary } from '@shared/avatar-state'
import { AVATAR_PALETTE, type AvatarPalette, type AvatarTheme } from '@shared/avatar-mask-geometry'
import { MaskSkin } from './MaskSkin'

const FACE_DOMAIN = {
  panne: true,
  reclame: true,
  perdu: true,
  courrier: true,
  travaille: true,
  endormi: true,
  seul: true
} as const satisfies Record<AvatarFace, true>

export const AVATAR_FACES = Object.keys(FACE_DOMAIN) as AvatarFace[]

export type AvatarSkinComponent = (props: { summary: AvatarSummary }) => React.JSX.Element

export const AVATAR_SKINS = {
  mask: MaskSkin
} as const satisfies Record<string, AvatarSkinComponent>

export type AvatarSkinId = keyof typeof AVATAR_SKINS

const PALETTE_VARS = {
  ink: '--avatar-ink',
  underlay: '--avatar-underlay',
  dim: '--avatar-dim',
  faded: '--avatar-faded',
  fault: '--avatar-fault',
  glow: '--avatar-glow',
  lost: '--avatar-lost',
  quota: '--avatar-quota',
  mail: '--avatar-mail',
  accent: '--avatar-accent',
  work: '--avatar-work'
} as const satisfies Record<keyof AvatarPalette, `--avatar-${string}`>

export function avatarThemeVars(theme: AvatarTheme): Record<string, string> {
  const palette: AvatarPalette = AVATAR_PALETTE[theme]
  const vars: Record<string, string> = {}
  for (const [name, cssVar] of Object.entries(PALETTE_VARS) as [keyof AvatarPalette, string][]) vars[cssVar] = palette[name]
  return vars
}
