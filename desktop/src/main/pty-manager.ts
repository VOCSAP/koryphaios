import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'
import { buildShellInvocation, type SpawnOpts } from './shell-command'

export interface PtyDataPayload {
  id: string
  data: string
}
export interface PtyExitPayload {
  id: string
  exitCode: number
}

/** Give up stripping the interactive start marker after this many buffered bytes. */
const MARKER_BUFFER_CAP = 65536

interface Spawned {
  proc: pty.IPty
  cols: number
  rows: number
  /** Start marker to strip (interactive mode), or null. */
  marker: string | null
  markerSeen: boolean
  preBuf: string
}

/** Owns every live PTY. One instance for the whole app. */
export class PtyManager extends EventEmitter {
  private procs = new Map<string, Spawned>()

  /**
   * Spawn a peer terminal for `id`. Replaces any existing PTY for that id.
   * `extraEnv` (the scope env from scope.ts) is merged last so its forced-group
   * vars win over anything inherited from the parent process. In interactive
   * mode the rc/profile noise before the start marker is stripped from output.
   */
  spawn(id: string, cwd: string, opts: SpawnOpts, extraEnv?: Record<string, string>): number {
    this.kill(id)
    const { file, args, marker } = buildShellInvocation(opts)

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        // Populate the status-line peer_id cache so the Deck can show peer_id.
        CLAUDE_PEERS_STATUS_LINE_CACHE: '1',
        TERM: 'xterm-256color',
        ...extraEnv
      }
    })

    const state: Spawned = { proc, cols: 80, rows: 24, marker, markerSeen: false, preBuf: '' }
    this.procs.set(id, state)

    proc.onData((data) => this.handleData(id, data))
    proc.onExit(({ exitCode }) => {
      // Only react if THIS proc is still the one registered for `id`. A kill()
      // (remove/closeAll) deletes procs[id] before killing, and a spawn() during
      // restart replaces procs[id] with a fresh state -- in both cases the dying
      // proc's late, asynchronous onExit must NOT emit, otherwise it would tear
      // down a tile that was intentionally closed or just respawned. Emitting
      // here therefore means strictly "the process exited on its own" (the user
      // typed /exit, or it crashed).
      if (this.procs.get(id) !== state) return
      this.procs.delete(id)
      this.emit('exit', { id, exitCode } satisfies PtyExitPayload)
    })

    return proc.pid
  }

  /** Emit PTY output, stripping everything up to and including the start marker. */
  private handleData(id: string, data: string): void {
    const s = this.procs.get(id)
    if (!s) return
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
    } else if (s.preBuf.length > MARKER_BUFFER_CAP) {
      // Marker never showed up; stop swallowing and flush what we have.
      const buf = s.preBuf
      s.markerSeen = true
      s.preBuf = ''
      this.emit('data', { id, data: buf } satisfies PtyDataPayload)
    }
  }

  /** Returns false when no live PTY carries this id (write silently dropped). */
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

  kill(id: string): void {
    const s = this.procs.get(id)
    if (!s) return
    this.procs.delete(id)
    try {
      s.proc.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id)
  }
}
