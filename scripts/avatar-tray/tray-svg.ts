import type { AvatarTrayTaskbar, AvatarTrayVariant } from '../../desktop/src/main/avatar-tray-icon.ts'
import { AVATAR_PALETTE, MASK_OUTLINE, TRAY_GEOMETRY } from '../../desktop/src/shared/avatar-mask-geometry.ts'

export interface AvatarTrayInk {
  stroke: string
  badge: string | null
}

export function avatarTrayInk(variant: AvatarTrayVariant, taskbar: AvatarTrayTaskbar): AvatarTrayInk {
  const p = AVATAR_PALETTE[taskbar]
  switch (variant) {
    case 'endormi': return { stroke: p.dim, badge: null }
    case 'eveille': return { stroke: p.accent, badge: null }
    case 'reclame': return { stroke: p.accent, badge: p.glow }
    case 'panne': return { stroke: p.dim, badge: p.fault }
  }
}

export function avatarTraySvg(variant: AvatarTrayVariant, taskbar: AvatarTrayTaskbar): string {
  const g = TRAY_GEOMETRY
  const ink = avatarTrayInk(variant, taskbar)
  const awake = variant === 'eveille' || variant === 'reclame'
  const eyes = awake ? `<path d="${g.eyesOpen}" fill="${ink.stroke}"/>` : `<path d="${g.eyesShut}"/>`
  const mouth = awake ? `<path d="${g.mouthAwake}" fill="${ink.stroke}"/>` : `<path d="${g.mouthAsleep}"/>`
  const crack = variant === 'panne' ? `<path d="${g.crack}"/>` : ''
  const b = g.badge
  const knockout = ink.badge === null ? '' : `<mask id="k"><rect x="0" y="0" width="${g.viewBox}" height="${g.viewBox}" fill="#fff"/><circle cx="${b.cx}" cy="${b.cy}" r="${b.knockout}" fill="#000"/></mask>`
  const maskAttr = ink.badge === null ? '' : ' mask="url(#k)"'
  const badge = ink.badge === null ? '' : `<circle cx="${b.cx}" cy="${b.cy}" r="${b.r}" fill="${ink.badge}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.viewBox} ${g.viewBox}" width="${g.viewBox}" height="${g.viewBox}">${knockout}`
    + `<g${maskAttr}><g transform="translate(${g.offset.x} ${g.offset.y}) scale(${g.scale})" fill="none" stroke="${ink.stroke}" stroke-width="${g.strokeWidth / g.scale}" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="${MASK_OUTLINE}"/>${eyes}${mouth}${crack}</g></g>${badge}</svg>\n`
}
