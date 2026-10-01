// Byte-stable for one ImageMagick build only: regenerate every file with the same binary.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AVATAR_TRAY_TASKBARS, AVATAR_TRAY_VARIANTS, avatarTrayIconPath } from '../../desktop/src/main/avatar-tray-icon.ts'
import { avatarTraySvg } from './tray-svg.ts'

const USAGE = `Generates the Avatar Tray PNGs (16 px and @2x) from the character's mask geometry,
and scripts/avatar-tray/manifest.json pairing each PNG with the hash of its SVG.

  MAGICK_BIN=<ImageMagick 7 magick executable> bun scripts/avatar-tray/make.ts [outDir]

outDir defaults to desktop/resources/avatar-tray; given an outDir, the manifest is written there.`

if (process.argv.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}

const MAGICK = process.env.MAGICK_BIN
if (MAGICK === undefined || MAGICK === '') {
  console.error(`MAGICK_BIN is not set.\n\n${USAGE}`)
  process.exit(1)
}
const OUT = process.argv[2] ?? join(import.meta.dir, '..', '..', 'desktop', 'resources', 'avatar-tray')
const MANIFEST = process.argv[2] === undefined ? join(import.meta.dir, 'manifest.json') : join(OUT, 'manifest.json')

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

const manifest: Record<string, { svg: string; png: string }> = {}
for (const taskbar of AVATAR_TRAY_TASKBARS) {
  for (const variant of AVATAR_TRAY_VARIANTS) {
    const svg = avatarTraySvg(variant, taskbar)
    const base = avatarTrayIconPath(OUT, variant, taskbar)
    for (const [size, out] of [[16, base], [32, base.replace(/\.png$/, '@2x.png')]] as const) {
      const r = spawnSync(MAGICK, ['-background', 'none', '-density', '1536', 'svg:-', '-resize', `${size}x${size}`, '-strip', `PNG32:${out}`], { input: svg, encoding: 'utf-8' })
      if (r.error !== undefined) throw new Error(`magick could not start (${MAGICK}): ${r.error.message}`)
      if (r.status !== 0) throw new Error(`magick failed for ${out}: ${r.stderr}`)
      manifest[basename(out)] = { svg: sha256(svg), png: sha256(readFileSync(out)) }
    }
  }
}
const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`)
console.log('ok', Object.keys(sorted).length, 'files ->', OUT, '| manifest ->', MANIFEST)
