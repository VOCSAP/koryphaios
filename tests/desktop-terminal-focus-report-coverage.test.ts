import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const RENDERER_ROOT = join(import.meta.dir, '..', 'desktop', 'src', 'renderer')
const SPECIFIER = '@xterm/xterm'
const FACTORY = 'src/terminal-focus-report.ts'
const EXEMPTIONS: Readonly<Record<string, string>> = {
  'src/components/SandboxTerminal.tsx': 'utility PTYs with no tracked session, so no activity predicate reads them'
}

// Only these two statement shapes are proven to carry no runtime Terminal; any
// other occurrence of the specifier, comments and strings included, counts as a
// value import. Comments are not stripped: a lexer that desyncs would erase a
// real import, and this guard must fail closed.
const NON_VALUE_FORMS: readonly RegExp[] = [
  /^[ \t]*import[ \t]+type[ \t]*\{[^{}'"`]*\}[ \t]*from[ \t]*'@xterm\/xterm'[ \t]*;?[ \t]*$/gm,
  /^[ \t]*import[ \t]*'@xterm\/xterm\/css\/xterm\.css'[ \t]*;?[ \t]*$/gm
]

interface SourceFile {
  path: string
  src: string
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function isValueImporter(src: string): boolean {
  const total = countOccurrences(src, SPECIFIER)
  const nonValue = NON_VALUE_FORMS.reduce((sum, form) => sum + [...src.matchAll(form)].length, 0)
  return total > nonValue
}

function auditTerminalImporters(
  files: readonly SourceFile[],
  factory: string,
  exemptions: Readonly<Record<string, string>>
): string[] {
  const violations: string[] = []
  const importers = files.filter((file) => isValueImporter(file.src)).map((file) => file.path)
  if (files.length === 0) violations.push('the renderer scan found no source file, so it guards nothing')
  if (importers.length === 0) violations.push(`no renderer file imports ${SPECIFIER} as a value, so the scan guards nothing`)
  if (!importers.includes(factory)) {
    violations.push(`${factory} must build every session terminal but does not import ${SPECIFIER} as a value`)
  }
  for (const exempt of Object.keys(exemptions)) {
    if (!importers.includes(exempt)) violations.push(`exemption ${exempt} matches no file importing ${SPECIFIER}: stale`)
  }
  for (const path of importers) {
    if (path === factory || exemptions[path] !== undefined) continue
    violations.push(
      `${path} imports ${SPECIFIER} as a value: build session terminals with createSessionTerminal from ${factory}, ` +
        'or the terminal reports focus and the activity predicate reads it idle'
    )
  }
  return violations
}

const FACTORY_EXPORTS = ['FOCUS_REPORTING_MODE', 'createSessionTerminal', 'suppressFocusReporting']
const EXEMPT_EXPORT_FORMS: Readonly<Record<string, RegExp>> = {
  'src/components/SandboxTerminal.tsx': /^export function SandboxTerminal\(/gm
}

// An allowed importer that exports anything else could hand the raw Terminal
// class to another file. Every export token counts, prose and strings included.
function unexpectedExports(src: string, allowed: RegExp): number {
  const tokens = [...src.matchAll(/\bexport\b/g)].length
  return tokens - [...src.matchAll(allowed)].length
}

function listSources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...listSources(full))
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) found.push(full)
  }
  return found
}

function rendererSources(): SourceFile[] {
  return listSources(RENDERER_ROOT).map((full) => ({
    path: relative(RENDERER_ROOT, full).split(sep).join('/'),
    src: readFileSync(full, 'utf-8')
  }))
}

const FACTORY_SRC = `import { Terminal } from '${SPECIFIER}'\nexport function createSessionTerminal() { return new Terminal() }`
const EXEMPT_SRC = `import { Terminal, type ITheme } from '${SPECIFIER}'`
const baseline = (): SourceFile[] => [
  { path: FACTORY, src: FACTORY_SRC },
  { path: 'src/components/SandboxTerminal.tsx', src: EXEMPT_SRC },
  { path: 'src/components/TerminalTile.tsx', src: `import type { ITheme, Terminal } from '${SPECIFIER}'` }
]
const audit = (files: readonly SourceFile[]): string[] => auditTerminalImporters(files, FACTORY, EXEMPTIONS)
const withFile = (src: string): SourceFile[] => [...baseline(), { path: 'src/components/Rogue.tsx', src }]

describe('terminal importers in the real renderer tree', () => {
  test('only the factory and the named exemption import @xterm/xterm as a value', () => {
    const files = rendererSources()
    expect(existsSync(join(RENDERER_ROOT, FACTORY)), `${FACTORY} is missing`).toBe(true)
    expect(audit(files)).toEqual([])
  })

  test('the factory exports no xterm value, so no file can build an unguarded Terminal through it', async () => {
    const factory = await import('../desktop/src/renderer/src/terminal-focus-report')
    expect(Object.keys(factory).sort(), `${FACTORY} must not re-export the Terminal class or a value bound to it`).toEqual(
      FACTORY_EXPORTS
    )
  })

  test('each exempt importer exports only its own component', () => {
    expect(Object.keys(EXEMPT_EXPORT_FORMS).sort()).toEqual(Object.keys(EXEMPTIONS).sort())
    for (const [path, allowed] of Object.entries(EXEMPT_EXPORT_FORMS)) {
      const src = readFileSync(join(RENDERER_ROOT, path), 'utf-8')
      expect([...src.matchAll(allowed)], `${path} lost its own component export: the form is stale`).toHaveLength(1)
      expect(unexpectedExports(src, allowed), `${path} exports something besides its component`).toBe(0)
    }
  })
})

describe('unexpectedExports', () => {
  const allowed = /^export function SandboxTerminal\(/gm
  const component = 'export function SandboxTerminal() {}'

  test('accepts the component alone and ignores words that merely start with export', () => {
    expect(unexpectedExports(`${component}\n// exported once, exports nothing else`, allowed)).toBe(0)
  })

  const leaks: Array<[string, string]> = [
    ['named re-export', 'export { Terminal }'],
    ['star re-export', `export * from '${SPECIFIER}'`],
    ['re-export from the module', `export { Terminal } from '${SPECIFIER}'`],
    ['bound variable', 'export const Xt = Terminal'],
    ['default export', 'export default Terminal']
  ]
  for (const [label, line] of leaks) {
    test(`counts a ${label}`, () => {
      expect(unexpectedExports(`${component}\n${line}`, allowed)).toBe(1)
    })
  }
})

describe('auditTerminalImporters', () => {
  test('a compliant tree has no violation', () => {
    expect(audit(baseline())).toEqual([])
  })

  const valueForms: Array<[string, string]> = [
    ['named', `import { Terminal } from '${SPECIFIER}'`],
    ['aliased', `import { Terminal as Xt } from '${SPECIFIER}'`],
    ['namespace', `import * as xterm from '${SPECIFIER}'`],
    ['default', `import xterm from '${SPECIFIER}'`],
    ['mixed inline type', `import { type ITheme, Terminal } from '${SPECIFIER}'`],
    ['type-only default, not recognised', `import type Xt from '${SPECIFIER}'`],
    ['re-export', `export { Terminal } from '${SPECIFIER}'`],
    ['dynamic import', `const { Terminal } = await import('${SPECIFIER}')`],
    ['require', `const { Terminal } = require("${SPECIFIER}")`],
    ['specifier held in a string', `const spec = ['@xterm', 'xterm'].join('/') || '${SPECIFIER}'`],
    ['type import on a line with other code', `import type { Terminal } from '${SPECIFIER}'; import('${SPECIFIER}')`]
  ]
  for (const [label, src] of valueForms) {
    test(`counts a ${label} as a value import`, () => {
      expect(audit(withFile(src))).toEqual([expect.stringContaining('src/components/Rogue.tsx imports @xterm/xterm')])
    })
  }

  test('ignores a type-only named import and the stylesheet import', () => {
    const ok = withFile(`import type {\n  ITheme,\n  Terminal\n} from '${SPECIFIER}'\nimport '${SPECIFIER}/css/xterm.css'`)
    expect(audit(ok)).toEqual([])
  })

  test('fails closed when the factory no longer imports the terminal', () => {
    const files = baseline().map((file) => (file.path === FACTORY ? { ...file, src: 'export {}' } : file))
    expect(audit(files)).toEqual([expect.stringContaining(`${FACTORY} must build every session terminal`)])
  })

  test('fails closed when the exemption no longer matches a file', () => {
    const files = baseline().map((file) =>
      file.path === 'src/components/SandboxTerminal.tsx' ? { ...file, path: 'src/components/ShellTerminal.tsx' } : file
    )
    expect(audit(files)).toEqual([
      expect.stringContaining('exemption src/components/SandboxTerminal.tsx matches no file'),
      expect.stringContaining('src/components/ShellTerminal.tsx imports @xterm/xterm')
    ])
  })

  test('fails closed on an empty scan', () => {
    expect(audit([])).toEqual([
      expect.stringContaining('found no source file'),
      expect.stringContaining('no renderer file imports'),
      expect.stringContaining(`${FACTORY} must build every session terminal`),
      expect.stringContaining('exemption src/components/SandboxTerminal.tsx matches no file')
    ])
  })
})
