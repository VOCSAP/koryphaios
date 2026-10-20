import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/xterm'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { logicalLine } from '../desktop/src/shared/link-detect'
import { installTerminalLinks, type LinkNotice, type LinkTerminal } from '../desktop/src/renderer/src/terminal-links'
import type { LinkIntent, LinkOutcome } from '../desktop/src/shared/types'

interface LinkRig {
  provide(bufferLine: number): ILink[]
  handler: NonNullable<LinkTerminal['options']['linkHandler']>
  opened: { target: string; intent: LinkIntent }[]
  refused: LinkNotice[]
  reports: string[]
}

interface RigOptions {
  fileLinks?: boolean
  outcome?: () => Promise<LinkOutcome>
}

type TerminalView = Pick<LinkTerminal, 'cols' | 'buffer'>

function rigOver(view: TerminalView, opts: RigOptions): LinkRig {
  const opened: LinkRig['opened'] = []
  const refused: LinkNotice[] = []
  const reports: string[] = []
  let provider: ILinkProvider | undefined
  const term: LinkTerminal = {
    cols: view.cols,
    options: {},
    buffer: view.buffer,
    registerLinkProvider: (p) => ((provider = p), { dispose() {} })
  }
  installTerminalLinks(term, {
    open: async (target, intent) => {
      opened.push({ target, intent })
      return opts.outcome ? opts.outcome() : { ok: true }
    },
    onRefused: (reason) => refused.push(reason),
    report: (m) => reports.push(m),
    fileLinks: () => opts.fileLinks ?? true
  })
  return {
    provide: (line) => {
      let out: ILink[] = []
      provider!.provideLinks(line, (links) => (out = links ?? []))
      return out
    },
    handler: term.options.linkHandler!,
    opened,
    refused,
    reports
  }
}

/** `wrapped` lists the 0-based rows xterm flags as a soft wrap of the row above. */
function linkRig(rows: string[], cols: number, opts: RigOptions & { wrapped?: number[] } = {}): LinkRig {
  return rigOver(
    {
      cols,
      buffer: {
        active: {
          getLine: (r) =>
            rows[r] === undefined
              ? undefined
              : {
                  isWrapped: opts.wrapped?.includes(r) ?? false,
                  translateToString: () => rows[r]!,
                  getCell: (x) => (x < rows[r]!.length ? { getChars: () => rows[r]![x]!, getWidth: () => 1 } : undefined)
                }
        }
      }
    },
    opts
  )
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const click = (ctrlKey: boolean, button = 0, metaKey = false): MouseEvent => ({ ctrlKey, metaKey, button }) as MouseEvent

describe('installTerminalLinks', () => {
  test('a path hard-wrapped at the terminal width is one link spanning both rows, on either row', () => {
    const rig = linkRig(['see /work/very/long/pa', 'th/to/file.md'], 22)
    const first = rig.provide(1)
    const second = rig.provide(2)
    expect(first).toHaveLength(1)
    expect(first[0]!.text).toBe('/work/very/long/path/to/file.md')
    expect(first[0]!.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 13, y: 2 } })
    expect(second[0]!.range).toEqual(first[0]!.range)
  })

  test('a row xterm flags as wrapped joins the row above even when that one stops short of the width', () => {
    // A wide character that does not fit in the last column makes xterm wrap one cell early.
    const rows = ['see /work/very/long/p', 'ath/to/file.md']
    expect(linkRig(rows, 22, { wrapped: [1] }).provide(1)[0]!.text).toBe('/work/very/long/path/to/file.md')
    expect(linkRig(rows, 22).provide(1)[0]!.text, 'the width heuristic alone does not see this wrap').toBe('/work/very/long/p')
  })

  test('a quoted path with spaces, Windows or Git Bash form, is one link to the whole path on a tile with file links', async () => {
    const rig = linkRig(['open "D:\\a b\\c.md" or "/d/a b/c.md" now'], 80)
    const links = rig.provide(1)
    expect(links.map((l) => l.text)).toEqual(['D:\\a b\\c.md', '/d/a b/c.md'])
    expect(links[0]!.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 17, y: 1 } })
    links[1]!.activate(click(false), links[1]!.text)
    await tick()
    expect(rig.opened).toEqual([{ target: '/d/a b/c.md', intent: 'reveal' }])
  })

  test('click reveals, Ctrl+click opens, Cmd+click opens, and the target sent to main is the path without the :line suffix', async () => {
    const rig = linkRig(['edit /work/src/a.ts:42'], 80)
    const [link] = rig.provide(1)
    link!.activate(click(false), link!.text)
    link!.activate(click(true), link!.text)
    link!.activate(click(false, 0, true), link!.text)
    await tick()
    expect(rig.opened).toEqual([
      { target: '/work/src/a.ts', intent: 'reveal' },
      { target: '/work/src/a.ts', intent: 'open' },
      { target: '/work/src/a.ts', intent: 'open' }
    ])
  })

  test.each([1, 2])('a click with button %i (middle, right) never activates a link: it belongs to copy and paste', async (button) => {
    const rig = linkRig(['edit /work/src/a.ts'], 80)
    rig.provide(1)[0]!.activate(click(false, button), '/work/src/a.ts')
    rig.handler.activate(click(true, button), 'file:///work/src/a.ts', {} as never)
    await tick()
    expect(rig.opened).toEqual([])
    expect(rig.refused).toEqual([])
  })

  test('an OSC 8 file: link is forwarded to main as is', async () => {
    const rig = linkRig([], 80)
    rig.handler.activate(click(false), 'file:///C:/proj/a.md', {} as never)
    await tick()
    expect(rig.opened).toEqual([{ target: 'file:///C:/proj/a.md', intent: 'reveal' }])
  })

  test('a refusal from main is surfaced to the operator, and a rejected call is reported then surfaced', async () => {
    const refusing = linkRig(['/a/b'], 80, { outcome: async () => ({ ok: false, reason: 'not-found' }) })
    refusing.provide(1)[0]!.activate(click(false), '/a/b')
    await tick()
    expect(refusing.refused).toEqual(['not-found'])

    const failing = linkRig(['/a/b'], 80, { outcome: () => Promise.reject(new Error('ipc down')) })
    failing.provide(1)[0]!.activate(click(false), '/a/b')
    await tick()
    expect(failing.refused).toEqual(['failed'])
    expect(failing.reports[0]).toContain('ipc down')
  })

  test('on a sandbox tile only http(s) stays clickable: no file link is offered and an OSC 8 file: is refused locally, traced, as a sandbox refusal', async () => {
    const rig = linkRig(['/a/b and https://example.com/x HTTP://EXAMPLE.com/y "C:\\a b\\c.md"'], 80, { fileLinks: false })
    expect(rig.provide(1).map((l) => l.text), 'the scheme is matched without regard to case').toEqual(['https://example.com/x', 'HTTP://EXAMPLE.com/y'])
    rig.handler.activate(click(false), 'file:///a/b', {} as never)
    rig.handler.activate(click(false), 'https://example.com/x', {} as never)
    rig.handler.activate(click(false), 'HTTP://EXAMPLE.com/y', {} as never)
    await tick()
    expect(rig.refused, 'a dedicated reason, not the generic not-allowed of main').toEqual(['sandbox'])
    expect(rig.reports).toHaveLength(1)
    expect(rig.reports[0]).toContain('file:///a/b')
    expect(rig.opened).toEqual([
      { target: 'https://example.com/x', intent: 'reveal' },
      { target: 'HTTP://EXAMPLE.com/y', intent: 'reveal' }
    ])
  })
})

describe('installTerminalLinks over a real xterm buffer', () => {
  const FIXTURE = join(import.meta.dir, 'pty-harness', 'fixtures', 'permission-bash-wrapped-2.1.291.json')

  async function replay(): Promise<Terminal> {
    const chunks = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { t: number; data: string }[]
    // The harness appends a "SNAPSHOT dialog" banner that Claude Code never printed.
    const recorded = chunks.filter((c) => !c.data.startsWith('\n########## '))
    const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write(recorded.map((c) => c.data).join(''), resolve))
    return term
  }

  test('on the recorded Claude Code screen, xterm soft wraps are joined and Claude Code indented hard wraps are not', async () => {
    const term = await replay()
    const buffer = term.buffer.active
    const rowText = (r: number): string | undefined => buffer.getLine(r)?.translateToString(true)
    const wrapped = (r: number): boolean => buffer.getLine(r)?.isWrapped ?? false
    const rowOf = (prefix: string): number => {
      for (let r = 0; r < buffer.length; r++) if (rowText(r)?.startsWith(prefix)) return r
      throw new Error(`no row starts with ${prefix}`)
    }
    const rowsOf = (row: number, withFlag: boolean): number[] =>
      logicalLine(rowText, row, term.cols, withFlag ? wrapped : undefined).segments.map((s) => s.row)

    const prompt = rowOf('❯ Use the Bash tool')
    const echoRows = [prompt, prompt + 1, prompt + 2, prompt + 3]
    expect(rowsOf(prompt + 2, true), 'the typed command is soft-wrapped by xterm into indented rows').toEqual(echoRows)
    expect(rowsOf(prompt, true)).toEqual(echoRows)
    expect(rowsOf(prompt + 2, false), 'the width heuristic alone cannot join an indented continuation').toEqual([prompt + 2])

    for (const header of [rowOf('● Bash(mkdir'), rowOf(' │ mkdir')]) {
      expect(rowsOf(header, true), 'a hard wrap indented by Claude Code is not reconstructible').toEqual([header])
    }
  })

  test('a path longer than the width is one link across the soft-wrapped rows of a real buffer', async () => {
    const term = new Terminal({ cols: 30, rows: 10, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write('see /work/very/long/path/to/some/file.md ok', resolve))
    const rig = rigOver({ cols: term.cols, buffer: term.buffer }, {})
    expect(term.buffer.active.getLine(1)?.isWrapped, 'the premise: xterm itself wrapped the row').toBe(true)
    const [link] = rig.provide(2)
    expect(link!.text).toBe('/work/very/long/path/to/some/file.md')
    expect(link!.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 10, y: 2 } })
  })

  test('the range counts cells: a wide character before the path pushes it right by its two cells', async () => {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write('日本語 /w/x.md', resolve))
    const [link] = rigOver({ cols: term.cols, buffer: term.buffer }, {}).provide(1)
    expect(link!.text).toBe('/w/x.md')
    expect(link!.range, '3 wide characters (6 cells) and a space precede the path').toEqual({ start: { x: 8, y: 1 }, end: { x: 14, y: 1 } })
  })

  test('the range counts the cells a cursor jump leaves empty before the link', async () => {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write(`ab${String.fromCharCode(0x1b)}[3C/work/dir/file.md`, resolve))
    const [link] = rigOver({ cols: term.cols, buffer: term.buffer }, {}).provide(1)
    expect(link!.text).toBe('/work/dir/file.md')
    expect(link!.range, 'two characters and three skipped cells precede the path').toEqual({ start: { x: 6, y: 1 }, end: { x: 22, y: 1 } })
  })

  test.each([
    ['an astral character', '😀 /w/x.md'],
    ['a combining mark', 'é /w/x.md'],
    ['a wide character inside the link', '/w/日.md'],
    ['a wide character as the last one of the link', '/w/日']
  ])('the range follows the cells of the buffer with %s', async (_label, text) => {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write(text, resolve))
    const line = term.buffer.active.getLine(0)!
    const cells = Array.from({ length: term.cols }, (_, x) => ({ chars: line.getCell(x)!.getChars(), width: line.getCell(x)!.getWidth() }))
    const first = cells.findIndex((c) => c.chars === '/')
    // The last cell of the text: a wide character ends on its second, empty, half.
    let last = cells.findLastIndex((c) => c.chars !== '')
    if (cells[last]!.width === 2) last++
    const [link] = rigOver({ cols: term.cols, buffer: term.buffer }, {}).provide(1)
    expect(link!.range).toEqual({ start: { x: first + 1, y: 1 }, end: { x: last + 1, y: 1 } })
  })
})
