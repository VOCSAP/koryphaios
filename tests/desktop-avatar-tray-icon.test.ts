import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AVATAR_TRAY_FACES,
  AVATAR_TRAY_ICON_DIRNAME,
  AVATAR_TRAY_TASKBARS,
  AVATAR_TRAY_VARIANTS,
  avatarTrayIconDir,
  avatarTrayIconFiles,
  avatarTrayIconPath,
  avatarTrayTaskbar,
  avatarTrayVariant,
  type AvatarTrayTaskbar
} from '../desktop/src/main/avatar-tray-icon.ts'
import {
  createAvatarTray,
  electronAvatarTrayDependencies,
  type AvatarTrayImage,
  type ElectronTrayModule
} from '../desktop/src/main/avatar-tray.ts'
import type { AvatarFace } from '../desktop/src/shared/avatar-state.ts'
import type { AvatarViewSummary } from '../desktop/src/shared/avatar-view.ts'
import { MASK_OUTLINE } from '../desktop/src/shared/avatar-mask-geometry.ts'
import { avatarTrayInk, avatarTraySvg } from '../scripts/avatar-tray/tray-svg.ts'

const DESKTOP_DIR = join(import.meta.dir, '..', 'desktop')
const MANIFEST_PATH = join(import.meta.dir, '..', 'scripts', 'avatar-tray', 'manifest.json')
const REGENERATE = 'regenerate with MAGICK_BIN=<magick> bun scripts/avatar-tray/make.ts'
const TASKBAR_COLOUR: Record<AvatarTrayTaskbar, string> = { dark: '#202020', light: '#f3f3f3' }

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

function contrast(a: string, b: string): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(bl!)
  }
  const x = lum(a)
  const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function summaryWithFace(face: AvatarFace): AvatarViewSummary {
  return {
    face,
    faceCopy: { title: face, ariaLabel: face },
    counters: { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
    unread: 0,
    decks: []
  }
}

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function hiDpiSibling(path: string): string {
  return path.replace(/\.png$/, '@2x.png')
}

const BRIEF_VARIANT_BY_FACE = {
  seul: 'endormi',
  endormi: 'endormi',
  travaille: 'eveille',
  perdu: 'eveille',
  courrier: 'eveille',
  reclame: 'reclame',
  panne: 'panne'
} as const satisfies Record<AvatarFace, string>

test('the icon variant of every face is the one the brief assigns', () => {
  expect<string[]>([...AVATAR_TRAY_FACES].sort(),'the brief oracle and the face domain disagree').toEqual(Object.keys(BRIEF_VARIANT_BY_FACE).sort())
  for (const face of AVATAR_TRAY_FACES) {
    expect(avatarTrayVariant(face), `face ${face}`).toBe(BRIEF_VARIANT_BY_FACE[face])
  }
})

test('every face resolves, on each taskbar, to a real 16 px PNG with a 32 px @2x sibling, and no two icons share pixels', () => {
  const dir = avatarTrayIconDir(false, 'unused-resources', DESKTOP_DIR)
  const variants = [...new Set(AVATAR_TRAY_FACES.map(avatarTrayVariant))]
  expect(variants.length, 'faces collapse onto fewer icons than the brief draws').toBe(new Set(Object.values(BRIEF_VARIANT_BY_FACE)).size)

  const bytesByTier: Array<Map<string, string>> = [new Map(), new Map()]
  for (const taskbar of AVATAR_TRAY_TASKBARS) {
    for (const variant of variants) {
      const path = avatarTrayIconPath(dir, variant, taskbar)
      for (const [tier, file, size] of [[0, path, 16], [1, hiDpiSibling(path), 32]] as const) {
        expect(existsSync(file), `Avatar Tray icon missing at ${file}`).toBe(true)
        expect(readFileSync(file).length, `Avatar Tray icon is empty at ${file}`).toBeGreaterThan(0)
        expect(pngSize(file), file).toEqual({ width: size, height: size })
        const hex = readFileSync(file).toString('hex')
        expect(bytesByTier[tier]!.get(hex), `${variant} on a ${taskbar} taskbar is byte-identical to ${bytesByTier[tier]!.get(hex)} at ${size} px`).toBeUndefined()
        bytesByTier[tier]!.set(hex, `${variant}/${taskbar}`)
      }
    }
  }
})

test('the icon file set is every variant, on both taskbars, at both tiers, and nothing else', () => {
  const expected = AVATAR_TRAY_TASKBARS.flatMap((taskbar) => AVATAR_TRAY_VARIANTS.flatMap((variant) => {
    const base = taskbar === 'light' ? `avatar-${variant}-light.png` : `avatar-${variant}.png`
    return [base, base.replace(/\.png$/, '@2x.png')]
  }))
  expect([...avatarTrayIconFiles()].sort()).toEqual(expected.sort())
  expect(new Set(avatarTrayIconFiles()).size, 'two (variant, taskbar) pairs share one file name').toBe(AVATAR_TRAY_VARIANTS.length * AVATAR_TRAY_TASKBARS.length * 2)
  for (const variant of AVATAR_TRAY_VARIANTS) {
    expect(avatarTrayIconPath('d', variant, 'dark')).toBe(join('d', `avatar-${variant}.png`))
    expect(avatarTrayIconPath('d', variant, 'light')).toBe(join('d', `avatar-${variant}-light.png`))
  }
})

test('every shipped icon is the raster of the current mask geometry, as recorded by the generator', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, { svg: string; png: string }>
  expect(Object.keys(manifest).sort(), `the manifest and the icon file set disagree: ${REGENERATE}`).toEqual([...avatarTrayIconFiles()].sort())
  const dir = avatarTrayIconDir(false, 'unused-resources', DESKTOP_DIR)
  expect(existsSync(join(dir, 'manifest.json')), 'the manifest sits in the shipped icon dir, so it would be packaged').toBe(false)
  for (const taskbar of AVATAR_TRAY_TASKBARS) {
    for (const variant of AVATAR_TRAY_VARIANTS) {
      const svgHash = sha256(avatarTraySvg(variant, taskbar))
      const path = avatarTrayIconPath(dir, variant, taskbar)
      for (const file of [path, hiDpiSibling(path)]) {
        const name = file.slice(dir.length + 1)
        expect(manifest[name]?.svg, `${name} was rasterized from another geometry or palette: ${REGENERATE}`).toBe(svgHash)
        expect(sha256(readFileSync(file)), `${name} is not the file the generator wrote: ${REGENERATE}`).toBe(manifest[name]!.png)
      }
    }
  }
})

const MAGICK_BIN = process.env.MAGICK_BIN
const REGENERATION = 'regenerating the icons with ImageMagick reproduces the shipped PNGs and manifest byte for byte'

;(MAGICK_BIN ? test : test.skip)(MAGICK_BIN ? REGENERATION : `skipped: MAGICK_BIN unset -- ${REGENERATION}`, () => {
  const out = mkdtempSync(join(tmpdir(), 'avatar-tray-regen-'))
  try {
    const run = spawnSync(process.execPath, [join(import.meta.dir, '..', 'scripts', 'avatar-tray', 'make.ts'), out], { encoding: 'utf-8', env: { ...process.env, MAGICK_BIN } })
    expect(run.status, `make.ts failed: ${run.stderr}`).toBe(0)
    const dir = avatarTrayIconDir(false, 'unused-resources', DESKTOP_DIR)
    for (const name of avatarTrayIconFiles()) {
      expect(sha256(readFileSync(join(out, name))), `${name} differs from a fresh rasterization of the current geometry`).toBe(sha256(readFileSync(join(dir, name))))
    }
    expect(readFileSync(join(out, 'manifest.json'), 'utf-8'), 'the committed manifest is not what the generator writes').toBe(readFileSync(MANIFEST_PATH, 'utf-8').replaceAll('\r\n', '\n'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 60_000)

test('the Tray icon is the character mask outline, in colours that clear 3:1 on its own taskbar', () => {
  for (const taskbar of AVATAR_TRAY_TASKBARS) {
    for (const variant of AVATAR_TRAY_VARIANTS) {
      expect(avatarTraySvg(variant, taskbar), `${variant}/${taskbar} does not draw the character outline`).toContain(`d="${MASK_OUTLINE}"`)
      const ink = avatarTrayInk(variant, taskbar)
      for (const colour of [ink.stroke, ink.badge].filter((c): c is string => c !== null)) {
        expect(contrast(colour, TASKBAR_COLOUR[taskbar]), `${variant}/${taskbar} ${colour} on ${TASKBAR_COLOUR[taskbar]}`).toBeGreaterThanOrEqual(3)
      }
    }
  }
})

test('the taskbar shade follows the system-integrated UI on win32 and darwin, and is dark elsewhere', () => {
  const cases: Array<[string, boolean | undefined, AvatarTrayTaskbar]> = [
    ['win32', true, 'dark'],
    ['win32', false, 'light'],
    ['win32', undefined, 'dark'],
    ['darwin', true, 'dark'],
    ['darwin', false, 'light'],
    ['linux', false, 'dark'],
    ['linux', true, 'dark'],
    ['linux', undefined, 'dark']
  ]
  for (const [platform, systemDark, expected] of cases) {
    expect(avatarTrayTaskbar(platform, systemDark), `${platform}, systemIntegratedUiDark=${String(systemDark)}`).toBe(expected)
  }
})

test('the packaged icon dir is the extraResources target that ships the dev dir', () => {
  const yaml = readFileSync(join(DESKTOP_DIR, 'electron-builder.yml'), 'utf-8')

  expect(avatarTrayIconDir(true, 'R', 'A')).toBe(join('R', AVATAR_TRAY_ICON_DIRNAME))
  expect(yaml).toMatch(new RegExp(`-\\s*from:\\s*resources/${AVATAR_TRAY_ICON_DIRNAME}\\s*\\r?\\n\\s*to:\\s*${AVATAR_TRAY_ICON_DIRNAME}\\s*$`, 'm'))
})

interface FakeElectron {
  module: ElectronTrayModule
  loadedPaths: string[]
  trayImages: unknown[]
  setImages: unknown[]
  emptyCalls: number
  systemDark: boolean | undefined
  themeListeners: Set<() => void>
}

function fakeElectron(load: (path: string) => AvatarTrayImage): FakeElectron {
  const fake: FakeElectron = {
    module: null as unknown as ElectronTrayModule,
    loadedPaths: [],
    trayImages: [],
    setImages: [],
    emptyCalls: 0,
    systemDark: true,
    themeListeners: new Set()
  }
  class Tray {
    constructor(image: unknown) { fake.trayImages.push(image) }
    setToolTip(): void {}
    setContextMenu(): void {}
    setImage(image: unknown): void { fake.setImages.push(image) }
    destroy(): void {}
  }
  fake.module = {
    Tray,
    Menu: { buildFromTemplate: (template: unknown) => template },
    nativeImage: {
      createFromPath: (path: string) => { fake.loadedPaths.push(path); return load(path) },
      createEmpty: () => { fake.emptyCalls += 1; return { isEmpty: () => true } }
    },
    nativeTheme: {
      get shouldUseDarkColorsForSystemIntegratedUI() { return fake.systemDark },
      on: (event: string, listener: () => void) => { if (event === 'updated') fake.themeListeners.add(listener) },
      removeListener: (event: string, listener: () => void) => { if (event === 'updated') fake.themeListeners.delete(listener) }
    }
  } as unknown as ElectronTrayModule
  return fake
}

interface TrayHarness {
  fake: FakeElectron
  errors: string[]
  setFace(face: AvatarFace): void
  setSystemDark(dark: boolean | undefined, notify: boolean): void
  tick(): void
  dispose(): void
}

function startTray(
  iconDir: string,
  initialFace: AvatarFace,
  load: (path: string) => AvatarTrayImage,
  initialSystemDark: boolean | undefined = true,
  platform = 'win32'
): TrayHarness {
  const fake = fakeElectron(load)
  fake.systemDark = initialSystemDark
  const errors: string[] = []
  let face = initialFace
  let tick: (() => void) | null = null
  const tray = createAvatarTray({
    summary: () => summaryWithFace(face),
    iconDir,
    locale: 'en',
    attachedDecks: () => [],
    appearance: () => ({ positionLocked: false, alwaysOnTop: true, motion: 'continuous', size: 'm', frame: 'normal' }),
    windowShown: () => true,
    dispatch: () => {},
    getDnd: () => null,
    onDnd: () => {},
    onDeckMenuClick: () => {},
    onQuit: () => {}
  }, {
    ...electronAvatarTrayDependencies(() => fake.module),
    setInterval: (callback: () => void) => { tick = callback; return 'timer' as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => {},
    reportError: (_scope: string, message: string) => { errors.push(message) },
    platform
  })
  return {
    fake,
    errors,
    setFace: (next) => { face = next },
    setSystemDark: (dark, notify) => {
      fake.systemDark = dark
      if (notify) for (const listener of [...fake.themeListeners]) listener()
    },
    tick: () => {
      if (tick === null) throw new Error('Expected the Tray refresh interval to be armed')
      tick()
    },
    dispose: () => tray.dispose()
  }
}

function imageFor(path: string): AvatarTrayImage {
  return { isEmpty: () => false, toString: () => path } as AvatarTrayImage
}

test('the Tray is built from the icon of the variant of the current face, never an empty one', () => {
  const harness = startTray('icons-dir', 'panne', imageFor)
  harness.dispose()

  expect(harness.fake.loadedPaths).toEqual([avatarTrayIconPath('icons-dir', 'panne', 'dark')])
  expect(harness.fake.trayImages.map(String)).toEqual([avatarTrayIconPath('icons-dir', 'panne', 'dark')])
  expect(harness.fake.emptyCalls, 'the Tray fell back to nativeImage.createEmpty(), the blank-square icon').toBe(0)
  expect(harness.errors).toEqual([])
})

test('a refresh swaps the icon only when the variant changes', () => {
  const harness = startTray('icons-dir', 'seul', imageFor)
  harness.setFace('endormi')
  harness.tick()
  expect(harness.fake.setImages, 'an unchanged variant re-set the icon').toEqual([])

  harness.setFace('reclame')
  harness.tick()
  harness.setFace('travaille')
  harness.tick()
  expect(harness.fake.setImages.map(String)).toEqual([
    avatarTrayIconPath('icons-dir', 'reclame', 'dark'),
    avatarTrayIconPath('icons-dir', 'eveille', 'dark')
  ])

  harness.setFace('courrier')
  harness.tick()
  harness.tick()
  expect(harness.fake.setImages, 'a face change inside one variant re-set the icon').toHaveLength(2)

  harness.setFace('seul')
  harness.tick()
  expect(harness.fake.setImages.map(String).at(-1)).toBe(avatarTrayIconPath('icons-dir', 'endormi', 'dark'))
  harness.dispose()
  expect(harness.errors).toEqual([])
})

test('an icon that loads empty is reported with its path and the Tray still comes up', () => {
  const harness = startTray('missing-dir', 'seul', () => ({ isEmpty: () => true }))
  harness.dispose()

  expect(harness.fake.trayImages).toHaveLength(1)
  expect(harness.errors).toEqual([`Avatar Tray icon missing or unreadable: ${avatarTrayIconPath('missing-dir', 'endormi', 'dark')}`])
})

test('an unreadable variant keeps the previous icon and is reported once, not on every heartbeat', () => {
  const claim = avatarTrayIconPath('icons-dir', 'reclame', 'dark')
  const harness = startTray('icons-dir', 'seul', (path) => path === claim ? { isEmpty: () => true } : imageFor(path))

  harness.setFace('reclame')
  harness.tick()
  harness.tick()
  harness.dispose()

  expect(harness.fake.setImages, 'an empty image replaced the visible icon').toEqual([])
  expect(harness.errors).toEqual([`Avatar Tray icon missing or unreadable: ${claim}`])
})

test('a light taskbar at start builds the Tray from the light set', () => {
  const harness = startTray('icons-dir', 'reclame', imageFor, false)
  harness.dispose()

  expect(harness.fake.trayImages.map(String)).toEqual([avatarTrayIconPath('icons-dir', 'reclame', 'light')])
})

test('a taskbar theme change re-sets the icon of the current variant, and an unchanged one does not', () => {
  const harness = startTray('icons-dir', 'travaille', imageFor, true)

  harness.setSystemDark(true, true)
  expect(harness.fake.setImages, 'an updated event with the same taskbar shade re-set the icon').toEqual([])

  harness.setSystemDark(false, true)
  harness.setSystemDark(true, true)
  expect(harness.fake.setImages.map(String)).toEqual([
    avatarTrayIconPath('icons-dir', 'eveille', 'light'),
    avatarTrayIconPath('icons-dir', 'eveille', 'dark')
  ])

  harness.setSystemDark(false, true)
  harness.setFace('panne')
  harness.tick()
  expect(harness.fake.setImages.map(String).at(-1), 'a face change lost the taskbar shade').toBe(avatarTrayIconPath('icons-dir', 'panne', 'light'))
  harness.dispose()
  expect(harness.errors).toEqual([])
})

test('a taskbar change that raises no updated event is still picked up by the heartbeat', () => {
  const harness = startTray('icons-dir', 'seul', imageFor, true)

  harness.setSystemDark(false, false)
  expect(harness.fake.setImages).toEqual([])
  harness.tick()
  harness.dispose()

  expect(harness.fake.setImages.map(String)).toEqual([avatarTrayIconPath('icons-dir', 'endormi', 'light')])
})

test('without a system-integrated UI theme the dark set applies, whatever the API answers', () => {
  const absent = startTray('icons-dir', 'seul', imageFor, undefined)
  absent.dispose()
  expect(absent.fake.trayImages.map(String)).toEqual([avatarTrayIconPath('icons-dir', 'endormi', 'dark')])

  const linux = startTray('icons-dir', 'seul', imageFor, false, 'linux')
  linux.setSystemDark(false, true)
  linux.tick()
  linux.dispose()
  expect(linux.fake.trayImages.map(String)).toEqual([avatarTrayIconPath('icons-dir', 'endormi', 'dark')])
  expect(linux.fake.setImages, 'a platform without the API switched to the light set').toEqual([])
})

test('disposing the Tray stops following the taskbar theme', () => {
  const harness = startTray('icons-dir', 'seul', imageFor, true)
  expect(harness.fake.themeListeners.size, 'the Tray never subscribed to nativeTheme updated').toBe(1)
  harness.dispose()

  expect(harness.fake.themeListeners.size, 'a disposed Tray still listens to nativeTheme updated').toBe(0)
})
