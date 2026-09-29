import { expect, test } from 'bun:test'
import { uniqueAvatarDeckLabels } from '../desktop/src/shared/avatar-label.ts'

test('keeps the first Deck label and suffixes duplicate names in order', () => {
  expect(uniqueAvatarDeckLabels(['Deck', 'Deck', 'Deck'])).toEqual(['Deck', 'Deck (2)', 'Deck (3)'])
})

test('disambiguates a literal suffix that collides with an earlier label', () => {
  expect(uniqueAvatarDeckLabels(['Deck', 'Deck', 'Deck (2)', 'Deck'])).toEqual([
    'Deck',
    'Deck (2)',
    'Deck (2) (2)',
    'Deck (3)'
  ])
})

test('preserves an empty list and ampersands for the Tray boundary', () => {
  expect(uniqueAvatarDeckLabels([])).toEqual([])
  expect(uniqueAvatarDeckLabels(['A & B', 'A & B'])).toEqual(['A & B', 'A & B (2)'])
})
