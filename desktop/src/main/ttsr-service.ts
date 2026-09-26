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
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
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
import { isTtsrApproved, readTtsrApprovals, withTtsrApproval, writeTtsrApprovals, type TtsrApprovals } from './ttsr-approvals'
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
/** Hook log lines forwarded per log per poll pass; the rest are counted. */
export const TTSR_LOG_TICK_LINES = 20
const TTSR_LOG_LINE_CHARS = 1000

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

interface TileState {
  id: string
  supervisor: boolean
  project: TtsrProjectRef | null
  effectivePath: string
  /** Last content written to the effective file. */
  written: string | null
  sandbox: SandboxCopy | null
  log: LogTail
}

const ABSENT: FileSnapshot = { sig: 'absent', status: 'absent', text: null, hash: null, errors: [], rules: [], probed: true }

/**
 * Change signature of a file: ino, size, mtime, link-ness. `follow` stats the
 * symlink target instead (the operator's own global file may be a symlink).
 * Never throws: an unexpected error becomes an `error:<code>` signature that
 * the reader then reports.
 */
function statSig(path: string, follow = false): string {
  try {
    const st = follow ? statSync(path) : lstatSync(path)
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.isSymbolicLink() ? 'l' : 'f'}`
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    return `error:${code ?? 'unknown'}`
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
  private approvals: TtsrApprovals = {}
  private approvalsSig = 'unread'
  /** `<key>\n<hash>` already shown to the operator this run. */
  private readonly prompted = new Set<string>()
  /** `<path>\n<hash or errors>` already traced as invalid this run. */
  private readonly reportedInvalid = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private readonly defer: (fn: () => void) => void
  private readonly match: NonNullable<TtsrServiceDeps['matchIsolated']>
  private readonly probeRules: NonNullable<TtsrServiceDeps['probeRules']>
  /** Timing verdict per file hash: one probe per content per run. */
  private readonly probes = new Map<string, ProbeVerdict>()

  constructor(private readonly deps: TtsrServiceDeps) {
    this.defer = deps.defer ?? ((fn) => setImmediate(fn))
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
        sandbox: null,
        log: newLogTail(join(dir, ttsrLogFileName(spec.id)))
      }
      this.tiles.set(spec.id, tile)
      if (project) {
        const state = this.refreshProject(project)
        this.maybePrompt(state)
      }
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
        this.maybePrompt(state)
      }
    }
    if (changed) this.recompileAll()
    for (const tile of this.tiles.values()) {
      this.checkSandboxCopy(tile)
      this.drainLog(tile, tile.log)
      if (tile.sandbox) this.drainLog(tile, tile.sandbox.log)
    }
  }

  // ----- operator actions -----

  /** Validates (parser, then timing probe), writes the global rules file, recompiles every tile. */
  async saveGlobal(text: string): Promise<TtsrSaveResult> {
    const parsed = parseRulesFile(text)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const slow = await this.probeErrors(rulesHash(text), parsed.file.rules)
    if (slow.length > 0) return { ok: false, errors: slow }
    const path = this.deps.globalRulesFile()
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, text)
    this.global = this.readRulesFile(path, null)
    this.deps.journal('global guard rules saved')
    this.recompileAll()
    return { ok: true, hash: rulesHash(text) }
  }

  /**
   * Validates and writes a project's repo rules file. The operator authored
   * this content from the Deck, so its new hash is approved in the same call.
   * Refuses a symlinked leaf and a parent directory resolving outside the root.
   */
  async saveRepo(project: TtsrProjectRef, text: string): Promise<TtsrSaveResult> {
    const parsed = parseRulesFile(text)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const slow = await this.probeErrors(rulesHash(text), parsed.file.rules)
    if (slow.length > 0) return { ok: false, errors: slow }
    const path = repoRulesPathForWrite(project.root)
    writeFileAtomic(path, text)
    const hash = rulesHash(text)
    this.persistApproval(project.projectKey, hash)
    this.deps.journal(`repo guard rules saved and approved for ${project.projectKey}`)
    const state = this.projects.get(project.root)
    if (state) state.snap = this.readRulesFile(path, project.root)
    this.recompileAll()
    return { ok: true, hash }
  }

  /** Approves a repo file, only if `hash` is the hash of its CURRENT valid content. */
  approveRepo(project: TtsrProjectRef, hash: string): TtsrApproveResult {
    const snap = this.readRulesFile(join(project.root, REPO_RULES_REL), project.root)
    const state = this.projects.get(project.root)
    if (state) state.snap = snap
    if (snap.status === 'absent') return { ok: false, reason: 'absent' }
    if (snap.status === 'invalid') return { ok: false, reason: 'invalid' }
    if (snap.hash !== hash) return { ok: false, reason: 'stale' }
    this.persistApproval(project.projectKey, hash)
    this.deps.journal(`repo guard rules approved for ${project.projectKey}`)
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
      projects.push({
        projectDir: state.root,
        projectKey: state.key,
        sessionIds,
        file: this.fileState(join(state.root, REPO_RULES_REL), state.snap, approved ? 'approved' : 'pending'),
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

  /** Approved AND timed: a repo file's rules take effect only then. */
  private isApproved(state: ProjectState): boolean {
    const snap = state.snap
    return snap.status === 'ok' && snap.probed && snap.hash !== null && isTtsrApproved(this.approvals, state.key, snap.hash)
  }

  private refreshProject(ref: TtsrProjectRef): ProjectState {
    const path = join(ref.root, REPO_RULES_REL)
    let state = this.projects.get(ref.root)
    if (!state) {
      state = { root: ref.root, key: ref.projectKey, snap: this.readRulesFile(path, ref.root) }
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

  /** Read-modify-write against the file, so an approval from another window survives. */
  private persistApproval(projectKey: string, hash: string): void {
    const file = this.deps.approvalsFile()
    const current = readTtsrApprovals(file, (m, e) => this.deps.reportError('ttsr', m, e))
    const next = withTtsrApproval(current, projectKey, hash)
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
    if (tile.sandbox) this.writeSandboxCopy(tile)
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
    const promptKey = `${state.key}\n${snap.hash}`
    if (this.prompted.has(promptKey)) return
    this.prompted.add(promptKey)
    const req: TtsrApprovalRequest = { projectDir: state.root, projectKey: state.key, hash: snap.hash, rules: snap.rules }
    this.defer(() => {
      this.deps
        .promptApproval(req)
        .then((approve) => {
          if (!approve) {
            this.deps.journal(`repo guard rules left pending for ${req.projectKey}`)
            return
          }
          const res = this.approveRepo({ root: req.projectDir, projectKey: req.projectKey }, req.hash)
          if (!res.ok) {
            this.deps.reportError('ttsr', `repo guard rules not approved for ${req.projectKey}: the file is now ${res.reason}`)
          }
        })
        .catch((e: unknown) => this.deps.reportError('ttsr', `approval prompt failed for ${req.projectKey}`, e))
    })
  }

  /** Timing errors of a file's rules, probing once per hash. */
  private probeErrors(hash: string, rules: readonly TtsrRule[]): Promise<string[]> {
    const v = this.probeVerdict(hash, rules)
    return v.done ? Promise.resolve(v.errors) : v.promise
  }

  /**
   * The probe verdict of a content, starting its probe when unknown. When an
   * asynchronous probe settles, every file holding that content is re-read
   * (now with a verdict) and the tiles are recompiled.
   */
  private probeVerdict(hash: string, rules: readonly TtsrRule[]): ProbeVerdict {
    const known = this.probes.get(hash)
    if (known) return known
    let out: string[] | Promise<string[]>
    try {
      out = this.probeRules(rules)
    } catch (e) {
      out = [`file: the pattern timing check failed: ${(e as Error).message}`]
      this.deps.reportError('ttsr', 'guard rules timing check failed', e)
    }
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
        this.maybePrompt(state)
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
   * container writes: a symlink or non-file there is refused, never followed.
   */
  private drainLog(tile: TileState, log: LogTail): void {
    let fd: number | null = null
    const fault = (what: string, e?: unknown): void => {
      const tag = `${what}:${(e as NodeJS.ErrnoException | undefined)?.code ?? ''}`
      if (log.fault === tag) return
      log.fault = tag
      this.deps.reportError('ttsr', `hook log ${log.path} of tile ${tile.id}: ${what}`, e)
    }
    try {
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(log.path)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return
        throw e
      }
      if (!st.isFile()) return fault('not a regular file, not read')
      if (log.ino !== null && st.ino !== log.ino) log.offset = 0
      if (st.size < log.offset) log.offset = 0
      log.ino = st.ino
      if (st.size === log.offset) return
      fd = openSync(log.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      if (fstatSync(fd).ino !== st.ino) return fault('replaced while being read, retried next pass')
      const buf = Buffer.alloc(Math.min(st.size - log.offset, TTSR_LOG_TICK_BYTES))
      const n = readSync(fd, buf, 0, buf.length, log.offset)
      const nl = buf.lastIndexOf(0x0a, n - 1)
      // Only whole lines, unless one line alone fills the read.
      const take = nl >= 0 ? nl + 1 : n === TTSR_LOG_TICK_BYTES ? n : 0
      if (take === 0) return
      log.offset += take
      log.fault = null
      const lines = buf.subarray(0, take).toString('utf8').split('\n').filter((l) => l.trim() !== '')
      for (const line of lines.slice(0, TTSR_LOG_TICK_LINES)) {
        this.deps.reportError('ttsr-hook', `tile ${tile.id}: ${line.slice(0, TTSR_LOG_LINE_CHARS)}`)
      }
      if (lines.length > TTSR_LOG_TICK_LINES) {
        this.deps.reportError('ttsr-hook', `tile ${tile.id}: (+${lines.length - TTSR_LOG_TICK_LINES} more lines in ${log.path})`)
      }
    } catch (e) {
      fault('cannot be read', e)
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  /**
   * Reads one rules file. `root` set = repo file: the leaf must not be a
   * symlink and must resolve inside the root. Never a partial result: an
   * invalid file yields no rules and its errors.
   */
  private readRulesFile(path: string, root: string | null): FileSnapshot {
    const sig = statSig(path, root === null)
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
      const st = root !== null ? lstatSync(path) : statSync(path)
      if (root !== null) {
        if (st.isSymbolicLink()) return invalid(['file: is a symlink; a repo rules file must be a regular file'])
        if (!within(root, realpathSync.native(path))) return invalid(['file: resolves outside the project root'])
      }
      if (!st.isFile()) return invalid(['file: is not a regular file'])
      if (st.size > MAX_FILE_BYTES) return invalid([`file: ${st.size} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`])
      const text = readFileSync(path, 'utf8')
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
      this.deps.reportError('ttsr', `cannot read ${path}`, e)
      return invalid([`file: cannot read: ${(e as Error).message}`])
    }
  }
}

/**
 * Where a Deck save writes a project's rules file: the parent directories are
 * created, must resolve inside the root, and the leaf must not be a symlink.
 * Throws otherwise.
 */
export function repoRulesPathForWrite(root: string): string {
  const canonRoot = canonicalizePath(root)
  const path = join(canonRoot, REPO_RULES_REL)
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  if (!within(canonRoot, realpathSync.native(parent))) {
    throw new Error(`refusing to write ${path}: its directory resolves outside the project root`)
  }
  let leaf: ReturnType<typeof lstatSync> | null = null
  try {
    leaf = lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (leaf?.isSymbolicLink()) throw new Error(`refusing to write ${path}: it is a symlink`)
  if (leaf && !leaf.isFile()) throw new Error(`refusing to write ${path}: it is not a regular file`)
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
