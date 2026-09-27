// Deck-side owner of the guard rules (TTSR): loads the three sources (Kory
// built-ins, the operator's global file, each project's repo file), decides
// what is trusted (a repo file only once its hash is approved for its project
// key), and compiles one EFFECTIVE file per tile, which the session hook reads
// through CLAUDE_PEERS_TTSR_FILE. The hook never sees unapproved repo content:
// trust is settled here.
//
// Keyed by tile (the desk session id), not by project: two worktrees of one
// project may carry two versions of rules.json, and a per-project file would
// let the last writer win silently.
//
// Node builtins only, no electron: every side effect the Deck owns (error
// sink, journal, dialog, broadcast, paths) is injected, so the service runs
// under bun test on a throwaway directory.

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  canonicalizePath,
  extractField,
  globToRegExp,
  MAX_FILE_BYTES,
  parseEffectiveFile,
  parseRulesFile,
  qualifyRule,
  rulesHash,
  TTSR_TOOLS,
  type TtsrEffectiveFile,
  type TtsrEffectiveRule,
  type TtsrRule,
  type TtsrSource,
  type TtsrTool
} from '../shared/ttsr-rules'
import { KORY_EFFECTIVE_RULES } from '../shared/ttsr-builtin'
import { readBounded } from '../shared/ttsr-fs'
import type {
  TtsrApproveResult,
  TtsrFileState,
  TtsrRepoProject,
  TtsrRuleRow,
  TtsrRulesList,
  TtsrSaveResult,
  TtsrTestOptions,
  TtsrTestResult
} from '../shared/types'
import { writeFileAtomic } from './atomic-write'
import {
  emptyTtsrApprovals,
  readTtsrApprovals,
  ttsrRepoTrust,
  withTtsrApproval,
  withTtsrCurrent,
  writeTtsrApprovals,
  type TtsrApprovals
} from './ttsr-approvals'
import { displaySafe } from './ttsr-dialog'
import { ttsrToggleKey } from './ttsr-toggles'
import { matchIsolated, probeRulesSpeed, type IsolatedMatchResult } from './ttsr-regex-worker'
import { isValidSandboxSessionId } from './sandbox-prompt'
import { SANDBOX_RUN_DIR } from './sandbox-command'
import { computeDeckProjectKey } from './roadmap-service'

/** Repo rules file, relative to the project root. */
export const REPO_RULES_REL = join('.claude', 'claude-peers', 'rules.json')
/** Operator rules file name, under the global config dir. */
export const GLOBAL_RULES_FILE = 'ttsr-rules.json'
/** Subdirectory of the window's session dir holding the effective files. */
export const TTSR_EFFECTIVE_SUBDIR = 'ttsr'

/** Effective file of one tile, named by its desk id (validated as a uuid by the caller). */
export function ttsrEffectiveFileName(deskId: string): string {
  return `${deskId}.json`
}

/** Sandbox copy of an effective file in the container run dir, named by the spawn's session uuid. */
export function ttsrSandboxCopyName(sessionId: string): string {
  return `ttsr-${sessionId}.json`
}

/** Hook trace log of a tile, next to its effective file. */
export function ttsrLogFileName(deskId: string): string {
  return `${deskId}.log`
}

/** Hook trace log of a sandboxed spawn, in the container run dir. */
export function ttsrSandboxLogName(sessionId: string): string {
  return `ttsr-${sessionId}.log`
}

/** Bytes of one hook log read per poll pass; the rest waits for the next pass. */
export const TTSR_LOG_TICK_BYTES = 16 * 1024
/** Hook log lines forwarded per tile per poll pass; the rest are counted. */
export const TTSR_LOG_TICK_LINES = 20
/** Hook log lines forwarded per tile per minute; the rest are counted. */
export const TTSR_LOG_MINUTE_LINES = 200
/** Characters of one forwarded hook log line. */
export const TTSR_LOG_LINE_CHARS = 500
const MINUTE_MS = 60_000

/** Minimum delay between two approval dialogs of one project root; later changes surface in Settings. */
export const TTSR_PROMPT_INTERVAL_MS = 60_000
/** Timing probes (worker threads) running at once; the others wait. */
export const TTSR_PROBE_CONCURRENCY = 2
/** Entries kept in each per-run memo (prompted, probe verdicts, traced invalid files). */
export const TTSR_MEMO_MAX = 200

/** Poll period of the rules files (repo, global, approvals). */
export const TTSR_POLL_MS = 2000

/** What the service needs from a tile: its desk id, cwd, and supervisor flag. */
export interface TtsrTileSpec {
  id: string
  cwd: string
  supervisor?: boolean
}

export interface TtsrProjectRef {
  /** Canonical project root (git toplevel of the tile cwd, else the cwd). */
  root: string
  projectKey: string
}

/** A pending repo file shown to the operator for approval. */
export interface TtsrApprovalRequest {
  projectDir: string
  projectKey: string
  hash: string
  rules: TtsrRule[]
}

export interface TtsrServiceDeps {
  /** `<globalConfigDir>/ttsr-rules.json`. */
  globalRulesFile: () => string
  /** `<appStateDir>/ttsr-approvals.json`. */
  approvalsFile: () => string
  /**
   * This window's session-scoped state dir (sessions/<groupId>/); the
   * effective files live in its `ttsr/` subdirectory. May throw once the
   * window quits.
   */
  sessionDir: () => string
  /** Current `ttsrDisabled` toggle keys. */
  getDisabled: () => readonly string[]
  reportError: (scope: string, message: string, error?: unknown) => void
  journal: (text: string) => void
  /** Asks the operator to approve a pending repo file; true = approve. */
  promptApproval: (req: TtsrApprovalRequest) => Promise<boolean>
  /** Called after any change visible in `list()`. */
  onChanged: () => void
  /** Project root + key of a tile cwd; defaults to git toplevel + computeDeckProjectKey. */
  resolveProject?: (cwd: string) => TtsrProjectRef
  /** Isolated regex runner for `test()`; injectable for tests. */
  matchIsolated?: (pattern: string, flags: string, texts: readonly string[]) => Promise<IsolatedMatchResult>
  /**
   * Adversarial timing gate of a file's rules (errors, [] when fast); a
   * synchronous result is applied at once. Defaults to the worker probe.
   */
  probeRules?: (rules: readonly TtsrRule[]) => string[] | Promise<string[]>
  /** Defers the approval prompt off the spawn path; defaults to setImmediate. */
  defer?: (fn: () => void) => void
  /** Clock of the dialog interval and the log rate limit; defaults to Date.now. */
  now?: () => number
}

type FileStatus = 'absent' | 'invalid' | 'ok'

interface FileSnapshot {
  /** lstat signature (ino, size, mtime), or 'absent'. */
  sig: string
  status: FileStatus
  text: string | null
  hash: string | null
  errors: string[]
  rules: TtsrRule[]
  /** The timing probe passed: only then are the rules compiled, prompted, approved in effect. */
  probed: boolean
}

interface ProjectState {
  root: string
  key: string
  snap: FileSnapshot
  /** Hash whose rules this root applied at the last evaluation, null when none. */
  applied: string | null
}

interface SandboxCopy {
  path: string
  sig: string
  /** Host path of the container-side hook log. */
  log: LogTail
}

/** A hook trace log the poll forwards to the Deck's error sink. */
interface LogTail {
  path: string
  offset: number
  ino: number | null
  /** Last fault reported for this log, so one fault is reported once. */
  fault: string | null
}

type ProbeVerdict = { done: false; promise: Promise<string[]> } | { done: true; errors: string[] }

/** Hook log lines forwarded for one tile: per poll pass and per minute. */
interface LogRate {
  windowStart: number
  minuteSent: number
  tickSent: number
  suppressed: number
}

interface TileState {
  id: string
  supervisor: boolean
  project: TtsrProjectRef | null
  effectivePath: string
  /** Last content written to the effective file. */
  written: string | null
  /** statSig of the effective file right after the Deck wrote it. */
  writtenSig: string
  sandbox: SandboxCopy | null
  log: LogTail
  rate: LogRate
}

const ABSENT: FileSnapshot = { sig: 'absent', status: 'absent', text: null, hash: null, errors: [], rules: [], probed: true }

const sigOf = (st: Stats): string => `${st.ino}:${st.size}:${st.mtimeMs}:${st.isSymbolicLink() ? 'l' : 'f'}`

/**
 * Change signature of a file: ino, size, mtime, link-ness. `follow` stats the
 * symlink target instead (the operator's own global file may be a symlink).
 * Never throws: an unexpected error becomes an `error:<code>` signature that
 * the reader then reports.
 */
function statSig(path: string, follow = false): string {
  try {
    return sigOf(follow ? statSync(path) : lstatSync(path))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    return `error:${code ?? 'unknown'}`
  }
}

/**
 * A Set that forgets its oldest entries past `max`: the per-run memos are
 * fed by content an agent controls (every rewrite is a new hash).
 */
export class BoundedSet {
  private readonly items = new Set<string>()
  constructor(private readonly max: number) {}
  has(k: string): boolean {
    return this.items.has(k)
  }
  add(k: string): void {
    this.items.delete(k)
    this.items.add(k)
    while (this.items.size > this.max) this.items.delete(this.items.values().next().value as string)
  }
  deleteWhere(pred: (k: string) => boolean): void {
    for (const k of [...this.items]) if (pred(k)) this.items.delete(k)
  }
}

/** Map counterpart of BoundedSet (insertion order, oldest evicted). */
export class BoundedMap<V> {
  private readonly items = new Map<string, V>()
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    return this.items.get(k)
  }
  set(k: string, v: V): void {
    this.items.delete(k)
    this.items.set(k, v)
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value as string)
  }
  delete(k: string): void {
    this.items.delete(k)
  }
  get size(): number {
    return this.items.size
  }
}

/** True when `p` (already canonical) is `root` or strictly inside it. */
function within(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

/**
 * Git toplevel of `cwd` (canonical), or the canonical cwd when it is not in a
 * repository. A git that cannot run at all is traced, then falls back too.
 */
export function defaultResolveProject(cwd: string, onError: (msg: string, err?: unknown) => void): TtsrProjectRef {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000
  })
  if (res.error) onError(`git rev-parse failed in ${cwd}; the cwd is taken as the project root`, res.error)
  const top = res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : ''
  const root = canonicalizePath(top || cwd)
  return { root, projectKey: computeDeckProjectKey(root) }
}

export class TtsrService {
  private readonly tiles = new Map<string, TileState>()
  private readonly projects = new Map<string, ProjectState>()
  private readonly projectCache = new Map<string, TtsrProjectRef>()
  private global: FileSnapshot = ABSENT
  private approvals: TtsrApprovals = emptyTtsrApprovals()
  private approvalsSig = 'unread'
  /** `<root>\n<hash>` already shown to the operator this run. */
  private readonly prompted = new BoundedSet(TTSR_MEMO_MAX)
  /** Roots whose approval dialog is open; a change meanwhile is re-evaluated when it closes. */
  private readonly promptOpen = new Set<string>()
  private readonly promptAgain = new Set<string>()
  /** Last dialog time per root, for TTSR_PROMPT_INTERVAL_MS. */
  private readonly lastPromptAt = new BoundedMap<number>(TTSR_MEMO_MAX)
  /** `<path>\n<hash or errors>` already traced as invalid this run. */
  private readonly reportedInvalid = new BoundedSet(TTSR_MEMO_MAX)
  private timer: NodeJS.Timeout | null = null
  private readonly defer: (fn: () => void) => void
  private readonly now: () => number
  private readonly match: NonNullable<TtsrServiceDeps['matchIsolated']>
  private readonly probeRules: NonNullable<TtsrServiceDeps['probeRules']>
  /** Timing verdict per file hash: one probe per content per run. */
  private readonly probes = new BoundedMap<ProbeVerdict>(TTSR_MEMO_MAX)
  private probeActive = 0
  private readonly probeQueue: Array<() => void> = []

  constructor(private readonly deps: TtsrServiceDeps) {
    this.defer = deps.defer ?? ((fn) => setImmediate(fn))
    this.now = deps.now ?? Date.now
    this.match = deps.matchIsolated ?? matchIsolated
    this.probeRules = deps.probeRules ?? probeRulesSpeed
    this.global = this.readRulesFile(deps.globalRulesFile(), null)
    this.reloadApprovals()
  }

  // ----- lifecycle -----

  start(intervalMs: number = TTSR_POLL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (e) {
        this.deps.reportError('ttsr', 'rules poll failed', e)
      }
    }, intervalMs)
  }

  /** Stops the poll and removes the sandbox copies (the run dir outlives the window). */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const tile of this.tiles.values()) this.dropSandboxCopy(tile)
  }

  // ----- per-tile effective file -----

  /**
   * Compiles and writes the tile's effective file and returns its path, the
   * value of CLAUDE_PEERS_TTSR_FILE. '' (no rules) when the tile id is not a
   * uuid or anything fails, always with a trace: a tile never fails to spawn
   * because of its guard rules.
   */
  fileFor(spec: TtsrTileSpec): string {
    try {
      if (!isValidSandboxSessionId(spec.id)) {
        this.deps.reportError('ttsr', `no guard rules for tile ${JSON.stringify(spec.id)}: its id is not a uuid`)
        return ''
      }
      const supervisor = spec.supervisor === true
      const project = supervisor ? null : this.projectFor(spec.cwd)
      // A respawn drops the previous spawn's sandbox copy; the sandbox wrap of
      // this spawn projects a fresh one when the tile is sandboxed.
      const prev = this.tiles.get(spec.id)
      if (prev) {
        this.drainLog(prev, prev.log)
        this.dropSandboxCopy(prev)
      }
      const dir = join(this.deps.sessionDir(), TTSR_EFFECTIVE_SUBDIR)
      const tile: TileState = {
        id: spec.id,
        supervisor,
        project,
        effectivePath: join(dir, ttsrEffectiveFileName(spec.id)),
        written: null,
        writtenSig: 'absent',
        sandbox: null,
        log: newLogTail(join(dir, ttsrLogFileName(spec.id))),
        rate: prev?.rate ?? { windowStart: this.now(), minuteSent: 0, tickSent: 0, suppressed: 0 }
      }
      this.tiles.set(spec.id, tile)
      if (project) this.settle(this.refreshProject(project))
      this.writeTile(tile, true)
      this.deps.onChanged()
      return tile.effectivePath
    } catch (e) {
      this.deps.reportError('ttsr', `guard rules unavailable for tile ${spec.id}; it runs without them`, e)
      return ''
    }
  }

  /** Host path of the tile's hook trace log (CLAUDE_PEERS_TTSR_LOG), or '' when the tile is unknown. */
  logPathOf(deskId: string): string {
    return this.tiles.get(deskId)?.log.path ?? ''
  }

  /**
   * Copies the tile's effective file into the sandbox run dir (mounted at
   * /kory-run) and returns the container paths of the copy and of the hook
   * log, both '' with a trace on failure. Named by the spawn's session id,
   * minted per spawn: the run dir belongs to the project container and is
   * shared by every Deck window on that project, where two restored
   * workspaces may carry the same desk id.
   */
  projectIntoSandbox(deskId: string, sessionId: string, runDirHost: string): { file: string; log: string } {
    const none = { file: '', log: '' }
    const tile = this.tiles.get(deskId)
    try {
      if (!tile || tile.written === null) {
        this.deps.reportError('ttsr', `no guard rules in the sandbox: tile ${deskId} has no compiled rules file`)
        return none
      }
      if (!isValidSandboxSessionId(sessionId)) {
        this.deps.reportError('ttsr', `no guard rules in the sandbox: session id ${JSON.stringify(sessionId)} is not a uuid`)
        return none
      }
      const name = ttsrSandboxCopyName(sessionId)
      const path = join(runDirHost, name)
      if (tile.sandbox && tile.sandbox.path !== path) this.dropSandboxCopy(tile)
      mkdirSync(runDirHost, { recursive: true })
      // The rename replaces whatever sits at `path`, a symlink planted from
      // inside the container included, instead of writing through it.
      writeFileAtomic(path, tile.written, { mode: 0o644 })
      const logName = ttsrSandboxLogName(sessionId)
      tile.sandbox = { path, sig: statSig(path), log: newLogTail(join(runDirHost, logName)) }
      return { file: `${SANDBOX_RUN_DIR}/${name}`, log: `${SANDBOX_RUN_DIR}/${logName}` }
    } catch (e) {
      this.deps.reportError('ttsr', `guard rules not delivered to the sandbox for tile ${deskId}`, e)
      if (tile) tile.sandbox = null
      return none
    }
  }

  /** Tile closed for good: drop its files and forget it. */
  remove(deskId: string): void {
    const tile = this.tiles.get(deskId)
    if (!tile) return
    this.tiles.delete(deskId)
    this.drainLog(tile, tile.log)
    try {
      rmSync(tile.effectivePath, { force: true })
      rmSync(tile.log.path, { force: true })
    } catch (e) {
      this.deps.reportError('ttsr', `could not delete the guard rules files of tile ${deskId}`, e)
    }
    this.dropSandboxCopy(tile)
    this.pruneProjects()
    this.deps.onChanged()
  }

  /** Rewrites every tile whose compiled content changed (toggles, approvals, files). */
  recompileAll(): void {
    for (const tile of this.tiles.values()) {
      try {
        this.writeTile(tile, false)
      } catch (e) {
        this.deps.reportError('ttsr', `could not rewrite the guard rules of tile ${tile.id}`, e)
      }
    }
    this.deps.onChanged()
  }

  /** One poll pass; exposed for tests (the timer calls it). */
  tick(): void {
    let changed = false
    const aSig = statSig(this.deps.approvalsFile())
    if (aSig !== this.approvalsSig) {
      this.reloadApprovals()
      for (const state of this.projects.values()) this.settle(state)
      changed = true
    }
    const gPath = this.deps.globalRulesFile()
    if (statSig(gPath, true) !== this.global.sig) {
      const before = this.global
      this.global = this.readRulesFile(gPath, null)
      if (before.hash !== this.global.hash || before.status !== this.global.status) changed = true
    }
    for (const state of this.projects.values()) {
      const path = join(state.root, REPO_RULES_REL)
      if (statSig(path) === state.snap.sig) continue
      const before = state.snap
      state.snap = this.readRulesFile(path, state.root)
      if (before.hash !== state.snap.hash || before.status !== state.snap.status) {
        changed = true
        this.settle(state)
      }
    }
    if (changed) this.recompileAll()
    for (const tile of this.tiles.values()) {
      this.checkEffectiveFile(tile)
      this.checkSandboxCopy(tile)
      this.rollLogWindow(tile).tickSent = 0
      this.drainLog(tile, tile.log)
      if (tile.sandbox) this.drainLog(tile, tile.sandbox.log)
      this.flushSuppressed(tile)
    }
  }

  // ----- operator actions -----

  /**
   * Validates (parser, then timing probe), writes the global rules file,
   * recompiles every tile. `expectedHash` is the hash the editor opened
   * (null: absent); a file changed on disk since is refused as 'stale'.
   */
  async saveGlobal(text: string, expectedHash: string | null): Promise<TtsrSaveResult> {
    const parsed = parseRulesFile(text)
    if (!parsed.ok) return { ok: false, reason: 'invalid', errors: parsed.errors }
    const hash = rulesHash(text)
    const slow = await this.probeErrors(hash, parsed.file.rules)
    if (slow.length > 0) return { ok: false, reason: 'invalid', errors: slow }
    const path = this.deps.globalRulesFile()
    const refused = baseRefusal(this.readRulesFile(path, null), expectedHash)
    if (refused) return refused
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileAtomic(path, text)
    } catch (e) {
      this.deps.reportError('ttsr', `could not write the global guard rules ${path}`, e)
      return { ok: false, reason: 'io', errors: [`file: cannot write: ${(e as Error).message}`] }
    }
    this.global = this.readRulesFile(path, null)
    this.deps.journal('global guard rules saved')
    this.recompileAll()
    return { ok: true, hash, approved: true }
  }

  /**
   * Validates and writes a project's repo rules file. `expectedHash` as for
   * saveGlobal. The new hash is approved (and becomes the root's current
   * hash) only when the base was absent or the file this root applies: an
   * operator editing agent-written content he has not approved would
   * approve it unseen, so a pending base is refused ('pending'), and an
   * invalid base (the raw editor fixing it) is written but stays pending.
   */
  async saveRepo(project: TtsrProjectRef, text: string, expectedHash: string | null): Promise<TtsrSaveResult> {
    const parsed = parseRulesFile(text)
    if (!parsed.ok) return { ok: false, reason: 'invalid', errors: parsed.errors }
    const hash = rulesHash(text)
    const slow = await this.probeErrors(hash, parsed.file.rules)
    if (slow.length > 0) return { ok: false, reason: 'invalid', errors: slow }
    const base = this.readRulesFile(join(project.root, REPO_RULES_REL), project.root)
    const refused = baseRefusal(base, expectedHash)
    if (refused) return refused
    let approve = base.status === 'absent'
    if (base.status === 'ok' && base.hash !== null) {
      if (ttsrRepoTrust(this.approvals, project.root, project.projectKey, base.hash) === 'pending') {
        return {
          ok: false,
          reason: 'pending',
          errors: ['file: the rules file on disk is not approved yet; review and approve it before editing it']
        }
      }
      approve = true
    }
    let path: string
    try {
      path = repoRulesPathForWrite(project.root)
      writeFileAtomic(path, text)
    } catch (e) {
      this.deps.reportError('ttsr', `could not write the repo guard rules of ${project.root}`, e)
      return { ok: false, reason: 'io', errors: [`file: cannot write: ${(e as Error).message}`] }
    }
    if (approve) {
      try {
        this.persistApproval(project.projectKey, hash, project.root)
      } catch (e) {
        this.deps.reportError('ttsr', `repo guard rules of ${project.root} saved but their approval could not be stored`, e)
        approve = false
      }
    }
    this.deps.journal(
      approve
        ? `repo guard rules saved and approved for ${project.root}`
        : `repo guard rules saved for ${project.root}, pending approval`
    )
    const state = this.projects.get(project.root)
    if (state) {
      state.snap = this.readRulesFile(path, project.root)
      this.settle(state)
    }
    this.recompileAll()
    return { ok: true, hash, approved: approve }
  }

  /**
   * Approves a repo file, only if `hash` is the hash of its CURRENT valid
   * content; it becomes the hash this root applies.
   */
  approveRepo(project: TtsrProjectRef, hash: string): TtsrApproveResult {
    const snap = this.readRulesFile(join(project.root, REPO_RULES_REL), project.root)
    const state = this.projects.get(project.root)
    if (state) state.snap = snap
    if (snap.status === 'absent') return { ok: false, reason: 'absent' }
    if (snap.status === 'invalid') return { ok: false, reason: 'invalid' }
    if (snap.hash !== hash) return { ok: false, reason: 'stale' }
    this.persistApproval(project.projectKey, hash, project.root)
    this.deps.journal(`repo guard rules approved for ${project.root} (${project.projectKey})`)
    if (state) this.settle(state)
    this.recompileAll()
    return { ok: true }
  }

  /**
   * Validates one rule and runs it against a sample text, the regex in an
   * isolated worker with a hard deadline. `opts.filePath` (project-relative)
   * is checked against the rule's `paths` globs.
   */
  async test(rule: unknown, sampleText: string, opts: TtsrTestOptions = {}): Promise<TtsrTestResult> {
    let fileText: string
    try {
      fileText = JSON.stringify({ version: 1, rules: [rule] })
    } catch (e) {
      return { ok: false, errors: [`rule is not serializable: ${(e as Error).message}`] }
    }
    const parsed = parseRulesFile(fileText)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const r = parsed.file.rules[0]!
    const tool: TtsrTool = opts.tool !== undefined ? opts.tool : r.tools[0]!
    if (!(TTSR_TOOLS as readonly string[]).includes(tool) || !r.tools.includes(tool)) {
      return { ok: false, errors: [`tool: "${String(tool)}" is not one of this rule's tools (${r.tools.join(', ')})`] }
    }
    let pathMatched: boolean | null = null
    if (opts.filePath !== undefined && r.paths && r.paths.length > 0) {
      const problem = checkRelativePath(opts.filePath)
      if (problem) return { ok: false, errors: [`filePath: ${problem}`] }
      const rel = opts.filePath
      const inc = r.paths.filter((g) => !g.startsWith('!')).map((g) => globToRegExp(g))
      const exc = r.paths.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)))
      pathMatched = (inc.length === 0 || inc.some((re) => re.test(rel))) && !exc.some((re) => re.test(rel))
    }
    const texts = extractField(samplePayload(r, tool, String(sampleText)), r.field)
    const res = await this.match(r.pattern, r.flags ?? '', texts)
    if (res.timedOut) return { ok: true, timedOut: true }
    if ('error' in res) return { ok: false, errors: [`pattern: ${res.error}`] }
    const match = res.matches.find((m) => m !== null) ?? null
    return { ok: true, timedOut: false, matched: match !== null, match, pathMatched }
  }

  // ----- queries -----

  /** Project of a live tile whose canonical root is `dir`, or null. */
  knownProject(dir: string): TtsrProjectRef | null {
    let root: string
    try {
      root = canonicalizePath(dir)
    } catch (e) {
      this.deps.reportError('ttsr', `cannot canonicalize ${dir}`, e)
      return null
    }
    const state = this.projects.get(root)
    return state ? { root: state.root, projectKey: state.key } : null
  }

  /** Project root + key of a directory (cached per canonical directory). */
  projectFor(cwd: string): TtsrProjectRef {
    const canon = canonicalizePath(cwd)
    let ref = this.projectCache.get(canon)
    if (!ref) {
      ref = this.deps.resolveProject
        ? this.deps.resolveProject(canon)
        : defaultResolveProject(canon, (m, e) => this.deps.reportError('ttsr', m, e))
      this.projectCache.set(canon, ref)
    }
    return ref
  }

  /** Path of a tile's effective file, or null when the tile is unknown. */
  effectivePathOf(deskId: string): string | null {
    return this.tiles.get(deskId)?.effectivePath ?? null
  }

  list(): TtsrRulesList {
    const disabled = new Set(this.deps.getDisabled())
    const row = (source: TtsrSource, rule: TtsrRule, trusted: boolean, projectKey?: string): TtsrRuleRow => {
      const toggleKey = ttsrToggleKey(source, rule.id, projectKey)
      const enabled = !disabled.has(toggleKey)
      const { source: _s, qualifiedId: _q, ...plain } = rule as TtsrEffectiveRule
      return {
        qualifiedId: `${source}/${rule.id}`,
        source,
        toggleKey,
        enabled,
        active: enabled && trusted,
        rule: plain
      }
    }
    const kory = KORY_EFFECTIVE_RULES.map((r) => row('kory', r, true))
    const globalRows = this.global.status === 'ok' ? this.global.rules.map((r) => row('user', r, this.global.probed)) : []
    const projects: TtsrRepoProject[] = []
    for (const state of this.projects.values()) {
      const sessionIds = [...this.tiles.values()]
        .filter((t) => t.project?.root === state.root)
        .map((t) => t.id)
      if (sessionIds.length === 0) continue
      const approved = this.isApproved(state)
      const file = this.fileState(join(state.root, REPO_RULES_REL), state.snap, approved ? 'approved' : 'pending')
      const current = this.approvals.roots[state.root]
      if (current !== undefined && current !== state.snap.hash) {
        file.previousHash = current
        if (state.snap.status === 'absent') file.removedApproved = true
      }
      projects.push({
        projectDir: state.root,
        projectKey: state.key,
        sessionIds,
        file,
        rules: state.snap.status === 'ok' ? state.snap.rules.map((r) => row('repo', r, approved, state.key)) : []
      })
    }
    return {
      kory,
      global: { file: this.fileState(this.deps.globalRulesFile(), this.global, 'valid'), rules: globalRows },
      projects
    }
  }

  // ----- internals -----

  private fileState(path: string, snap: FileSnapshot, okStatus: 'approved' | 'pending' | 'valid'): TtsrFileState {
    return {
      path,
      status: snap.status === 'ok' ? okStatus : snap.status,
      hash: snap.hash,
      errors: [...snap.errors],
      text: snap.text
    }
  }

  /**
   * Approved AND timed: a repo file's rules take effect only then. Approved
   * means the root's current hash, or, for a root with none yet, a hash
   * approved for its project key.
   */
  private isApproved(state: ProjectState): boolean {
    const snap = state.snap
    return (
      snap.status === 'ok' &&
      snap.probed &&
      snap.hash !== null &&
      ttsrRepoTrust(this.approvals, state.root, state.key, snap.hash) !== 'pending'
    )
  }

  /**
   * Re-evaluates a project after its file, its approvals or its timing
   * verdict changed: records an adopted hash as the root's current one,
   * traces the loss of applied rules once per transition (an agent deleting
   * or rewriting an approved file is operator-visible), then prompts.
   */
  private settle(state: ProjectState): void {
    const snap = state.snap
    let applied: string | null = null
    if (this.isApproved(state) && snap.hash !== null) {
      applied = snap.hash
      if (ttsrRepoTrust(this.approvals, state.root, state.key, snap.hash) === 'adoptable') {
        try {
          this.persistCurrent(state.root, snap.hash)
          this.deps.journal(`repo guard rules of ${state.root} applied: already approved for ${state.key}`)
        } catch (e) {
          this.deps.reportError('ttsr', `could not record the applied guard rules of ${state.root}`, e)
        }
      }
    }
    const before = state.applied
    state.applied = applied
    if (before !== null && applied === null) {
      const what =
        snap.status === 'absent'
          ? 'was deleted'
          : snap.status === 'invalid'
            ? 'was changed and is now invalid'
            : 'was changed and awaits approval'
      const text = `approved repo guard rules of ${state.root} no longer apply: the file ${what}`
      this.deps.journal(text)
      this.deps.reportError('ttsr', text)
    }
    this.maybePrompt(state)
  }

  private refreshProject(ref: TtsrProjectRef): ProjectState {
    const path = join(ref.root, REPO_RULES_REL)
    let state = this.projects.get(ref.root)
    if (!state) {
      state = { root: ref.root, key: ref.projectKey, snap: this.readRulesFile(path, ref.root), applied: null }
      this.projects.set(ref.root, state)
    } else if (statSig(path) !== state.snap.sig) {
      state.snap = this.readRulesFile(path, ref.root)
    }
    return state
  }

  private pruneProjects(): void {
    const live = new Set([...this.tiles.values()].map((t) => t.project?.root).filter((r): r is string => !!r))
    for (const root of this.projects.keys()) if (!live.has(root)) this.projects.delete(root)
  }

  private reloadApprovals(): void {
    const file = this.deps.approvalsFile()
    this.approvalsSig = statSig(file)
    this.approvals = readTtsrApprovals(file, (m, e) => this.deps.reportError('ttsr', m, e))
  }

  /**
   * Read-modify-write against the file, so an approval from another window
   * survives. `hash` joins the key's set and becomes `root`'s current hash;
   * a later dialog for that root may ask again.
   */
  private persistApproval(projectKey: string, hash: string, root: string): void {
    this.updateApprovals((a) => withTtsrApproval(a, projectKey, hash, root))
    this.prompted.deleteWhere((k) => k.startsWith(`${root}\n`))
  }

  private persistCurrent(root: string, hash: string): void {
    this.updateApprovals((a) => withTtsrCurrent(a, root, hash))
  }

  private updateApprovals(change: (a: TtsrApprovals) => TtsrApprovals): void {
    const file = this.deps.approvalsFile()
    const next = change(readTtsrApprovals(file, (m, e) => this.deps.reportError('ttsr', m, e)))
    mkdirSync(dirname(file), { recursive: true })
    writeTtsrApprovals(file, next)
    this.approvals = next
    this.approvalsSig = statSig(file)
  }

  private compile(tile: TileState): TtsrEffectiveFile {
    const disabled = new Set(this.deps.getDisabled())
    const rules: TtsrEffectiveRule[] = KORY_EFFECTIVE_RULES.filter((r) => !disabled.has(ttsrToggleKey('kory', r.id)))
    if (tile.supervisor) return { version: 1, rules }
    if (this.global.status === 'ok' && this.global.probed) {
      for (const r of this.global.rules) {
        if (!disabled.has(ttsrToggleKey('user', r.id))) rules.push(qualifyRule('user', r))
      }
    }
    const state = tile.project ? this.projects.get(tile.project.root) : undefined
    if (state && this.isApproved(state)) {
      for (const r of state.snap.rules) {
        if (!disabled.has(ttsrToggleKey('repo', r.id, state.key))) rules.push(qualifyRule('repo', r))
      }
    }
    return { version: 1, rules }
  }

  /** Compiles, self-checks through the shared parser, writes when changed (or forced). */
  private writeTile(tile: TileState, force: boolean): void {
    let text = JSON.stringify(this.compile(tile), null, 2) + '\n'
    const check = parseEffectiveFile(text)
    if (!check.ok) {
      this.deps.reportError(
        'ttsr',
        `compiled guard rules of tile ${tile.id} failed validation, falling back to the Kory rules: ${check.errors.slice(0, 3).join('; ')}`
      )
      text = JSON.stringify(this.compile({ ...tile, supervisor: true }), null, 2) + '\n'
    }
    if (!force && text === tile.written) return
    mkdirSync(dirname(tile.effectivePath), { recursive: true })
    writeFileAtomic(tile.effectivePath, text)
    tile.written = text
    tile.writtenSig = statSig(tile.effectivePath)
    if (tile.sandbox) this.writeSandboxCopy(tile)
  }

  /**
   * A host-side agent can write its own effective file (the session dir is
   * the operator's): a copy changed or removed behind the Deck's back is
   * rewritten, with a trace.
   */
  private checkEffectiveFile(tile: TileState): void {
    if (tile.written === null || statSig(tile.effectivePath) === tile.writtenSig) return
    this.deps.reportError('ttsr', `guard rules file of tile ${tile.id} was modified or removed outside the Deck; rewritten`)
    try {
      this.writeTile(tile, true)
    } catch (e) {
      this.deps.reportError('ttsr', `could not rewrite the guard rules of tile ${tile.id}`, e)
    }
  }

  private writeSandboxCopy(tile: TileState): void {
    if (!tile.sandbox || tile.written === null) return
    try {
      writeFileAtomic(tile.sandbox.path, tile.written, { mode: 0o644 })
      tile.sandbox.sig = statSig(tile.sandbox.path)
    } catch (e) {
      this.deps.reportError('ttsr', `could not refresh the sandbox guard rules of tile ${tile.id}`, e)
    }
  }

  /** The container can write its run dir: a copy changed behind our back is restored. */
  private checkSandboxCopy(tile: TileState): void {
    if (!tile.sandbox) return
    if (statSig(tile.sandbox.path) === tile.sandbox.sig) return
    this.deps.reportError('ttsr', `sandbox guard rules of tile ${tile.id} were modified or removed; restored`)
    this.writeSandboxCopy(tile)
  }

  private dropSandboxCopy(tile: TileState): void {
    if (!tile.sandbox) return
    this.drainLog(tile, tile.sandbox.log)
    try {
      rmSync(tile.sandbox.path, { force: true })
      rmSync(tile.sandbox.log.path, { force: true })
    } catch (e) {
      this.deps.reportError('ttsr', `could not delete the sandbox guard rules of tile ${tile.id}`, e)
    }
    tile.sandbox = null
  }

  /**
   * Opens the approval dialog of a pending repo file, at most one per root
   * at a time and one per TTSR_PROMPT_INTERVAL_MS per root: an agent
   * rewriting its file in a loop must not bury the operator in dialogs. A
   * change while a dialog is open is re-evaluated when it closes; one inside
   * the interval waits in Settings > Rules.
   */
  private maybePrompt(state: ProjectState): void {
    const snap = state.snap
    if (snap.status === 'invalid') {
      const tag = `${state.root}\n${snap.hash ?? snap.errors.join('|')}`
      if (!this.reportedInvalid.has(tag)) {
        this.reportedInvalid.add(tag)
        this.deps.reportError(
          'ttsr',
          `repo guard rules rejected (${snap.errors.length} error(s)), none loaded: ${join(state.root, REPO_RULES_REL)}: ${snap.errors.slice(0, 3).join('; ')}`
        )
      }
      return
    }
    // Never ask the operator to approve rules that have not been timed yet.
    if (snap.status !== 'ok' || !snap.probed || snap.hash === null || this.isApproved(state)) return
    const root = state.root
    if (this.promptOpen.has(root)) {
      this.promptAgain.add(root)
      return
    }
    const promptKey = `${root}\n${snap.hash}`
    if (this.prompted.has(promptKey)) return
    const last = this.lastPromptAt.get(root)
    if (last !== undefined && this.now() - last < TTSR_PROMPT_INTERVAL_MS) return
    this.prompted.add(promptKey)
    this.lastPromptAt.set(root, this.now())
    this.promptOpen.add(root)
    const req: TtsrApprovalRequest = { projectDir: root, projectKey: state.key, hash: snap.hash, rules: snap.rules }
    const closed = (): void => {
      this.promptOpen.delete(root)
      if (!this.promptAgain.delete(root)) return
      const now = this.projects.get(root)
      if (now) this.maybePrompt(now)
    }
    this.defer(() => {
      this.deps
        .promptApproval(req)
        .then((approve) => {
          if (!approve) {
            this.deps.journal(`repo guard rules left pending for ${req.projectDir}`)
            return
          }
          const res = this.approveRepo({ root: req.projectDir, projectKey: req.projectKey }, req.hash)
          if (!res.ok) {
            this.deps.reportError('ttsr', `repo guard rules not approved for ${req.projectDir}: the file is now ${res.reason}`)
          }
        })
        .catch((e: unknown) => this.deps.reportError('ttsr', `approval prompt failed for ${req.projectDir}`, e))
        .finally(closed)
    })
  }

  /** Timing errors of a file's rules, probing once per hash. */
  private probeErrors(hash: string, rules: readonly TtsrRule[]): Promise<string[]> {
    const v = this.probeVerdict(hash, rules)
    return v.done ? Promise.resolve(v.errors) : v.promise
  }

  /**
   * Runs the probe now when fewer than TTSR_PROBE_CONCURRENCY run, else
   * queues it: each asynchronous probe holds a worker thread for up to
   * seconds, and an agent can mint a new content every poll.
   */
  private scheduleProbe(rules: readonly TtsrRule[]): string[] | Promise<string[]> {
    if (this.probeActive < TTSR_PROBE_CONCURRENCY) return this.startProbe(rules)
    return new Promise((resolve) => {
      this.probeQueue.push(() => resolve(this.startProbe(rules)))
    })
  }

  private startProbe(rules: readonly TtsrRule[]): string[] | Promise<string[]> {
    let out: string[] | Promise<string[]>
    try {
      out = this.probeRules(rules)
    } catch (e) {
      this.deps.reportError('ttsr', 'guard rules timing check failed', e)
      return [`file: the pattern timing check failed: ${(e as Error).message}`]
    }
    if (Array.isArray(out)) return out
    this.probeActive++
    const release = (): void => {
      this.probeActive--
      while (this.probeActive < TTSR_PROBE_CONCURRENCY && this.probeQueue.length > 0) this.probeQueue.shift()!()
    }
    out.then(release, release)
    return out
  }

  /**
   * The probe verdict of a content, starting its probe when unknown. When an
   * asynchronous probe settles, every file holding that content is re-read
   * (now with a verdict) and the tiles are recompiled.
   */
  private probeVerdict(hash: string, rules: readonly TtsrRule[]): ProbeVerdict {
    const known = this.probes.get(hash)
    if (known) return known
    const out = this.scheduleProbe(rules)
    if (Array.isArray(out)) {
      const done: ProbeVerdict = { done: true, errors: out }
      this.probes.set(hash, done)
      return done
    }
    const promise = out
      .catch((e: unknown) => {
        this.deps.reportError('ttsr', 'guard rules timing check failed', e)
        return [`file: the pattern timing check failed: ${(e as Error).message}`]
      })
      .then((errors) => {
        this.probes.set(hash, { done: true, errors })
        this.onProbed(hash)
        return errors
      })
    const pending: ProbeVerdict = { done: false, promise }
    this.probes.set(hash, pending)
    return pending
  }

  private onProbed(hash: string): void {
    try {
      if (this.global.hash === hash) this.global = this.readRulesFile(this.deps.globalRulesFile(), null)
      for (const state of this.projects.values()) {
        if (state.snap.hash !== hash) continue
        state.snap = this.readRulesFile(join(state.root, REPO_RULES_REL), state.root)
        this.settle(state)
      }
      this.recompileAll()
    } catch (e) {
      this.deps.reportError('ttsr', 'could not apply a guard rules timing verdict', e)
    }
  }

  /**
   * Forwards the new complete lines of a hook trace log to the error sink,
   * at most TTSR_LOG_TICK_BYTES per pass. A log that shrank or was replaced
   * is read again from its start. The sandbox log sits in a directory the
   * container writes: it is opened once, without following a symlink and
   * without blocking, and read only if that descriptor is a regular file.
   */
  private drainLog(tile: TileState, log: LogTail): void {
    const fault = (what: string, e?: unknown): void => {
      const tag = `${what}:${(e as NodeJS.ErrnoException | undefined)?.code ?? ''}`
      if (log.fault === tag) return
      log.fault = tag
      this.deps.reportError('ttsr', `hook log ${log.path} of tile ${tile.id}: ${what}`, e)
    }
    try {
      const res = readBounded(log.path, {
        cap: TTSR_LOG_TICK_BYTES,
        overflow: 'truncate',
        offset: (st) => {
          if (log.ino !== null && st.ino !== log.ino) log.offset = 0
          if (st.size < log.offset) log.offset = 0
          log.ino = st.ino
          return log.offset
        }
      })
      if (res.kind === 'absent') return
      if (res.kind === 'refused') return fault(`${res.reason}, not read`)
      const buf = res.bytes
      const n = buf.length
      if (n === 0) return
      const nl = buf.lastIndexOf(0x0a, n - 1)
      // Only whole lines, unless one line alone fills the read.
      const take = nl >= 0 ? nl + 1 : n === TTSR_LOG_TICK_BYTES ? n : 0
      if (take === 0) return
      log.offset += take
      log.fault = null
      const lines = buf.subarray(0, take).toString('utf8').split('\n').filter((l) => l.trim() !== '')
      for (const line of lines) this.forwardLogLine(tile, line)
    } catch (e) {
      fault('cannot be read', e)
    }
  }

  /**
   * One hook log line to the error sink: control characters neutralized,
   * truncated, and rate-limited per tile (TTSR_LOG_TICK_LINES per pass,
   * TTSR_LOG_MINUTE_LINES per minute); the excess is counted and reported as
   * one summary line.
   */
  private forwardLogLine(tile: TileState, line: string): void {
    const r = this.rollLogWindow(tile)
    if (r.tickSent >= TTSR_LOG_TICK_LINES || r.minuteSent >= TTSR_LOG_MINUTE_LINES) {
      r.suppressed++
      return
    }
    r.tickSent++
    r.minuteSent++
    const safe = displaySafe(line)
    const cut = safe.length > TTSR_LOG_LINE_CHARS ? `${safe.slice(0, TTSR_LOG_LINE_CHARS)}…` : safe
    this.deps.reportError('ttsr-hook', `tile ${tile.id}: ${cut}`)
  }

  /** Starts a new minute window when the current one is over, reporting what it suppressed. */
  private rollLogWindow(tile: TileState): LogRate {
    const r = tile.rate
    const now = this.now()
    if (now - r.windowStart >= MINUTE_MS) {
      r.windowStart = now
      r.minuteSent = 0
      this.flushSuppressed(tile)
    }
    return r
  }

  /** The suppressed-lines summary, when the minute budget still allows a line. */
  private flushSuppressed(tile: TileState): void {
    const r = tile.rate
    if (r.suppressed === 0 || r.minuteSent >= TTSR_LOG_MINUTE_LINES) return
    this.deps.reportError(
      'ttsr-hook',
      `tile ${tile.id}: (+${r.suppressed} more lines suppressed by the rate limit; full log in ${tile.log.path}${tile.sandbox ? ` and ${tile.sandbox.log.path}` : ''})`
    )
    r.minuteSent++
    r.suppressed = 0
  }

  /**
   * Reads one rules file. `root` set = repo file, which an agent (possibly
   * sandboxed) can rewrite at any moment: the leaf must be a regular file,
   * never a symlink, its directory must resolve inside the root, and the
   * file is opened once (no follow, no block) and checked on the descriptor:
   * same inode as the lstat, still reachable inside the root after the read.
   * Never a partial result: an invalid file yields no rules and its errors.
   */
  private readRulesFile(path: string, root: string | null): FileSnapshot {
    let sig = statSig(path, root === null)
    if (sig === 'absent') return ABSENT
    const invalid = (errors: string[], text: string | null = null): FileSnapshot => ({
      sig,
      status: 'invalid',
      text,
      hash: text === null ? null : rulesHash(text),
      errors,
      rules: [],
      probed: true
    })
    if (sig.startsWith('error:')) {
      const tag = `${path}\n${sig}`
      if (!this.reportedInvalid.has(tag)) {
        this.reportedInvalid.add(tag)
        this.deps.reportError('ttsr', `cannot stat ${path} (${sig.slice(6)}); its rules are not loaded`)
      }
      return invalid([`file: cannot stat (${sig.slice(6)})`])
    }
    try {
      let expect: { dev: number; ino: number } | undefined
      if (root !== null) {
        const st = lstatSync(path)
        if (st.isSymbolicLink()) return invalid(['file: is a symlink; a repo rules file must be a regular file'])
        if (!st.isFile()) return invalid(['file: is not a regular file'])
        if (!within(root, realpathSync.native(dirname(path)))) return invalid(['file: resolves outside the project root'])
        expect = { dev: st.dev, ino: st.ino }
      }
      const res = readBounded(path, { cap: MAX_FILE_BYTES, follow: root === null, expect })
      if (res.kind === 'absent') return ABSENT
      if (res.kind === 'refused') {
        return invalid([
          res.reason === 'is a symlink' ? 'file: is a symlink; a repo rules file must be a regular file' : `file: ${res.reason}`
        ])
      }
      sig = sigOf(res.stat)
      if (root !== null) {
        // The directory may have been swapped for a symlink between the
        // containment check and the open: the inode read must still be the
        // one found at the contained path.
        const realDir = realpathSync.native(dirname(path))
        const again = within(root, realDir) ? lstatSync(join(realDir, basename(path))) : null
        if (!again || again.dev !== res.stat.dev || again.ino !== res.stat.ino) {
          return invalid(['file: was replaced while being read'])
        }
      }
      const text = res.bytes.toString('utf8')
      const hash = rulesHash(text)
      const parsed = parseRulesFile(text)
      const verdict = parsed.ok ? this.probeVerdict(hash, parsed.file.rules) : null
      const errors = !parsed.ok ? parsed.errors : verdict !== null && verdict.done ? verdict.errors : []
      if (errors.length > 0) {
        if (root === null) {
          const tag = `${path}\n${hash}`
          if (!this.reportedInvalid.has(tag)) {
            this.reportedInvalid.add(tag)
            this.deps.reportError(
              'ttsr',
              `global guard rules rejected (${errors.length} error(s)), none loaded: ${path}: ${errors.slice(0, 3).join('; ')}`
            )
          }
        }
        return invalid(errors, text)
      }
      const rules = parsed.ok ? parsed.file.rules : []
      return { sig, status: 'ok', text, hash, errors: [], rules, probed: verdict?.done === true }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return ABSENT
      this.deps.reportError('ttsr', `cannot read ${path}`, e)
      return invalid([`file: cannot read: ${(e as Error).message}`])
    }
  }
}

/**
 * Why a save must not overwrite `base`: the editor opened another version
 * ('stale'), or the file on disk cannot be read ('io'); null when it may.
 */
function baseRefusal(base: FileSnapshot, expectedHash: string | null): TtsrSaveResult | null {
  if (base.status === 'absent') {
    return expectedHash === null
      ? null
      : { ok: false, reason: 'stale', errors: ['file: removed since the editor opened it; reload'] }
  }
  if (base.hash === null) {
    return { ok: false, reason: 'io', errors: base.errors.length > 0 ? [...base.errors] : ['file: cannot be read'] }
  }
  if (base.hash !== expectedHash) {
    return { ok: false, reason: 'stale', errors: ['file: changed on disk since the editor opened it; reload'] }
  }
  return null
}

/**
 * Where a Deck save writes a project's rules file. The nearest existing
 * ancestor of its directory must resolve inside the root BEFORE anything is
 * created (a `.claude` symlinked outside must not get a directory made
 * there); the missing levels are then created one at a time, each checked
 * to be a real directory, never a symlink; the leaf must not be a symlink
 * nor a non-file. Throws otherwise. Residual race: a directory swapped for a
 * symlink after these checks and before the atomic rename.
 */
export function repoRulesPathForWrite(root: string): string {
  const canonRoot = canonicalizePath(root)
  const path = join(canonRoot, REPO_RULES_REL)
  const parent = dirname(path)
  const refuse = (why: string): never => {
    throw new Error(`refusing to write ${path}: ${why}`)
  }
  let existing = parent
  while (existing !== canonRoot && !existsSync(existing)) existing = dirname(existing)
  if (!within(canonRoot, realpathSync.native(existing))) refuse('its directory resolves outside the project root')
  const missing: string[] = []
  for (let d = parent; d !== existing; d = dirname(d)) missing.unshift(d)
  for (const d of missing) {
    try {
      mkdirSync(d)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const st = lstatSync(d)
    if (st.isSymbolicLink()) refuse(`${d} is a symlink`)
    if (!st.isDirectory()) refuse(`${d} is not a directory`)
  }
  if (!within(canonRoot, realpathSync.native(parent))) refuse('its directory resolves outside the project root')
  let leaf: ReturnType<typeof lstatSync> | null = null
  try {
    leaf = lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (leaf?.isSymbolicLink()) refuse('it is a symlink')
  if (leaf && !leaf.isFile()) refuse('it is not a regular file')
  return path
}

/** A tail of `path` starting at its current end: lines already there belong to an earlier spawn. */
function newLogTail(path: string): LogTail {
  try {
    const st = lstatSync(path)
    if (st.isFile()) return { path, offset: st.size, ino: st.ino, fault: null }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
  }
  return { path, offset: 0, ino: null, fault: null }
}

function checkRelativePath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'must be a non-empty string'
  if (p.includes('\\')) return 'must use "/" separators'
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be relative to the project root'
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) return 'must not hold empty, "." or ".." segments'
  return null
}

/** A synthetic hook payload carrying `text` in the rule's field for `tool`. */
function samplePayload(rule: TtsrRule, tool: TtsrTool, text: string): unknown {
  const base = { hook_event_name: rule.event, tool_name: tool }
  switch (rule.field) {
    case 'command':
      return { ...base, tool_input: { command: text } }
    case 'output':
      return { ...base, tool_input: { command: '' }, tool_response: { stdout: text, stderr: '' } }
    case 'file_path':
      return { ...base, tool_input: { file_path: text } }
    case 'added':
      if (tool === 'MultiEdit') return { ...base, tool_input: { edits: [{ new_string: text }] } }
      if (tool === 'Write') return { ...base, tool_input: { content: text } }
      if (tool === 'NotebookEdit') return { ...base, tool_input: { new_source: text } }
      return { ...base, tool_input: { new_string: text } }
  }
}
