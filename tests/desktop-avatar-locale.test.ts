import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { avatarDeckStateDir, readAvatarLocale } from '../desktop/src/main/avatar-locale.ts'

function rig(content: string | null) {
  const stateDir = mkdtempSync(join(tmpdir(), 'avatar-locale-'))
  if (content !== null) writeFileSync(join(stateDir, 'config.json'), content, 'utf8')
  const reports: string[] = []
  const reportError = (scope: string, message: string): void => {
    reports.push(`${scope}: ${message}`)
  }
  return {
    stateDir,
    read:(osLocale: string) => readAvatarLocale(stateDir, osLocale, { reportError }),
    reports,
    dispose: () => rmSync(stateDir, { recursive: true, force: true })
  }
}

test('an explicit Deck locale wins over the OS locale', () => {
  const fr = rig(JSON.stringify({ locale: 'fr', theme: 'dark' }))
  const en = rig(JSON.stringify({ locale: 'en' }))
  try {
    expect(fr.read('en-US')).toBe('fr')
    expect(en.read('fr-FR')).toBe('en')
    expect([...fr.reports, ...en.reports]).toEqual([])
  } finally {
    fr.dispose()
    en.dispose()
  }
})

test('auto, an unsupported tag or a missing field follow the OS locale', () => {
  for (const content of [JSON.stringify({ locale: '' }), JSON.stringify({ locale: 'de' }), JSON.stringify({ theme: 'dark' }), JSON.stringify({ locale: 7 }), '[]']) {
    const r = rig(content)
    try {
      expect(r.read('fr-CA'), content).toBe('fr')
      expect(r.read('de-DE'), content).toBe('en')
      expect(r.reports, content).toEqual([])
    } finally {
      r.dispose()
    }
  }
})

test('a missing config file is the first-run case and falls back silently', () => {
  const r = rig(null)
  try {
    expect(r.read('fr-FR')).toBe('fr')
    expect(r.reports).toEqual([])
  } finally {
    r.dispose()
  }
})

test('a corrupt config file falls back to the OS locale and is reported', () => {
  const r = rig('{ not json')
  try {
    expect(r.read('fr-FR')).toBe('fr')
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]).toStartWith('avatar-locale: cannot read the Deck locale from ')
  } finally {
    r.dispose()
  }
})

test('an unreadable config path other than a missing file is reported, not silenced', () => {
  const r = rig(null)
  try {
    mkdirSync(join(r.stateDir, 'config.json'))
    expect(r.read('fr-FR')).toBe('fr')
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]).toStartWith('avatar-locale: cannot read the Deck locale from ')
  } finally {
    r.dispose()
  }
})

test('reads config.json directly under the state directory it is given', () => {
  const seen: string[] = []
  const locale = readAvatarLocale(join('deck-data', 'config'), 'en-US', {
    readFile: (file) => {
      seen.push(file)
      return JSON.stringify({ locale: 'fr' })
    },
    reportError: () => {
      throw new Error('unexpected report')
    }
  })
  expect(locale).toBe('fr')
  expect(seen).toEqual([join('deck-data', 'config', 'config.json')])
})

test('the Deck state directory is the config subfolder of the Deck userData, not the Avatar one', () => {
  const deckUserData = join('Roaming', 'koryphaios')
  const seen: string[] = []
  readAvatarLocale(avatarDeckStateDir(deckUserData), 'en-US', {
    readFile: (file) => {
      seen.push(file)
      return '{}'
    },
    reportError: () => {
      throw new Error('unexpected report')
    }
  })
  expect(seen, 'the Avatar must read the config.json the Deck store writes').toEqual([join('Roaming', 'koryphaios', 'config', 'config.json')])
})
