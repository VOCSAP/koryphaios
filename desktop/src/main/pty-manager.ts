import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import type { IPty } from 'node-pty'
import { buildSpawnPlan, type SpawnOpts } from './shell-command'
import { JobStartupStatus, scanJobStartup } from './pty-startup-status'
import { reportError } from './log'

/**
 * KORY_PTY_RAW_CAPTURE hex-dumps the first RAW_CAPTURE_LIMIT PTY chunks before
 * marker stripping, ANSI stripping, or any detection heuristic — the most
 * upstream point reachable from our code, since node-pty itself already
 * UTF-8-decodes bytes before onData fires.
 * Must be set in the environment before the Electron main process launches,
 * since process.env is read once at module load; setting it in a terminal
 * afterward has no effect on an already-running process.
 * Counter is module-level, shared across every spawned session, matching a
 * single manual capture session rather than a per-id budget.
 */
const RAW_CAPTURE_FILE = process.env.KORY_PTY_RAW_CAPTURE ?? null
const RAW_CAPTURE_LIMIT = 30
let rawCaptureCount = 0

export interface PtyDataPayload {
  id: string
  data: string
}
export interface PtyExitPayload {
  id: string
  exitCode: number
}

/** Give up stripping the interactive start marker after this many buffered UTF-16 code units. */
const MARKER_BUFFER_CAP_CODE_UNITS = 65536

/**
 * ConPTY (Windows) can withhold a TUI's first full-screen frame until the next
 * resize forces a repaint; the Deck only resizes on a tile's mount/view return,
 * which lands before the child has drawn its first screen, so the frame can
 * stay invisible indefinitely.
 * These delayed same-dims 'kicks' force the flush instead. A kick on an
 * already-flowing PTY is just a harmless repaint, so they run unconditionally;
 * the spread covers slow boots (MCP servers, hooks) without kicking forever.
 */
const CONPTY_KICK_DELAYS_MS = [1500, 4000, 8000, 15000]
const KILL_ACK_TIMEOUT_MS = 3000

type PtyAdapter = {
  spawn: typeof import('node-pty').spawn
}

interface SpawnRequest {
  cwd: string
  opts: SpawnOpts
  extraEnv?: Record<string, string>
  cols: number
  rows: number
}

interface Spawned {
  proc: IPty
  cols: number
  rows: number
  /** Start marker to strip (interactive mode), or null. */
  marker: string | null
  markerSeen: boolean
  jobStartup: JobStartupStatus | null
  preBuf: string
  /** Pending ConPTY flush kicks (win32 only, cleared on kill/exit/respawn). */
  kickTimers: NodeJS.Timeout[]
}

interface Retired {
  id: string
  pid: number
  killTimer: NodeJS.Timeout | null
}

interface PtyManagerDeps {
  pty?: PtyAdapter
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => NodeJS.Timeout
  clearTimeout?: (timer: NodeJS.Timeout) => void
  reportError?: typeof reportError
  scanJobStartup?: typeof scanJobStartup
}

function defaultPtyAdapter(): PtyAdapter {
  return require('node-pty') as PtyAdapter
}

function consumeJobStartup(
  holder: { jobStartup: JobStartupStatus | null },
  data: string,
  scan: typeof scanJobStartup,
  clock: () => number
): boolean {
  const jobScan = scan(holder.jobStartup, data, clock)
  holder.jobStartup = jobScan.status
  return jobScan.reportFailure
}

/** Owns every live PTY. One instance for the whole app. */
export class PtyManager extends EventEmitter {
  private procs = new Map<string, Spawned>()
  private retired = new Map<IPty, Retired>()
  private readonly pty: PtyAdapter
  private readonly now: () => number
  private readonly schedule: (callback: () => void, delay: number) => NodeJS.Timeout
  private readonly cancel: (timer: NodeJS.Timeout) => void
  private readonly reportError: typeof reportError
  private readonly scanJobStartup: typeof scanJobStartup

  constructor(deps: PtyManagerDeps = {}) {
    super()
    this.pty = deps.pty ?? defaultPtyAdapter()
    this.now = deps.now ?? Date.now
    this.schedule = deps.setTimeout ?? setTimeout
    this.cancel = deps.clearTimeout ?? clearTimeout
    this.reportError = deps.reportError ?? reportError
    this.scanJobStartup = deps.scanJobStartup ?? scanJobStartup
  }

  /**
   * Spawn a peer terminal for `id`. A replacement immediately takes the tile's
   * public identity while the old process stays separately observable until exit.
   * `extraEnv` (the scope env from scope.ts) is merged last so its forced-group
   * vars win over anything inherited from the parent process. In interactive mode
   * the rc/profile noise before the start marker is stripped from output.
   */
  spawn(id: string, cwd: string, opts: SpawnOpts, extraEnv?: Record<string, string>): number {
    this.kill(id)
    return this.spawnNow(id, { cwd, opts, extraEnv, cols: 80, rows: 24 })
  }

  private spawnNow(id: string, request: SpawnRequest): number {
    const {
      invocation: { file, args, marker },
      env
    } = buildSpawnPlan(request.opts, request.extraEnv, process.platform)
    // CLAUDE_PEERS_TOOLS's absence is load-bearing, unlike every other key this
    // merge handles: '' means zero tools, the opposite of 'no restriction', so
    // it can't be neutralized with an empty-string default the way other keys
    // are.
    // If Kory's own process env carries CLAUDE_PEERS_TOOLS and this spawn's
    // sessionEnv didn't set it, the ...process.env spread would otherwise
    // silently restrict a tile nobody meant to restrict — deleting the key, not
    // defaulting it, is the only correct shape.
    if (!request.extraEnv || !('CLAUDE_PEERS_TOOLS' in request.extraEnv)) delete env.CLAUDE_PEERS_TOOLS
    if (!request.extraEnv || !('KORY_STATUS_FALLBACK' in request.extraEnv)) delete env.KORY_STATUS_FALLBACK
    if (!request.extraEnv || !('KORY_PERMISSION_LEASE' in request.extraEnv)) env.KORY_PERMISSION_LEASE = ''

    const proc = this.pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env
    })

    const state: Spawned = {
      proc,
      cols: request.cols,
      rows: request.rows,
      marker,
      markerSeen: false,
      jobStartup: process.platform === 'win32' ? new JobStartupStatus(this.now()) : null,
      preBuf: '',
      kickTimers: []
    }
    this.procs.set(id, state)

    // See CONPTY_KICK_DELAYS_MS: force ConPTY to flush the withheld first
    // frame. Same-dims resize -- dims may have been updated by resize() by the
    // time a kick fires, hence state.cols/rows read at fire time.
    if (process.platform === 'win32') {
      state.kickTimers = CONPTY_KICK_DELAYS_MS.map((ms) =>
        this.schedule(() => {
          if (this.procs.get(id) !== state) return
          try {
            state.proc.resize(state.cols, state.rows)
          } catch {
            // PTY just exited; onExit owns the cleanup.
          }
        }, ms)
      )
    }

    proc.onData((data) => {
      if (this.procs.get(id) !== state) return
      if (RAW_CAPTURE_FILE && rawCaptureCount < RAW_CAPTURE_LIMIT) this.captureRawChunk(id, data)
      this.handleData(id, data)
    })
    proc.onExit(({ exitCode }) => {
      const retired = this.retired.get(proc)
      if (retired) {
        this.retired.delete(proc)
        if (retired.killTimer) this.cancel(retired.killTimer)
        return
      }
      if (this.procs.get(id) !== state) return
      this.procs.delete(id)
      for (const t of state.kickTimers) this.cancel(t)
      this.emit('exit', { id, exitCode } satisfies PtyExitPayload)
    })

    return proc.pid
  }

  /**
   * Append one hex-dumped raw chunk to RAW_CAPTURE_FILE (see the constant's
   * doc comment). Never allowed to break the PTY pipeline: a write failure
   * is routed through reportError() and swallowed, never thrown.
   */
  private captureRawChunk(id: string, data: string): void {
    rawCaptureCount++
    try {
      const hex = Buffer.from(data, 'utf8').toString('hex')
      const entry =
        `--- chunk ${rawCaptureCount}/${RAW_CAPTURE_LIMIT} id=${id} len=${data.length} t=${new Date().toISOString()} ---\n` +
        `hex: ${hex}\n` +
        `str: ${JSON.stringify(data)}\n\n`
      appendFileSync(RAW_CAPTURE_FILE as string, entry)
    } catch (err) {
      reportError('pty-capture', 'failed to write raw PTY capture chunk', err)
    }
  }

  /** Emit PTY output, stripping everything up to and including the start marker. */
  private handleData(id: string, data: string): void {
    const s = this.procs.get(id)
    if (!s) return
    if (consumeJobStartup(s, data, this.scanJobStartup, this.now)) {
      this.reportError('pty', `kory-job: tree kill disabled for tile ${id}`)
    }
    if (!s.marker || s.markerSeen) {
      this.emit('data', { id, data } satisfies PtyDataPayload)
      return
    }
    s.preBuf += data
    const idx = s.preBuf.indexOf(s.marker)
    if (idx !== -1) {
      // Drop up to the end of the marker's line, emit whatever follows.
      const afterMarker = idx + s.marker.length
      const nl = s.preBuf.indexOf('\n', afterMarker)
      const rest = nl !== -1 ? s.preBuf.slice(nl + 1) : ''
      s.markerSeen = true
      s.preBuf = ''
      if (rest) this.emit('data', { id, data: rest } satisfies PtyDataPayload)
    } else if (s.preBuf.length > MARKER_BUFFER_CAP_CODE_UNITS) {
      // Marker never showed up; stop swallowing and flush what we have.
      const buf = s.preBuf
      s.markerSeen = true
      s.preBuf = ''
      this.emit('data', { id, data: buf } satisfies PtyDataPayload)
    }
  }

  write(id: string, data: string): boolean {
    const s = this.procs.get(id)
    if (!s) return false
    s.proc.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.procs.get(id)
    if (!s || cols < 1 || rows < 1) return
    s.cols = cols
    s.rows = rows
    try {
      s.proc.resize(cols, rows)
    } catch {
      // PTY may have just exited; ignore.
    }
  }

  isAlive(id: string): boolean {
    return this.procs.has(id)
  }

  pid(id: string): number | null {
    return this.procs.get(id)?.proc.pid ?? null
  }

  private retryKill(proc: IPty, retired: Retired): void {
    try {
      proc.kill()
    } catch (error) {
      this.reportError('pty', `failed to kill retired PTY for tile ${retired.id} pid ${retired.pid}`, error)
    }
  }

  private retire(id: string, state: Spawned): void {
    for (const timer of state.kickTimers) this.cancel(timer)
    const retired: Retired = { id, pid: state.proc.pid, killTimer: null }
    this.retired.set(state.proc, retired)
    retired.killTimer = this.schedule(() => {
      if (this.retired.get(state.proc) !== retired) return
      retired.killTimer = null
      this.reportError('pty', `kill not acknowledged for tile ${retired.id} pid ${retired.pid}`)
    }, KILL_ACK_TIMEOUT_MS)
    this.retryKill(state.proc, retired)
  }

  kill(id: string): void {
    const state = this.procs.get(id)
    if (!state) return
    this.procs.delete(id)
    this.retire(id, state)
  }

  killAll(): void {
    for (const [proc, retired] of this.retired) this.retryKill(proc, retired)
    for (const id of [...this.procs.keys()]) this.kill(id)
  }
}
