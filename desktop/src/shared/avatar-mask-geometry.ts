import type { AvatarFace } from './avatar-state'

// Mask paths are in mask-local units (100 x 110), placed in the figure at MASK_ORIGIN.

// y starts above 0 so the Reclame halo and the underlay ring above the brow are not clipped.
export const FIGURE_VIEWBOX = { x: 0, y: -9, width: 150, height: 181 } as const
export const MASK_ORIGIN = { x: 25, y: 2 } as const
export const MASK_CENTER = { x: 50, y: 55 } as const

export const MASK_OUTLINE = 'M50 0C80 0 94 16 93 40C92 62 82 88 50 110C18 88 8 62 7 40C6 16 20 0 50 0Z'
export const MASK_NOSE = 'M50 42C49.5 52 47.5 59 46 64Q50 67 54 64'
export const MASK_CRACK = 'M60 0.5L55 11.5L62 18.5L57 27.5'
export const HALO_SCALE = 1.13

export const EYE_CENTERS = [
  { x: 32, y: 47 },
  { x: 68, y: 47 }
] as const

type Pair = readonly [string, string]

const EYES = {
  neutral: ['M18 47C22 38 42 38 46 47C42 55 22 55 18 47Z', 'M54 47C58 38 78 38 82 47C78 55 58 55 54 47Z'],
  wide: ['M19 45C19 39 25 35 32 35S45 39 45 45 39 55 32 55 19 51 19 45Z', 'M55 45C55 39 61 35 68 35S81 39 81 45 75 55 68 55 55 51 55 45Z'],
  tragic: ['M18 51C22 45 35 38 45 40C45 49 31 57 18 51Z', 'M82 51C78 45 65 38 55 40C55 49 69 57 82 51Z'],
  comic: ['M18 50C21 38 43 38 46 50C40 45 24 45 18 50Z', 'M54 50C57 38 79 38 82 50C76 45 60 45 54 50Z'],
  half: ['M19 48C24 44.5 40 44.5 45 48C40 51.5 24 51.5 19 48Z', 'M55 48C60 44.5 76 44.5 81 48C76 51.5 60 51.5 55 48Z'],
  shut: ['M19 46C24 51 40 51 45 46C40 48.6 24 48.6 19 46Z', 'M55 46C60 51 76 51 81 46C76 48.6 60 48.6 55 46Z']
} as const satisfies Record<string, Pair>

const BROWS = {
  neutral: 'M20 34Q32 29 44 33M56 33Q68 29 80 34',
  raised: 'M19 30Q32 22 44 28M56 28Q68 22 81 30',
  tragic: 'M20 36Q31 34 43 27M57 27Q69 34 80 36',
  relaxed: 'M21 37Q32 35 43 37M57 37Q68 35 79 37',
  low: 'M22 38Q32 36.5 42 38M58 38Q68 36.5 78 38',
  broken: 'M21 36H43M57 36H62M66 36H79'
} as const

const MOUTHS = {
  smile: 'M30 74C38 93 62 93 70 74C60 80 40 80 30 74Z',
  tragic: 'M30 91C36 72 64 72 70 91C60 84 40 84 30 91Z',
  cry: 'M50 70C55.5 70 59 75 59 81S55.5 92 50 92 41 87 41 81 44.5 70 50 70Z',
  neutral: 'M36 79C42 75 58 75 64 79C58 86 42 86 36 79Z',
  crooked: 'M36 84C44 80 56 78 64 76C57 83 44 86 36 84Z',
  slit: 'M40 81C46 79 54 79 60 81C54 83.6 46 83.6 40 81Z',
  slitLow: 'M41 83C46 81.4 54 81.4 59 83C54 85 46 85 41 83Z'
} as const

export interface FaceGeometry {
  /** Eye openings, cut through the plate. */
  eyes: Pair
  brows: string
  /** Mouth opening, cut through the plate: never a bare line. */
  mouth: string
  /** Offset of the gaze dot from each eye centre; absent = empty openings. */
  gaze?: { dx: number; dy: number }
  crack: boolean
  halo: boolean
  /** Degrees, around MASK_CENTER. */
  tilt: number
}

export const FACE_GEOMETRY = {
  panne: { eyes: EYES.neutral, brows: BROWS.broken, mouth: MOUTHS.crooked, crack: true, halo: false, tilt: 0 },
  reclame: { eyes: EYES.wide, brows: BROWS.raised, mouth: MOUTHS.cry, crack: false, halo: true, tilt: 0 },
  perdu: { eyes: EYES.tragic, brows: BROWS.tragic, mouth: MOUTHS.tragic, crack: false, halo: false, tilt: 0 },
  courrier: { eyes: EYES.neutral, brows: BROWS.neutral, mouth: MOUTHS.neutral, gaze: { dx: 5, dy: -3 }, crack: false, halo: false, tilt: 0 },
  travaille: { eyes: EYES.comic, brows: BROWS.raised, mouth: MOUTHS.smile, gaze: { dx: -5, dy: -1.5 }, crack: false, halo: false, tilt: 0 },
  endormi: { eyes: EYES.half, brows: BROWS.relaxed, mouth: MOUTHS.slit, crack: false, halo: false, tilt: 0 },
  seul: { eyes: EYES.shut, brows: BROWS.low, mouth: MOUTHS.slitLow, crack: false, halo: false, tilt: -12 }
} as const satisfies Record<AvatarFace, FaceGeometry>

// The stage is a floor, not a necklace: wider than the mask and well below
// the chin, so an arc of small marks under one large shape does not read as
// a paw print turned upside down.
export const STAGE = { p0: { x: 0, y: 150 }, p1: { x: 75, y: 178 }, p2: { x: 150, y: 150 } } as const
export const PILL = { width: 7, height: 13, lift: 2 } as const

export function stagePoint(t: number): { x: number; y: number } {
  const a = (1 - t) * (1 - t)
  const b = 2 * t * (1 - t)
  const c = t * t
  return {
    x: a * STAGE.p0.x + b * STAGE.p1.x + c * STAGE.p2.x,
    y: a * STAGE.p0.y + b * STAGE.p1.y + c * STAGE.p2.y
  }
}

/** Curve parameters of `count` evenly spread slots on the stage. */
export function stageSlots(count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0.5]
  const lo = count >= 6 ? 0.06 : 0.2
  const hi = 1 - lo
  return Array.from({ length: count }, (_, i) => lo + (i * (hi - lo)) / (count - 1))
}

/** Glyph markers shrink with the slot spacing down to `min`; past `capacity`
 * slots the last one becomes a "+N" counter. */
export const STAGE_MARKER = { max: 18, min: 10, gap: 2, capacity: 12 } as const

export function stageMarkerSize(slotCount: number): number {
  const slots = stageSlots(slotCount)
  if (slots.length < 2) return STAGE_MARKER.max
  const spacing = stagePoint(slots[1]!).x - stagePoint(slots[0]!).x
  return Math.max(STAGE_MARKER.min, Math.min(STAGE_MARKER.max, spacing - STAGE_MARKER.gap))
}

export const BADGE ={ cx: 128, r: 11, knockout: 13.5, rows: [16, 42] } as const

export type AvatarTheme = 'dark' | 'light'

export interface AvatarPalette {
  /** Strokes of an awake mask. */
  ink: string
  /** Ring drawn under every stroke so it reads on any desktop. */
  underlay: string
  /** Endormi mask, stage line, dim pills. */
  dim: string
  /** Seul mask: one step more faded than dim. */
  faded: string
  /** Panne crack and torchOut pills. */
  fault: string
  /** Reclame halo and waiting badge. */
  glow: string
  /** Lost deck (exited) marker. */
  lost: string
  /** Rate-limited deck (quota) marker. */
  quota: string
  /** Unread badge. */
  mail: string
  /** Awake Tray icon. */
  accent: string
  /** Working pills. */
  work: string
}

export const AVATAR_PALETTE = {
  dark: {
    ink: '#ece8dc', underlay: '#202020', dim: '#9a9a9a', faded: '#6e6e6e', fault: '#d04545',
    glow: '#d4a24a', lost: '#b678ff', quota: '#e0b341', mail: '#4488ff', accent: '#4488ff', work: '#3ec46d'
  },
  light: {
    ink: '#2a2a2a', underlay: '#f3f3f3', dim: '#6a6a6a', faded: '#8a8a8a', fault: '#a03030',
    glow: '#a87b0a', lost: '#7c3aed', quota: '#9a6700', mail: '#2563eb', accent: '#2563eb', work: '#1f8a4c'
  }
} as const satisfies Record<AvatarTheme, AvatarPalette>

// Stroke width and badge radii are in Tray units (22 grid), not mask units.
export const TRAY_GEOMETRY = {
  viewBox: 22,
  scale: 0.19,
  offset: { x: 1.5, y: 0.55 },
  strokeWidth: 2,
  eyesOpen: 'M23 47C26 41 38 41 41 47C38 52 26 52 23 47ZM59 47C62 41 74 41 77 47C74 52 62 52 59 47Z',
  eyesShut: 'M22 44Q32 53 42 44M58 44Q68 53 78 44',
  mouthAwake: 'M32 74C40 92 60 92 68 74C58 80 42 80 32 74Z',
  mouthAsleep: 'M42 81H58',
  crack: 'M60 0.5L54 14.5L62 24.5',
  badge: { cx: 18, cy: 3.9, r: 3.4, knockout: 4.9 }
} as const
