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

// The taskbar the icon is drawn on, not the Deck theme: the two differ when
// Windows runs light apps with a dark taskbar, or the reverse.
export type AvatarTrayTaskbar = 'dark' | 'light'

export const AVATAR_TRAY_TASKBARS: readonly AvatarTrayTaskbar[] = ['dark', 'light']

// Only win32 and darwin report the taskbar shade; elsewhere the dark set applies.
export function avatarTrayTaskbar(platform: string, systemIntegratedUiDark: boolean | undefined): AvatarTrayTaskbar {
  if (platform !== 'win32' && platform !== 'darwin') return 'dark'
  return systemIntegratedUiDark === false ? 'light' : 'dark'
}

function iconBasename(variant: AvatarTrayVariant, taskbar: AvatarTrayTaskbar): string {
  return taskbar === 'light' ? `avatar-${variant}-light.png` : `avatar-${variant}.png`
}

// PNG, not the SVG glyph set: nativeImage decodes PNG/JPEG only. The base file
// is the 16 px tier; nativeImage picks the @2x sibling up by name at 200% DPI.
export function avatarTrayIconPath(dir: string, variant: AvatarTrayVariant, taskbar: AvatarTrayTaskbar): string {
  return join(dir, iconBasename(variant, taskbar))
}

export function avatarTrayIconFiles(): string[] {
  return AVATAR_TRAY_TASKBARS.flatMap((taskbar) => AVATAR_TRAY_VARIANTS.flatMap((variant) => {
    const base = iconBasename(variant, taskbar)
    return [base, base.replace(/\.png$/, '@2x.png')]
  }))
}
