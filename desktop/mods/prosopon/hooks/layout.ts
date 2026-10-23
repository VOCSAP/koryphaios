import type { ThemeKey } from 'claude-code'

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

export const SUPPORTED_THEME_KEYS = {
  text: true, inverseText: true, inactive: true, subtle: true, suggestion: true, remember: true, success: true,
  error: true, warning: true, merged: true, claude: true, permission: true, planMode: true, autoAccept: true,
  promptBorder: true, bashBorder: true, ide: true, diffAdded: true, diffRemoved: true, diffAddedDimmed: true,
  diffRemovedDimmed: true, diffAddedWord: true, diffRemovedWord: true,
} as const satisfies Record<ThemeKey, true>

const THEME_KEYS = new Set(Object.keys(SUPPORTED_THEME_KEYS))

type FrameOptions = {
  labels?: unknown
  user_label?: unknown
  user_color?: unknown
  assistant_color?: unknown
}

export type FrameConfiguration = {
  userLabel: string
  assistantLabel: string
  userColor: string
  assistantColor: string
}

const USER_LABEL_BIDI_CONTROLS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
])

function resolveUserLabel(value: unknown, fallback: string): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    [...value].length > 20 ||
    /[\p{Cc}\p{Cs}]/u.test(value) ||
    [...value].some(character => USER_LABEL_BIDI_CONTROLS.has(character.codePointAt(0)!))
  ) return fallback
  return value
}

function resolveColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return THEME_KEYS.has(value) || /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

export function resolveFrameConfiguration(options: FrameOptions): FrameConfiguration {
  const labels = resolveLabels(options.labels)
  return {
    userLabel: resolveUserLabel(options.user_label, labels.user),
    assistantLabel: labels.assistant,
    userColor: resolveColor(options.user_color, USER_COLOR),
    assistantColor: resolveColor(options.assistant_color, ASSISTANT_COLOR),
  }
}

// Over-matching only leaves a short message unframed; under-matching splits a
// limit message across frame rows, which the quota detector cannot read across.
const STOCK_VOCABULARY = /limit|reset|quota|overloaded|usage/i
const STOCK_MAX_CHARS = 400
const STOCK_MAX_LINES = 3
const SHORT_NOTE_MAX_CHARS = 160
export const SHORT_NOTE_BULLET = `${String.fromCodePoint(0x25cf)} `

function mustStayStock(text: string): boolean {
  return (
    text.length <= STOCK_MAX_CHARS &&
    text.split('\n').length <= STOCK_MAX_LINES &&
    STOCK_VOCABULARY.test(text)
  )
}

export function classifyAssistantBlock(text: string, isSummary: boolean): BlockKind {
  if (text === '' || isSummary || mustStayStock(text)) return 'stock'
  return !text.includes('\n') && text.length <= SHORT_NOTE_MAX_CHARS ? 'dim' : 'frame'
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
