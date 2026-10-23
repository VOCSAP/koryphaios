import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FINGERPRINT_PATTERN, isEnginePath, modsFingerprint, PLUGIN_NAME_PATTERN, type ModFile } from '../../../shared/mods-fingerprint'
import { reportError } from './log'

export const MODS_LOCK_FILENAME = 'choregos.lock.json'

export type WorkingCopyRefusal =
  | 'plugin-name'
  | 'not-locked'
  | 'fingerprint'
  | 'distributed-drift'
  | 'unsafe-parent'
  | 'drift-rename'
  | 'materialize'
  | 'io'

export type WorkingCopyOutcome =
  | { ok: true; dir: string; reused: boolean; drifted: string | null }
  | { ok: false; reason: WorkingCopyRefusal; message: string; drifted: string | null }

export interface WorkingCopyRequest {
  distDir: string
  workRoot: string
  plugin: string
  lock: ReadonlyMap<string, string>
  rename?: (from: string, to: string) => void | Promise<void>
  wait?: (delay: number) => void | Promise<void>
  nonce?: () => string
}

// The `extends` form is the only root tsconfig.json the engine writes; any other content reaches the bundled Bun's config lookup.
const ENGINE_ROOT_TSCONFIG = '{\n  "extends": "./.claude-plugin/types/tsconfig.json"\n}\n'
// The only JSX mode of the engine's types tsconfig: the automatic runtimes import <jsxImportSource>/jsx-runtime through ancestor node_modules.
export const ENGINE_JSX = 'react'
const TYPES_PREFIX = '.claude-plugin/types/'
const PROJECT_CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'package.json', 'bunfig.toml', 'node_modules']
const TYPES_TOP_LEVEL_KEYS = new Set(['compilerOptions', 'include'])
const TYPES_INCLUDE = ['../../hooks', '../../types', '../../tests']
const TYPES_COMPILER_OPTIONS = new Set([
  'target',
  'lib',
  'module',
  'moduleResolution',
  'strict',
  'noUncheckedIndexedAccess',
  'noEmit',
  'skipLibCheck',
  'jsx',
  'jsxFactory',
  'jsxFragmentFactory',
  'typeRoots',
  'types'
])

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160]

// A directory rename right after its tree was written can fail with EPERM on Windows for a few milliseconds.
// Onto an existing directory it fails for good, so the retry only applies while the target is absent.
async function renameWithRetry(
  rename: (from: string, to: string) => void | Promise<void>,
  from: string,
  to: string,
  wait: (delay: number) => void | Promise<void>,
  revalidate: () => void
): Promise<void> {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '') || existsSync(to)) throw error
      await wait(delay)
      revalidate()
    }
  }
  await rename(from, to)
}

class ModsRefusal extends Error {
  constructor(
    readonly reason: WorkingCopyRefusal,
    message: string
  ) {
    super(message)
  }
}

type Inspection = { kind: 'absent' } | { kind: 'conforming' } | { kind: 'drift'; detail: string }

export function loadModsLock(distDir: string): Map<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(distDir, MODS_LOCK_FILENAME), 'utf-8'))
  const plugins = isRecord(parsed) ? parsed.plugins : undefined
  if (!isRecord(plugins)) throw new Error(`${MODS_LOCK_FILENAME} has no plugins object`)
  const lock = new Map<string, string>()
  for (const [name, entry] of Object.entries(plugins)) {
    const fingerprint = isRecord(entry) ? entry.fingerprint : undefined
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`${MODS_LOCK_FILENAME}: plugin name '${name}' does not match ${PLUGIN_NAME_PATTERN}`)
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new Error(`${MODS_LOCK_FILENAME}: plugin '${name}' has a fingerprint that does not match ${FINGERPRINT_PATTERN}`)
    }
    lock.set(name, fingerprint)
  }
  return lock
}

export function listLockedMods(
  distDir: string,
  loadLock: (dir: string) => ReadonlyMap<string, string> = loadModsLock,
  report: (scope: string, message: string, error?: unknown) => void = reportError
): string[] {
  try {
    return Array.from(loadLock(distDir).keys())
  } catch (error) {
    report('mods', 'failed to list choregos mods', error)
    return []
  }
}

export function enabledModsFromLock(enabled: unknown, lock: ReadonlyMap<string, string>): string[] {
  if (!isRecord(enabled)) return []
  return Array.from(lock.keys()).filter((name) => PLUGIN_NAME_PATTERN.test(name) && enabled[name] === true)
}

export function activeClaudePlugins(
  files: readonly string[],
  report: (scope: string, message: string, error?: unknown) => void = reportError
): ReadonlySet<string> {
  const active = new Set<string>()
  for (const file of files) {
    try {
      if (lstatSync(file, { throwIfNoEntry: false }) === undefined) continue
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
      const enabledPlugins = isRecord(parsed) ? parsed.enabledPlugins : undefined
      if (!isRecord(enabledPlugins)) continue
      for (const [key, enabled] of Object.entries(enabledPlugins)) {
        const separator = key.indexOf('@')
        const plugin = key.slice(0, separator)
        if (separator > 0 && separator < key.length - 1 && PLUGIN_NAME_PATTERN.test(plugin) && enabled === true) active.add(plugin)
      }
    } catch (error) {
      report('mods', `failed to read Claude Code settings at ${file}`, error)
    }
  }
  return active
}

export interface ClaudePluginOmission {
  plugin: string
  hostDir: string
  source: 'global Claude Code settings' | 'project Claude Code settings'
}

export function claudePluginOmissions(
  globalSettings: string,
  cwd: string,
  copies: readonly { plugin: string; hostDir: string }[],
  report: (scope: string, message: string, error?: unknown) => void = reportError
): readonly ClaudePluginOmission[] {
  const globalActive = activeClaudePlugins([globalSettings], report)
  const projectActive = activeClaudePlugins([join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')], report)
  const omissions: ClaudePluginOmission[] = []
  for (const copy of copies) {
    if (globalActive.has(copy.plugin)) omissions.push({ ...copy, source: 'global Claude Code settings' })
    else if (projectActive.has(copy.plugin)) omissions.push({ ...copy, source: 'project Claude Code settings' })
  }
  return omissions
}

export function verifyModWorkingCopy(request: WorkingCopyRequest): WorkingCopyOutcome {
  const { distDir, workRoot, plugin, lock } = request
  try {
    if (!PLUGIN_NAME_PATTERN.test(plugin)) throw new ModsRefusal('plugin-name', `plugin name '${plugin}' does not match ${PLUGIN_NAME_PATTERN}`)
    const fingerprint = lock.get(plugin)
    if (fingerprint === undefined) throw new ModsRefusal('not-locked', `plugin '${plugin}' is not in the lock`)
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new ModsRefusal('fingerprint', `the locked fingerprint of '${plugin}' does not match ${FINGERPRINT_PATTERN}`)
    }
    const distributed = readTree(join(distDir, plugin), 'distributed-drift', `distributed copy of '${plugin}'`)
    if (modsFingerprint(distributed) !== fingerprint) {
      throw new ModsRefusal('distributed-drift', `the distributed copy of '${plugin}' does not match its locked fingerprint`)
    }
    const parent = join(workRoot, plugin)
    requireRealDirectoryIfPresent(workRoot)
    requireRealDirectoryIfPresent(parent)
    for (const holder of [parent, workRoot, dirname(workRoot)]) requireNoProjectConfig(holder)
    const dir = join(parent, fingerprint)
    const inspection = inspectWorkingCopy(dir, fingerprint, distributed)
    if (inspection.kind !== 'conforming') {
      throw new ModsRefusal('materialize', `the working copy of '${plugin}' is not conforming: ${inspection.kind === 'drift' ? inspection.detail : 'absent'}`)
    }
    return { ok: true, dir, reused: true, drifted: null }
  } catch (error) {
    if (error instanceof ModsRefusal) return { ok: false, reason: error.reason, message: error.message, drifted: null }
    return { ok: false, reason: 'io', message: errorText(error), drifted: null }
  }
}

export async function ensureModWorkingCopy(request: WorkingCopyRequest): Promise<WorkingCopyOutcome> {
  const { distDir, workRoot, plugin, lock } = request
  const wait = request.wait ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)))
  const nonce = request.nonce ?? (() => randomBytes(6).toString('hex'))
  let drifted: string | null = null
  try {
    if (!PLUGIN_NAME_PATTERN.test(plugin)) throw new ModsRefusal('plugin-name', `plugin name '${plugin}' does not match ${PLUGIN_NAME_PATTERN}`)
    const fingerprint = lock.get(plugin)
    if (fingerprint === undefined) throw new ModsRefusal('not-locked', `plugin '${plugin}' is not in the lock`)
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new ModsRefusal('fingerprint', `the locked fingerprint of '${plugin}' does not match ${FINGERPRINT_PATTERN}`)
    }
    const distributed = readTree(join(distDir, plugin), 'distributed-drift', `distributed copy of '${plugin}'`)
    if (modsFingerprint(distributed) !== fingerprint) {
      throw new ModsRefusal('distributed-drift', `the distributed copy of '${plugin}' does not match its locked fingerprint`)
    }
    const parent = join(workRoot, plugin)
    const dir = join(parent, fingerprint)
    const validateParents = (): void => {
      requireRealDirectoryIfPresent(workRoot)
      requireRealDirectoryIfPresent(parent)
      for (const holder of [parent, workRoot, dirname(workRoot)]) requireNoProjectConfig(holder)
    }
    const revalidate = (): void => {
      validateParents()
      requireRealDirectoryIfPresent(dir)
    }
    const rename = (from: string, to: string): Promise<void> => renameWithRetry(request.rename ?? renameSync, from, to, wait, revalidate)
    validateParents()
    const inspect = (): Inspection => inspectWorkingCopy(dir, fingerprint, distributed)

    const first = inspect()
    if (first.kind === 'conforming') return { ok: true, dir, reused: true, drifted }
    if (first.kind === 'drift') {
      const retired = `${dir}.drift-${nonce()}`
      try {
        await rename(dir, retired)
        revalidate()
        drifted = retired
      } catch (error) {
        revalidate()
        const again = inspect()
        if (again.kind === 'conforming') return { ok: true, dir, reused: true, drifted }
        if (again.kind === 'drift') {
          throw new ModsRefusal('drift-rename', `the drifted working copy of '${plugin}' (${first.detail}) cannot be moved aside: ${errorText(error)}`)
        }
      }
    }

    const staging = `${dir}.staging-${nonce()}`
    let stagingRenamed = false
    try {
      mkdirSync(parent, { recursive: true })
      for (const file of distributed) {
        const target = join(staging, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.bytes)
      }
      await rename(staging, dir)
      stagingRenamed = true
      revalidate()
    } catch (error) {
      try {
        revalidate()
      } catch (revalidationError) {
        if (!stagingRenamed && revalidationError instanceof ModsRefusal) {
          throw new ModsRefusal(revalidationError.reason, `${revalidationError.message}; staging directory '${staging}' was left in place`)
        }
        throw revalidationError
      }
      rmSync(staging, { recursive: true, force: true })
      if (inspect().kind === 'conforming') return { ok: true, dir, reused: true, drifted }
      throw new ModsRefusal('materialize', `the working copy of '${plugin}' cannot be materialized: ${errorText(error)}`)
    }
    return { ok: true, dir, reused: false, drifted }
  } catch (error) {
    if (error instanceof ModsRefusal) return { ok: false, reason: error.reason, message: error.message, drifted }
    return { ok: false, reason: 'io', message: errorText(error), drifted }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Bun reads project config from each controlled ancestor of a working copy.
function requireNoProjectConfig(dir: string): void {
  for (const name of PROJECT_CONFIG_NAMES) {
    if (existsSync(join(dir, name))) throw new ModsRefusal('unsafe-parent', `${join(dir, name)} sits above the working copies and would be read by the engine`)
  }
}

function requireRealDirectoryIfPresent(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory()) throw new ModsRefusal('unsafe-parent', `${path} is not a real directory`)
}

// lstat on every entry, directories included: a link or junction is never followed.
function listFiles(root: string): { files: string[]; special: string | null } {
  const files: string[] = []
  const pending = ['']
  while (pending.length > 0) {
    const relative = pending.pop()!
    for (const name of readdirSync(join(root, relative))) {
      const entry = relative === '' ? name : `${relative}/${name}`
      const stat = lstatSync(join(root, entry))
      if (stat.isDirectory()) pending.push(entry)
      else if (stat.isFile()) files.push(entry)
      else return { files, special: entry }
    }
  }
  return { files, special: null }
}

function readTree(root: string, reason: WorkingCopyRefusal, label: string): ModFile[] {
  const { files, special } = listFiles(root)
  if (special !== null) throw new ModsRefusal(reason, `${label} holds a link or special file at ${special}`)
  return files.map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(root, path))) }))
}

function inspectWorkingCopy(dir: string, fingerprint: string, distributed: readonly ModFile[]): Inspection {
  let stat
  try {
    stat = lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  if (!stat.isDirectory()) return { kind: 'drift', detail: 'not a real directory' }
  const { files, special } = listFiles(dir)
  if (special !== null) return { kind: 'drift', detail: `link or special file at ${special}` }

  const code = files.filter((path) => !isEnginePath(path))
  const read = code.map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(dir, path))) }))
  if (modsFingerprint(read) !== fingerprint) {
    const expected = new Set(distributed.map((file) => file.path))
    const extra = code.filter((path) => !expected.has(path))
    const missing = [...expected].filter((path) => !code.includes(path))
    return { kind: 'drift', detail: `files differ from the distributed copy (extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})` }
  }

  for (const path of files.filter(isEnginePath)) {
    const detail = engineFileDrift(dir, path)
    if (detail !== null) return { kind: 'drift', detail: `${path}: ${detail}` }
  }
  return { kind: 'conforming' }
}

function engineFileDrift(dir: string, path: string): string | null {
  const folded = path.toLowerCase()
  if (folded === 'tsconfig.json') {
    return Buffer.from(readFileSync(join(dir, path))).toString('utf-8') === ENGINE_ROOT_TSCONFIG ? null : 'not the extends form the engine writes'
  }
  const inTypes = folded.slice(TYPES_PREFIX.length)
  if (inTypes === 'tsconfig.json') return typesTsconfigDrift(readFileSync(join(dir, path), 'utf-8'))
  if (inTypes === '.gitignore' || inTypes.endsWith('.d.ts')) return null
  return 'not a declaration file'
}

function typesTsconfigDrift(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'not valid JSON'
  }
  if (!isRecord(parsed)) return 'not an object'
  const topLevel = Object.keys(parsed).find((key) => !TYPES_TOP_LEVEL_KEYS.has(key))
  if (topLevel !== undefined) return `unexpected top-level key '${topLevel}'`
  if (JSON.stringify(parsed.include) !== JSON.stringify(TYPES_INCLUDE)) return 'include differs from the measured list'
  const options = parsed.compilerOptions
  if (!isRecord(options)) return 'no compilerOptions object'
  const unknownOption = Object.keys(options).find((key) => !TYPES_COMPILER_OPTIONS.has(key))
  if (unknownOption !== undefined) return `unexpected compilerOptions key '${unknownOption}'`
  if ('jsx' in options && options.jsx !== ENGINE_JSX) return `jsx is not ${ENGINE_JSX}`
  if ('jsxFactory' in options && options.jsxFactory !== 'h') return 'jsxFactory is not h'
  if ('jsxFragmentFactory' in options && options.jsxFragmentFactory !== 'Fragment') return 'jsxFragmentFactory is not Fragment'
  if ('typeRoots' in options && JSON.stringify(options.typeRoots) !== JSON.stringify(['.'])) return 'typeRoots is not [.]'
  return null
}
