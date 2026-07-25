// Sandbox mode (PLAN-SANDBOX SBX1–SBX5 + M2/M3): Docker/Podman lifecycle for
// the per-project sandbox container. Engine + image detection, ensure (volume,
// optional ephemeral clone, create, start, config projection), auth probe on
// the shared credentials volume, broker-bridge probe, container-side transcript
// cache (resume), the cross-project listing for the rail view, and the cached
// launch info the SessionService wraps spawns with.
//
// The engine CLI is reached through an injectable `exec` (never a shell string
// — argument vectors only), so the sequencing is bun-testable with a scripted
// fake. Container names arriving from IPC are re-validated here against the
// generated shape (hostile input #3): this service only ever passes
// `kory-sbx-<hash12>` names it re-checked, whatever the renderer sent.

import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  SandboxContainerAction,
  SandboxContainerInfo,
  SandboxExecResponse,
  SandboxStatus
} from '@shared/types'
import {
  SANDBOX_AUTH_VOLUME,
  SANDBOX_HOME,
  buildAuthProbeArgs,
  buildAuthPurgeArgs,
  buildBrokerProbeArgs,
  buildCopyIntoArgs,
  buildCreateArgs,
  buildExecCommand,
  buildImageBuildCommand,
  buildImageProbeArgs,
  buildLaunchScript,
  buildSupervisorExecArgs,
  buildTranscriptListArgs,
  containerNameFor,
  containerTranscriptDir,
  isSandboxContainerName,
  parseTranscriptList,
  scriptFileName,
  type SandboxEngine,
  type SandboxLaunchScriptSpec
} from './sandbox-command'
import {
  projectSandboxSettings,
  readSandboxStore,
  writeSandboxImage,
  writeSandboxSettings,
  type SandboxProjectSettings,
  type SandboxWorkMode
} from './sandbox-store'
import { planIgnoredCopy } from './sandbox-copy'
import { describeProjection, planProjection, projectionHookWarnings, unknownOverrides } from './sandbox-projection'
import { reportError } from './log'

export interface SandboxExecResult {
  code: number
  stdout: string
  stderr: string
}

const EXEC_TIMEOUT_MS = 20_000
/** Engine probe cache: re-detect at most this often (the view's refresh forces it). */
const ENGINE_PROBE_TTL_MS = 60_000
/** Cap on supervisor exec output handed back to the agent (M2). */
const SUPERVISOR_EXEC_MAX_CHARS = 16_000
/** Supervisor exec wall-clock cap (dependency installs are slow but bounded). */
const SUPERVISOR_EXEC_TIMEOUT_MS = 5 * 60_000

export type SandboxEngineState = 'ok' | 'daemon-down' | 'missing'

interface EngineProbe {
  engine: SandboxEngine | null
  state: SandboxEngineState
  version: string | null
  at: number
}

/** What startPty needs to wrap a session command (cached, synchronous). */
export interface SandboxLaunch {
  engine: SandboxEngine
  container: string
  runDirHost: string
  /** Host dir mounted at /work — the project, or the clone in copy mode. */
  workSource: string
}

export interface SandboxServiceDeps {
  projectDir: string
  /** computeDeckProjectKey(projectDir) — the sandbox.json key. */
  projectKey: string
  /** App state dir (sandbox.json, sandbox-run/, sandbox-copies/). */
  stateDir: string
  /** Host ~/.claude (projection source + peers back-channel mount). */
  claudeHomeDir: string
  /** Dir holding the shipped Dockerfile (image auto-build). */
  imageContextDir: string
  /** Broker endpoint the CONTAINER should reach (already host.docker.internal). */
  containerBrokerUrl: () => string
  journal: (msg: string) => void
  /** Engine CLI runner, injectable for tests. Never throws — resolves code -1. */
  exec?: (file: string, args: string[], timeoutMs?: number) => Promise<SandboxExecResult>
}

function defaultExec(
  file: string,
  args: string[],
  timeoutMs = EXEC_TIMEOUT_MS
): Promise<SandboxExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = err
          ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | undefined)
          : 0
        resolvePromise({
          code: typeof raw === 'number' ? raw : err ? -1 : 0,
          stdout: String(stdout ?? ''),
          stderr: err && !stderr ? String((err as Error).message) : String(stderr ?? '')
        })
      }
    )
  })
}

/** Emits `changed` (SandboxStatus) after every state-moving operation. */
export class SandboxService extends EventEmitter {
  private probe: EngineProbe | null = null
  private busy = false
  private lastError: string | null = null
  /** Last observed readiness, consumed synchronously by launchInfo(). */
  private lastReady = false
  /** Last broker-bridge verdict (null = not probed yet). */
  private bridgeOk: boolean | null = null
  /** Container-side transcripts, keyed by HOST cwd (M2 resume). */
  private transcripts = new Map<string, { id: string; mtimeMs: number }[]>()
  private imagePresent: boolean | null = null
  private projectionSummary: string | null = null
  private hookWarnings: string[] = []
  private copyUnmatched: string[] = []
  readonly containerName: string
  private readonly storeFile: string
  private readonly runDirHost: string
  private readonly copyDirHost: string

  constructor(private readonly deps: SandboxServiceDeps) {
    super()
    this.containerName = containerNameFor(deps.projectDir)
    this.storeFile = join(deps.stateDir, 'sandbox.json')
    this.runDirHost = join(deps.stateDir, 'sandbox-run')
    // Short, stable clone dir keyed by the same hash as the container.
    this.copyDirHost = join(deps.stateDir, 'sandbox-copies', this.containerName)
  }

  private run(args: string[], timeoutMs?: number): Promise<SandboxExecResult> {
    const engine = this.probe?.engine
    if (!engine) return Promise.resolve({ code: -1, stdout: '', stderr: 'no engine' })
    return (this.deps.exec ?? defaultExec)(engine, args, timeoutMs)
  }

  // ----- settings -----

  settings(): SandboxProjectSettings {
    return projectSandboxSettings(this.storeFile, this.deps.projectKey)
  }

  isEnabled(): boolean {
    return this.settings().enabled
  }

  image(): string {
    return readSandboxStore(this.storeFile).image
  }

  private mode(): SandboxWorkMode {
    return this.settings().mode
  }

  /** Host dir mounted at /work: the project, or the ephemeral clone. */
  private workSource(): string {
    return this.mode() === 'copy' ? this.copyDirHost : this.deps.projectDir
  }

  /**
   * The dir sessions and worktrees must land in. In copy mode this is the
   * clone — returning it from the pre-spawn gate is what keeps `git worktree
   * add` and the tile cwd inside the mounted tree.
   */
  effectiveRoot(): string {
    return this.isEnabled() ? this.workSource() : this.deps.projectDir
  }

  // ----- engine / image -----

  /** Detect docker, then podman. Cached (TTL) — `force` for the view's refresh. */
  async detectEngine(force = false): Promise<EngineProbe> {
    if (!force && this.probe && Date.now() - this.probe.at < ENGINE_PROBE_TTL_MS) {
      return this.probe
    }
    const exec = this.deps.exec ?? defaultExec
    let result: EngineProbe = { engine: null, state: 'missing', version: null, at: Date.now() }
    for (const candidate of ['docker', 'podman'] as const) {
      const version = await exec(candidate, ['version', '--format', '{{.Client.Version}}'], 8000)
      if (version.code === 0 && version.stdout.trim()) {
        // CLI + daemon both answer.
        result = { engine: candidate, state: 'ok', version: version.stdout.trim(), at: Date.now() }
        break
      }
      if (version.stdout.trim()) {
        // CLI answered but the daemon leg failed: Desktop/VM not running.
        result = {
          engine: candidate,
          state: 'daemon-down',
          version: version.stdout.trim(),
          at: Date.now()
        }
        break
      }
    }
    this.probe = result
    return result
  }

  private async probeImage(): Promise<boolean> {
    const res = await this.run(buildImageProbeArgs(this.image()), 10_000)
    this.imagePresent = res.code === 0
    return this.imagePresent
  }

  /** PTY command line building the shipped Dockerfile (utility terminal, M2). */
  imageBuildCommand(): string {
    const engine = this.probe?.engine ?? 'docker'
    return buildImageBuildCommand(engine, this.image(), this.deps.imageContextDir)
  }

  setImage(image: string): string {
    const next = writeSandboxImage(this.storeFile, image)
    this.imagePresent = null
    return next
  }

  private async inspectState(name: string): Promise<string | null> {
    const res = await this.run(['inspect', '--format', '{{.State.Status}}', name])
    return res.code === 0 ? res.stdout.trim() : null
  }

  /** Container creation date vs image creation date (drift badge, M2). */
  private async driftDays(): Promise<number | null> {
    const [ctn, img] = await Promise.all([
      this.run(['inspect', '--format', '{{.Created}}', this.containerName]),
      this.run(buildImageProbeArgs(this.image()))
    ])
    if (ctn.code !== 0 || img.code !== 0) return null
    const ctnAt = Date.parse(ctn.stdout.trim())
    const imgAt = Date.parse(img.stdout.trim())
    if (!Number.isFinite(ctnAt) || !Number.isFinite(imgAt)) return null
    // Positive = the image was rebuilt AFTER this container was created.
    const diff = imgAt - ctnAt
    return diff > 0 ? Math.floor(diff / (24 * 3600 * 1000)) : null
  }

  // ----- status -----

  async status(forceEngine = false): Promise<SandboxStatus> {
    const probe = await this.detectEngine(forceEngine)
    const settings = this.settings()
    let containerState: SandboxStatus['containerState'] = 'missing'
    let authed: boolean | null = null
    let drift: number | null = null
    if (probe.state === 'ok') {
      if (this.imagePresent === null || forceEngine) await this.probeImage()
      const state = await this.inspectState(this.containerName)
      if (state === 'running') {
        containerState = 'running'
        authed = await this.probeAuth()
        drift = await this.driftDays()
      } else if (state !== null) {
        containerState = 'stopped'
        drift = await this.driftDays()
      }
    }
    this.lastReady = containerState === 'running'
    return {
      engine: probe.engine,
      engineState: probe.state,
      engineVersion: probe.version,
      enabled: settings.enabled,
      mode: settings.mode,
      containerName: this.containerName,
      containerState,
      authed,
      image: this.image(),
      imagePresent: this.imagePresent,
      ports: settings.ports,
      copyIgnored: settings.copyIgnored,
      copyDir: settings.mode === 'copy' ? this.copyDirHost : null,
      copyUnmatched: this.copyUnmatched,
      projection: this.projectionSummary,
      hookWarnings: this.hookWarnings,
      brokerBridge: this.bridgeOk,
      driftDays: drift,
      busy: this.busy,
      error: this.lastError
    }
  }

  private async broadcastStatus(): Promise<SandboxStatus> {
    const st = await this.status()
    this.emit('changed', st)
    return st
  }

  /**
   * Toggle / settings patch for this project. The LIVE-SESSIONS guard lives at
   * the IPC layer (service.hasLiveSessions()) so the rule sits next to its
   * sibling scope gate; this method only persists + notifies.
   */
  async patchSettings(patch: Partial<SandboxProjectSettings>): Promise<SandboxStatus> {
    const next = writeSandboxSettings(this.storeFile, this.deps.projectKey, patch)
    if (patch.enabled !== undefined) {
      this.deps.journal(`sandbox: mode ${next.enabled ? 'enabled' : 'disabled'} for this project`)
    }
    if (patch.mode !== undefined) {
      this.deps.journal(`sandbox: work mode set to ${next.mode}`)
    }
    return this.broadcastStatus()
  }

  // ----- copy mode (M3) -----

  /**
   * Prepare the ephemeral clone: `git clone --local` (shared object store, so
   * even a big repo is instant) then the operator's allow-listed gitignored
   * files on top. Idempotent: an existing clone is kept, only newer host
   * copies of the allow-listed files are refreshed — an agent's edits inside
   * the sandbox are never clobbered by a stale host file.
   */
  private async ensureCopyTree(): Promise<void> {
    const exec = this.deps.exec ?? defaultExec
    if (!existsSync(join(this.copyDirHost, '.git'))) {
      mkdirSync(dirname(this.copyDirHost), { recursive: true })
      rmSync(this.copyDirHost, { recursive: true, force: true })
      const cloned = await exec(
        'git',
        ['clone', '--local', '--no-hardlinks', this.deps.projectDir, this.copyDirHost],
        120_000
      )
      if (cloned.code !== 0) {
        throw new Error(
          `ephemeral clone failed (is the project a git repo?): ${cloned.stderr.trim() || cloned.code}`
        )
      }
      this.deps.journal(`sandbox: ephemeral clone created at ${this.copyDirHost}`)
    }
    const { files, unmatched } = planIgnoredCopy(this.deps.projectDir, this.settings().copyIgnored)
    this.copyUnmatched = unmatched
    let copied = 0
    for (const rel of files) {
      const src = join(this.deps.projectDir, rel)
      const dst = join(this.copyDirHost, rel)
      try {
        if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue
        mkdirSync(dirname(dst), { recursive: true })
        cpSync(src, dst)
        copied++
      } catch (e) {
        // One unreadable file must not abort the whole spawn path.
        reportError('sandbox', `ignored-file copy failed: ${rel}`, e)
      }
    }
    if (copied > 0) this.deps.journal(`sandbox: ${copied} ignored file(s) copied into the clone`)
  }

  /** Delete and re-create the clone (operator action; container untouched). */
  async resetCopy(): Promise<SandboxStatus> {
    rmSync(this.copyDirHost, { recursive: true, force: true })
    this.deps.journal('sandbox: ephemeral clone reset')
    await this.ensureCopyTree()
    return this.broadcastStatus()
  }

  // ----- lifecycle -----

  /**
   * Bring the project container up: volume + (copy mode) clone + create
   * (idempotent) + start + config projection. Persistent by design — created
   * once, `stop`ped on app close, removed only by an explicit operator action.
   */
  async ensure(): Promise<SandboxStatus> {
    const probe = await this.detectEngine()
    if (probe.state !== 'ok') {
      this.lastError =
        probe.state === 'daemon-down'
          ? 'engine daemon not running (start Docker Desktop / podman machine)'
          : 'no container engine found (install Docker Desktop or Podman)'
      return this.broadcastStatus()
    }
    this.busy = true
    this.lastError = null
    try {
      if (!(await this.probeImage())) {
        this.lastError = `image "${this.image()}" not found — build it from the Docker view`
        return this.broadcastStatus()
      }
      mkdirSync(this.runDirHost, { recursive: true })
      const peersDirHost = join(this.deps.claudeHomeDir, 'peers')
      mkdirSync(peersDirHost, { recursive: true })
      if (this.mode() === 'copy') await this.ensureCopyTree()
      await this.run(['volume', 'create', SANDBOX_AUTH_VOLUME])

      const state = await this.inspectState(this.containerName)
      if (state === null) {
        const created = await this.run(
          buildCreateArgs({
            name: this.containerName,
            image: this.image(),
            projectDir: this.deps.projectDir,
            workSource: this.workSource(),
            runDirHost: this.runDirHost,
            peersDirHost,
            ports: this.settings().ports
          }),
          60_000
        )
        if (created.code !== 0) {
          this.lastError = created.stderr.trim() || 'container create failed'
          reportError('sandbox', `create failed for ${this.containerName}: ${this.lastError}`)
          return this.broadcastStatus()
        }
        this.deps.journal(`sandbox: container ${this.containerName} created (${this.image()})`)
      }
      if (state !== 'running') {
        const started = await this.run(['start', this.containerName], 30_000)
        if (started.code !== 0) {
          this.lastError = started.stderr.trim() || 'container start failed'
          reportError('sandbox', `start failed for ${this.containerName}: ${this.lastError}`)
          return this.broadcastStatus()
        }
        this.deps.journal(`sandbox: container ${this.containerName} started`)
      }
      this.lastReady = true
      await this.projectConfig()
      await this.probeBrokerBridge()
      return this.broadcastStatus()
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      reportError('sandbox', 'ensure failed', e)
      return this.broadcastStatus()
    } finally {
      this.busy = false
    }
  }

  /**
   * Copy the operator's Claude config (CLAUDE.md, agents, skills, plugins,
   * settings.json — allow-listed in sandbox-projection.ts) into the
   * container's ~/.claude. A COPY, never a mount: see that module's header
   * for why a mounted settings.json would be a sandbox escape.
   */
  private async projectConfig(): Promise<void> {
    const entries = planProjection(this.deps.claudeHomeDir)
    for (const entry of entries) {
      const res = await this.run(
        buildCopyIntoArgs(this.containerName, entry.hostPath, `${SANDBOX_HOME}/.claude/`),
        60_000
      )
      if (res.code !== 0) {
        reportError('sandbox', `config projection failed for ${entry.name}: ${res.stderr.trim()}`)
      }
    }
    this.projectionSummary = describeProjection(entries)
    this.hookWarnings = projectionHookWarnings(entries)
    const stray = unknownOverrides(this.deps.claudeHomeDir)
    if (stray.length > 0) {
      this.hookWarnings = [
        ...this.hookWarnings,
        `sandbox-overrides/ entries ignored (not projectable): ${stray.join(', ')}`
      ]
    }
    if (entries.length > 0) {
      this.deps.journal(`sandbox: operator config projected (${this.projectionSummary})`)
    }
  }

  /** exit 0 = credentials file present; null when the container cannot answer. */
  async probeAuth(): Promise<boolean | null> {
    const res = await this.run(buildAuthProbeArgs(this.containerName), 8000)
    if (res.code === 0) return true
    if (res.code === 1) return false
    return null
  }

  /** Wipe the credentials in the shared volume ("disconnect"). Guarded upstream. */
  async purgeAuth(): Promise<SandboxStatus> {
    const res = await this.run(buildAuthPurgeArgs(this.containerName))
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'auth purge failed')
    this.deps.journal('sandbox: credentials volume disconnected')
    return this.broadcastStatus()
  }

  /**
   * Real end-to-end broker check FROM the container (M2): `host.docker.internal`
   * resolves natively on Docker Desktop, but a native Linux engine also needs
   * the broker bound beyond loopback — guessing from the platform would lie,
   * so we curl /health from inside and report what actually happened.
   */
  async probeBrokerBridge(): Promise<boolean | null> {
    if (!this.lastReady) return null
    const res = await this.run(
      buildBrokerProbeArgs(this.containerName, this.deps.containerBrokerUrl()),
      8000
    )
    this.bridgeOk = res.code === 0
    return this.bridgeOk
  }

  // ----- transcripts (resume inside the sandbox, M2) -----

  /**
   * Refresh the container-side transcript list for a host cwd. `~/.claude` is
   * the auth volume, so transcripts outlive the container and a resume after
   * a rebuild still finds its conversation.
   */
  async refreshTranscripts(cwdHost: string): Promise<void> {
    if (!this.isEnabled() || !this.lastReady) return
    const dir = containerTranscriptDir(cwdHost, this.workSource())
    const res = await this.run(buildTranscriptListArgs(this.containerName, dir), 10_000)
    // A missing dir (never used this cwd) exits non-zero: that IS "no transcript".
    this.transcripts.set(cwdHost, res.code === 0 ? parseTranscriptList(res.stdout) : [])
  }

  /** Cached container-side transcripts for a cwd (null = sandbox not in play). */
  transcriptsFor(cwdHost: string): { id: string; mtimeMs: number }[] | null {
    if (!this.isEnabled()) return null
    return this.transcripts.get(cwdHost) ?? []
  }

  // ----- listing / actions -----

  /** Every kory-sbx container on the machine (rail view), current project first. */
  async list(): Promise<SandboxContainerInfo[]> {
    const probe = await this.detectEngine()
    if (probe.state !== 'ok') return []
    const res = await this.run([
      'ps',
      '-a',
      '--filter',
      'label=kory.sandbox=1',
      '--format',
      '{{.Names}}\t{{.State}}\t{{.Image}}\t{{.RunningFor}}\t{{.Label "kory.project"}}'
    ])
    if (res.code !== 0) return []
    const rows: SandboxContainerInfo[] = []
    for (const line of res.stdout.split('\n')) {
      const [name, state, image, age, project] = line.split('\t')
      if (!name || !isSandboxContainerName(name.trim())) continue
      rows.push({
        name: name.trim(),
        state: (state ?? '').trim(),
        image: (image ?? '').trim(),
        age: (age ?? '').trim(),
        project: (project ?? '').trim(),
        current: name.trim() === this.containerName
      })
    }
    rows.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
    return rows
  }

  /**
   * Rail-view action. `name` is renderer-supplied: re-validated against the
   * generated shape + the kory.sandbox label before reaching the CLI. `remove`
   * / `rebuild` never run implicitly — operator-invoked, ConfirmDialog'd.
   */
  async containerAction(name: unknown, action: SandboxContainerAction): Promise<void> {
    if (!isSandboxContainerName(name)) throw new Error('invalid container name')
    const label = await this.run([
      'inspect',
      '--format',
      '{{index .Config.Labels "kory.sandbox"}}',
      name
    ])
    if (label.code !== 0 || label.stdout.trim() !== '1') throw new Error('not a sandbox container')
    const fail = (r: SandboxExecResult, verb: string): never => {
      throw new Error(r.stderr.trim() || `${verb} failed`)
    }
    switch (action) {
      case 'start': {
        const r = await this.run(['start', name], 30_000)
        if (r.code !== 0) fail(r, 'start')
        if (name === this.containerName) this.lastReady = true
        break
      }
      case 'stop': {
        const r = await this.run(['stop', '-t', '5', name], 30_000)
        if (r.code !== 0) fail(r, 'stop')
        if (name === this.containerName) this.lastReady = false
        break
      }
      case 'remove': {
        const r = await this.run(['rm', '-f', name], 30_000)
        if (r.code !== 0) fail(r, 'remove')
        if (name === this.containerName) this.lastReady = false
        break
      }
      case 'rebuild': {
        // Anti-drift: recreate from the image. Only meaningful for the CURRENT
        // project (mounts/ports derive from this window's settings); other
        // projects rebuild from their own window.
        if (name !== this.containerName) throw new Error('rebuild only applies to this project')
        const rm = await this.run(['rm', '-f', name], 30_000)
        if (rm.code !== 0 && !rm.stderr.includes('No such container')) fail(rm, 'remove')
        this.lastReady = false
        await this.ensure()
        break
      }
      default:
        throw new Error(`unknown action: ${String(action)}`)
    }
    this.deps.journal(`sandbox: ${action} ${name}`)
    await this.broadcastStatus()
  }

  /**
   * Supervisor-driven exec (M2, `deck_sandbox_exec`): "add this dependency to
   * the instance". The agent's command line is passed as ONE argv element to
   * the CONTAINER's bash — it never reaches a host shell. Bounded in time and
   * output, refused unless the sandbox is on and up, always journaled.
   */
  async supervisorExec(command: string): Promise<SandboxExecResponse> {
    const trimmed = command.trim()
    if (!trimmed) throw new Error('command is required')
    if (!this.isEnabled()) throw new Error('sandbox mode is off for this project')
    if (!this.lastReady) {
      const st = await this.ensure()
      if (st.containerState !== 'running') {
        throw new Error(st.error || 'sandbox container not ready')
      }
    }
    this.deps.journal(`sandbox: supervisor exec — ${trimmed.slice(0, 160)}`)
    const res = await this.run(
      buildSupervisorExecArgs(this.containerName, trimmed),
      SUPERVISOR_EXEC_TIMEOUT_MS
    )
    const clip = (s: string): string =>
      s.length > SUPERVISOR_EXEC_MAX_CHARS
        ? `${s.slice(0, SUPERVISOR_EXEC_MAX_CHARS)}\n…[truncated]`
        : s
    return { code: res.code, stdout: clip(res.stdout), stderr: clip(res.stderr) }
  }

  // ----- spawn integration -----

  /**
   * Synchronous launch info for SessionService.startPty. null = sandbox off.
   * Throws when enabled but the container is not known-running — create() has
   * an async gate upstream (sandboxGate in create-session.ts) so this only
   * fires on ungated paths (workspace restore with a cold container), where a
   * visibly-exited tile beats a login prompt in every tile (SBX3).
   */
  launchInfo(): SandboxLaunch | null {
    if (!this.isEnabled()) return null
    const engine = this.probe?.engine
    if (!engine || this.probe?.state !== 'ok' || !this.lastReady) {
      throw new Error('sandbox enabled but container not ready — open the Docker view')
    }
    return {
      engine,
      container: this.containerName,
      runDirHost: this.runDirHost,
      workSource: this.workSource()
    }
  }

  /** Write a session's launch script into the run dir. */
  writeLaunchScript(sessionId: string, spec: SandboxLaunchScriptSpec): void {
    mkdirSync(this.runDirHost, { recursive: true })
    writeFileSync(join(this.runDirHost, scriptFileName(sessionId)), buildLaunchScript(spec), {
      mode: 0o700
    })
  }

  /** The `docker exec` command line the PTY runs for a sandboxed session. */
  execCommand(launch: SandboxLaunch, sessionId: string): string {
    return buildExecCommand(launch.engine, launch.container, sessionId)
  }

  /** True when any kory-sbx container is running (auth-purge guard, SBX3). */
  async anyRunning(): Promise<boolean> {
    return (await this.list()).some((c) => c.state === 'running')
  }

  /**
   * App-quit hook: stop (never remove) this project's container. Detached
   * fire-and-forget — quit must not wait on the engine, and a missed stop
   * only costs an idling `sleep infinity`.
   */
  stopCurrentDetached(): void {
    const engine = this.probe?.engine
    if (!engine || !this.lastReady) return
    try {
      const child = spawn(engine, ['stop', '-t', '5', this.containerName], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
      this.deps.journal(`sandbox: stopping ${this.containerName} (app close)`)
    } catch (e) {
      reportError('sandbox', 'detached stop failed', e)
    }
  }
}
