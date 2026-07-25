// Sandbox mode (PLAN-SANDBOX SBX1/SBX2/SBX3): Docker/Podman lifecycle for the
// per-project sandbox container. Engine detection, ensure (volume + create +
// start), auth probe on the shared credentials volume, the cross-project
// container listing for the rail view, and the cached launch info the
// SessionService wraps spawns with.
//
// The engine CLI is reached through an injectable `exec` (never a shell string
// — argument vectors only), so the sequencing is bun-testable with a scripted
// fake. Container names arriving from IPC are re-validated here against the
// generated shape (hostile input #3): this service only ever passes
// `kory-sbx-<hash12>` names it re-checked, whatever the renderer sent.

import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxContainerAction, SandboxContainerInfo, SandboxStatus } from '@shared/types'
import {
  SANDBOX_AUTH_VOLUME,
  buildAuthProbeArgs,
  buildCreateArgs,
  buildExecCommand,
  buildLaunchScript,
  containerNameFor,
  isSandboxContainerName,
  scriptFileName,
  type SandboxEngine,
  type SandboxLaunchScriptSpec
} from './sandbox-command'
import { projectSandboxSettings, readSandboxStore, writeSandboxEnabled } from './sandbox-store'
import { reportError } from './log'

export interface SandboxExecResult {
  code: number
  stdout: string
  stderr: string
}
export type SandboxExec = (args: string[], timeoutMs?: number) => Promise<SandboxExecResult>

const EXEC_TIMEOUT_MS = 20_000
/** Engine probe cache: re-detect at most this often (the view's refresh forces it). */
const ENGINE_PROBE_TTL_MS = 60_000

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
  projectDir: string
}

export interface SandboxServiceDeps {
  projectDir: string
  /** computeDeckProjectKey(projectDir) — the sandbox.json key. */
  projectKey: string
  /** App state dir (sandbox.json + sandbox-run/). */
  stateDir: string
  /** Host ~/.claude/peers (back-channel/peer-cache mount), '' to skip. */
  peersDirHost?: string
  journal: (msg: string) => void
  /** Engine CLI runner, injectable for tests. Never throws — resolves code -1. */
  exec?: (file: string, args: string[], timeoutMs?: number) => Promise<SandboxExecResult>
}

function defaultExec(file: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<SandboxExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | undefined) ?? -1 : 0
        resolvePromise({
          code: typeof code === 'number' ? code : -1,
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
  readonly containerName: string
  private readonly storeFile: string
  private readonly runDirHost: string

  constructor(private readonly deps: SandboxServiceDeps) {
    super()
    this.containerName = containerNameFor(deps.projectDir)
    this.storeFile = join(deps.stateDir, 'sandbox.json')
    this.runDirHost = join(deps.stateDir, 'sandbox-run')
  }

  private run(args: string[], timeoutMs?: number): Promise<SandboxExecResult> {
    const engine = this.probe?.engine
    if (!engine) return Promise.resolve({ code: -1, stdout: '', stderr: 'no engine' })
    const exec = this.deps.exec ?? defaultExec
    return exec(engine, args, timeoutMs)
  }

  isEnabled(): boolean {
    return projectSandboxSettings(this.storeFile, this.deps.projectKey).enabled
  }

  image(): string {
    return readSandboxStore(this.storeFile).image
  }

  private ports(): number[] {
    return projectSandboxSettings(this.storeFile, this.deps.projectKey).ports
  }

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

  private async inspectState(name: string): Promise<string | null> {
    const res = await this.run(['inspect', '--format', '{{.State.Status}}', name])
    return res.code === 0 ? res.stdout.trim() : null
  }

  async status(forceEngine = false): Promise<SandboxStatus> {
    const probe = await this.detectEngine(forceEngine)
    const enabled = this.isEnabled()
    let containerState: SandboxStatus['containerState'] = 'missing'
    let authed: boolean | null = null
    if (probe.state === 'ok') {
      const state = await this.inspectState(this.containerName)
      if (state === 'running') {
        containerState = 'running'
        authed = await this.probeAuth()
      } else if (state !== null) {
        containerState = 'stopped'
      }
    }
    this.lastReady = containerState === 'running'
    return {
      engine: probe.engine,
      engineState: probe.state,
      engineVersion: probe.version,
      enabled,
      containerName: this.containerName,
      containerState,
      authed,
      image: this.image(),
      ports: this.ports(),
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
   * Toggle for this project. The LIVE-SESSIONS guard lives at the IPC layer
   * (service.hasLiveSessions()) so the rule sits next to its sibling scope
   * gate; this method only persists + notifies.
   */
  async setEnabled(enabled: boolean): Promise<SandboxStatus> {
    writeSandboxEnabled(this.storeFile, this.deps.projectKey, enabled)
    this.deps.journal(`sandbox: mode ${enabled ? 'enabled' : 'disabled'} for this project`)
    return this.broadcastStatus()
  }

  /**
   * Bring the project container up: volume + create (idempotent) + start.
   * Persistent by design — created once, `stop`ped on app close, removed only
   * by an explicit operator action in the rail view.
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
      mkdirSync(this.runDirHost, { recursive: true })
      if (this.deps.peersDirHost) mkdirSync(this.deps.peersDirHost, { recursive: true })
      await this.run(['volume', 'create', SANDBOX_AUTH_VOLUME])
      const state = await this.inspectState(this.containerName)
      if (state === null) {
        const created = await this.run(
          buildCreateArgs({
            name: this.containerName,
            image: this.image(),
            projectDir: this.deps.projectDir,
            runDirHost: this.runDirHost,
            peersDirHost: this.deps.peersDirHost || undefined,
            ports: this.ports()
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
      return this.broadcastStatus()
    } finally {
      this.busy = false
    }
  }

  /** exit 0 = credentials file present; null when the container cannot answer. */
  async probeAuth(): Promise<boolean | null> {
    const res = await this.run(buildAuthProbeArgs(this.containerName), 8000)
    if (res.code === 0) return true
    if (res.code === 1) return false
    return null
  }

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
    const label = await this.run(['inspect', '--format', '{{index .Config.Labels "kory.sandbox"}}', name])
    if (label.code !== 0 || label.stdout.trim() !== '1') throw new Error('not a sandbox container')
    const fail = (r: SandboxExecResult, verb: string): never => {
      throw new Error(r.stderr.trim() || `${verb} failed`)
    }
    switch (action) {
      case 'start': {
        const r = await this.run(['start', name], 30_000)
        if (r.code !== 0) fail(r, 'start')
        break
      }
      case 'stop': {
        const r = await this.run(['stop', '-t', '5', name], 30_000)
        if (r.code !== 0) fail(r, 'stop')
        break
      }
      case 'remove': {
        const r = await this.run(['rm', '-f', name], 30_000)
        if (r.code !== 0) fail(r, 'remove')
        break
      }
      case 'rebuild': {
        // Anti-drift: recreate from the image. Only meaningful for the CURRENT
        // project (mounts/ports derive from this window's settings); other
        // projects rebuild from their own window.
        if (name !== this.containerName) throw new Error('rebuild only applies to this project')
        const rm = await this.run(['rm', '-f', name], 30_000)
        if (rm.code !== 0) fail(rm, 'remove')
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
      projectDir: this.deps.projectDir
    }
  }

  /** Write a session's launch script into the run dir; returns nothing (path is derived). */
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
