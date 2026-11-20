// Loopback endpoint where a tile's claude.exe reports its own turn events. A
// request is believed because of WHO opened the socket, never because of what
// it says: the owner pid of the connection must be the claude.exe of exactly
// one live tile, and the body is only a closed shape (turn-signal-wire).
// A separate server from deck-control: it carries no tool and no token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { parseTurnSignal, TURN_SIGNAL_LIMITS, type TurnSignal, type TurnSignalRefusal } from '../../hooks/turn-signal-wire'
import { loopbackSocketOwner, runSocketOwnerHelper, type SocketOwnerDeps } from './avatar-socket-owner'
import { logInfo, reportError } from './log'
import { tileOfClaude, type ProcessRow, type TilePty } from './tile-process-owner'

export const TURN_SIGNAL_PLATFORM_SUPPORT: Readonly<Record<string, boolean>> = {
  win32: true
}

export function turnSignalSupported(platform: NodeJS.Platform = process.platform): boolean {
  return TURN_SIGNAL_PLATFORM_SUPPORT[platform] === true
}

export const TURN_SIGNAL_PATH = '/signal'
/** Carries the id the module drew when it was loaded; a different id on the same PTY is another source. */
export const TURN_SIGNAL_LOAD_HEADER = 'x-kory-load'
export const REFUSAL_TRACE_WINDOW_MS = 10_000
/** Identifications that may wait at once; each costs a netstat and a process listing. */
export const MAX_PENDING_IDENTIFICATIONS = 16
export const MAX_CONNECTIONS = 32
export const HEADERS_TIMEOUT_MS = 5_000

const LOAD_ID = /^[A-Za-z0-9_-]{8,64}$/
const MAX_ANNOUNCED_LOADS = 8
const MAX_FAILURE_DETAIL = 200
const LOOPBACK = '127.0.0.1'

export interface TileRef {
  id: string
  /** Identifies one PTY life of the tile: a new one means a new claude.exe. */
  generation: object
  isCurrent(): boolean
}

export type TurnSignalEvent =
  | { type: 'signal'; signal: TurnSignal; loadId: string; generation: object }
  | { type: 'signal-refused'; reason: TurnSignalRefusal; generation: object }
  | { type: 'source-changed'; loadId: string; generation: object }

export type TurnSignalServerRefusal =
  | TurnSignalRefusal
  | 'bad-method'
  | 'bad-path'
  | 'bad-host'
  | 'unknown-process'
  | 'stale-tile'
  | 'bad-load-id'
  | 'source-changed'
  | 'identity-unavailable'
  | 'identity-busy'

export interface TurnSignalServerDeps {
  /** The live tiles with the pid of their PTY shell. */
  tiles(): ReadonlyArray<TileRef & TilePty>
  /** One listing of the process table; the server never runs two at once. */
  listProcesses(): Promise<readonly ProcessRow[]>
  /** How netstat is run; the default reads the real one. */
  socketOwner?: SocketOwnerDeps
  platform?: NodeJS.Platform
  now?: () => number
  trace?: (message: string) => void
  report?: (message: string, error?: unknown) => void
}

export interface TurnSignalServer {
  url: string
  /** One listener per tile; throws when the tile already has one. Returns its unsubscribe. */
  subscribe(tileId: string, listener: (event: TurnSignalEvent) => void): () => void
  close(): void
}

interface TileSource {
  generation: object
  loadId: string
  announced: Set<string>
}

interface Accepted {
  at: number
  tick: number
}

interface Settled<T> {
  value: T
  tick: number
}

class IdentityBusy extends Error {}

type Body = Buffer | 'too-large'

/**
 * Runs `task` one at a time. A caller passes the tick it needs the run to have
 * been launched after: the run in flight serves it when that holds, and
 * otherwise it waits for the one next run that every such caller shares.
 */
export function createSharedRuns<T>(nextTick: () => number) {
  let running: { launched: number; result: Promise<Settled<T>> } | null = null
  let following: Promise<Settled<T>> | null = null
  const launch = (task: () => Promise<T>): Promise<Settled<T>> => {
    const run = {
      launched: nextTick(),
      result: (async () => task())().then((value) => ({ value, tick: nextTick() }))
    }
    running = run
    const release = (): void => {
      if (running === run) running = null
    }
    run.result.then(release, release)
    return run.result
  }
  return (after: number, task: () => Promise<T>): Promise<Settled<T>> => {
    if (!running) return following ?? launch(task)
    if (running.launched > after) return running.result
    following ??= running.result
      .then(undefined, () => undefined)
      .then(() => {
        following = null
        return launch(task)
      })
    return following
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (declared > limit) return resolve('too-large')
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) return resolve('too-large')
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('close', () => reject(new Error('connection closed before the body ended')))
  })
}

/** One line per key and window, naming how many were held back since the last one. */
function limitedTrace(emit: (message: string) => void, now: () => number, label: string) {
  const last = new Map<string, { at: number; suppressed: number }>()
  return (key: string, detail?: string): void => {
    const entry = last.get(key)
    if (entry && now() - entry.at < REFUSAL_TRACE_WINDOW_MS) {
      entry.suppressed++
      return
    }
    const more = entry && entry.suppressed > 0 ? ` (${entry.suppressed} more since the last trace)` : ''
    last.set(key, { at: now(), suppressed: 0 })
    emit(`${label}: ${key}${detail === undefined ? '' : ` [${detail}]`}${more}`)
  }
}

/** Resolves to null where the endpoint is not supported (see TURN_SIGNAL_PLATFORM_SUPPORT): nothing listens there. */
export function startTurnSignalServer(deps: TurnSignalServerDeps, opts: { port?: number } = {}): Promise<TurnSignalServer | null> {
  if (!turnSignalSupported(deps.platform)) return Promise.resolve(null)
  const ownerDeps = deps.socketOwner ?? { env: process.env, run: runSocketOwnerHelper }
  const report = deps.report ?? ((message, error) => reportError('turn-signal', message, error))
  const now = deps.now ?? Date.now
  const traceRefusal = limitedTrace(deps.trace ?? ((message) => logInfo('turn-signal', message)), now, 'turn signal refused')
  const traceFailure = limitedTrace((message) => report(message), now, 'turn signal failure')
  const listeners = new Map<string, (event: TurnSignalEvent) => void>()
  const sources = new Map<string, TileSource>()
  const identities = new WeakMap<Socket, Promise<TileRef | null>>()
  const accepted = new WeakMap<Socket, Accepted>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let tick = 0
  let pendingIdentifications = 0
  let port = 0
  const nextTick = (): number => ++tick
  const netstatRuns = createSharedRuns<string>(nextTick)
  const listings = createSharedRuns<readonly ProcessRow[]>(nextTick)

  const ownerOf = async (socket: Socket, arrival: Accepted): Promise<TileRef | null> => {
    if (socket.remoteAddress !== LOOPBACK || socket.remotePort === undefined) return null
    let netstatDone = 0
    // netstat lists a loopback connection once per end: the row whose local end is the client's names the client's pid.
    const pid = await loopbackSocketOwner(
      { address: LOOPBACK, port: socket.remotePort },
      { address: LOOPBACK, port },
      {
        env: ownerDeps.env,
        run: async (command, args, options) => {
          const shared = await netstatRuns(arrival.tick, () => ownerDeps.run(command, args, options))
          netstatDone = shared.tick
          return shared.value
        }
      }
    )
    if (pid === null) return null
    // The process table must postdate the netstat read that named the pid.
    const listing = await listings(netstatDone, deps.listProcesses)
    const tiles = deps.tiles()
    const id = tileOfClaude(listing.value, pid, tiles, arrival.at)
    return tiles.find((tile) => tile.id === id) ?? null
  }

  const identify = (socket: Socket): Promise<TileRef | null> => {
    const known = identities.get(socket)
    if (known) return known
    if (pendingIdentifications >= MAX_PENDING_IDENTIFICATIONS) return Promise.reject(new IdentityBusy())
    pendingIdentifications++
    const pending = ownerOf(socket, accepted.get(socket)!).finally(() => {
      pendingIdentifications--
    })
    identities.set(socket, pending)
    pending.catch(() => identities.delete(socket))
    return pending
  }

  const deliver = (tileId: string, event: TurnSignalEvent): void => {
    try {
      listeners.get(tileId)?.(event)
    } catch (error) {
      report(`a turn signal listener of tile ${tileId} threw`, error)
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const refuse = (status: number, reason: TurnSignalServerRefusal, traced = true): void => {
      if (traced) traceRefusal(reason)
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ ok: false, reason }), () => req.socket.destroy())
    }
    if (req.method !== 'POST') return refuse(405, 'bad-method')
    if (req.url !== TURN_SIGNAL_PATH) return refuse(404, 'bad-path')
    if (req.headers.host !== `${LOOPBACK}:${port}`) return refuse(403, 'bad-host')

    let tile: TileRef | null
    try {
      tile = await identify(req.socket)
    } catch (error) {
      if (error instanceof IdentityBusy) return refuse(503, 'identity-busy')
      traceFailure('identity-unavailable', (error instanceof Error ? error.message : String(error)).slice(0, MAX_FAILURE_DETAIL))
      return refuse(503, 'identity-unavailable', false)
    }
    if (!tile) return refuse(403, 'unknown-process')
    if (!tile.isCurrent()) return refuse(403, 'stale-tile')

    const loadId = req.headers[TURN_SIGNAL_LOAD_HEADER]
    if (typeof loadId !== 'string' || !LOAD_ID.test(loadId)) return refuse(400, 'bad-load-id')
    let source = sources.get(tile.id)
    if (!source || source.generation !== tile.generation) {
      source = { generation: tile.generation, loadId, announced: new Set() }
      sources.set(tile.id, source)
    }
    if (loadId !== source.loadId) {
      if (source.announced.size < MAX_ANNOUNCED_LOADS && !source.announced.has(loadId)) {
        source.announced.add(loadId)
        deliver(tile.id, { type: 'source-changed', loadId, generation: tile.generation })
      }
      return refuse(409, 'source-changed')
    }

    const owner = tile
    const refuseSignal = (status: number, reason: TurnSignalRefusal): void => {
      deliver(owner.id, { type: 'signal-refused', reason, generation: owner.generation })
      refuse(status, reason)
    }
    let body: Body
    try {
      body = await readBody(req, TURN_SIGNAL_LIMITS.bodyBytes)
    } catch (error) {
      report(`a turn signal body of tile ${owner.id} could not be read`, error)
      return
    }
    if (body === 'too-large') return refuseSignal(413, 'body-too-large')
    let text: string
    try {
      text = decoder.decode(body)
    } catch {
      return refuseSignal(400, 'not-json')
    }
    const result = parseTurnSignal(text)
    if (!result.ok) return refuseSignal(400, result.reason)

    deliver(tile.id, { type: 'signal', signal: result.signal, loadId, generation: tile.generation })
    res.writeHead(204)
    res.end()
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      report('a turn signal request failed', error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.maxConnections = MAX_CONNECTIONS
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.on('connection', (socket) => accepted.set(socket, { at: now(), tick: nextTick() }))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, LOOPBACK, () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no address'))
      port = address.port
      resolve({
        url: `http://${LOOPBACK}:${port}${TURN_SIGNAL_PATH}`,
        subscribe(tileId, listener) {
          if (listeners.has(tileId)) throw new Error(`tile ${tileId} already has a turn signal listener`)
          listeners.set(tileId, listener)
          return () => {
            if (listeners.get(tileId) === listener) listeners.delete(tileId)
          }
        },
        close() {
          server.close()
          server.closeAllConnections()
        }
      })
    })
  })
}
