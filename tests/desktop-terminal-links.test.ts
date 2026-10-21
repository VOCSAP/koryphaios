import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'

GlobalRegistrator.register()

afterEach(() => document.querySelectorAll('.terminal-link-tooltip').forEach((tooltip) => tooltip.remove()))
afterAll(async () => GlobalRegistrator.unregister())
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/xterm'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { logicalLine } from '../desktop/src/shared/link-detect'
import { installTerminalLinks, type LinkNotice, type LinkTerminal } from '../desktop/src/renderer/src/terminal-links'
import { createSessionTerminal } from '../desktop/src/renderer/src/terminal-focus-report'
import type { ImagePreviewResult, LinkIntent, LinkOutcome } from '../desktop/src/shared/types'

interface LinkRig {
  provide(bufferLine: number): ILink[]
  handler: NonNullable<LinkTerminal['options']['linkHandler']>
  opened: { target: string; intent: LinkIntent }[]
  previews: string[]
  refused: LinkNotice[]
  reports: string[]
  dispose(): void
}

interface RigOptions {
  fileLinks?: boolean
  outcome?: () => Promise<LinkOutcome>
  preview?: (target: string) => Promise<ImagePreviewResult>
}

const NO_PREVIEW: ImagePreviewResult = { ok: false, reason: 'unavailable' }

type TerminalView = Pick<LinkTerminal, 'cols' | 'buffer'>

function rigOver(view: TerminalView, opts: RigOptions): LinkRig {
  const opened: LinkRig['opened'] = []
  const previews: string[] = []
  const refused: LinkNotice[] = []
  const reports: string[] = []
  let provider: ILinkProvider | undefined
  const term: LinkTerminal = {
    cols: view.cols,
    options: {},
    buffer: view.buffer,
    registerLinkProvider: (p) => ((provider = p), { dispose() {} })
  }
  const gate = installTerminalLinks(term, {
    open: async (target, intent) => {
      opened.push({ target, intent })
      return opts.outcome ? opts.outcome() : { ok: true }
    },
    preview: async (target) => {
      previews.push(target)
      return opts.preview ? opts.preview(target) : NO_PREVIEW
    },
    onRefused: (reason) => refused.push(reason),
    report: (m) => reports.push(m),
    fileLinks: () => opts.fileLinks ?? true,
    label: (key) => key
  })
  return {
    provide: (line) => {
      let out: ILink[] = []
      provider!.provideLinks(line, (links) => (out = links ?? []))
      return out
    },
    handler: term.options.linkHandler!,
    opened,
    previews,
    refused,
    reports,
    dispose: gate.dispose
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
const hover = (clientX: number, clientY: number): MouseEvent => ({ clientX, clientY }) as MouseEvent
const tooltipLines = (): string[] | undefined =>
  document.querySelector<HTMLElement>('.terminal-link-tooltip')?.textContent?.split('\n')

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

  test('Shift+click reveals and Ctrl+Shift+click opens: xterm keeps a Shift click from the application, the link still acts', async () => {
    const rig = linkRig(['edit /work/src/a.ts'], 80)
    const [link] = rig.provide(1)
    link!.activate({ button: 0, shiftKey: true, ctrlKey: false, metaKey: false } as MouseEvent, link!.text)
    link!.activate({ button: 0, shiftKey: true, ctrlKey: true, metaKey: false } as MouseEvent, link!.text)
    await tick()
    expect(rig.opened).toEqual([
      { target: '/work/src/a.ts', intent: 'reveal' },
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

  test('hovering an OSC 8 link shows its target and gestures, then leave removes the tooltip', () => {
    const rig = linkRig([], 80)
    const target = 'https://example.com/actual-target'
    rig.handler.hover?.(hover(40, 50), target, {} as never)
    expect(tooltipLines(), 'main opens a web target in the browser whatever the intent').toEqual([target, 'tile.linkBrowser', 'tile.linkShift'])
    rig.handler.leave?.(hover(40, 50), target, {} as never)
    expect(document.querySelector('.terminal-link-tooltip')).toBeNull()
    rig.handler.hover?.(hover(40, 50), 'file:///C:/proj/a.md', {} as never)
    expect(tooltipLines()).toEqual(['file:///C:/proj/a.md', 'tile.linkReveal', 'tile.linkOpen', 'tile.linkShift'])
  })

  test('hovering a detected path shows the target main receives, not the printed text, and leave removes the tooltip', () => {
    const rig = linkRig(['edit /work/src/a.ts:12'], 80)
    const [link] = rig.provide(1)
    expect(link!.text, 'the premise: the printed text carries a line suffix the target drops').toBe('/work/src/a.ts:12')
    link!.hover?.(hover(40, 50), link!.text)
    expect(tooltipLines()?.[0]).toBe('/work/src/a.ts')
    link!.leave?.(hover(40, 50), link!.text)
    expect(document.querySelector('.terminal-link-tooltip')).toBeNull()
  })

  test('hovering a second link without a leave in between keeps a single tooltip, showing the second target', () => {
    const rig = linkRig([], 80)
    rig.handler.hover?.(hover(40, 50), 'https://example.com/first', {} as never)
    rig.handler.hover?.(hover(60, 50), 'https://example.com/second', {} as never)
    expect(document.querySelectorAll('.terminal-link-tooltip')).toHaveLength(1)
    expect(tooltipLines()?.[0]).toBe('https://example.com/second')
  })

  test('disposing the link gate removes a visible tooltip', () => {
    let provider: ILinkProvider | undefined
    const term: LinkTerminal = {
      cols: 80,
      options: {},
      buffer: { active: { getLine: () => undefined } },
      registerLinkProvider: (p) => ((provider = p), { dispose() {} })
    }
    const gate = installTerminalLinks(term, { open: async () => ({ ok: true }), preview: async () => NO_PREVIEW, onRefused() {}, report() {}, fileLinks: () => true, label: (k) => k })
    expect(provider).toBeDefined()
    term.options.linkHandler!.hover?.(hover(40, 50), 'https://example.com/x', {} as never)
    expect(document.querySelector('.terminal-link-tooltip')).not.toBeNull()
    gate.dispose()
    expect(document.querySelector('.terminal-link-tooltip')).toBeNull()
  })

  test('on a sandbox tile a file target names the refusal instead of the click gestures, a web target still opens in the browser', () => {
    const rig = linkRig([], 80, { fileLinks: false })
    rig.handler.hover?.(hover(40, 50), 'file:///a/b', {} as never)
    expect(tooltipLines()).toEqual(['file:///a/b', 'tile.linkSandbox'])
    rig.handler.hover?.(hover(40, 50), 'https://example.com/x', {} as never)
    expect(tooltipLines()).toEqual(['https://example.com/x', 'tile.linkBrowser', 'tile.linkShift'])
  })

  test('the tooltip keeps a link target as text rather than markup', () => {
    const rig = linkRig([], 80)
    const target = '<img src=x onerror=alert(1)>'
    rig.handler.hover?.(hover(40, 50), target, {} as never)
    const tooltip = document.querySelector<HTMLElement>('.terminal-link-tooltip')
    expect(tooltip!.textContent).toContain(target)
    expect(tooltip!.querySelector('img')).toBeNull()
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

describe('image preview in the link tooltip', () => {
  const DATA = 'data:image/png;base64,AAAA'
  const shown = (width = 40, height = 30): ImagePreviewResult => ({ ok: true, dataUrl: DATA, width, height })
  const tooltips = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.terminal-link-tooltip')]
  const images = (): HTMLImageElement[] => [...document.querySelectorAll<HTMLImageElement>('.terminal-link-preview')]
  const notes = (): (string | null)[] => [...document.querySelectorAll('.terminal-link-preview-note')].map((n) => n.textContent)

  function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
    return { promise, resolve, reject }
  }

  test('hovering an image path asks main once and puts the image in the one tooltip, after a loading note', async () => {
    const answer = deferred<ImagePreviewResult>()
    const rig = linkRig(['see /work/a.png'], 80, { preview: () => answer.promise })
    const [link] = rig.provide(1)
    link!.hover?.(hover(40, 50), link!.text)
    expect(rig.previews).toEqual(['/work/a.png'])
    expect(notes()).toEqual(['tile.linkPreviewLoading'])

    answer.resolve(shown(40, 30))
    await tick()

    expect(tooltips()).toHaveLength(1)
    expect(images().map((i) => i.getAttribute('src'))).toEqual([DATA])
    expect([images()[0]!.getAttribute('width'), images()[0]!.getAttribute('height')]).toEqual(['40', '30'])
    expect(notes()).toEqual([])
    expect(tooltipLines()?.[0], 'the target stays the first line').toBe('/work/a.png')
  })

  test('an OSC 8 file: link to an image is previewed with the target it carries', async () => {
    const rig = linkRig([], 80, { preview: async () => shown() })
    rig.handler.hover?.(hover(40, 50), 'file:///C:/proj/shot.JPG', {} as never)
    await tick()
    expect(rig.previews).toEqual(['file:///C:/proj/shot.JPG'])
    expect(images()).toHaveLength(1)
  })

  test.each([
    ['a web URL ending in .png', 'https://example.com/a.png', true],
    ['a file that is not a PNG or a JPEG', 'file:///work/a.gif', true],
    ['a markdown file', 'file:///work/a.md', true],
    ['an image on a sandbox tile', 'file:///work/a.png', false]
  ])('%s is never sent to main for a preview', async (_name, target, fileLinks) => {
    const rig = linkRig([], 80, { fileLinks, preview: async () => shown() })
    rig.handler.hover?.(hover(40, 50), target, {} as never)
    await tick()
    expect(rig.previews).toEqual([])
    expect(images()).toHaveLength(0)
    expect(notes()).toEqual([])
  })

  test('leaving before the answer drops it: the tooltip that asked never receives the image', async () => {
    const answer = deferred<ImagePreviewResult>()
    const rig = linkRig([], 80, { preview: () => answer.promise })
    rig.handler.hover?.(hover(40, 50), 'file:///work/a.png', {} as never)
    const host = tooltips()[0]!
    rig.handler.leave?.(hover(40, 50), 'file:///work/a.png', {} as never)

    answer.resolve(shown())
    await tick()

    expect(host.querySelector('img'), 'the answer reached a tooltip the operator already left').toBeNull()
    expect(tooltips()).toHaveLength(0)
  })

  test('disposing the gate before the answer drops it, and a rejection after the dispose is still traced', async () => {
    const answer = deferred<ImagePreviewResult>()
    const rig = linkRig([], 80, { preview: () => answer.promise })
    rig.handler.hover?.(hover(40, 50), 'file:///work/a.png', {} as never)
    const host = tooltips()[0]!
    rig.dispose()

    answer.reject(new Error('ipc down'))
    await tick()

    expect(host.querySelector('.terminal-link-preview-note')?.textContent, 'no state is painted on a disposed tooltip').toBe('tile.linkPreviewLoading')
    expect(rig.reports).toEqual(['image preview failed: ipc down'])
  })

  test('a late answer never lands in the tooltip of a newer hover', async () => {
    const first = deferred<ImagePreviewResult>()
    const rig = linkRig([], 80, { preview: (t) => (t.endsWith('first.png') ? first.promise : Promise.resolve(shown(9, 9))) })
    rig.handler.hover?.(hover(40, 50), 'file:///work/first.png', {} as never)
    rig.handler.hover?.(hover(60, 50), 'https://example.com/page', {} as never)

    first.resolve(shown())
    await tick()

    expect(tooltips()).toHaveLength(1)
    expect(images(), 'the newer tooltip is a web link: it has no image').toHaveLength(0)
  })

  test('hovers that pile up behind a pending request are reduced to the last one, requested after the first answer', async () => {
    const first = deferred<ImagePreviewResult>()
    const rig = linkRig([], 80, { preview: (t) => (t.endsWith('a.png') ? first.promise : Promise.resolve(shown(7, 7))) })
    for (const name of ['a', 'b', 'c']) rig.handler.hover?.(hover(40, 50), `file:///work/${name}.png`, {} as never)
    expect(rig.previews, 'one request at a time').toEqual(['file:///work/a.png'])

    first.resolve(shown())
    await tick()

    expect(rig.previews, 'b was replaced before it was ever asked').toEqual(['file:///work/a.png', 'file:///work/c.png'])
    expect(images().map((i) => i.getAttribute('width'))).toEqual(['7'])
  })

  test('a waiting hover that was left is not requested', async () => {
    const first = deferred<ImagePreviewResult>()
    const rig = linkRig([], 80, { preview: () => first.promise })
    rig.handler.hover?.(hover(40, 50), 'file:///work/a.png', {} as never)
    rig.handler.hover?.(hover(40, 50), 'file:///work/b.png', {} as never)
    rig.handler.leave?.(hover(40, 50), 'file:///work/b.png', {} as never)

    first.resolve(shown())
    await tick()

    expect(rig.previews).toEqual(['file:///work/a.png'])
  })

  test('an unavailable answer says so in the tooltip, and a busy one says nothing', async () => {
    const unavailable = linkRig([], 80, { preview: async () => ({ ok: false, reason: 'unavailable' }) })
    unavailable.handler.hover?.(hover(40, 50), 'file:///work/a.png', {} as never)
    await tick()
    expect(notes()).toEqual(['tile.linkPreviewUnavailable'])
    expect(images()).toHaveLength(0)
    unavailable.handler.leave?.(hover(40, 50), 'file:///work/a.png', {} as never)

    const busy = linkRig([], 80, { preview: async () => ({ ok: false, reason: 'busy' }) })
    busy.handler.hover?.(hover(40, 50), 'file:///work/a.png', {} as never)
    await tick()
    expect(notes()).toEqual([])
    expect(images()).toHaveLength(0)
  })

  test('a failed call is traced, shown as unavailable, and never raised as a toast', async () => {
    const rig = linkRig([], 80, { preview: () => Promise.reject(new Error('ipc down')) })
    rig.handler.hover?.(hover(40, 50), 'file:///work/a.png', {} as never)
    await tick()
    expect(rig.reports).toEqual(['image preview failed: ipc down'])
    expect(notes()).toEqual(['tile.linkPreviewUnavailable'])
    expect(rig.refused, 'a hover is not a user action: no toast').toEqual([])
  })

  test('an image the renderer cannot decode is traced and replaced by the unavailable note', async () => {
    const rig = linkRig([], 80, { preview: async () => shown() })
    rig.handler.hover?.(hover(40, 50), 'file:///work/a.png', {} as never)
    await tick()
    images()[0]!.dispatchEvent(new Event('error'))
    expect(rig.reports).toHaveLength(1)
    expect(rig.reports[0]).toContain('could not be decoded')
    expect(images()).toHaveLength(0)
    expect(notes()).toEqual(['tile.linkPreviewUnavailable'])
  })

  test('the tooltip is moved back inside the viewport once the image has made it larger', async () => {
    const measure = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 200 }) as DOMRect
    try {
      const rig = linkRig([], 80, { preview: async () => shown() })
      rig.handler.hover?.(hover(window.innerWidth - 10, window.innerHeight - 10), 'file:///work/a.png', {} as never)
      await tick()
      const host = tooltips()[0]!
      expect(host.style.getPropertyValue('--terminal-link-tooltip-x')).toBe(`${window.innerWidth - 300 - 8}px`)
      expect(host.style.getPropertyValue('--terminal-link-tooltip-y')).toBe(`${window.innerHeight - 200 - 8}px`)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = measure
    }
  })

  test('the box is measured at left 0, because a fixed box narrows with its left edge, then clamped to the right edge', async () => {
    const measure = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const left = Number.parseFloat(this.style.getPropertyValue('--terminal-link-tooltip-x'))
      return { width: Math.min(480, window.innerWidth - left), height: 200 } as DOMRect
    }
    try {
      for (const withImage of [true, false]) {
        const rig = linkRig([], 80, { preview: async () => (withImage ? shown() : { ok: false, reason: 'unavailable' }) })
        rig.handler.hover?.(hover(window.innerWidth - 10, 100), 'file:///work/a.png', {} as never)
        await tick()
        expect(tooltips()[0]!.style.getPropertyValue('--terminal-link-tooltip-x'), `image: ${withImage}`).toBe(
          `${window.innerWidth - 480 - 8}px`
        )
        rig.handler.leave?.(hover(0, 0), 'file:///work/a.png', {} as never)
      }
    } finally {
      HTMLElement.prototype.getBoundingClientRect = measure
    }
  })

  test('a click on an image link is unchanged: it reveals and asks for no preview', async () => {
    const rig = linkRig(['see /work/a.png'], 80)
    rig.provide(1)[0]!.activate(click(false), '/work/a.png')
    await tick()
    expect(rig.opened).toEqual([{ target: '/work/a.png', intent: 'reveal' }])
    expect(rig.previews).toEqual([])
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

  test('disposing a session terminal removes the link tooltip it is showing', () => {
    const term = createSessionTerminal({ allowProposedApi: true }, () => {}, {
      open: async () => ({ ok: true }),
      preview: async () => NO_PREVIEW,
      onRefused() {},
      report() {},
      fileLinks: () => true,
      label: (k) => k
    })
    term.options.linkHandler!.hover?.(hover(40, 50), 'https://example.com/x', {} as never)
    expect(document.querySelector('.terminal-link-tooltip')).not.toBeNull()
    term.dispose()
    expect(document.querySelector('.terminal-link-tooltip')).toBeNull()
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
