import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../desktop/src/main/store-defaults'

test('mods are disabled in the default configuration', () => {
  expect(DEFAULT_CONFIG.enabledMods).toEqual({})
})
