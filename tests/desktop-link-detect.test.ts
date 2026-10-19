import { describe, expect, test } from 'bun:test'
import { detectLinks, locate, logicalLine } from '../desktop/src/shared/link-detect'

const targets = (text: string): string[] => detectLinks(text).map((l) => l.target)

describe('detectLinks', () => {
  test('finds a home path, an absolute POSIX path, a Windows path and a URL in one line', () => {
    expect(targets('see ~/.claude/plugins and /usr/local/bin/x then C:\\Users\\op\\a.md or https://example.com/a')).toEqual([
      '~/.claude/plugins',
      '/usr/local/bin/x',
      'C:\\Users\\op\\a.md',
      'https://example.com/a'
    ])
  })

  test('trailing punctuation and a :line:col suffix stay out of the target but the suffix stays in the clickable text', () => {
    const [link] = detectLinks('open (src/x) at /work/src/a.ts:42:7.')
    expect(link?.target).toBe('/work/src/a.ts')
    const text = 'open (src/x) at /work/src/a.ts:42:7.'
    expect(text.slice(link!.start, link!.end)).toBe('/work/src/a.ts:42:7')
  })

  test('a URL scheme is recognized in any letter case, as main and the activation gate do', () => {
    expect(targets('see HTTPS://x.com/a now')).toEqual(['HTTPS://x.com/a'])
  })

  test('a slash command, a fraction and a bare drive letter are not paths', () => {
    expect(targets('/help and and/or 1/2 C: done')).toEqual([])
  })

  test('the path inside a URL is not reported a second time', () => {
    expect(targets('https://example.com/usr/local/bin')).toEqual(['https://example.com/usr/local/bin'])
  })

  test('a path in a URL query string is part of the URL, not a second link', () => {
    expect(targets('https://x.com/?f=/usr/local/bin')).toEqual(['https://x.com/?f=/usr/local/bin'])
  })

  test('a path directly after a word character is not a path start', () => {
    expect(targets('abc/def/ghi')).toEqual([])
    expect(targets('xC:\\a\\b')).toEqual([])
    expect(targets('foo~/bar')).toEqual([])
  })
})

describe('logicalLine', () => {
  const rows = ['intro line', '/work/very/long/pa', 'th/to/file.md', '', 'next']

  test('a full-width row continues into a row that starts on text', () => {
    const line = logicalLine((r) => rows[r], 1, 18)
    expect(line.text).toBe('/work/very/long/path/to/file.md')
    expect(line.segments.map((s) => s.row)).toEqual([1, 2])
  })

  test('asking from the continuation row yields the same logical line', () => {
    expect(logicalLine((r) => rows[r], 2, 18).text).toBe('/work/very/long/path/to/file.md')
  })

  test('a row shorter than the width, or followed by an indented or empty row, is not joined', () => {
    expect(logicalLine((r) => rows[r], 0, 18).segments.map((s) => s.row)).toEqual([0])
    expect(logicalLine((r) => ['aaaa', ' bbbb'][r], 0, 4).segments.map((s) => s.row)).toEqual([0])
    expect(logicalLine((r) => ['aaaa', ''][r], 0, 4).segments.map((s) => s.row)).toEqual([0])
  })

  test('a row flagged as wrapped joins the row above, whatever its width or its first character', () => {
    const short = ['/work/very/long/p', '  ath/to/file.md']
    const wrapped = (r: number): boolean => r === 1
    expect(logicalLine((r) => short[r], 1, 18, wrapped).segments.map((s) => s.row)).toEqual([0, 1])
    expect(logicalLine((r) => short[r], 0, 18, wrapped).segments.map((s) => s.row)).toEqual([0, 1])
    expect(logicalLine((r) => short[r], 0, 18).segments.map((s) => s.row), 'unflagged, the same rows stay apart').toEqual([0])
  })

  test('a row that ends on a blank is not full width, so nothing is joined to it', () => {
    expect(logicalLine((r) => ['abc ', 'def'][r], 0, 4).segments.map((s) => s.row)).toEqual([0])
  })

  test('joining is bounded so a wall of full-width rows cannot grow without limit', () => {
    const wall = (r: number): string | undefined => (r < 100 ? 'abcd' : undefined)
    expect(logicalLine(wall, 50, 4).segments.length).toBeLessThanOrEqual(33)
  })

  test('locate maps an offset back to its buffer row and column', () => {
    const line = logicalLine((r) => rows[r], 1, 18)
    expect(locate(line, 0)).toEqual({ row: 1, col: 0 })
    expect(locate(line, 18)).toEqual({ row: 2, col: 0 })
    expect(locate(line, 20)).toEqual({ row: 2, col: 2 })
  })
})
