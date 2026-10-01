// Rasterizes each silhouette's Tray reduction with the shipping magick
// parameters, then measures WCAG contrast of the composited pixels.
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-ignore CommonJS geometry shared with the Electron board
import geom from './geom.cjs'

const MAGICK = process.env.MAGICK_BIN ?? 'magick'
const OUT = join(process.env.BOARD_OUT ?? join(tmpdir(), 'avatar-a2-board'), 'tray')
const BARS: Record<string, number[]> = { light: [0xf3, 0xf3, 0xf3], dark: [0x20, 0x20, 0x20] }

const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

function measure(file: string, bg: number[], face: number[], badge?: number[]) {
  const r = spawnSync(MAGICK, [file, '-depth', '8', 'rgba:-'], { maxBuffer: 1 << 20 })
  if (r.status !== 0) throw new Error(`magick read failed for ${file}: ${r.stderr}`)
  const buf: Buffer = r.stdout
  let facePeak = 0, badgePeak = 0, maxA = 0
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3]! / 255
    if (a === 0) continue
    maxA = Math.max(maxA, a)
    const rgb = [buf[i]!, buf[i + 1]!, buf[i + 2]!]
    const comp = rgb.map((v, j) => v * a + bg[j]! * (1 - a))
    const c = ratio(comp, bg)
    if (badge !== undefined && dist(rgb, badge) < dist(rgb, face)) badgePeak = Math.max(badgePeak, c)
    else facePeak = Math.max(facePeak, c)
  }
  return { face: +facePeak.toFixed(2), badge: badge === undefined ? null : +badgePeak.toFixed(2), maxAlpha: +maxA.toFixed(2) }
}

const results: Record<string, unknown>[] = []
for (const sil of geom.TRAY_SETS as string[]) {
  const dir = join(OUT, sil)
  mkdirSync(dir, { recursive: true })
  for (const bar of ['light', 'dark'] as const) {
    const p = geom.TRAY_PALETTES[bar]
    for (const v of geom.TRAY_VARIANTS) {
      const awake = v === 'eveille' || v === 'reclame'
      const face = hexRgb(awake ? p.accent : p.dim)
      const badge = v === 'reclame' ? hexRgb(p.glow) : v === 'panne' ? hexRgb(p.banner) : undefined
      const svg = geom.traySvgAny(sil, v, bar)
      writeFileSync(join(dir, `${v}-${bar}.svg`), svg)
      for (const size of [16, 32]) {
        const out = join(dir, `${v}-${bar}-${size}.png`)
        const r = spawnSync(MAGICK, ['-background', 'none', '-density', '1536', 'svg:-', '-resize', `${size}x${size}`, '-strip', `PNG32:${out}`], { input: svg, encoding: 'utf-8' })
        if (r.status !== 0) throw new Error(`magick failed for ${out}: ${r.stderr}`)
        const own = measure(out, BARS[bar]!, face, badge)
        const cross = measure(out, BARS[bar === 'light' ? 'dark' : 'light']!, face, badge)
        results.push({ sil, bar, variant: v, size, own, cross })
      }
    }
  }
}
writeFileSync(join(OUT, 'contrast.json'), JSON.stringify(results, null, 1))
for (const r of results as any[]) {
  console.log(`${r.sil} ${r.bar.padEnd(5)} ${r.variant.padEnd(8)} ${String(r.size).padStart(2)}px own face=${r.own.face} badge=${r.own.badge ?? '-'} maxA=${r.own.maxAlpha} | cross face=${r.cross.face}`)
}
const fails = (results as any[]).filter((r) => r.own.face < 3 || (r.own.badge !== null && r.own.badge < 3))
console.log('own-bar items below 3:1:', fails.length)
