export type BlockKind = 'frame' | 'dim' | 'stock'

export const MIN_FRAME_COLUMNS = 40
export const GUARD_SAFE_BORDER = 'single'
export const USER_COLOR = 'suggestion'
export const ASSISTANT_COLOR = 'claude'

const LABELS = {
  en: { user: 'You', assistant: 'Claude' },
  fr: { user: 'Vous', assistant: 'Claude' },
} as const

export type Labels = (typeof LABELS)[keyof typeof LABELS]

export function resolveLabels(value: unknown): Labels {
  return value === 'fr' ? LABELS.fr : LABELS.en
}

// Over-matching only leaves a short message unframed; under-matching splits a
// limit message across frame rows, which the quota detector cannot read across.
const STOCK_VOCABULARY = /limit|reset|quota|overloaded|usage/i
const STOCK_MAX_CHARS = 400
const STOCK_MAX_LINES = 3

function mustStayStock(text: string): boolean {
  return (
    text.length <= STOCK_MAX_CHARS &&
    text.split('\n').length <= STOCK_MAX_LINES &&
    STOCK_VOCABULARY.test(text)
  )
}

export function classifyAssistantBlock(text: string, isSummary: boolean): BlockKind {
  if (text.trim() === '' || mustStayStock(text)) return 'stock'
  return isSummary ? 'dim' : 'frame'
}

const TURN_WORD_MAX = 24

function turnDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// Two columns shorter than the terminal: a row as wide as the terminal made of rule glyphs is
// what Koryphaios reads as the top border of a composer, and no part of it may look like a spinner row.
export function turnRule(word: string, durationMs: number, columns: number): string {
  const width = columns - 2
  const spoken = [...word.trim().replace(/\s+/g, ' ')].slice(0, TURN_WORD_MAX).join('')
  const label = ` ${spoken} for ${turnDuration(durationMs)} `
  const fill = '─'.repeat(Math.max(0, width - [...label].length - 2))
  return [...`──${label}${fill}`].slice(0, width).join('')
}
