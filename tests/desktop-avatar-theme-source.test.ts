import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { BunPlugin } from 'bun'

// The Avatar Tray picks its icon set from shouldUseDarkColorsForSystemIntegratedUI,
// which follows the APP theme as soon as the process forces the theme source.
// Every module the avatar process loads is therefore barred from naming it.

const DESKTOP = join(import.meta.dir, '..', 'desktop')
const AVATAR_ENTRY = join(DESKTOP, 'src', 'main', 'avatar-entry.ts')
const REQUIRED_INPUTS = ['src/main/avatar-entry.ts', 'src/main/avatar-tray.ts', 'src/main/avatar-tray-icon.ts']
const FORBIDDEN = /\bthemeSource\b/
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'avatar-theme-source-')))
  temporaryRoots.push(root)
  return root
}

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

// packages:'external' would externalize every bare specifier, an alias such as
// @shared/* included, dropping a local module from the closure; only the
// project's real packages are external, and its tsconfig paths are resolved.
function declaredPackages(root: string): string[] {
  const manifest = join(root, 'package.json')
  if (!existsSync(manifest)) return []
  const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
}

function resolveSourceFile(base: string): string | undefined {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// Resolve project aliases before external package handling so local modules stay in the closure.
function tsconfigPathsPlugin(tsconfigPath: string): BunPlugin {
  const config = existsSync(tsconfigPath) ? readFileSync(tsconfigPath, 'utf-8') : '{}'
  const { compilerOptions } = JSON.parse(config) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
  const baseDir = resolve(dirname(tsconfigPath), compilerOptions?.baseUrl ?? '.')
  const aliases = Object.entries(compilerOptions?.paths ?? {})
  return {
    name: 'tsconfig-paths',
    setup(build) {
      for (const [pattern, targets] of aliases) {
        const wildcard = pattern.endsWith('*')
        const prefix = wildcard ? pattern.slice(0, -1) : pattern
        build.onResolve({ filter: new RegExp(`^${escapeRegExp(prefix)}${wildcard ? '' : '$'}`) }, (args) => {
          const rest = args.path.slice(prefix.length)
          for (const target of targets) {
            const found = resolveSourceFile(resolve(baseDir, wildcard ? target.replace('*', rest) : target))
            if (found !== undefined) return { path: found }
          }
          throw new Error(`alias ${args.path} matches ${pattern} in ${tsconfigPath} but resolves to no file`)
        })
      }
    }
  }
}

// Bun reports metafile inputs relative to the process cwd, so the build runs
// from inside the root it reports against.
async function closureInputs(root: string, entry: string, tsconfigPath: string): Promise<string[]> {
  const previousCwd = process.cwd()
  process.chdir(root)
  try {
    let result: Awaited<ReturnType<typeof Bun.build>>
    try {
      result = await Bun.build({
        entrypoints: [entry],
        root,
        target: 'node',
        external: ['electron', 'node:*', ...builtinModules, ...declaredPackages(root)],
        plugins: [tsconfigPathsPlugin(tsconfigPath)],
        metafile: true
      })
    } catch (error) {
      throw new Error(`Avatar import closure requires every local import to resolve:\n${error instanceof Error ? error.message : String(error)}`)
    }
    if (!result.success || result.metafile === undefined) {
      throw new Error(`Avatar import closure requires every local import to resolve:\n${result.logs.map((log) => log.message).join('\n')}`)
    }
    return Object.keys(result.metafile.inputs).map((input) => (isAbsolute(input) ? input : resolve(root, input)))
  } finally {
    process.chdir(previousCwd)
  }
}

async function themeSourceViolations(root: string, entry: string, tsconfigPath = join(root, 'tsconfig.node.json')): Promise<{ inputs: string[]; violations: string[] }> {
  const inputs = await closureInputs(root, entry, tsconfigPath)
  const violations = inputs.filter((path) => FORBIDDEN.test(readFileSync(path, 'utf-8'))).map((path) => normalizedRelative(root, path))
  return { inputs: inputs.map((path) => normalizedRelative(root, path)), violations }
}

const UNHANDLED = 'the closure scan does not handle this configuration; extend its resolver before adding it'

function pathPatterns(root: string): string[] {
  const { compilerOptions } = JSON.parse(readFileSync(join(root, 'tsconfig.node.json'), 'utf-8')) as { compilerOptions?: { paths?: Record<string, string[]> } }
  return Object.keys(compilerOptions?.paths ?? {})
}

function patternPrefix(pattern: string): string {
  return pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
}

function overlappingPatterns(patterns: string[]): string[] {
  const overlaps: string[] = []
  for (const a of patterns) {
    for (const b of patterns) {
      if (a !== b && patternPrefix(b).startsWith(patternPrefix(a))) overlaps.push(`${a} also claims ${b}`)
    }
  }
  return overlaps
}

function patternsNamingPackages(patterns: string[], packages: string[]): string[] {
  const clashes: string[] = []
  for (const pattern of patterns) {
    const prefix = patternPrefix(pattern)
    for (const name of packages) {
      const claimed = pattern.endsWith('*') ? name.startsWith(prefix) || prefix.startsWith(`${name}/`) || prefix === name : name === pattern
      if (claimed) clashes.push(`${pattern} claims the declared package ${name}`)
    }
  }
  return clashes
}

test('no tsconfig paths pattern overlaps another, which the alias resolver would match in declaration order', () => {
  const patterns = pathPatterns(DESKTOP)
  expect(patterns.length, 'tsconfig.node.json lost its paths, so this trip-wire checks nothing').toBeGreaterThan(0)
  const overlaps = overlappingPatterns(patterns)
  expect(overlaps, `${UNHANDLED}: ${overlaps.join('; ')}`).toEqual([])
})

test('no tsconfig paths pattern claims a declared package name, whose precedence over external is not pinned', () => {
  const clashes = patternsNamingPackages(pathPatterns(DESKTOP), declaredPackages(DESKTOP))
  expect(clashes, `${UNHANDLED}: ${clashes.join('; ')}`).toEqual([])
})

test('the trip-wires catch an overlapping pattern and an alias named after a package', () => {
  expect(overlappingPatterns(['@shared/*', '@shared/special/*'])).toEqual(['@shared/* also claims @shared/special/*'])
  expect(overlappingPatterns(['@shared/*', '@roadmap-append'])).toEqual([])
  expect(patternsNamingPackages(['ws'], ['ws'])).toEqual(['ws claims the declared package ws'])
  expect(patternsNamingPackages(['ws/*'], ['ws'])).toEqual(['ws/* claims the declared package ws'])
  expect(patternsNamingPackages(['@electron/*'], ['@electron/rebuild'])).toEqual(['@electron/* claims the declared package @electron/rebuild'])
  expect(patternsNamingPackages(['@shared/*'], ['ws', 'selfsigned'])).toEqual([])
})

test('no module the avatar process loads names nativeTheme.themeSource', async () => {
  const { inputs, violations } = await themeSourceViolations(DESKTOP, AVATAR_ENTRY)
  const missing = REQUIRED_INPUTS.filter((input) => !inputs.includes(input))
  expect(missing, `the avatar import closure lost modules it must contain, so the scan covers less than the process: ${missing.join(', ')}`).toEqual([])
  expect(violations, `a module of the avatar process names themeSource, which makes the Tray follow the app theme instead of the taskbar: ${violations.join(', ')}`).toEqual([])
})

test('the avatar process reads the Deck locale without loading the Deck config store', async () => {
  const { inputs } = await themeSourceViolations(DESKTOP, AVATAR_ENTRY)
  expect(inputs, 'the avatar closure lost its locale reader, so the store exclusion below proves nothing').toContain('src/main/avatar-locale.ts')
  expect(inputs, 'store.ts resolves userData at call time, which the avatar process redirects to its own subdirectory: it would read another config.json').not.toContain('src/main/store.ts')
})

test('a themeSource write in an imported module is reported, one in a module outside the closure is not', async () => {
  const root = temporaryRoot()
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'entry.ts'), 'import { theme } from "./lib/theme.ts"\nexport const x = theme')
  writeFileSync(join(root, 'lib', 'theme.ts'), 'export const theme = { themeSource: "dark" }')
  writeFileSync(join(root, 'deck.ts'), 'export const deck = { themeSource: "light" }')

  expect((await themeSourceViolations(root, join(root, 'entry.ts'))).violations).toEqual(['lib/theme.ts'])
})

test('a themeSource write reached only through a literal dynamic import is reported', async () => {
  const root = temporaryRoot()
  writeFileSync(join(root, 'entry.ts'), 'export const load = () => import("./late.ts")')
  writeFileSync(join(root, 'late.ts'), 'export const late = { themeSource: "dark" }')

  expect((await themeSourceViolations(root, join(root, 'entry.ts'))).violations).toEqual(['late.ts'])
})

function writeAliasProject(root: string): void {
  mkdirSync(join(root, 'src', 'shared'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['src/shared/*'] } } }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { ws: '1' } }))
}

async function scanError(root: string, entry: string): Promise<string> {
  try {
    await themeSourceViolations(root, entry)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

test('a themeSource write in a module imported through a tsconfig path alias is reported', async () => {
  const root = temporaryRoot()
  writeAliasProject(root)
  writeFileSync(join(root, 'src', 'entry.ts'), 'import { theme } from "@shared/theme"\nimport ws from "ws"\nimport { join } from "node:path"\nimport { app } from "electron"\nexport const x = [theme, ws, join, app]')
  writeFileSync(join(root, 'src', 'shared', 'theme.ts'), 'export const theme = { themeSource: "dark" }')

  const { inputs, violations } = await themeSourceViolations(root, join(root, 'src', 'entry.ts'))
  expect(inputs, 'the aliased module left the closure').toContain('src/shared/theme.ts')
  expect(violations).toEqual(['src/shared/theme.ts'])
})

test('an alias that maps to no file fails the scan instead of shrinking it', async () => {
  const root = temporaryRoot()
  writeAliasProject(root)
  writeFileSync(join(root, 'src', 'entry.ts'), 'import "@shared/missing"')

  expect(await scanError(root, join(root, 'src', 'entry.ts'))).toContain('Avatar import closure requires every local import to resolve')
})

test('a bare specifier no alias claims and no package declares fails the scan', async () => {
  const root = temporaryRoot()
  writeAliasProject(root)
  writeFileSync(join(root, 'src', 'entry.ts'), 'import "@local/undeclared"')

  expect(await scanError(root, join(root, 'src', 'entry.ts'))).toContain('Avatar import closure requires every local import to resolve')
})

test('an unresolved relative import fails the scan instead of shrinking it', async () => {
  const root = temporaryRoot()
  writeFileSync(join(root, 'entry.ts'), 'import "./missing.ts"')

  expect(await scanError(root, join(root, 'entry.ts'))).toContain('Avatar import closure requires every local import to resolve')
})
