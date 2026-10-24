/*
 * Despacer
 * https://github.com/MattSenter/despacer
 * Copyright (c) 2026 Matt Senter
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const MINIMUM_PLAUSIBLE_WIDTH = 40
const AGENT_INDENT = 2
const BOX_VERTICAL = String.fromCodePoint(0x2502)
const BOX_LEFT = `${BOX_VERTICAL} `
const BOX_RIGHT = ` ${BOX_VERTICAL}`
const BOX_FRAME_WIDTH = 4

type StringWidth = (text: string) => number

interface NormalizeOptions {
  requireAgentIndent?: boolean
  stringWidth?: StringWidth
  firstRowFull?: string
}

function leadingSpaces(text: string): number {
  let count = 0
  while (text[count] === ' ') count++
  return count
}

function defaultWcwidth(codepoint: number): 0 | 1 | 2 {
  if (
    codepoint === 0 ||
    codepoint < 32 ||
    (codepoint >= 0x7f && codepoint < 0xa0) ||
    codepoint === 0x200d ||
    (codepoint >= 0xfe00 && codepoint <= 0xfe0f) ||
    /\p{Mark}/u.test(String.fromCodePoint(codepoint))
  ) return 0
  if (
    codepoint >= 0x1100 && (
      codepoint <= 0x115f ||
      codepoint === 0x2329 ||
      codepoint === 0x232a ||
      (codepoint >= 0x2e80 && codepoint <= 0xa4cf && codepoint !== 0x303f) ||
      (codepoint >= 0xac00 && codepoint <= 0xd7a3) ||
      (codepoint >= 0xf900 && codepoint <= 0xfaff) ||
      (codepoint >= 0xfe10 && codepoint <= 0xfe19) ||
      (codepoint >= 0xfe30 && codepoint <= 0xfe6f) ||
      (codepoint >= 0xff00 && codepoint <= 0xff60) ||
      (codepoint >= 0xffe0 && codepoint <= 0xffe6) ||
      (codepoint >= 0x1f300 && codepoint <= 0x1faff) ||
      (codepoint >= 0x20000 && codepoint <= 0x3fffd)
    )
  ) return 2
  return 1
}

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

function fallbackStringWidth(text: string): number {
  if (!graphemeSegmenter) {
    let length = 0
    for (const character of text) length += defaultWcwidth(character.codePointAt(0)!)
    return length
  }
  let length = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    let clusterWidth = 0
    for (const character of segment) clusterWidth = Math.max(clusterWidth, defaultWcwidth(character.codePointAt(0)!))
    length += clusterWidth
  }
  return length
}

function firstWordLength(text: string, stringWidth: StringWidth): number {
  return stringWidth(text.match(/^\S*/)?.[0] ?? '')
}

function lastWordLength(text: string, stringWidth: StringWidth): number {
  return stringWidth(text.match(/\S+$/)?.[0] ?? '')
}

function joinKind(previous: string, next: string, shownLength: number, width: number, stringWidth: StringWidth): 'mid-token' | 'word-wrap' | 'newline' {
  if (!previous || !next || previous.endsWith('\\')) return 'newline'

  const firstWord = firstWordLength(next, stringWidth)
  if (shownLength >= width) {
    return lastWordLength(previous, stringWidth) + firstWord > width ? 'mid-token' : 'word-wrap'
  }
  return shownLength + 1 + firstWord > width ? 'word-wrap' : 'newline'
}

function hasAgentIndent(text: string): boolean {
  let lines = text.split('\n').map((line) => line.trimEnd())
  while (lines[0] === '') lines = lines.slice(1)
  while (lines.at(-1) === '') lines = lines.slice(0, -1)
  if (lines.length === 0) return false

  const continuationIndents = lines.slice(1).filter((line) => line !== '').map(leadingSpaces)
  const continuationIndent = Math.min(...continuationIndents)
  const partialFirstLine = Number.isFinite(continuationIndent) && leadingSpaces(lines[0]!) < continuationIndent
  const indent = partialFirstLine
    ? continuationIndent
    : Math.min(...lines.filter((line) => line !== '').map(leadingSpaces))
  return indent >= AGENT_INDENT
}

function isCompleteFrameRow(row: string): boolean {
  return row.startsWith(BOX_LEFT) && row.endsWith(BOX_RIGHT)
}

/**
 * `firstRowFull` is the whole screen row holding the selection's first line:
 * a partial first row does not say at which column it starts, so only that
 * row can prove its right border when the selection has no complete row.
 */
export function stripBoxFrame(
  text: string,
  width: number,
  stringWidth: StringWidth = fallbackStringWidth,
  firstRowFull?: string
): { text: string; frameWidth: number } {
  if (!Number.isFinite(width) || !Number.isInteger(width) || width <= 0) return { text, frameWidth: 0 }

  const rows = text.replaceAll(`${BOX_RIGHT}${BOX_LEFT}`, `${BOX_RIGHT}\n${BOX_LEFT}`).split('\n')
  const hasFrame = rows.every((row, index) => (
    (index === 0 || row.startsWith(BOX_LEFT)) &&
    (index === rows.length - 1 || row.endsWith(BOX_RIGHT))
  ))
  if (!hasFrame) return { text, frameWidth: 0 }

  const completeRows = rows.filter(isCompleteFrameRow)
  const verifiedRows = completeRows.length > 0
    ? completeRows
    : firstRowFull !== undefined && isCompleteFrameRow(firstRowFull) && firstRowFull.endsWith(rows[0]!)
      ? [firstRowFull]
      : []
  if (verifiedRows.length === 0) return { text, frameWidth: 0 }

  const rightColumns = verifiedRows.map((row) => stringWidth(row) - stringWidth(BOX_VERTICAL))
  const expectedRightColumn = width - 1
  if (!rightColumns.every((column) => column === expectedRightColumn)) return { text, frameWidth: 0 }

  const stripped = rows.map((row) => {
    const withoutLeft = row.startsWith(BOX_LEFT) ? row.slice(BOX_LEFT.length) : row
    const withoutFrame = withoutLeft.endsWith(BOX_RIGHT) ? withoutLeft.slice(0, -BOX_RIGHT.length) : withoutLeft
    return withoutFrame.trimEnd()
  }).join('\n')
  return hasAgentIndent(stripped) ? { text: stripped, frameWidth: BOX_FRAME_WIDTH } : { text, frameWidth: 0 }
}

export function normalizeTerminalSelection(text: string, width: number, options: NormalizeOptions = {}): string {
  const frame = stripBoxFrame(text, width, options.stringWidth ?? fallbackStringWidth, options.firstRowFull)
  text = frame.text
  width -= frame.frameWidth
  let lines = text.split('\n').map((line) => line.trimEnd())
  while (lines[0] === '') lines = lines.slice(1)
  while (lines.at(-1) === '') lines = lines.slice(0, -1)
  if (lines.length === 0) return ''

  const continuationIndents = lines.slice(1).filter((line) => line !== '').map(leadingSpaces)
  const continuationIndent = Math.min(...continuationIndents)
  const partialFirstLine = Number.isFinite(continuationIndent) && leadingSpaces(lines[0]!) < continuationIndent
  const indent = partialFirstLine
    ? continuationIndent
    : Math.min(...lines.filter((line) => line !== '').map(leadingSpaces))
  if (options.requireAgentIndent && indent < AGENT_INDENT) return text
  lines = lines.map((line) => line.slice(Math.min(indent, leadingSpaces(line))))

  const wrapWidth = width - indent
  if (lines.length < 2 || wrapWidth < MINIMUM_PLAUSIBLE_WIDTH) return lines.join('\n')

  const stringWidth = options.stringWidth ?? fallbackStringWidth
  let output = lines[0]!
  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1]!
    const next = lines[index]!
    const join = joinKind(previous, next, stringWidth(previous), wrapWidth, stringWidth)
    output += join === 'mid-token' ? next : join === 'word-wrap' ? ` ${next}` : `\n${next}`
  }
  return output
}
