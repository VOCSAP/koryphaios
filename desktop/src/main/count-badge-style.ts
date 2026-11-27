import { COUNT_BADGE_STYLES, type CountBadgeStyle } from '../shared/types'

/** The stored look of the row counts, or 'glyph' for anything a hand-edited config.json may hold. */
export function normalizeCountBadgeStyle(value: unknown): CountBadgeStyle {
  return COUNT_BADGE_STYLES.includes(value as CountBadgeStyle) ? (value as CountBadgeStyle) : 'glyph'
}
