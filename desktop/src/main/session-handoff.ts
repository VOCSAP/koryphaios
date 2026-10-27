import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { canonicalPath } from './worktree-service'

const HEADER_PREFIX = '<!-- kory-session-handoff '
const HEADER_SUFFIX = ' -->\n'
const HANDOFF_FILE = /^(\d{6})\.md$/
const RESERVATION_FILE = /^(\d{6})\.reserve$/
const MAX_HANDOFF_BYTES = 256 * 1024

export const SESSION_HANDOFF_PLATFORM_SUPPORT: Readonly<Record<string, boolean>> = {
  win32: true
}

export function sessionHandoffSupported(platform: NodeJS.Platform = process.platform): boolean {
  return SESSION_HANDOFF_PLATFORM_SUPPORT[platform] === true
}

export interface SessionHandoffStore {
  archiveDir: string
  projectKey: string
}

export interface HandoffProvenance {
  author: string
  now: Date
}

export interface SessionHandoff {
  number: number
  markdown: string
  author: string
  createdAt: string
}

export interface SessionHandoffBinding {
  version: 1
  projectKey: string
  archiveDir: string
  draftPath: string
  helperPath: string
  logDir: string
  launchId: string
  tileId: string
  generation: string
  runId: string
}

export interface SessionHandoffLaunch {
  additionalDirectory: string
  allowedTools: readonly string[]
  environment: Record<string, string>
  stateDir: string
}

interface HandoffHeader {
  version: 1
  projectKey: string
  number: number
  author: string
  createdAt: string
}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && !rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function canonicalStateDir(stateDir: string): string {
  const root = canonicalPath(stateDir)
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error('Handoff state directory is invalid')
  }
  return root
}

function ensureSafeDirectory(root: string, ...parts: string[]): string {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Handoff directory is a symbolic link')
    } else {
      try {
        mkdirSync(current)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Handoff directory is a symbolic link')
    }
    const canonical = canonicalPath(current)
    if (!isWithin(root, canonical)) throw new Error('Handoff directory escapes its state root')
    current = canonical
  }
  return current
}

function existingSafeDirectory(root: string, ...parts: string[]): string | null {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (!existsSync(current)) return null
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Handoff directory is a symbolic link')
    const canonical = canonicalPath(current)
    if (!isWithin(root, canonical)) throw new Error('Handoff directory escapes its state root')
    current = canonical
  }
  return current
}

export function createSessionHandoffStore(stateDir: string, projectKey: string): SessionHandoffStore {
  if (!projectKey.trim()) throw new Error('Project key is empty')
  const root = canonicalStateDir(stateDir)
  const digest = createHash('sha256').update(projectKey).digest('hex')
  return { archiveDir: join(root, 'session-handoffs', digest), projectKey }
}

function assertArchiveDir(store: SessionHandoffStore): void {
  const root = canonicalStateDir(dirname(dirname(store.archiveDir)))
  const digest = createHash('sha256').update(store.projectKey).digest('hex')
  if (basename(store.archiveDir) !== digest || basename(dirname(store.archiveDir)) !== 'session-handoffs') {
    throw new Error('Handoff archive is invalid')
  }
  const archive = ensureSafeDirectory(root, 'session-handoffs', digest)
  if (archive !== canonicalPath(store.archiveDir)) throw new Error('Handoff archive escapes its state root')
}

function formatNumber(number: number): string {
  return number.toString().padStart(6, '0')
}

function nextNumber(archiveDir: string): number {
  const occupied = readdirSync(archiveDir)
    .map((name) => HANDOFF_FILE.exec(name) ?? RESERVATION_FILE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
  return (occupied.length === 0 ? 0 : Math.max(...occupied)) + 1
}

function reserveNumber(archiveDir: string): { number: number; reservation: string } {
  for (let number = nextNumber(archiveDir); number <= 999999; number++) {
    const reservation = join(archiveDir, `${formatNumber(number)}.reserve`)
    try {
      const fd = openSync(reservation, 'wx')
      closeSync(fd)
      if (existsSync(join(archiveDir, `${formatNumber(number)}.md`))) {
        rmSync(reservation, { force: true })
        continue
      }
      return { number, reservation }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('Handoff archive is full')
}

function headerFor(store: SessionHandoffStore, number: number, provenance: HandoffProvenance): HandoffHeader {
  const author = provenance.author.trim()
  if (!author || author.length > 128 || /[\r\n\0]/.test(author)) throw new Error('Invalid handoff author')
  if (Number.isNaN(provenance.now.valueOf())) throw new Error('Invalid handoff date')
  return { version: 1, projectKey: store.projectKey, number, author, createdAt: provenance.now.toISOString() }
}

function validateMarkdown(markdown: string): void {
  if (!markdown.trim()) throw new Error('Handoff content is empty')
  if (Buffer.byteLength(markdown, 'utf8') > MAX_HANDOFF_BYTES) throw new Error('Handoff content is too large')
}

function encodeHandoff(header: HandoffHeader, markdown: string): string {
  validateMarkdown(markdown)
  return `${HEADER_PREFIX}${JSON.stringify(header)}${HEADER_SUFFIX}${markdown}`
}

function decodeHandoff(store: SessionHandoffStore, file: string): SessionHandoff | null {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HANDOFF_BYTES + 1024) return null
  const content = readFileSync(file, 'utf8')
  if (!content.startsWith(HEADER_PREFIX)) return null
  const end = content.indexOf(HEADER_SUFFIX)
  if (end === -1) return null
  let header: HandoffHeader
  try {
    header = JSON.parse(content.slice(HEADER_PREFIX.length, end)) as HandoffHeader
  } catch {
    return null
  }
  const name = HANDOFF_FILE.exec(file.split(/[\\/]/).pop() ?? '')
  if (
    !name ||
    header.version !== 1 ||
    header.projectKey !== store.projectKey ||
    header.number !== Number(name[1]) ||
    !Number.isInteger(header.number) ||
    header.number < 1 ||
    typeof header.author !== 'string' ||
    typeof header.createdAt !== 'string' ||
    Number.isNaN(Date.parse(header.createdAt))
  ) return null
  return { number: header.number, markdown: content.slice(end + HEADER_SUFFIX.length), author: header.author, createdAt: header.createdAt }
}

function slashPath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/g, '/') : path
}

function bashPath(path: string): string {
  const normalized = slashPath(path)
  const match = /^([A-Za-z]):\/(.+)$/.exec(normalized)
  return match ? `/${match[1]!.toLowerCase()}/${match[2]!}` : normalized
}

export function sessionHandoffAllowedTools(draftPath: string): readonly string[] {
  return [
    `Edit(${slashPath(draftPath)})`,
    'Bash("$KORY_SESSION_HELPER" context)',
    'Bash("$KORY_SESSION_HELPER" read:*)',
    'Bash("$KORY_SESSION_HELPER" publish)'
  ]
}

interface SessionHandoffOwner {
  version: 1
  runId: string
  pid: number
}

function writeSessionHandoffOwner(runDir: string, runId: string): void {
  const owner = join(runDir, 'owner.json')
  if (existsSync(owner)) {
    const stat = lstatSync(owner)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Handoff run owner is invalid')
    const current = JSON.parse(readFileSync(owner, 'utf8')) as SessionHandoffOwner
    if (current.version !== 1 || current.runId !== runId || current.pid !== process.pid) throw new Error('Handoff run owner is invalid')
    return
  }
  writeFileSync(owner, JSON.stringify({ version: 1, runId, pid: process.pid } satisfies SessionHandoffOwner), { encoding: 'utf8', flag: 'wx' })
}

export function createSessionHandoffLaunch(
  stateDir: string,
  projectKey: string,
  helperPath: string,
  tileId: string,
  runId: string,
  logDir: string
): SessionHandoffLaunch {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Invalid handoff run id')
  const root = canonicalStateDir(stateDir)
  const generation = randomUUID()
  const runDir = ensureSafeDirectory(root, 'session-handoff-drafts', runId)
  writeSessionHandoffOwner(runDir, runId)
  const launchDir = ensureSafeDirectory(root, 'session-handoff-drafts', runId, generation)
  const draftPath = join(launchDir, 'handoff.md')
  const bindingPath = join(launchDir, 'binding.json')
  const helper = bashPath(helperPath)
  const store = createSessionHandoffStore(root, projectKey)
  writeSessionHandoffBinding(bindingPath, {
    version: 1,
    projectKey,
    archiveDir: store.archiveDir,
    draftPath,
    helperPath: helper,
    logDir,
    launchId: generation,
    tileId,
    generation,
    runId
  })
  return {
    additionalDirectory: launchDir,
    allowedTools: sessionHandoffAllowedTools(draftPath),
    environment: {
      KORY_SESSION_HELPER: helper,
      KORY_SESSION_HANDOFF_BINDING: bindingPath
    },
    stateDir: root
  }
}

export function removeSessionHandoffLaunch(launch: SessionHandoffLaunch): void {
  const root = canonicalStateDir(launch.stateDir)
  const runId = basename(dirname(launch.additionalDirectory))
  const generation = basename(launch.additionalDirectory)
  const launchDir = existingSafeDirectory(root, 'session-handoff-drafts', runId, generation)
  if (launchDir) rmSync(launchDir, { recursive: true, force: true, maxRetries: 3 })
}

function readSessionHandoffOwner(runDir: string, runId: string): SessionHandoffOwner | null {
  const owner = join(runDir, 'owner.json')
  if (!existsSync(owner)) return null
  const stat = lstatSync(owner)
  if (!stat.isFile() || stat.isSymbolicLink()) return null
  try {
    const parsed = JSON.parse(readFileSync(owner, 'utf8')) as SessionHandoffOwner
    return parsed.version === 1 && parsed.runId === runId && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null
  } catch {
    return null
  }
}

export function purgeSessionHandoffDrafts(
  stateDir: string,
  currentRunId: string,
  report: (message: string, error: unknown) => void,
  isProcessAlive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
      throw error
    }
  }
): number {
  let root: string
  let draftsDir: string | null
  try {
    root = canonicalStateDir(stateDir)
    draftsDir = existingSafeDirectory(root, 'session-handoff-drafts')
  } catch (error) {
    report('session handoff: could not inspect draft directories', error)
    return 0
  }
  if (!draftsDir) return 0
  let entries: Dirent[]
  try {
    entries = readdirSync(draftsDir, { withFileTypes: true })
  } catch (error) {
    report('session handoff: could not list draft directories', error)
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (entry.name === currentRunId || !entry.isDirectory() || entry.isSymbolicLink()) continue
    try {
      const runDir = existingSafeDirectory(root, 'session-handoff-drafts', entry.name)
      const owner = runDir && readSessionHandoffOwner(runDir, entry.name)
      if (!runDir || !owner) continue
      try {
        if (isProcessAlive(owner.pid)) continue
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EPERM') continue
        throw error
      }
      const checked = existingSafeDirectory(root, 'session-handoff-drafts', entry.name)
      if (!checked || checked !== runDir) continue
      rmSync(checked, { recursive: true, force: true, maxRetries: 3 })
      removed++
    } catch (error) {
      report(`session handoff: could not remove draft directory ${entry.name}`, error)
    }
  }
  return removed
}

export function writeSessionHandoffBinding(file: string, binding: SessionHandoffBinding): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(binding), { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function assertBindingScope(file: string, binding: SessionHandoffBinding): void {
  const bindingPath = canonicalPath(file)
  const launchDir = dirname(bindingPath)
  const runDir = dirname(launchDir)
  const draftsDir = dirname(runDir)
  const stateDir = dirname(draftsDir)
  const expectedArchive = canonicalPath(join(
    stateDir,
    'session-handoffs',
    createHash('sha256').update(binding.projectKey).digest('hex')
  ))
  if (
    basename(bindingPath) !== 'binding.json' ||
    basename(draftsDir) !== 'session-handoff-drafts' ||
    basename(runDir) !== binding.runId ||
    !/^[0-9a-f-]{36}$/i.test(binding.runId) ||
    canonicalPath(binding.draftPath) !== canonicalPath(join(launchDir, 'handoff.md')) ||
    canonicalPath(binding.archiveDir) !== expectedArchive
  ) throw new Error('Invalid handoff binding')
}

export function readSessionHandoffBinding(file: string): SessionHandoffBinding {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid handoff binding')
  let binding: SessionHandoffBinding
  try {
    binding = JSON.parse(readFileSync(file, 'utf8')) as SessionHandoffBinding
  } catch {
    throw new Error('Invalid handoff binding')
  }
  if (
    binding.version !== 1 ||
    !binding.projectKey ||
    !binding.archiveDir ||
    !binding.draftPath ||
    !binding.helperPath ||
    !binding.logDir ||
    !binding.launchId ||
    !binding.tileId ||
    !binding.generation ||
    !binding.runId
  ) throw new Error('Invalid handoff binding')
  assertBindingScope(file, binding)
  return binding
}

export function publishSessionHandoff(
  store: SessionHandoffStore,
  markdown: string,
  provenance: HandoffProvenance,
  onWarning: (message: string, error: unknown) => void = () => {},
  removeReservation: (file: string) => void = (file) => rmSync(file, { force: true })
): number {
  validateMarkdown(markdown)
  assertArchiveDir(store)
  const { number, reservation } = reserveNumber(store.archiveDir)
  const target = join(store.archiveDir, `${formatNumber(number)}.md`)
  const temporary = join(store.archiveDir, `.${formatNumber(number)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, encodeHandoff(headerFor(store, number, provenance), markdown), { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  try {
    removeReservation(reservation)
  } catch (error) {
    onWarning('session handoff: could not remove archive reservation', error)
  }
  return number
}

export function readSessionHandoff(store: SessionHandoffStore, selector: 'latest' | number): SessionHandoff {
  if (selector !== 'latest' && (!Number.isInteger(selector) || selector < 1)) throw new Error('Invalid handoff selector')
  assertArchiveDir(store)
  const matching = readdirSync(store.archiveDir)
    .map((name) => ({ name, match: HANDOFF_FILE.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .filter((entry) => selector === 'latest' || Number(entry.match[1]) === selector)
    .map((entry) => decodeHandoff(store, join(store.archiveDir, entry.name)))
    .filter((handoff): handoff is SessionHandoff => handoff !== null)
    .sort((left, right) => right.number - left.number)
  const handoff = matching[0]
  if (!handoff) throw new Error('Handoff not found')
  return handoff
}
