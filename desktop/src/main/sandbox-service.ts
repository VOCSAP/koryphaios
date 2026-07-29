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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  SANDBOX_IMAGE_CUSTOM,
  SANDBOX_WORK_DIR,
  buildAuthProbeArgs,
  composeCustomDockerfile,
  buildAuthPurgeArgs,
  buildBrokerProbeArgs,
  buildCopyIntoArgs,
  buildCreateArgs,
  buildExecCommand,
  buildImageBuildCommand,
  buildImageProbeArgs,
  buildImageRemoveArgs,
  buildLaunchScript,
  buildProjectionChownArgs,
  buildProjectionCleanArgs,
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
import { canonicalPath } from './worktree-service'
import {
  PROJECTED_ENTRIES,
  SANDBOX_OVERRIDES_DIR,
  describeProjection,
  parseProjectedMarker,
  planProjection,
  projectionHookWarnings,
  projectionSignature,
  stripHostOnlyHooks,
  unknownOverrides,
  type ProjectedMarker
} from './sandbox-projection'
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
  /** Host ~/.claude — projection SOURCE only (never mounted, see projection). */
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
  /**
   * Last credentials verdict. Cached because probing now spins a throwaway
   * container and `status()` runs on the Docker view's poll timer; keyed by
   * nothing on purpose — the volume it describes is app-wide, one per machine.
   */
  private authedCache: boolean | null = null
  /** In-flight background auth probe (status() must never stack a second one). */
  private authProbeInFlight: Promise<void> | null = null
  /**
   * PERSISTED marker of what was last projected: the container ID plus a
   * fingerprint of the operator's config (projectionSignature), written to a
   * per-container file under the app state dir. Three deliberate choices:
   *  - keyed by the container ID (not the name): a recreate mints a new ID, so
   *    a fresh container always gets a fresh copy with no manual invalidation;
   *  - persisted (not an instance field): the projection copies ~200 MB of
   *    plugins through `docker cp` (~10 s measured) and an in-memory marker
   *    made EVERY app start pay it again on the first spawn — the operator's
   *    "why does the first agent take 15 seconds" bug;
   *  - stored OUTSIDE any container-mounted dir (hostile input #5): a marker
   *    inside the run dir would let a sandboxed agent tamper with it.
   */
  private readonly projectedMarkerFile: string
  private projectionSummary: string | null = null
  private hookWarnings: string[] = []
  private copyUnmatched: string[] = []
  readonly containerName: string
  private readonly storeFile: string
  private readonly runDirHost: string
  private readonly copyDirHost: string
  /** Back-channel / peer-cache dir the containers write into (never the host's). */
  readonly peersDirHost: string

  constructor(private readonly deps: SandboxServiceDeps) {
    super()
    this.containerName = containerNameFor(deps.projectDir)
    this.storeFile = join(deps.stateDir, 'sandbox.json')
    this.runDirHost = join(deps.stateDir, 'sandbox-run')
    // Deck-owned, sandbox-only peers dir (see buildCreateArgs' peersDirHost).
    this.peersDirHost = join(deps.stateDir, 'sandbox-peers')
    // Short, stable clone dir keyed by the same hash as the container.
    this.copyDirHost = join(deps.stateDir, 'sandbox-copies', this.containerName)
    this.projectedMarkerFile = join(deps.stateDir, `sandbox-projected-${this.containerName}`)
    // Operator's Dockerfile fragment (app-state, NEVER a repo file — hostile
    // input #1: what runs in the sandbox image is an operator decision).
    this.customFragmentFile = join(deps.stateDir, 'sandbox-custom.dockerfile')
    this.customContextDir = join(deps.stateDir, 'sandbox-custom')
  }

  private readonly customFragmentFile: string
  private readonly customContextDir: string

  /** The operator's Dockerfile fragment ('' when none saved yet). */
  customFragment(): string {
    try {
      return readFileSync(this.customFragmentFile, 'utf8')
    } catch {
      return '' // never saved: the empty editor is the honest state
    }
  }

  /** Persist the fragment (empty string clears it). App-state, app-wide. */
  saveCustomFragment(fragment: string): void {
    writeFileSync(this.customFragmentFile, fragment)
    this.deps.journal(
      fragment.trim()
        ? `sandbox: custom image fragment saved (${fragment.trim().split('\n').length} lines)`
        : 'sandbox: custom image fragment cleared'
    )
  }

  /**
   * PTY command line building the CUSTOM image: writes the composed
   * `FROM <base>` + fragment Dockerfile into an app-state context dir and
   * builds it under the SANDBOX_IMAGE_CUSTOM tag. Throws on an empty fragment
   * or a fragment carrying its own FROM (composeCustomDockerfile).
   */
  customBuildCommand(): string {
    const dockerfile = composeCustomDockerfile(this.customFragment())
    if (dockerfile === null) throw new Error('custom-fragment-empty')
    mkdirSync(this.customContextDir, { recursive: true })
    writeFileSync(join(this.customContextDir, 'Dockerfile'), dockerfile)
    const engine = this.probe?.engine ?? 'docker'
    return buildImageBuildCommand(engine, SANDBOX_IMAGE_CUSTOM, this.customContextDir)
  }

  /**
   * Generate `~/.claude/sandbox-overrides/settings.json` from the HOST
   * settings.json with the host-only hooks stripped (50ac8683). Refuses to
   * overwrite an existing overlay unless `force` — the operator may have
   * hand-tuned it, and this call can come from the companion path, so the
   * confirmation lives in a renderer dialog and arrives here as an explicit
   * boolean. The projection picks the overlay up on its own (planProjection
   * prefers overlay entries, so the signature changes).
   */
  generateOverlay(force: boolean): { path: string; removed: string[] } {
    const sourcePath = join(this.deps.claudeHomeDir, 'settings.json')
    let raw: string
    try {
      raw = readFileSync(sourcePath, 'utf8')
    } catch {
      throw new Error('host-settings-missing')
    }
    const stripped = stripHostOnlyHooks(raw)
    if (stripped === null) throw new Error('host-settings-invalid')
    const dir = join(this.deps.claudeHomeDir, SANDBOX_OVERRIDES_DIR)
    const target = join(dir, 'settings.json')
    if (!force && existsSync(target)) throw new Error('overlay-exists')
    mkdirSync(dir, { recursive: true })
    writeFileSync(target, JSON.stringify(stripped.settings, null, 2) + '\n')
    // Generate is the opt-IN gesture: it undoes a prior "Remove" (the marker
    // key folds the flag in, so the next container start re-projects).
    if (!this.settings().projectConfig) {
      writeSandboxSettings(this.storeFile, this.deps.projectKey, { projectConfig: true })
      this.deps.journal('sandbox: operator config projection re-enabled (overlay generated)')
      void this.broadcastStatus().catch((e) =>
        reportError('sandbox', 'projection re-enable broadcast failed', e)
      )
    }
    this.deps.journal(
      `sandbox: overlay settings.json generated (${stripped.removed.length} host-only hooks removed)`
    )
    return { path: target, removed: stripped.removed }
  }

  /**
   * Operator opt-out (Docker view "Remove"): stop carrying the global config
   * into the container and scrub what previous starts projected. The decision
   * is PERSISTED first (projectConfig=false) so it holds with no engine, no
   * container, or a stopped one -- those cases are scrubbed by the next
   * ensure() (the marker key mismatches). Only a RUNNING container is scrubbed
   * right away (`docker exec` cannot reach a stopped one). generateOverlay()
   * is the opposite gesture and re-enables.
   */
  async removeProjection(): Promise<SandboxStatus> {
    writeSandboxSettings(this.storeFile, this.deps.projectKey, { projectConfig: false })
    this.projectionSummary = null
    this.hookWarnings = []
    const probe = await this.detectEngine()
    if (probe.state === 'ok') {
      const info = await this.inspectIdState(this.containerName)
      if (info?.state === 'running') {
        const res = await this.run(
          buildProjectionCleanArgs(this.containerName, [...PROJECTED_ENTRIES]),
          30_000
        )
        if (res.code !== 0) {
          reportError('sandbox', `projection remove failed: ${res.stderr.trim().slice(0, 400)}`)
        } else {
          // Mark the scrub done so the next ensure() does not redo it.
          this.writeProjectedMarker(`${info.id}\ndisabled`)
        }
      }
    }
    this.deps.journal('sandbox: operator config projection disabled by the operator')
    return this.broadcastStatus()
  }

  private readProjectedMarker(): ProjectedMarker | null {
    try {
      return parseProjectedMarker(readFileSync(this.projectedMarkerFile, 'utf8'))
    } catch {
      return null // never projected (or unreadable): re-project, the safe answer
    }
  }

  /** Persist the key + WHAT was projected (summary survives app restarts). */
  private writeProjectedMarker(key: string): void {
    try {
      const marker: ProjectedMarker = {
        key,
        summary: this.projectionSummary,
        hookWarnings: this.hookWarnings
      }
      writeFileSync(this.projectedMarkerFile, JSON.stringify(marker))
    } catch (e) {
      // Best-effort: losing the marker only costs one redundant projection.
      reportError('sandbox', 'projection marker write failed', e)
    }
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

  /**
   * Host dir mounted at /work: the project, or the ephemeral clone.
   *
   * CANONICAL on purpose: session cwds and worktree paths are canonicalized
   * (worktree-service), so leaving this one symlinked made every worktree path
   * look "outside the mount" on macOS and relocated the agent.
   */
  private workSource(): string {
    return canonicalPath(this.mode() === 'copy' ? this.copyDirHost : this.deps.projectDir)
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

  /**
   * Delete the image from the local engine. The `present` badge is driven by
   * the CACHED probe, so the cache is dropped whatever the outcome — leaving it
   * would make the badge claim "present" after a successful removal until the
   * operator hit Refresh, which is exactly the kind of quiet lie this view
   * exists to avoid. A refusal (a container, even stopped, still references the
   * image) is raised, not swallowed. The credentials volume is untouched.
   */
  async removeImage(): Promise<SandboxStatus> {
    const probe = await this.detectEngine()
    if (probe.state !== 'ok') throw new Error('sandbox engine not available')
    const res = await this.run(buildImageRemoveArgs(this.image()), 60_000)
    this.imagePresent = null
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'image removal failed')
    this.deps.journal(`sandbox: image ${this.image()} removed`)
    return this.broadcastStatus()
  }

  /** Host path currently bind-mounted at /work, or null when unknown. */
  private async mountedWorkSource(): Promise<string | null> {
    const res = await this.run([
      'inspect',
      '--format',
      `{{range .Mounts}}{{if eq .Destination "${SANDBOX_WORK_DIR}"}}{{.Source}}{{end}}{{end}}`,
      this.containerName
    ])
    if (res.code !== 0) return null
    return res.stdout.trim() || null
  }

  private async inspectState(name: string): Promise<string | null> {
    const res = await this.run(['inspect', '--format', '{{.State.Status}}', name])
    return res.code === 0 ? res.stdout.trim() : null
  }

  /**
   * Identity + state in ONE engine call (ensure() runs on every agent spawn).
   * The ID is what keys the projection marker — see projectedMarkerFile.
   */
  private async inspectIdState(name: string): Promise<{ id: string; state: string } | null> {
    const res = await this.run(['inspect', '--format', '{{.Id}}\t{{.State.Status}}', name])
    if (res.code !== 0) return null
    const [id, state] = res.stdout.trim().split('\t')
    if (!id || !state) return null
    return { id, state }
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
    let drift: number | null = null
    if (probe.state === 'ok') {
      if (this.imagePresent === null || forceEngine) await this.probeImage()
      const state = await this.inspectState(this.containerName)
      if (state === 'running') {
        containerState = 'running'
        drift = await this.driftDays()
      } else if (state !== null) {
        containerState = 'stopped'
        drift = await this.driftDays()
      }
      // Fresh app run, container carried over from the last one: the summary
      // is in-memory-null but the marker remembers what an earlier start
      // projected -- rehydrate so the card does not claim "nothing projected"
      // until the next ensure(). (A disabled-scrub marker has summary null.)
      if (this.projectionSummary === null && settings.projectConfig && containerState !== 'missing') {
        const marker = this.readProjectedMarker()
        if (marker?.summary) {
          this.projectionSummary = marker.summary
          if (this.hookWarnings.length === 0) this.hookWarnings = marker.hookWarnings
        }
      }
      // The credentials volume is app-wide: its state is knowable with no
      // container of ours at all. Probe once (throwaway container) and reuse
      // the verdict -- status() runs on the Docker view's poll timer.
      //
      // The cold probe is a `docker run --rm` (~0.5-3 s on Docker Desktop):
      // awaiting it here made the Docker view's FIRST paint hang behind it.
      // Only the explicit refresh (forceEngine) still blocks on it; the cold
      // path answers immediately with authed=null ("unknown", a state the UI
      // already renders) and a background probe broadcasts the real verdict.
      if (forceEngine) {
        await this.probeAuth()
      } else if (this.authedCache === null) {
        this.scheduleAuthProbe()
      }
    }
    const authed = probe.state === 'ok' ? this.authedCache : null
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
      projectionEnabled: settings.projectConfig,
      // Host-side overlay state (a handful of existsSync): reported separately
      // from `projection` so generating the overlay is visible IMMEDIATELY,
      // not only after the next container start picks it up.
      overlay: planProjection(this.deps.claudeHomeDir)
        .filter((e) => e.override)
        .map((e) => e.name),
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

  /**
   * Delete and re-create the clone. The container is recreated too: the bind
   * mount resolves to the directory's INODE, so a running container whose
   * source was rm -rf'd keeps writing into the deleted one (invisible on
   * Docker Desktop's VM, plainly broken on a native Linux engine).
   */
  async resetCopy(): Promise<SandboxStatus> {
    const existed = (await this.inspectState(this.containerName)) !== null
    if (existed) {
      // No projection-marker invalidation needed here or below: the marker is
      // keyed by the container ID, and a recreate mints a new one.
      await this.run(['rm', '-f', this.containerName], 30_000)
      this.lastReady = false
    }
    rmSync(this.copyDirHost, { recursive: true, force: true })
    this.deps.journal('sandbox: ephemeral clone reset')
    await this.ensureCopyTree()
    if (existed) return this.ensure() // recreate against the fresh clone
    return this.broadcastStatus()
  }

  // ----- lifecycle -----

  /** In-flight ensure(), shared by every concurrent caller. */
  private ensureInFlight: Promise<SandboxStatus> | null = null

  /**
   * Bring the project container up: volume + (copy mode) clone + create
   * (idempotent) + start + config projection. Persistent by design — created
   * once, `stop`ped on app close, removed only by an explicit operator action.
   *
   * Concurrent callers COALESCE onto one run: the startup warm-up can race the
   * first agent spawn (and several tiles can spawn at once), and two
   * interleaved runs would both see "no container" and both issue
   * `docker create` — the loser painting a false "name already in use" error.
   */
  async ensure(): Promise<SandboxStatus> {
    if (this.ensureInFlight) return this.ensureInFlight
    const run = this.ensureRun().finally(() => {
      this.ensureInFlight = null
    })
    this.ensureInFlight = run
    return run
  }

  /**
   * Pre-flight OFF the spawn path: called when the app opens a sandbox-enabled
   * project and after an image build succeeds, so the container creation and
   * the config projection (~10 s measured when plugins/ travels) happen while
   * the operator is not staring at an agent tile. Quiet by design: no engine /
   * no image / sandbox disabled are normal states here — the Docker view
   * already shows them — not errors worth painting.
   */
  async warmUp(): Promise<void> {
    if (!this.isEnabled()) return
    if ((await this.detectEngine()).state !== 'ok') return
    if (!(await this.probeImage())) {
      // Nothing to warm, but the rail/Agents indicators still deserve the
      // fresh state at boot — only sandbox-enabled projects pay this probe.
      await this.broadcastStatus()
      return
    }
    await this.ensure()
  }

  private async ensureRun(): Promise<SandboxStatus> {
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
    // Broadcast the busy flip NOW: the Docker view's Préparer button greys and
    // spins off this flag, and the 10 s poll alone would leave it clickable
    // for most of the pre-flight. Fire-and-forget: status() is read-only.
    void this.broadcastStatus().catch((e) => reportError('sandbox', 'busy broadcast failed', e))
    // Per-step timing, journaled only when the whole pre-flight was slow: the
    // 10-15 s spawns were diagnosed by guessing three times — the journal line
    // makes the NEXT regression a measurement instead of a guess.
    const t0 = Date.now()
    let tStep = t0
    const marks: string[] = []
    const mark = (label: string): void => {
      const now = Date.now()
      marks.push(`${label}=${now - tStep}ms`)
      tStep = now
    }
    try {
      if (!(await this.probeImage())) {
        this.lastError = `image "${this.image()}" not found — build it from the Docker view`
        return this.broadcastStatus()
      }
      mark('image')
      mkdirSync(this.runDirHost, { recursive: true })
      mkdirSync(this.peersDirHost, { recursive: true })
      if (this.mode() === 'copy') {
        await this.ensureCopyTree()
        mark('clone')
      }
      await this.run(['volume', 'create', SANDBOX_AUTH_VOLUME])
      mark('volume')

      let info = await this.inspectIdState(this.containerName)
      // A container created in the OTHER work mode still bind-mounts the other
      // tree: honouring it would let agents write the real repo while the UI
      // says "ephemeral copy". Recreate rather than trust the renderer's
      // best-effort rebuild.
      if (info !== null) {
        const mounted = await this.mountedWorkSource()
        if (mounted !== null && canonicalPath(mounted) !== this.workSource()) {
          this.deps.journal(
            `sandbox: container mount is stale (${mounted}) — recreating for ${this.workSource()}`
          )
          await this.run(['rm', '-f', this.containerName], 30_000)
          this.lastReady = false
          info = null
        }
      }
      mark('inspect')
      if (info === null) {
        const created = await this.run(
          buildCreateArgs({
            name: this.containerName,
            image: this.image(),
            projectDir: this.deps.projectDir,
            workSource: this.workSource(),
            runDirHost: this.runDirHost,
            peersDirHost: this.peersDirHost,
            ports: this.settings().ports
          }),
          60_000
        )
        if (created.code !== 0) {
          const raw = created.stderr.trim() || 'container create failed'
          // The defaults are shared by every project, so this is THE common
          // failure for a second sandboxed project — say so instead of echoing
          // the engine's bare "port is already allocated".
          this.lastError = /port is already allocated|address already in use/i.test(raw)
            ? `${raw} — another project's sandbox already publishes it; change or clear the ports in the Docker view`
            : raw
          reportError('sandbox', `create failed for ${this.containerName}: ${this.lastError}`)
          return this.broadcastStatus()
        }
        // `create` prints the new container's full ID; the inspect fallback
        // covers an engine that ever stops doing so.
        const createdId =
          created.stdout.trim() || ((await this.inspectIdState(this.containerName))?.id ?? '')
        info = { id: createdId, state: 'created' }
        this.deps.journal(`sandbox: container ${this.containerName} created (${this.image()})`)
        mark('create')
      }
      if (info.state !== 'running') {
        const started = await this.run(['start', this.containerName], 30_000)
        if (started.code !== 0) {
          this.lastError = started.stderr.trim() || 'container start failed'
          reportError('sandbox', `start failed for ${this.containerName}: ${this.lastError}`)
          return this.broadcastStatus()
        }
        this.deps.journal(`sandbox: container ${this.containerName} started`)
        mark('start')
      }
      this.lastReady = true
      // Projection and bridge probe are both off the per-spawn critical path:
      // the projection runs only when the container ID or the operator's config
      // fingerprint changed (the marker is PERSISTED — an in-memory flag made
      // every app start re-copy ~200 MB of plugins, ~10 s measured), and the
      // bridge probe is a Docker-view diagnostic with no business blocking a
      // spawn.
      // The opt-out folds into the marker key: toggling projectConfig either
      // way mismatches the marker, so the next ensure() re-projects or scrubs
      // exactly once, then skips again.
      const signature = this.settings().projectConfig
        ? `${info.id}\n${projectionSignature(this.deps.claudeHomeDir)}`
        : `${info.id}\ndisabled`
      mark('signature')
      const marker = this.readProjectedMarker()
      if (marker?.key !== signature) {
        await this.projectConfig()
        this.writeProjectedMarker(signature)
        mark('projection')
      } else if (this.projectionSummary === null && marker.summary !== null) {
        // Skipped projection after an app restart: the in-memory summary is
        // empty but the container still carries the config -- rehydrate from
        // the marker so status() tells the truth.
        this.projectionSummary = marker.summary
        if (this.hookWarnings.length === 0) this.hookWarnings = marker.hookWarnings
      }
      void this.probeBrokerBridge().catch((e) =>
        reportError('sandbox', 'broker bridge probe failed', e)
      )
      const st = await this.broadcastStatus()
      mark('status')
      const total = Date.now() - t0
      if (total > 1500) this.deps.journal(`sandbox: ensure took ${total}ms (${marks.join(' ')})`)
      return st
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      reportError('sandbox', 'ensure failed', e)
      return this.broadcastStatus()
    } finally {
      this.busy = false
      // Every broadcast above ran while busy was still true (finally executes
      // after the returns), so without this the view's Préparer spinner only
      // cleared at the next 10 s poll. Fire-and-forget, like the busy=true one.
      void this.broadcastStatus().catch((e) =>
        reportError('sandbox', 'busy-clear broadcast failed', e)
      )
    }
  }

  /**
   * Copy the operator's Claude config (CLAUDE.md, agents, skills, plugins,
   * settings.json — allow-listed in sandbox-projection.ts) into the
   * container's ~/.claude. A COPY, never a mount: see that module's header
   * for why a mounted settings.json would be a sandbox escape.
   */
  private async projectConfig(): Promise<void> {
    if (!this.settings().projectConfig) {
      // Operator opt-out (removeProjection): scrub whatever an earlier start
      // projected instead of copying. Runs at container start (exec needs a
      // running container) and only when the marker key changed -- so a
      // stopped container missed by removeProjection() still gets scrubbed
      // on its next start.
      const res = await this.run(
        buildProjectionCleanArgs(this.containerName, [...PROJECTED_ENTRIES]),
        30_000
      )
      if (res.code !== 0) {
        reportError('sandbox', `projection scrub failed: ${res.stderr.trim().slice(0, 400)}`)
      }
      this.projectionSummary = null
      this.hookWarnings = []
      this.deps.journal('sandbox: operator config projection is off -- container scrubbed')
      return
    }
    const entries = planProjection(this.deps.claudeHomeDir)
    if (entries.length > 0) {
      // Purge the targets first: `docker cp -L` overwrites files but will NOT
      // replace a directory symlink left in the auth volume by a pre-`-L`
      // copy — agents/skills then stayed dangling links while the projection
      // reported success (see buildProjectionCleanArgs). Best-effort: a failed
      // purge is reported and the copies still run.
      const cleaned = await this.run(
        buildProjectionCleanArgs(
          this.containerName,
          entries.map((e) => e.name)
        ),
        30_000
      )
      if (cleaned.code !== 0) {
        // Clip: a recursive rm can produce hundreds of per-file lines, and
        // reportError echoes to the dev console.
        reportError(
          'sandbox',
          `config projection pre-clean failed: ${cleaned.stderr.trim().slice(0, 400)}`
        )
      }
    }
    for (const entry of entries) {
      const res = await this.run(
        buildCopyIntoArgs(this.containerName, entry.hostPath, `${SANDBOX_HOME}/.claude/`),
        60_000
      )
      if (res.code !== 0) {
        reportError('sandbox', `config projection failed for ${entry.name}: ${res.stderr.trim()}`)
      }
    }
    if (entries.length > 0) {
      // `docker cp` lands the trees as root; hand them to the container user
      // so the CLI can maintain its own copy (installed_plugins.json…).
      const owned = await this.run(
        buildProjectionChownArgs(
          this.containerName,
          entries.map((e) => e.name)
        ),
        30_000
      )
      if (owned.code !== 0) {
        reportError(
          'sandbox',
          `config projection chown failed: ${owned.stderr.trim().slice(0, 400)}`
        )
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

  /**
   * exit 0 = credentials file present; null when nothing could answer.
   *
   * Runs in a throwaway container (see buildAuthProbeArgs): the shared volume
   * is readable whether or not THIS project has a container, so the Docker view
   * can state "connected / not connected" from a cold start. Costs one short
   * container run, hence the cache — `status()` polls on a timer.
   */
  async probeAuth(): Promise<boolean | null> {
    const hasImage = this.imagePresent ?? (await this.probeImage())
    if (!hasImage) return null
    const res = await this.run(buildAuthProbeArgs(this.image()), 20_000)
    const authed = res.code === 0 ? true : res.code === 1 ? false : null
    this.authedCache = authed
    return authed
  }

  /**
   * Cold-path auth probe, OFF the status() critical path. Coalesced; when a
   * real verdict lands, a 'changed' broadcast repaints the view. Deliberately
   * NO broadcast when the verdict stays null (image missing): broadcastStatus
   * re-enters status(), which would re-schedule this probe and broadcast
   * again -- an infinite loop of no-ops.
   */
  private scheduleAuthProbe(): void {
    if (this.authProbeInFlight) return
    this.authProbeInFlight = this.probeAuth()
      .then(async (authed) => {
        if (authed !== null) await this.broadcastStatus()
      })
      .catch((e) => reportError('sandbox', 'background auth probe failed', e))
      .finally(() => {
        this.authProbeInFlight = null
      })
  }

  /** Drop the cached auth verdict: the next status() re-probes for real. */
  invalidateAuth(): void {
    this.authedCache = null
  }

  /**
   * Provision what the LOGIN needs, and nothing more: an engine, the image
   * (it carries the CLI) and the credentials volume. Deliberately NOT
   * `ensure()` — signing in is an app-wide operation and must not drag in this
   * project's container, its work mount, its clone or its published ports.
   * `volume create` is idempotent, so this is also how the volume comes to
   * exist the very first time, before any project container ever has.
   */
  async ensureAuthPrereqs(): Promise<SandboxStatus> {
    const probe = await this.detectEngine()
    if (probe.state !== 'ok') {
      this.lastError =
        probe.state === 'daemon-down'
          ? 'engine daemon not running (start Docker Desktop / podman machine)'
          : 'no container engine found (install Docker Desktop or Podman)'
      return this.broadcastStatus()
    }
    this.lastError = null
    // Volume FIRST, and unconditionally: creating it needs no image at all, so
    // a missing image must not also stop the credentials store from existing.
    const vol = await this.run(['volume', 'create', SANDBOX_AUTH_VOLUME])
    if (vol.code !== 0) {
      this.lastError = vol.stderr.trim() || 'credentials volume could not be created'
      return this.broadcastStatus()
    }
    if (!(await this.probeImage())) {
      this.lastError = `image "${this.image()}" not found — build it from the Docker view`
    }
    return this.broadcastStatus()
  }

  /**
   * Wipe the credentials in the shared volume ("disconnect"). Like the login
   * and the probe, this runs in a throwaway container: it used to be an `exec`
   * that needed THIS project's container running, which contradicted the
   * upstream guard ("no live sessions") and made the button unusable half the
   * time.
   */
  async purgeAuth(): Promise<SandboxStatus> {
    const probe = await this.detectEngine()
    if (probe.state !== 'ok') throw new Error('sandbox engine not available')
    if (!(await this.probeImage())) {
      throw new Error(`image "${this.image()}" not found — build it from the Docker view`)
    }
    const res = await this.run(buildAuthPurgeArgs(this.image()), 20_000)
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'auth purge failed')
    this.authedCache = false
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
    if (dir === null) return // outside the mount: nothing knowable, stay "unknown"
    const res = await this.run(buildTranscriptListArgs(this.containerName, dir), 10_000)
    // A missing dir (never used this cwd) exits non-zero: that IS "no transcript".
    this.transcripts.set(
      canonicalPath(cwdHost),
      res.code === 0 ? parseTranscriptList(res.stdout) : []
    )
  }

  /**
   * Cached container-side transcripts for a cwd.
   *
   * null means "the host files are authoritative" — returned both when the
   * sandbox is off AND when this cwd was never refreshed. Returning `[]` for an
   * un-refreshed cwd was a bug: `[]` is a positive claim ("no transcript here")
   * that silently downgraded every resume to a fresh session.
   */
  transcriptsFor(cwdHost: string): { id: string; mtimeMs: number }[] | null {
    if (!this.isEnabled()) return null
    return this.transcripts.get(canonicalPath(cwdHost)) ?? null
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
