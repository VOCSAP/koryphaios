import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AVATAR_TRAY_FACES,
  AVATAR_TRAY_ICON_DIRNAME,
  avatarTrayIconDir,
  avatarTrayIconPath,
  avatarTrayVariant,
  type AvatarTrayVariant
} from '../desktop/src/main/avatar-tray-icon.ts'
import {
  createAvatarTray,
  electronAvatarTrayDependencies,
  type AvatarTrayImage,
  type ElectronTrayModule
} from '../desktop/src/main/avatar-tray.ts'
import type { AvatarFace, AvatarState, AvatarSummary } from '../desktop/src/shared/avatar-state.ts'

const DESKTOP_DIR = join(import.meta.dir, '..', 'desktop')

function summaryWithFace(face: AvatarFace): AvatarSummary {
  return {
    face,
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

test('every face resolves to a real 16 px PNG with a 32 px @2x sibling, and no two variants share pixels', () => {
  const dir = avatarTrayIconDir(false, 'unused-resources', DESKTOP_DIR)
  const variants = [...new Set(AVATAR_TRAY_FACES.map(avatarTrayVariant))]
  expect(variants.length, 'faces collapse onto fewer icons than the brief draws').toBe(new Set(Object.values(BRIEF_VARIANT_BY_FACE)).size)

  const bytesByTier: Array<Map<string, AvatarTrayVariant>> = [new Map(), new Map()]
  for (const variant of variants) {
    const path = avatarTrayIconPath(dir, variant)
    for (const [tier, file, size] of [[0, path, 16], [1, hiDpiSibling(path), 32]] as const) {
      expect(existsSync(file), `Avatar Tray icon missing at ${file}`).toBe(true)
      expect(pngSize(file), file).toEqual({ width: size, height: size })
      const hex = readFileSync(file).toString('hex')
      expect(bytesByTier[tier]!.get(hex), `${variant} is byte-identical to another variant at ${size} px`).toBeUndefined()
      bytesByTier[tier]!.set(hex, variant)
    }
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
}

function fakeElectron(load: (path: string) => AvatarTrayImage): FakeElectron {
  const fake: FakeElectron = { module: null as unknown as ElectronTrayModule, loadedPaths: [], trayImages: [], setImages: [], emptyCalls: 0 }
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
    }
  } as unknown as ElectronTrayModule
  return fake
}

interface TrayHarness {
  fake: FakeElectron
  errors: string[]
  setFace(face: AvatarFace): void
  tick(): void
  dispose(): void
}

function startTray(iconDir: string, initialFace: AvatarFace, load: (path: string) => AvatarTrayImage): TrayHarness {
  const fake = fakeElectron(load)
  const errors: string[] = []
  let face = initialFace
  let tick: (() => void) | null = null
  const tray = createAvatarTray({
    state: { summary: () => summaryWithFace(face) } as unknown as AvatarState,
    iconDir,
    attachedDecks: () => [],
    onDeckMenuClick: () => {},
    onQuit: () => {}
  }, {
    ...electronAvatarTrayDependencies(() => fake.module),
    setInterval: (callback: () => void) => { tick = callback; return 'timer' as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => {},
    reportError: (_scope: string, message: string) => { errors.push(message) }
  })
  return {
    fake,
    errors,
    setFace: (next) => { face = next },
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

  expect(harness.fake.loadedPaths).toEqual([avatarTrayIconPath('icons-dir', 'panne')])
  expect(harness.fake.trayImages.map(String)).toEqual([avatarTrayIconPath('icons-dir', 'panne')])
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
    avatarTrayIconPath('icons-dir', 'reclame'),
    avatarTrayIconPath('icons-dir', 'eveille')
  ])

  harness.setFace('courrier')
  harness.tick()
  harness.tick()
  expect(harness.fake.setImages, 'a face change inside one variant re-set the icon').toHaveLength(2)

  harness.setFace('seul')
  harness.tick()
  expect(harness.fake.setImages.map(String).at(-1)).toBe(avatarTrayIconPath('icons-dir', 'endormi'))
  harness.dispose()
  expect(harness.errors).toEqual([])
})

test('an icon that loads empty is reported with its path and the Tray still comes up', () => {
  const harness = startTray('missing-dir', 'seul', () => ({ isEmpty: () => true }))
  harness.dispose()

  expect(harness.fake.trayImages).toHaveLength(1)
  expect(harness.errors).toEqual([`Avatar Tray icon missing or unreadable: ${avatarTrayIconPath('missing-dir', 'endormi')}`])
})

test('an unreadable variant keeps the previous icon and is reported once, not on every heartbeat', () => {
  const claim = avatarTrayIconPath('icons-dir', 'reclame')
  const harness = startTray('icons-dir', 'seul', (path) => path === claim ? { isEmpty: () => true } : imageFor(path))

  harness.setFace('reclame')
  harness.tick()
  harness.tick()
  harness.dispose()

  expect(harness.fake.setImages, 'an empty image replaced the visible icon').toEqual([])
  expect(harness.errors).toEqual([`Avatar Tray icon missing or unreadable: ${claim}`])
})
