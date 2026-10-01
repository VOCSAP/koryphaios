// Shared geometry of the A2 board: one mask source per silhouette, two levels
// of detail (character figure, Tray icon). Mask-local units: 100 x 110.
'use strict'

const FG = '#ece8dc'
const BG = '#808080'

const SILS = {
  A: {
    key: 'A', name: 'Comédie', note: 'tempes pincées, pommettes saillantes',
    path: 'M50 2C78 2 96 12 97 32C98 44 92 50 94 60C97 82 78 106 50 108C22 106 3 82 6 60C8 50 2 44 3 32C4 12 22 2 50 2Z',
    crackY: 2.5, ribbons: ''
  },
  B: {
    key: 'B', name: 'Tragédie', note: 'front haut (onkos), menton en pointe',
    path: 'M50 0C80 0 94 16 93 40C92 62 82 88 50 110C18 88 8 62 7 40C6 16 20 0 50 0Z',
    crackY: 0.5, ribbons: ''
  },
  C: {
    key: 'C', name: 'Rubans', note: 'ovale noué de deux rubans aux tempes',
    path: 'M50 6C78 6 93 24 93 54C93 86 74 106 50 106C26 106 7 86 7 54C7 24 22 6 50 6Z',
    crackY: 6.5,
    ribbons: 'M8 38C-2 38-9 46-7 58M8 44C0 48-3 58 1 68M92 38C102 38 109 46 107 58M92 44C100 48 103 58 99 68'
  }
}

const FACES = ['panne', 'reclame', 'perdu', 'courrier', 'travaille', 'endormi', 'seul']
const LABEL = { panne: 'Panne', reclame: 'Réclame', perdu: 'Perdu', courrier: 'Courrier', travaille: 'Travaille', endormi: 'Endormi', seul: 'Seul' }

// Continuous-mode motion per face, and its cost class against the probe:
// a 60 fps loop recomposites the whole transparent window (~15 % of a core),
// a rare burst or a low-fps step loop costs a fraction of it.
const MOTION = {
  panne: { text: 'aucune boucle ; la fissure se trace à l’entrée (400 ms)', cost: 'léger' },
  reclame: { text: 'halo qui pulse en 4 pas/s ; sourcils levés 600 ms toutes les ~8 s', cost: 'léger' },
  perdu: { text: 'regard qui retombe 500 ms toutes les ~10 s', cost: 'léger' },
  courrier: { text: 'coup d’œil vers le badge 400 ms toutes les ~10 s', cost: 'léger' },
  travaille: { text: 'saccades des yeux (120 ms / 1,5 s) ; pastilles actives en 4 pas/s', cost: 'léger' },
  endormi: { text: 'respiration lente du masque (4 s), seule boucle continue', cost: 'lourd si 60 fps' },
  seul: { text: 'aucune (le brief exclut la respiration)', cost: 'nul' }
}

const HOLE_L = 'M20 46Q32 37 44 46Q32 54 20 46Z'
const HOLE_R = 'M56 46Q68 37 80 46Q68 54 56 46Z'
const NOSE = 'M50 42C49.5 52 47.5 59 46 64Q50 67 54 64'

const BROWS = {
  neutral: 'M20 34Q32 29 44 33M56 33Q68 29 80 34',
  raised: 'M19 30Q32 22 44 28M56 28Q68 22 81 30',
  tragic: 'M20 36Q31 34 43 27M57 27Q69 34 80 36',
  focused: 'M20 33Q32 31 44 35M56 35Q68 31 80 33',
  relaxed: 'M21 37Q32 35 43 37M57 37Q68 35 79 37',
  low: 'M22 38Q32 36.5 42 38M58 38Q68 36.5 78 38',
  broken: 'M21 36H43M57 36H62M66 36H79'
}

const MOUTHS = {
  smile: 'M34 76Q50 93 66 76Q50 84 34 76Z',
  call: 'M50 72.5C55 72.5 58 76 58 80.5S55 88.5 50 88.5 42 85 42 80.5 45 72.5 50 72.5Z',
  neutral: 'M36 80Q50 86 64 80Q50 75 36 80Z',
  tragic: 'M34 87Q50 70 66 87Q50 79 34 87Z',
  slit: 'M38 82Q50 80.5 62 78Q50 83.5 38 82Z',
  small: 'M50 77.5C53.5 77.5 55 79 55 81S53.5 84.5 50 84.5 45 83 45 81 46.5 77.5 50 77.5Z',
  shut: 'M43 82Q50 84 57 82Q50 80.5 43 82Z'
}

// eyes: open (pupils, offset dx/dy, radius), half (lid at mid-hole), closed, empty.
const SPEC = {
  panne: { brows: 'broken', eyes: { kind: 'empty' }, mouth: 'slit', crack: true, pills: ['work', 'torch', 'work', 'idle'] },
  reclame: { brows: 'raised', eyes: { kind: 'open', dx: 0, dy: 0, r: 4.8 }, mouth: 'call', halo: true, badge: 'count', pills: ['work', 'idle', 'work', 'idle'] },
  perdu: { brows: 'tragic', eyes: { kind: 'open', dx: 0, dy: 2, r: 4 }, mouth: 'tragic', pills: ['idle', 'warn', 'work', 'idle'] },
  courrier: { brows: 'neutral', eyes: { kind: 'open', dx: 3, dy: -1.5, r: 4 }, mouth: 'neutral', badge: 'mail', pills: ['idle', 'work', 'idle', 'idle'] },
  travaille: { brows: 'focused', eyes: { kind: 'open', dx: -4, dy: 2.5, r: 4 }, mouth: 'smile', pills: ['work', 'work', 'idle', 'work'] },
  endormi: { brows: 'relaxed', eyes: { kind: 'half' }, mouth: 'small', pills: ['dim', 'dim', 'dim', 'dim'] },
  seul: { brows: 'low', eyes: { kind: 'closed' }, mouth: 'shut', tilt: -12, pills: [] }
}

const CADUCEUS = '<path d="M12 6.5v13.5"/><circle cx="12" cy="4.4" r="1.3"/><path d="M11.2 7.2C9.8 5.8 7.8 5.9 6.8 7.4M12.8 7.2c1.4-1.4 3.4-1.3 4.4.2"/><path d="M8.3 9.5c0 1.8 7.4 2.4 7.4 4.3 0 1.9-7.4 2.5-7.4 4.3"/><path d="M15.7 9.5c0 1.8-7.4 2.4-7.4 4.3 0 1.9 7.4 2.5 7.4 4.3"/>'
const TORCH_OUT = '<path d="M8 10h8l-1.1 2.4c-.5 1-1.4 1.6-2.9 1.6s-2.4-.6-2.9-1.6L8 10Z"/><path d="M12 14v5.5M9.5 19.5h5"/><path d="M10.5 7.5c.5-.7 2.5-.7 3-1.5"/>'
const WARNING = '<path d="M10.7 5.2 3.6 17.4c-.6 1 .2 2.1 1.3 2.1h14.2c1.1 0 1.9-1.1 1.3-2.1L13.3 5.2c-.6-1-2-1-2.6 0Z"/><path d="M12 9.5v4"/><circle cx="12" cy="16.4" r="0.9" fill="currentColor"/>'

// Orchestra: the stage edge, a shallow arc WIDER than the mask, open upward.
const ARC = { p0: [6, 124], p1: [70, 164], p2: [134, 124] }
function arcPoint(t) {
  const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t
  return [a * ARC.p0[0] + b * ARC.p1[0] + c * ARC.p2[0], a * ARC.p0[1] + b * ARC.p1[1] + c * ARC.p2[1]]
}
function arcTs(n) {
  if (n === 1) return [0.5]
  const lo = n >= 6 ? 0.1 : 0.2, hi = 1 - lo
  return Array.from({ length: n }, (_, i) => lo + (i * (hi - lo)) / (n - 1))
}

function glyphAt(inner, cx, cy, size, sw) {
  const s = size / 24
  return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${s})" fill="none" stroke="${FG}" stroke-width="${sw / s}" stroke-linecap="round" stroke-linejoin="round" style="color:${FG}">${inner}</g>`
}

function pill(state, t) {
  const [x, y] = arcPoint(t)
  const top = y - 15
  if (state === 'torch') return glyphAt(TORCH_OUT, x, y - 9, 17, 2)
  if (state === 'warn') return glyphAt(WARNING, x, y - 9, 16, 2)
  const r = `x="${x - 3.5}" y="${top}" width="7" height="13" rx="3.5"`
  if (state === 'work') return `<rect ${r} fill="${FG}"/>`
  if (state === 'dim') return `<rect ${r} fill="none" stroke="${FG}" stroke-width="2" opacity="0.3"/>`
  return `<rect ${r} fill="none" stroke="${FG}" stroke-width="2"/>`
}

function orchestra(pills, empty) {
  const d = `M${ARC.p0}Q${ARC.p1} ${ARC.p2}`
  const arc = empty
    ? `<path d="${d}" fill="none" stroke="${FG}" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round" opacity="0.4"/>`
    : `<path d="${d}" fill="none" stroke="${FG}" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`
  const ts = arcTs(pills.length)
  return arc + pills.map((s, i) => pill(s, ts[i])).join('')
}

function eyes(spec, uid) {
  const clips = `<clipPath id="${uid}hl"><path d="${HOLE_L}"/></clipPath><clipPath id="${uid}hr"><path d="${HOLE_R}"/></clipPath><clipPath id="${uid}lid"><rect x="0" y="46" width="100" height="20"/></clipPath>`
  const holes = `<path d="${HOLE_L}"/><path d="${HOLE_R}"/>`
  const e = spec.eyes
  let inner = ''
  if (e.kind === 'open') {
    inner = `<g clip-path="url(#${uid}hl)"><circle cx="${32 + e.dx}" cy="${46 + e.dy}" r="${e.r}" fill="${FG}" stroke="none"/></g><g clip-path="url(#${uid}hr)"><circle cx="${68 + e.dx}" cy="${46 + e.dy}" r="${e.r}" fill="${FG}" stroke="none"/></g>`
  } else if (e.kind === 'half') {
    inner = `<g clip-path="url(#${uid}lid)"><g clip-path="url(#${uid}hl)"><circle cx="32" cy="49" r="4" fill="${FG}" stroke="none"/></g><g clip-path="url(#${uid}hr)"><circle cx="68" cy="49" r="4" fill="${FG}" stroke="none"/></g></g><path d="M21 46H43M57 46H79"/>`
  } else if (e.kind === 'closed') {
    inner = '<path d="M22 46.5Q32 51.5 42 46.5M58 46.5Q68 51.5 78 46.5"/>'
  }
  return { defs: clips, body: holes + inner }
}

function badge(kind, cx = 118, cy = 18) {
  const knock = `<circle cx="${cx}" cy="${cy}" r="14" fill="${BG}"/>`
  if (kind === 'count') {
    return `${knock}<circle cx="${cx}" cy="${cy}" r="11" fill="${FG}"/><text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-weight="700" font-size="14" fill="${BG}">2</text>`
  }
  if (kind === 'mail') {
    return `${knock}<circle cx="${cx}" cy="${cy}" r="11" fill="${FG}"/>${glyphAt(CADUCEUS, cx, cy, 17, 1.8).replace(`stroke="${FG}"`, `stroke="${BG}"`)}<circle cx="${cx + 11}" cy="${cy + 10}" r="7" fill="${BG}"/><circle cx="${cx + 11}" cy="${cy + 10}" r="5.5" fill="${FG}"/><text x="${cx + 11}" y="${cy + 13.3}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-weight="700" font-size="9" fill="${BG}">3</text>`
  }
  return ''
}

let seq = 0
function figureSvg(silKey, face, width = 160) {
  const sil = SILS[silKey], spec = SPEC[face], uid = `f${++seq}`
  const ey = eyes(spec, uid)
  const tilt = spec.tilt ? ` rotate(${spec.tilt} 50 55)` : ''
  const halo = spec.halo ? `<path d="${sil.path}" transform="translate(50 55) scale(1.13) translate(-50 -55)" fill="none" stroke="${FG}" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round" opacity="0.8"/>` : ''
  const crack = spec.crack ? `<path d="M60 ${sil.crackY}L55 ${sil.crackY + 11}L62 ${sil.crackY + 18}L57 ${sil.crackY + 27}"/>` : ''
  const ribbons = sil.ribbons ? `<path d="${sil.ribbons}"/>` : ''
  const h = (width * 150) / 140
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 150" width="${width}" height="${h}"><defs>${ey.defs}</defs>`
    + orchestra(spec.pills, spec.pills.length === 0)
    + `<g transform="translate(20 2)${tilt}">${halo}<g fill="none" stroke="${FG}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">`
    + `${ribbons}<path d="${sil.path}"/><path d="${BROWS[spec.brows]}"/>${ey.body}<path d="${NOSE}" stroke-width="2.5"/><path d="${MOUTHS[spec.mouth]}"/>${crack}</g></g>`
    + (spec.badge ? badge(spec.badge) : '')
    + '</svg>'
}

// Rule 8 check: flat fill, no features. 'control' is the paw-print pattern
// (discs huddled close under the shape, no stage line) shown as the thing to avoid.
function rule8Svg(silKey, n, width = 160) {
  const sil = SILS[silKey]
  const h = (width * 150) / 140
  const mask = `<g transform="translate(20 2)"><path d="${sil.path}" fill="${FG}"/>${sil.ribbons ? `<path d="${sil.ribbons}" fill="none" stroke="${FG}" stroke-width="3.5" stroke-linecap="round"/>` : ''}</g>`
  let marks
  if (n === 'control') {
    marks = [[40, 128], [58, 138], [82, 138], [100, 128]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8" fill="${FG}"/>`).join('')
  } else {
    const d = `M${ARC.p0}Q${ARC.p1} ${ARC.p2}`
    marks = `<path d="${d}" fill="none" stroke="${FG}" stroke-width="2" stroke-linecap="round"/>`
      + arcTs(n).map((t) => { const [x, y] = arcPoint(t); return `<rect x="${x - 3.5}" y="${y - 15}" width="7" height="13" rx="3.5" fill="${FG}"/>` }).join('')
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 150" width="${width}" height="${h}">${marks}${mask}</svg>`
}

// Tray level of detail: silhouette, eyes as dots or lids, one mouth mark, badge.
// Same 2.0-unit stroke and badge/knockout radii as the shipping generator.
const TRAY_PALETTES = {
  dark: { dim: '#9a9a9a', accent: '#4488ff', glow: '#d4a24a', banner: '#d04545' },
  light: { dim: '#6a6a6a', accent: '#2563eb', glow: '#a87b0a', banner: '#a03030' }
}
const TRAY_VARIANTS = ['endormi', 'eveille', 'reclame', 'panne']

function traySvg(silKey, variant, taskbar) {
  const sil = SILS[silKey], p = TRAY_PALETTES[taskbar]
  const s = 0.19
  const awake = variant === 'eveille' || variant === 'reclame'
  const color = awake ? p.accent : p.dim
  const badgeColor = variant === 'reclame' ? p.glow : variant === 'panne' ? p.banner : undefined
  const eyesPart = awake
    ? `<circle cx="32" cy="46" r="${1.4 / s}" fill="${color}" stroke="none"/><circle cx="68" cy="46" r="${1.4 / s}" fill="${color}" stroke="none"/>`
    : '<path d="M22 44Q32 53 42 44M58 44Q68 53 78 44"/>'
  const mouth = awake ? '<path d="M36 76Q50 90 64 76"/>' : '<path d="M42 81H58"/>'
  const crack = variant === 'panne' ? `<path d="M60 ${sil.crackY}L54 ${sil.crackY + 14}L62 ${sil.crackY + 24}"/>` : ''
  const B = { cx: 18, cy: 3.9, r: 3.4, knockout: 4.9 }
  const knock = badgeColor ? `<mask id="k"><rect x="0" y="0" width="22" height="22" fill="#fff"/><circle cx="${B.cx}" cy="${B.cy}" r="${B.knockout}" fill="#000"/></mask>` : ''
  const maskAttr = badgeColor ? ' mask="url(#k)"' : ''
  const badgeEl = badgeColor ? `<circle cx="${B.cx}" cy="${B.cy}" r="${B.r}" fill="${badgeColor}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="22" height="22">${knock}<g${maskAttr}><g transform="translate(1.5 0.55) scale(${s})" fill="none" stroke="${color}" stroke-width="${2 / s}" stroke-linecap="round" stroke-linejoin="round"><path d="${sil.path}"/>${eyesPart}${mouth}${crack}</g></g>${badgeEl}</svg>\n`
}

// ---------- B' : contour B as a theatre mask. A faint plate with the eyes and
// mouth CUT THROUGH it (the background shows in every opening), expression
// carried by the shape of each opening and by heavy brows.
const PRIME_EYES = {
  neutral: ['M18 47C22 38 42 38 46 47C42 55 22 55 18 47Z', 'M54 47C58 38 78 38 82 47C78 55 58 55 54 47Z'],
  wide: ['M19 45C19 39 25 35 32 35S45 39 45 45 39 55 32 55 19 51 19 45Z', 'M55 45C55 39 61 35 68 35S81 39 81 45 75 55 68 55 55 51 55 45Z'],
  tragic: ['M18 51C22 45 35 38 45 40C45 49 31 57 18 51Z', 'M82 51C78 45 65 38 55 40C55 49 69 57 82 51Z'],
  comic: ['M18 50C21 38 43 38 46 50C40 45 24 45 18 50Z', 'M54 50C57 38 79 38 82 50C76 45 60 45 54 50Z'],
  half: ['M19 48C24 44.5 40 44.5 45 48C40 51.5 24 51.5 19 48Z', 'M55 48C60 44.5 76 44.5 81 48C76 51.5 60 51.5 55 48Z'],
  shut: ['M19 46C24 51 40 51 45 46C40 48.6 24 48.6 19 46Z', 'M55 46C60 51 76 51 81 46C76 48.6 60 48.6 55 46Z']
}
const PRIME_MOUTHS = {
  smile: 'M30 74C38 93 62 93 70 74C60 80 40 80 30 74Z',
  tragic: 'M30 91C36 72 64 72 70 91C60 84 40 84 30 91Z',
  cry: 'M50 70C55.5 70 59 75 59 81S55.5 92 50 92 41 87 41 81 44.5 70 50 70Z',
  neutral: 'M36 79C42 75 58 75 64 79C58 86 42 86 36 79Z',
  crooked: 'M36 84C44 80 56 78 64 76C57 83 44 86 36 84Z',
  slit: 'M40 81C46 79 54 79 60 81C54 83.6 46 83.6 40 81Z',
  slitLow: 'M41 83C46 81.4 54 81.4 59 83C54 85 46 85 41 83Z'
}
const PRIME_SPEC = {
  panne: { brows: 'broken', eyes: 'neutral', mouth: 'crooked', crack: true, pills: ['work', 'torch', 'work', 'idle'] },
  reclame: { brows: 'raised', eyes: 'wide', mouth: 'cry', halo: true, badge: 'count', pills: ['work', 'idle', 'work', 'idle'] },
  perdu: { brows: 'tragic', eyes: 'tragic', mouth: 'tragic', pills: ['idle', 'warn', 'work', 'idle'] },
  courrier: { brows: 'neutral', eyes: 'neutral', gaze: [5, -3], mouth: 'neutral', badge: 'mail', pills: ['idle', 'work', 'idle', 'idle'] },
  travaille: { brows: 'raised', eyes: 'comic', gaze: [-5, -1.5], mouth: 'smile', pills: ['work', 'work', 'idle', 'work'] },
  endormi: { brows: 'relaxed', eyes: 'half', mouth: 'slit', pills: ['dim', 'dim', 'dim', 'dim'] },
  seul: { brows: 'low', eyes: 'shut', mouth: 'slitLow', tilt: -12, pills: [] }
}
// Stage lowered and widened: a clear gap under the chin and ends that do not
// rise to the jaw, so the arc reads as a floor, not a necklace.
const PARC = { p0: [0, 150], p1: [75, 178], p2: [150, 150] }
function parcPoint(t) {
  const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t
  return [a * PARC.p0[0] + b * PARC.p1[0] + c * PARC.p2[0], a * PARC.p0[1] + b * PARC.p1[1] + c * PARC.p2[1]]
}
function pstage(pills, empty, flat) {
  const d = `M${PARC.p0}Q${PARC.p1} ${PARC.p2}`
  const arc = empty
    ? `<path d="${d}" fill="none" stroke="${FG}" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round" opacity="0.4"/>`
    : `<path d="${d}" fill="none" stroke="${FG}" stroke-width="2" stroke-linecap="round" opacity="${flat ? 1 : 0.55}"/>`
  const ts = arcTs(pills.length)
  return arc + pills.map((s, i) => {
    const [x, y] = parcPoint(ts[i])
    if (s === 'torch') return glyphAt(TORCH_OUT, x, y - 9, 17, 2)
    if (s === 'warn') return glyphAt(WARNING, x, y - 9, 16, 2)
    const r = `x="${x - 3.5}" y="${y - 15}" width="7" height="13" rx="3.5"`
    if (s === 'work' || flat) return `<rect ${r} fill="${FG}"/>`
    if (s === 'dim') return `<rect ${r} fill="none" stroke="${FG}" stroke-width="2" opacity="0.3"/>`
    return `<rect ${r} fill="none" stroke="${FG}" stroke-width="2"/>`
  }).join('')
}
const PVB = { w: 150, h: 172, tx: 25 }

function figureSvgPrime(face, width = 160) {
  const sil = SILS.B, spec = PRIME_SPEC[face], uid = `p${++seq}`
  const [eL, eR] = PRIME_EYES[spec.eyes]
  const mouth = PRIME_MOUTHS[spec.mouth]
  const tilt = spec.tilt ? ` rotate(${spec.tilt} 50 55)` : ''
  const cut = `<mask id="${uid}m"><rect x="-20" y="-20" width="140" height="150" fill="#fff"/><path d="${eL}" fill="#000"/><path d="${eR}" fill="#000"/><path d="${mouth}" fill="#000"/></mask><clipPath id="${uid}l"><path d="${eL}"/></clipPath><clipPath id="${uid}r"><path d="${eR}"/></clipPath>`
  const gaze = spec.gaze
    ? `<g clip-path="url(#${uid}l)"><circle cx="${32 + spec.gaze[0]}" cy="${47 + spec.gaze[1]}" r="3" fill="${FG}"/></g><g clip-path="url(#${uid}r)"><circle cx="${68 + spec.gaze[0]}" cy="${47 + spec.gaze[1]}" r="3" fill="${FG}"/></g>`
    : ''
  const halo = spec.halo ? `<path d="${sil.path}" transform="translate(50 55) scale(1.13) translate(-50 -55)" fill="none" stroke="${FG}" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round" opacity="0.8"/>` : ''
  const crack = spec.crack ? `<path d="M60 ${sil.crackY}L55 ${sil.crackY + 11}L62 ${sil.crackY + 18}L57 ${sil.crackY + 27}"/>` : ''
  const h = (width * PVB.h) / PVB.w
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PVB.w} ${PVB.h}" width="${width}" height="${h}"><defs>${cut}</defs>`
    + pstage(spec.pills, spec.pills.length === 0, false)
    + `<g transform="translate(${PVB.tx} 2)${tilt}">${halo}<path d="${sil.path}" fill="${FG}" opacity="0.18" mask="url(#${uid}m)"/>`
    + `<g fill="none" stroke="${FG}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="${sil.path}"/>`
    + `<path d="${BROWS[spec.brows]}" stroke-width="5"/><path d="${eL}" stroke-width="4"/><path d="${eR}" stroke-width="4"/>${gaze}`
    + `<path d="${NOSE}" stroke-width="2.5"/><path d="${mouth}" stroke-width="4"/>${crack}</g></g>`
    + (spec.badge ? badge(spec.badge, 123, 18) : '')
    + '</svg>'
}

function rule8SvgPrime(n, width = 160) {
  const h = (width * PVB.h) / PVB.w
  const mask = `<g transform="translate(${PVB.tx} 2)"><path d="${SILS.B.path}" fill="${FG}"/></g>`
  const marks = n === 'control'
    ? [[45, 130], [63, 140], [87, 140], [105, 130]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8" fill="${FG}"/>`).join('')
    : pstage(Array(n).fill('work'), false, true)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PVB.w} ${PVB.h}" width="${width}" height="${h}">${marks}${mask}</svg>`
}

// B' Tray LOD: eyes are filled openings (lenses), the awake mouth a filled
// open smile, sleep stays a lid arc and a short slit.
function traySvgPrime(variant, taskbar) {
  const sil = SILS.B, p = TRAY_PALETTES[taskbar], s = 0.19
  const awake = variant === 'eveille' || variant === 'reclame'
  const color = awake ? p.accent : p.dim
  const badgeColor = variant === 'reclame' ? p.glow : variant === 'panne' ? p.banner : undefined
  const eyesPart = awake
    ? `<path d="M23 47C26 41 38 41 41 47C38 52 26 52 23 47ZM59 47C62 41 74 41 77 47C74 52 62 52 59 47Z" fill="${color}"/>`
    : '<path d="M22 44Q32 53 42 44M58 44Q68 53 78 44"/>'
  const mouth = awake ? `<path d="M32 74C40 92 60 92 68 74C58 80 42 80 32 74Z" fill="${color}"/>` : '<path d="M42 81H58"/>'
  const crack = variant === 'panne' ? `<path d="M60 ${sil.crackY}L54 ${sil.crackY + 14}L62 ${sil.crackY + 24}"/>` : ''
  const B = { cx: 18, cy: 3.9, r: 3.4, knockout: 4.9 }
  const knock = badgeColor ? `<mask id="k"><rect x="0" y="0" width="22" height="22" fill="#fff"/><circle cx="${B.cx}" cy="${B.cy}" r="${B.knockout}" fill="#000"/></mask>` : ''
  const maskAttr = badgeColor ? ' mask="url(#k)"' : ''
  const badgeEl = badgeColor ? `<circle cx="${B.cx}" cy="${B.cy}" r="${B.r}" fill="${badgeColor}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="22" height="22">${knock}<g${maskAttr}><g transform="translate(1.5 0.55) scale(${s})" fill="none" stroke="${color}" stroke-width="${2 / s}" stroke-linecap="round" stroke-linejoin="round"><path d="${sil.path}"/>${eyesPart}${mouth}${crack}</g></g>${badgeEl}</svg>\n`
}

const TRAY_SETS = ['A', 'B', 'C', 'Bp']
function traySvgAny(set, variant, taskbar) {
  return set === 'Bp' ? traySvgPrime(variant, taskbar) : traySvg(set, variant, taskbar)
}

module.exports = { FG, BG, SILS, FACES, LABEL, MOTION, figureSvg, rule8Svg, traySvg, TRAY_PALETTES, TRAY_VARIANTS, figureSvgPrime, rule8SvgPrime, TRAY_SETS, traySvgAny }
