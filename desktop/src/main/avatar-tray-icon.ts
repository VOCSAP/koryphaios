import { join } from 'node:path'
import type { AvatarFace } from '../shared/avatar-state'

export const AVATAR_TRAY_ICON_DIRNAME = 'avatar-tray'

export type AvatarTrayVariant = 'endormi' | 'eveille' | 'reclame' | 'panne'

// Seven faces do not read apart at 16 px: the icon keeps the mask's sleep, its
// waking, the gold point of a claim and the outage; the tooltip names the face.
const VARIANT_BY_FACE: Record<AvatarFace, AvatarTrayVariant> = {
  panne: 'panne',
  reclame: 'reclame',
  perdu: 'eveille',
  courrier: 'eveille',
  travaille: 'eveille',
  endormi: 'endormi',
  seul: 'endormi'
}

export const AVATAR_TRAY_FACES = Object.keys(VARIANT_BY_FACE) as AvatarFace[]

export const AVATAR_TRAY_VARIANTS: readonly AvatarTrayVariant[] = [...new Set(Object.values(VARIANT_BY_FACE))]

export function avatarTrayVariant(face: AvatarFace): AvatarTrayVariant {
  return VARIANT_BY_FACE[face]
}

export function avatarTrayIconDir(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return isPackaged ? join(resourcesPath, AVATAR_TRAY_ICON_DIRNAME) : join(appPath, 'resources', AVATAR_TRAY_ICON_DIRNAME)
}

function iconBasename(variant: AvatarTrayVariant): string {
  return `avatar-${variant}.png`
}

// PNG, not the SVG glyph set: nativeImage decodes PNG/JPEG only. The base file
// is the 16 px tier; nativeImage picks the @2x sibling up by name at 200% DPI.
export function avatarTrayIconPath(dir: string, variant: AvatarTrayVariant): string {
  return join(dir, iconBasename(variant))
}

export function avatarTrayIconFiles(): string[] {
  return AVATAR_TRAY_VARIANTS.flatMap((variant) => {
    const base = iconBasename(variant)
    return [base, base.replace(/\.png$/, '@2x.png')]
  })
}
