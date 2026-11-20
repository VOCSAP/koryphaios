import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { TURN_SIGNAL_LIMITS } from '../desktop/hooks/turn-signal-wire.ts'
import {
  createSharedRuns,
  MAX_CONNECTIONS,
  REFUSAL_TRACE_WINDOW_MS,
  startTurnSignalServer,
  TURN_SIGNAL_PATH,
  type TileRef,
  type TurnSignalEvent,
  type TurnSignalServer
} from '../desktop/src/main/turn-signal-server.ts'
import type { ProcessRow } from '../desktop/src/main/tile-process-owner.ts'
import { reachedWithin } from './_bounded-await'

const DECK_PID = 1111
const PID_A = 4242
const PID_B = 4343
const LOAD_A = 'load-aaaaaaaa'
const LOAD_B = 'load-bbbbbbbb'
const START = '{"kind":"turn.start","seq":1,"turnId":"turn-1"}'
const WAIT_MS = 1500

interface FakeTile extends TileRef {
  alive: boolean
}
const makeTile = (id: string): FakeTile => {
  const tile: FakeTile = { id, generation: {}, alive: true, isCurrent: () => tile.alive }
  return tile
}

/** A run the test can hold open: it counts the runs and how many overlap. */
interface Probe {
  runs: number
  inFlight: number
  maxInFlight: number
  /** While set, a run waits for it. */
  gate: Promise<void> | null
  fail: boolean
}

const freshProbe = (): Probe => ({ runs: 0, inFlight: 0, maxInFlight: 0, gate: null, fail: false })

async function probed<T>(probe: Probe, produce: () => T): Promise<T> {
  probe.runs++
  probe.inFlight++
  probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight)
  try {
    if (probe.gate) await probe.gate
    if (probe.fail) throw new Error('the run failed')
    return produce()
  } finally {
    probe.inFlight--
  }
}

function holdOpen(probe: Probe): () => void {
  let release!: () => void
  probe.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return () => {
    probe.gate = null
    release()
  }
}

interface Rig {
  /** Client port -> pid of the process that owns that end, as netstat lists it. */
  clients: Map<number, number>
  /** The live tiles with their shell pid; the Deck's own pid is one too, to catch a wrong end. */
  tiles: Array<FakeTile & { ptyPid: number }>
  /** What the process table says. */
  rows: ProcessRow[]
  netstat: Probe
  listing: Probe
  traces: string[]
  reports: string[]
}

const freshRig = (): Rig => ({
  clients: new Map(),
  tiles: [],
  rows: [],
  netstat: freshProbe(),
  listing: freshProbe(),
  traces: [],
  reports: []
})

let rig = freshRig()
/** The server keeps its trace windows across tests, so each test starts a window later. */
let clock = 1_000_000
let server: TurnSignalServer
let port = 0

function netstatText(): string {
  const lines = ['  Proto  Local Address          Foreign Address        State           PID']
  for (const [clientPort, pid] of rig.clients) {
    lines.push(`  TCP    127.0.0.1:${clientPort}      127.0.0.1:${port}      ESTABLISHED     ${pid}`)
    lines.push(`  TCP    127.0.0.1:${port}      127.0.0.1:${clientPort}      ESTABLISHED     ${DECK_PID}`)
  }
  return lines.join('\r\n')
}

beforeAll(async () => {
  const started = await startTurnSignalServer({
    platform: 'win32',
    socketOwner: {
      env: { SystemRoot: 'C:\\Windows' },
      run: () => probed(rig.netstat, netstatText)
    },
    tiles: () => rig.tiles,
    listProcesses: () => probed(rig.listing, () => [...rig.rows]),
    now: () => clock,
    trace: (message) => rig.traces.push(message),
    report: (message) => rig.reports.push(message)
  })
  if (!started) throw new Error('the server did not start on win32')
  server = started
  port = Number(new URL(server.url).port)
})

afterAll(() => server.close())

let unsubscribes: Array<() => void> = []

beforeEach(() => {
  for (const unsubscribe of unsubscribes) unsubscribe()
  unsubscribes = []
  rig = freshRig()
  clock += REFUSAL_TRACE_WINDOW_MS + 1
})

function subscribe(tileId: string, listener: (event: TurnSignalEvent) => void): () => void {
  const unsubscribe = server.subscribe(tileId, listener)
  unsubscribes.push(unsubscribe)
  return unsubscribe
}

interface Reply {
  status: number
  headers: Record<string, string>
  body: string
}

interface Client {
  socket: Socket
  localPort: number
  send(raw: Buffer): Promise<Reply>
  closed: Promise<void>
}

function parseReply(buffer: Buffer): { reply: Reply; rest: Buffer } | null {
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) return null
  const [statusLine, ...headerLines] = buffer.subarray(0, end).toString('utf8').split('\r\n')
  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
  }
  const status = Number(statusLine!.split(' ')[1])
  const start = end + 4
  if (headers['transfer-encoding']?.toLowerCase() === 'chunked') {
    // node and bun 1.4 frame a body written by `res.end(body)` in chunks; bun 1.3 sent a Content-Length.
    const parts: Buffer[] = []
    let at = start
    for (;;) {
      const lineEnd = buffer.indexOf('\r\n', at)
      if (lineEnd < 0) return null
      const size = Number.parseInt(buffer.subarray(at, lineEnd).toString('ascii'), 16)
      if (size === 0) {
        if (buffer.length < lineEnd + 4) return null
        return { reply: { status, headers, body: Buffer.concat(parts).toString('utf8') }, rest: buffer.subarray(lineEnd + 4) }
      }
      if (buffer.length < lineEnd + 2 + size + 2) return null
      parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size))
      at = lineEnd + 2 + size + 2
    }
  }
  const length = Number(headers['content-length'] ?? 0)
  if (buffer.length < start + length) return null
  return { reply: { status, headers, body: buffer.subarray(start, start + length).toString('utf8') }, rest: buffer.subarray(start + length) }
}

const open: Socket[] = []
/** Every test closes the connections it opened: the server holds at most MAX_CONNECTIONS of them where the runtime enforces it. */
afterEach(() => {
  for (const socket of open.splice(0)) socket.destroy()
})
afterAll(() => {
  for (const socket of open.splice(0)) socket.destroy()
})

/** A raw connection from `pid`'s end: netstat will list its port under that pid unless `pid` is null. */
function connect(pid: number | null = PID_A): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      if (pid !== null) rig.clients.set(socket.localPort!, pid)
      resolve(client)
    })
    open.push(socket)
    let buffer = Buffer.alloc(0)
    let waiting: ((reply: Reply) => void) | null = null
    let ended: () => void = () => undefined
    const closed = new Promise<void>((done) => {
      ended = done
    })
    const flush = (): void => {
      const parsed = parseReply(buffer)
      if (parsed && waiting) {
        buffer = Buffer.from(parsed.rest)
        const resolveReply = waiting
        waiting = null
        resolveReply(parsed.reply)
      }
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer])
      flush()
    })
    socket.on('error', reject)
    socket.on('close', () => ended())
    const client: Client = {
      socket,
      get localPort() {
        return socket.localPort!
      },
      closed,
      send: (raw) =>
        new Promise<Reply>((resolveReply) => {
          waiting = resolveReply
          socket.write(raw)
          flush()
        })
    }
  })
}

interface RequestOptions {
  method?: string
  path?: string
  host?: string
  headers?: Record<string, string>
  load?: string | null
  /** null: no Content-Length header; a number: declared whatever the body really is. */
  contentLength?: number | null
  chunked?: boolean
}

function request(body: Buffer | string = START, options: RequestOptions = {}): Buffer {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const headers: Record<string, string> = {
    Host: options.host ?? `127.0.0.1:${port}`,
    'Content-Type': 'application/json',
    ...(options.load === null ? {} : { 'X-Kory-Load': options.load ?? LOAD_A }),
    ...(options.headers ?? {})
  }
  if (options.chunked) headers['Transfer-Encoding'] = 'chunked'
  else if (options.contentLength !== null) headers['Content-Length'] = String(options.contentLength ?? bytes.length)
  const head = `${options.method ?? 'POST'} ${options.path ?? TURN_SIGNAL_PATH} HTTP/1.1\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')}\r\n\r\n`
  if (!options.chunked) return Buffer.concat([Buffer.from(head), bytes])
  const parts: Buffer[] = [Buffer.from(head)]
  for (let at = 0; at < bytes.length; at += 1000) {
    const piece = bytes.subarray(at, at + 1000)
    parts.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from('0\r\n\r\n'))
  return Buffer.concat(parts)
}

const within = <T>(promise: Promise<T>, what: string) => reachedWithin(promise, what, WAIT_MS)

/** One request on a fresh connection owned by `pid`, the reply and the events its tile received. */
async function exchange(raw: Buffer | string, options: RequestOptions = {}, pid: number | null = PID_A) {
  const client = await connect(pid)
  const reply = await within(client.send(request(raw, options)), 'the reply')
  return { reply, client }
}

function listen(tile: TileRef): TurnSignalEvent[] {
  const events: TurnSignalEvent[] = []
  subscribe(tile.id, (event) => events.push(event))
  return events
}

/** A tile whose shell and claude.exe are in the process table, the claude.exe created `claudeCreatedAt` ms (default: long before now). */
function ownTile(id: string, claudePid: number, claudeCreatedAt: number = clock - 50_000): FakeTile {
  const tile = Object.assign(makeTile(id), { ptyPid: 50_000 + claudePid })
  rig.tiles = rig.tiles.filter((other) => other.id !== id)
  rig.tiles.push(tile)
  rig.rows.push(
    { pid: tile.ptyPid, ppid: 1, name: 'powershell.exe', createdAt: clock - 100_000 },
    { pid: claudePid, ppid: tile.ptyPid, name: 'claude.exe', createdAt: claudeCreatedAt }
  )
  return tile
}

describe('who a request is believed to come from', () => {
  test('a signal from the socket of a tile claude.exe reaches that tile only, with its generation and load id', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const tileB = ownTile('tile-b', PID_B)
    const eventsA = listen(tileA)
    const eventsB = listen(tileB)

    const { reply } = await exchange(START, {}, PID_A)

    expect(reply.status).toBe(204)
    expect(eventsB).toEqual([])
    expect(eventsA).toEqual([
      {
        type: 'signal',
        signal: { kind: 'turn.start', seq: 1, turnId: 'turn-1' },
        loadId: LOAD_A,
        generation: tileA.generation
      }
    ])
    expect(eventsA[0]!.generation, 'the very PTY life object of the tile, not a look-alike').toBe(tileA.generation)
  })

  test('the tile is the one that owns the socket, whatever the request claims', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const tileB = ownTile('tile-b', PID_B)
    const eventsA = listen(tileA)
    const eventsB = listen(tileB)

    const { reply } = await exchange(START, { headers: { 'X-Kory-Tile': 'tile-b', 'X-Kory-Pid': String(PID_B) } }, PID_A)
    expect(reply.status).toBe(204)
    expect(eventsA).toHaveLength(1)
    expect(eventsB).toEqual([])

    const named = await exchange('{"kind":"turn.start","seq":2,"turnId":"t","tile":"tile-b"}', {}, PID_A)
    expect(named.reply.status, 'a tile named in the body is an unknown key').toBe(400)
    expect(JSON.parse(named.reply.body)).toEqual({ ok: false, reason: 'unknown-key' })
    expect(eventsB).toEqual([])
  })

  test('the owner is read from the client end of the connection: the Deck end of netstat is never taken', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const deckTile = ownTile('deck-tile', DECK_PID)
    const eventsA = listen(tileA)
    const eventsDeck = listen(deckTile)

    const { reply } = await exchange(START, {}, PID_A)

    expect(reply.status).toBe(204)
    expect(eventsA).toHaveLength(1)
    expect(eventsDeck).toEqual([])
  })

  test('a socket whose owner is unknown, or is no tile, gets a 403 and a trace of the reason only', async () => {
    ownTile('tile-a', PID_A)

    const noRow = await exchange(START, {}, null)
    expect(noRow.reply.status).toBe(403)
    expect(JSON.parse(noRow.reply.body)).toEqual({ ok: false, reason: 'unknown-process' })
    await within(noRow.client.closed, 'the connection closed after the refusal')

    const notATile = await exchange(START, {}, 9999)
    expect(notATile.reply.status).toBe(403)
    expect(rig.traces).toEqual(['turn signal refused: unknown-process'])
  })

  test('a claude.exe of a tile that was replaced is refused as stale', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)
    tileA.alive = false

    const { reply } = await exchange(START, {}, PID_A)

    expect(reply.status).toBe(403)
    expect(JSON.parse(reply.body)).toEqual({ ok: false, reason: 'stale-tile' })
    expect(events).toEqual([])
  })

  test('a connection is resolved once, however many requests it carries, and re-checked for staleness each time', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)
    const client = await connect(PID_A)

    const first = await within(client.send(request('{"kind":"turn.start","seq":1,"turnId":"t1"}')), 'the first reply')
    const second = await within(client.send(request('{"kind":"turn.start","seq":2,"turnId":"t2"}')), 'the second reply')

    expect([first.status, second.status]).toEqual([204, 204])
    expect(events).toHaveLength(2)
    expect([rig.netstat.runs, rig.listing.runs]).toEqual([1, 1])

    tileA.alive = false
    const third = await within(client.send(request('{"kind":"turn.start","seq":3,"turnId":"t3"}')), 'the third reply')
    expect(third.status).toBe(403)
    expect(events).toHaveLength(2)
  })

  test('when netstat or the process table cannot be read the request is refused with a 503, nothing is delivered', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)

    rig.netstat.fail = true
    const netstatDown = await exchange(START, {}, PID_A)
    rig.netstat.fail = false
    rig.listing.fail = true
    const listingDown = await exchange(START, {}, PID_A)
    rig.listing.fail = false

    expect([netstatDown.reply.status, listingDown.reply.status]).toEqual([503, 503])
    expect(JSON.parse(netstatDown.reply.body)).toEqual({ ok: false, reason: 'identity-unavailable' })
    expect(events).toEqual([])
    expect((await exchange(START, {}, PID_A)).reply.status, 'the next connection is resolved afresh').toBe(204)
  })

  test('identity failures are reported once per window with the count held back, without the body of any request', async () => {
    ownTile('tile-a', PID_A)
    rig.netstat.fail = true

    for (let i = 0; i < 4; i++) await exchange(START, {}, PID_A)
    expect(rig.reports).toHaveLength(1)
    expect(rig.reports[0]).toMatch(/^turn signal failure: identity-unavailable \[the run failed\]( \(\d+ more since the last trace\))?$/)

    clock += REFUSAL_TRACE_WINDOW_MS + 1
    await exchange(START, {}, PID_A)
    expect(rig.reports.at(-1)).toBe('turn signal failure: identity-unavailable [the run failed] (3 more since the last trace)')
    expect(rig.traces, 'a failure is not also a refusal line').toEqual([])
  })

  test('a claude.exe created after the connection was accepted cannot be the one that opened it', async () => {
    const tileA = ownTile('tile-a', PID_A, clock + 5_000)
    const events = listen(tileA)

    const { reply } = await exchange(START, {}, PID_A)

    expect(reply.status).toBe(403)
    expect(events).toEqual([])
  })

  test('a claude.exe created within a second of the connection still counts: clocks differ by a tick', async () => {
    const tileA = ownTile('tile-a', PID_A, clock + 1_000)
    const events = listen(tileA)

    expect((await exchange(START, {}, PID_A)).reply.status).toBe(204)
    expect(events).toHaveLength(1)
  })
})

/** Polls `condition` until it holds, bounded, so a missing event is a named failure and not a hang. */
const until = (condition: () => boolean, what: string) =>
  within(
    new Promise<void>((resolve) => {
      const poll = (): void => (condition() ? resolve() : void setTimeout(poll, 5))
      poll()
    }),
    what
  )

/** Lets the event loop deliver what is already in flight, such as the server side of a connection. */
const settle = () => Bun.sleep(40)

describe('what telling who connected may cost', () => {
  test('simultaneous connections share one netstat and one process listing, and no two runs overlap', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)
    const releaseNetstat = holdOpen(rig.netstat)
    const releaseListing = holdOpen(rig.listing)
    const clients = await Promise.all(Array.from({ length: 8 }, () => connect(PID_A)))
    await settle()

    const replies = clients.map((client) => client.send(request(START)))
    await until(() => rig.netstat.runs >= 1, 'the netstat run')
    await settle()
    expect(rig.netstat.runs, 'one netstat serves every socket accepted before it was launched').toBe(1)
    releaseNetstat()
    await until(() => rig.listing.runs >= 1, 'the process listing')
    await settle()
    expect(rig.listing.runs, 'one listing serves every request whose netstat it follows').toBe(1)
    releaseListing()

    const results = await within(Promise.all(replies), 'every reply')
    expect(results.map((reply) => reply.status)).toEqual(Array(8).fill(204))
    expect(events).toHaveLength(8)
    // bun reports a connection at its first request, so the sockets that follow the first one wait for one shared next run.
    expect(rig.netstat.runs).toBeLessThanOrEqual(2)
    expect(rig.listing.runs).toBeLessThanOrEqual(2)
    expect([rig.netstat.maxInFlight, rig.listing.maxInFlight]).toEqual([1, 1])
  })

  test('a socket accepted after a netstat was launched waits for the next one, which every such socket shares', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const tileB = ownTile('tile-b', PID_B)
    const eventsA = listen(tileA)
    const eventsB = listen(tileB)
    const releaseNetstat = holdOpen(rig.netstat)
    const early = await connect(PID_A)
    await settle()
    const earlyReply = early.send(request(START))
    await until(() => rig.netstat.runs >= 1, 'the first netstat run')

    const late = await Promise.all([connect(PID_B), connect(PID_B)])
    await settle()
    const lateReplies = late.map((client) => client.send(request(START)))
    await settle()
    expect(rig.netstat.runs, 'the run in flight predates these sockets and is not theirs').toBe(1)
    releaseNetstat()

    const statuses = (await within(Promise.all([earlyReply, ...lateReplies]), 'every reply')).map((reply) => reply.status)
    expect(statuses).toEqual([204, 204, 204])
    expect(rig.netstat.runs, 'one more run, shared by both late sockets').toBe(2)
    expect(rig.netstat.maxInFlight).toBe(1)
    expect([eventsA.length, eventsB.length]).toEqual([1, 2])
  })

  test('a listing launched before the netstat of a request is never reused for it', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const tileB = ownTile('tile-b', PID_B)
    const eventsA = listen(tileA)
    const eventsB = listen(tileB)
    const releaseListing = holdOpen(rig.listing)
    const first = await connect(PID_A)
    await settle()
    const firstReply = first.send(request(START))
    await until(() => rig.listing.runs >= 1, 'the first listing')

    const second = await connect(PID_B)
    await settle()
    const secondReply = second.send(request(START))
    await until(() => rig.netstat.runs >= 2, 'the netstat of the second request')
    await settle()
    expect(rig.listing.runs, 'the listing in flight began before that netstat finished').toBe(1)
    releaseListing()

    expect((await within(Promise.all([firstReply, secondReply]), 'both replies')).map((reply) => reply.status)).toEqual([204, 204])
    expect(rig.listing.runs, 'the second request waited for a listing of its own').toBe(2)
    expect(rig.listing.maxInFlight).toBe(1)
    expect([eventsA.length, eventsB.length]).toEqual([1, 1])
  })

  test('past sixteen identifications waiting at once the next connection is refused with a 503 at once', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)
    const releaseNetstat = holdOpen(rig.netstat)
    const clients = await Promise.all(Array.from({ length: 17 }, () => connect(PID_A)))
    await settle()

    const replies = clients.map((client) => client.send(request(START)))
    const refused = await within(Promise.race(replies), 'the immediate refusal')
    expect(refused.status).toBe(503)
    expect(JSON.parse(refused.body)).toEqual({ ok: false, reason: 'identity-busy' })
    releaseNetstat()

    const statuses = (await within(Promise.all(replies), 'every reply')).map((reply) => reply.status).sort()
    expect(statuses).toEqual([...Array(16).fill(204), 503])
    expect(events).toHaveLength(16)
    expect(rig.netstat.runs, 'sixteen identifications, two runs at most').toBeLessThanOrEqual(2)
    expect(rig.netstat.maxInFlight).toBe(1)
  })

  test('a keep-alive connection is identified once and takes no place among the waiting ones', async () => {
    const tileA = ownTile('tile-a', PID_A)
    listen(tileA)
    const client = await connect(PID_A)
    for (let seq = 1; seq <= 20; seq++) {
      const reply = await within(client.send(request(`{"kind":"turn.start","seq":${seq},"turnId":"t${seq}"}`)), `reply ${seq}`)
      expect(reply.status).toBe(204)
    }
    expect([rig.netstat.runs, rig.listing.runs]).toEqual([1, 1])
  })

})

/** Whether this runtime closes the connections an http server holds past its `maxConnections` (node does; bun 1.3 does not). */
async function runtimeEnforcesMaxConnections(): Promise<boolean> {
  const probe = createServer((_req, res) => res.end())
  probe.maxConnections = 1
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const probePort = (probe.address() as { port: number }).port
  const sockets = [createConnection({ host: '127.0.0.1', port: probePort }), createConnection({ host: '127.0.0.1', port: probePort })]
  let closed = 0
  for (const socket of sockets) {
    socket.on('error', () => undefined)
    socket.on('close', () => closed++)
  }
  await Bun.sleep(150)
  for (const socket of sockets) socket.destroy()
  probe.close()
  probe.closeAllConnections()
  return closed >= 1
}

const enforcesMaxConnections = await runtimeEnforcesMaxConnections()

describe('the connections the server holds', () => {
  test.skipIf(!enforcesMaxConnections)(
    'no more than thirty-two connections are held at once (needs a runtime that enforces server.maxConnections)',
    async () => {
      const clients = await Promise.all(Array.from({ length: 40 }, () => connect(null)))
      await settle()
      await settle()

      const ended = await Promise.all(clients.map((client) => Promise.race([client.closed.then(() => true), Bun.sleep(1).then(() => false)])))
      expect(ended.filter(Boolean).length).toBeGreaterThanOrEqual(40 - MAX_CONNECTIONS)
    }
  )
})

describe('createSharedRuns', () => {
  /** A task the test finishes by hand, counting its calls and how many run at once. */
  function manualTask() {
    const settlers: Array<{ resolve(value: string): void; reject(error: Error): void }> = []
    const state = { calls: 0, inFlight: 0, maxInFlight: 0 }
    const task = (): Promise<string> => {
      state.calls++
      state.inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      return new Promise<string>((resolve, reject) => {
        settlers.push({
          resolve: (value) => {
            state.inFlight--
            resolve(value)
          },
          reject: (error) => {
            state.inFlight--
            reject(error)
          }
        })
      })
    }
    return { task, state, settlers }
  }
  const flush = () => Bun.sleep(5)

  test('a caller that was there before the run was launched shares it, a later one waits for one more run that all such callers share', async () => {
    let tick = 0
    const run = createSharedRuns<string>(() => ++tick)
    const { task, state, settlers } = manualTask()
    const early = ++tick
    const first = run(early, task)
    const sharer = run(early, task)
    const late = ++tick
    const waiter = run(late, task)
    const secondWaiter = run(late, task)
    await flush()
    expect(state.calls, 'one run in flight, the others wait for it').toBe(1)

    settlers[0]!.resolve('first run')
    expect((await within(first, 'the first run')).value).toBe('first run')
    expect((await within(sharer, 'the sharer')).value).toBe('first run')
    await flush()
    expect(state.calls, 'one more run, not one per waiter').toBe(2)
    settlers[1]!.resolve('second run')
    expect((await within(waiter, 'the waiter')).value).toBe('second run')
    expect((await within(secondWaiter, 'the second waiter')).value).toBe('second run')
    expect(state.maxInFlight).toBe(1)
  })

  test('a result is stamped after the run was launched, so a later caller can tell which run is newer than its own read', async () => {
    let tick = 0
    const run = createSharedRuns<string>(() => ++tick)
    const { task, settlers } = manualTask()

    const pending = run(0, task)
    settlers[0]!.resolve('done')
    const settled = await within(pending, 'the run')

    expect(settled.tick).toBeGreaterThan(1)
  })

  test('once a run has ended the next caller launches a new one: nothing is kept between runs', async () => {
    let tick = 0
    const run = createSharedRuns<string>(() => ++tick)
    const { task, state, settlers } = manualTask()

    const first = run(0, task)
    settlers[0]!.resolve('one')
    await within(first, 'the first run')
    const second = run(0, task)
    settlers[1]!.resolve('two')

    expect((await within(second, 'the second run')).value).toBe('two')
    expect(state.calls).toBe(2)
  })

  test('a call between the end of a run and the launch of the queued next one joins that one instead of launching its own', async () => {
    let tick = 0
    const run = createSharedRuns<string>(() => ++tick)
    const { task, state, settlers } = manualTask()
    const early = ++tick
    const first = run(early, task)
    // Registered after the run's own release and before the queued run's reaction: it runs once nothing is running and the queued run is not launched yet.
    let intruder: ReturnType<typeof run> | undefined
    void first.then(() => {
      intruder = run(++tick, task)
    })
    const waiter = run(++tick, task)

    settlers[0]!.resolve('first run')
    await within(first, 'the first run')
    await flush()
    expect(intruder, 'the call did land in the interval').toBeDefined()
    expect(state.calls, 'the queued run and the intruder are one run').toBe(2)
    settlers[1]!.resolve('second run')

    expect((await within(waiter, 'the waiter')).value).toBe('second run')
    expect((await within(intruder!, 'the intruder')).value).toBe('second run')
    expect(state.maxInFlight, 'no two runs overlap').toBe(1)
  })

  test('a failing run fails every caller that shared it, and the callers waiting behind it get a fresh run', async () => {
    let tick = 0
    const run = createSharedRuns<string>(() => ++tick)
    const { task, state, settlers } = manualTask()
    const early = ++tick
    const sharing = run(early, task)
    const late = ++tick
    const waiting = run(late, task)
    const sharingFailure = within(sharing, 'the failing run').then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await flush()

    settlers[0]!.reject(new Error('run failed'))
    expect(await sharingFailure).toBe('run failed')
    await flush()
    expect(state.calls, 'the waiter launched its own run').toBe(2)
    settlers[1]!.resolve('fresh')
    expect((await within(waiting, 'the waiter')).value).toBe('fresh')
  })
})

describe('what a request must look like', () => {
  test('only a POST to the signal path is read, whatever the body says', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)

    for (const [options, status] of [
      [{ method: 'GET' }, 405],
      [{ method: 'PUT' }, 405],
      [{ path: '/' }, 404],
      [{ path: `${TURN_SIGNAL_PATH}/x` }, 404]
    ] as const) {
      const { reply } = await exchange(START, options, PID_A)
      expect(reply.status, JSON.stringify(options)).toBe(status)
    }
    expect(events).toEqual([])
  })

  test('the Host header must be exactly the loopback address and port of the server', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)

    for (const host of [`localhost:${port}`, '127.0.0.1:1', '127.0.0.1', `127.0.0.1:${port + 1}`, `evil.test:${port}`]) {
      const { reply } = await exchange(START, { host }, PID_A)
      expect(reply.status, host).toBe(403)
    }
    expect(events).toEqual([])
    expect((await exchange(START, {}, PID_A)).reply.status).toBe(204)
  })

  test('a body is read up to its byte limit and not a byte more, before anything decodes it', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)
    const limit = TURN_SIGNAL_LIMITS.bodyBytes
    const padded = (size: number) => '{"kind":"session.compact:resolved","seq":5}'.padEnd(size, ' ')

    const atLimit = await exchange(padded(limit), {}, PID_A)
    expect(atLimit.reply.status).toBe(204)
    const chunkedAtLimit = await exchange(padded(limit), { chunked: true }, PID_A)
    expect(chunkedAtLimit.reply.status).toBe(204)
    expect(events).toHaveLength(2)

    const declared = await exchange('', { contentLength: limit + 1 }, PID_A)
    expect(declared.reply.status, 'refused on the declared length, with no body sent at all').toBe(413)

    const streamed = await exchange(padded(limit + 1), { chunked: true }, PID_A)
    expect(streamed.reply.status, 'no Content-Length: the stream is cut at the limit').toBe(413)
    expect(JSON.parse(streamed.reply.body)).toEqual({ ok: false, reason: 'body-too-large' })
    expect(events.filter((event) => event.type === 'signal-refused').map((event) => (event as { reason: string }).reason)).toEqual([
      'body-too-large',
      'body-too-large'
    ])
  })

  test('a body that is not valid UTF-8 is refused even where a lossy decoder would let it through', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)
    const body = Buffer.concat([Buffer.from('{"kind":"turn.start","seq":1,"turnId":"t'), Buffer.from([0xff]), Buffer.from('"}')])

    const { reply } = await exchange(body, {}, PID_A)

    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toEqual({ ok: false, reason: 'not-json' })
    expect(events.map((event) => event.type)).toEqual(['signal-refused'])
  })

  test('every refusal of the closed shape reaches the tile as signal-refused and never echoes the body', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)
    const echoed = 'marker-xyz'

    for (const [body, reason] of [
      [`{"kind":"turn.start","seq":1,"turnId":"t","extra":"${echoed}"}`, 'unknown-key'],
      [`{"kind":"nope","note":"${echoed}"}`, 'unknown-kind'],
      [`not json ${echoed}`, 'not-json'],
      [`{"kind":"turn.start","seq":-1,"turnId":"${echoed}"}`, 'bad-seq']
    ] as const) {
      const { reply } = await exchange(body, {}, PID_A)
      expect(reply.status, reason).toBe(400)
      expect(reply.body, reason).not.toContain(echoed)
      expect(JSON.parse(reply.body)).toEqual({ ok: false, reason })
    }
    expect(events.map((event) => (event.type === 'signal-refused' ? event.reason : event.type))).toEqual([
      'unknown-key',
      'unknown-kind',
      'not-json',
      'bad-seq'
    ])
    expect(rig.traces.join('\n')).not.toContain(echoed)
    expect(rig.traces).toHaveLength(4)
  })

  test('refusals are traced once per window and per reason, with the count of those held back', async () => {
    for (let i = 0; i < 5; i++) await exchange(START, { method: 'GET' }, PID_A)
    expect(rig.traces).toHaveLength(1)
    expect(rig.traces[0]).toMatch(/^turn signal refused: bad-method( \(\d+ more since the last trace\))?$/)

    await exchange(START, { path: '/x' }, PID_A)
    expect(rig.traces, 'another reason has its own window').toHaveLength(2)

    clock += REFUSAL_TRACE_WINDOW_MS + 1
    await exchange(START, { method: 'GET' }, PID_A)
    expect(rig.traces.at(-1)).toBe('turn signal refused: bad-method (4 more since the last trace)')
  })
})

describe('which module load a signal comes from', () => {
  test('a request without a well formed load id is refused before its body is read', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)

    for (const load of [null, '', 'short', 'has space!!', 'x'.repeat(65)]) {
      const { reply } = await exchange(START, { load }, PID_A)
      expect(reply.status, String(load)).toBe(400)
      expect(JSON.parse(reply.body)).toEqual({ ok: false, reason: 'bad-load-id' })
    }
    expect(events).toEqual([])
  })

  test('another load id on the same PTY life is refused with a 409 and announced once, the first id keeps working', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const events = listen(tileA)

    expect((await exchange(START, { load: LOAD_A }, PID_A)).reply.status).toBe(204)
    const other = await exchange(START, { load: LOAD_B }, PID_A)
    expect(other.reply.status).toBe(409)
    expect(JSON.parse(other.reply.body)).toEqual({ ok: false, reason: 'source-changed' })
    expect((await exchange(START, { load: LOAD_B }, PID_A)).reply.status).toBe(409)
    expect((await exchange(START, { load: LOAD_A }, PID_A)).reply.status).toBe(204)

    expect(events.map((event) => event.type)).toEqual(['signal', 'source-changed', 'signal'])
    expect(events[1]).toEqual({ type: 'source-changed', loadId: LOAD_B, generation: tileA.generation })
    expect(events[1]!.generation).toBe(tileA.generation)
  })

  test('a new PTY life starts from a new baseline: its first load id is accepted', async () => {
    ownTile('tile-a', PID_A)
    expect((await exchange(START, { load: LOAD_A }, PID_A)).reply.status).toBe(204)

    const respawned = ownTile('tile-a', PID_A)
    const events = listen(respawned)
    const { reply } = await exchange(START, { load: LOAD_B }, PID_A)

    expect(reply.status).toBe(204)
    expect(events).toEqual([
      { type: 'signal', signal: { kind: 'turn.start', seq: 1, turnId: 'turn-1' }, loadId: LOAD_B, generation: respawned.generation }
    ])
  })
})

describe('the listener of a tile', () => {
  test('a tile has one listener at a time, and an old unsubscribe never removes a newer one', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const first: TurnSignalEvent[] = []
    const unsubscribeFirst = subscribe('tile-a', (event) => first.push(event))
    expect(() => server.subscribe('tile-a', () => undefined)).toThrow('tile tile-a already has a turn signal listener')
    unsubscribeFirst()
    const second = listen(tileA)
    unsubscribeFirst()

    await exchange(START, {}, PID_A)

    expect(first).toEqual([])
    expect(second).toHaveLength(1)
  })

  test('a signal for a tile nobody listens to is accepted and dropped', async () => {
    ownTile('tile-a', PID_A)
    expect((await exchange(START, {}, PID_A)).reply.status).toBe(204)
    expect(rig.reports).toEqual([])
  })

  test('a listener that throws is reported and does not turn the signal into an error', async () => {
    const tileA = ownTile('tile-a', PID_A)
    const unsubscribe = subscribe(tileA.id, () => {
      throw new Error('listener failed')
    })

    const { reply } = await exchange(START, {}, PID_A)
    unsubscribe()

    expect(reply.status).toBe(204)
    expect(rig.reports).toEqual(['a turn signal listener of tile tile-a threw'])
  })
})

describe('where the endpoint exists', () => {
  test('it listens on the loopback address only, on the signal path', () => {
    expect(server.url).toBe(`http://127.0.0.1:${port}${TURN_SIGNAL_PATH}`)
    expect(port).toBeGreaterThan(0)
  })

  test('outside win32 nothing starts', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(await startTurnSignalServer({ platform, tiles: () => [], listProcesses: async () => [] }), platform).toBeNull()
    }
  })
})
