// Generates the Avatar Tray PNG set (16 px + @2x) from four inline SVG faces:
// nativeImage decodes no SVG, so the tray ships rasters. Usage:
//   MAGICK_BIN=<path to ImageMagick 7 magick executable> bun scripts/avatar-tray/make.ts [outDir]
// Output is byte-stable for a given ImageMagick build; another build may
// rasterize differently, so regenerate every file with one binary.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  AVATAR_TRAY_TASKBARS,
  AVATAR_TRAY_VARIANTS,
  avatarTrayIconPath,
  type AvatarTrayTaskbar,
  type AvatarTrayVariant
} from '../../desktop/src/main/avatar-tray-icon.ts'

const MAGICK = process.env.MAGICK_BIN
if (MAGICK === undefined || MAGICK === '') {
  console.error('MAGICK_BIN is not set: point it at the ImageMagick 7 `magick` executable.')
  process.exit(1)
}
const OUT = process.argv[2] ?? join(import.meta.dir, '..', '..', 'desktop', 'resources', 'avatar-tray')

interface Palette { dim: string; accent: string; glow: string; banner: string }

// Token values of the matching Deck theme (--fg-dim, --accent, --glow, banner
// red), except two badges retuned to clear 3:1 on their taskbar (#f3f3f3 light,
// #202020 dark): the light gold is --glow's hue darkened, the dark red the
// banner red lightened.
const PALETTES: Record<AvatarTrayTaskbar, Palette> = {
  dark: { dim: '#9a9a9a', accent: '#4488ff', glow: '#d4a24a', banner: '#d04545' },
  light: { dim: '#6a6a6a', accent: '#2563eb', glow: '#a87b0a', banner: '#a03030' }
}

// 2.0, not 1.6: at 16 px a 1.6 stroke is ~1.2 px wide and leaves no pixel
// above alpha 0.91, which drags every face below its colour's contrast.
const STROKE = 2

const FACE = 'M6.5 4h11c.8 0 1.5.7 1.5 1.5V12c0 4.7-3.1 8-7 8s-7-3.3-7-8V5.5C5 4.7 5.7 4 6.5 4Z'
const EYES_OPEN = '<circle cx="9.4" cy="10" r="1.35" fill="C" stroke="none"/><circle cx="14.6" cy="10" r="1.35" fill="C" stroke="none"/>'
const EYES_SHUT = '<path d="M7.9 9.8c.7 1 2.3 1 3 0M13.1 9.8c.7 1 2.3 1 3 0"/>'
const MOUTH_SMILE = '<path d="M9 14.2c.9 1.9 5.1 1.9 6 0"/>'
const MOUTH_FLAT = '<path d="M10.4 15.4h3.2"/>'
const CRACK = '<path d="M11.6 4.2 13 6.4l-1.8 1.5"/>'
const BADGE = { cx: 19.4, cy: 4.6, r: 3.4, knockout: 4.9 }

interface Variant { color: string; parts: string; badge?: string }

function variant(name: AvatarTrayVariant, p: Palette): Variant {
  switch (name) {
    case 'endormi': return { color: p.dim, parts: EYES_SHUT + MOUTH_FLAT }
    case 'eveille': return { color: p.accent, parts: EYES_OPEN + MOUTH_SMILE }
    case 'reclame': return { color: p.accent, parts: EYES_OPEN + MOUTH_SMILE, badge: p.glow }
    case 'panne': return { color: p.dim, parts: EYES_SHUT + MOUTH_FLAT + CRACK, badge: p.banner }
  }
}

function svg(v: Variant): string {
  const parts = v.parts.replaceAll('"C"', `"${v.color}"`)
  const knockout = v.badge === undefined ? '' : `<mask id="k"><rect x="0" y="0" width="24" height="24" fill="#fff"/><circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.knockout}" fill="#000"/></mask>`
  const maskAttr = v.badge === undefined ? '' : ' mask="url(#k)"'
  const badge = v.badge === undefined ? '' : `<circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.r}" fill="${v.badge}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2.5 1 21 21" width="21" height="21">${knockout}<g fill="none" stroke="${v.color}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"${maskAttr}><path d="${FACE}"/>${parts}</g>${badge}</svg>\n`
}

let written = 0
for (const taskbar of AVATAR_TRAY_TASKBARS) {
  for (const name of AVATAR_TRAY_VARIANTS) {
    const base = avatarTrayIconPath(OUT, name, taskbar)
    for (const [size, out] of [[16, base], [32, base.replace(/\.png$/, '@2x.png')]] as const) {
      const r = spawnSync(MAGICK, ['-background', 'none', '-density', '1536', 'svg:-', '-resize', `${size}x${size}`, '-strip', `PNG32:${out}`], { input: svg(variant(name, PALETTES[taskbar])), encoding: 'utf-8' })
      if (r.error !== undefined) throw new Error(`magick could not start (${MAGICK}): ${r.error.message}`)
      if (r.status !== 0) throw new Error(`magick failed for ${out}: ${r.stderr}`)
      written += 1
    }
  }
}
console.log('ok', written, 'files ->', OUT)
