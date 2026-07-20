// Companion server (PLAN MB1/MB2): HTTPS + WebSocket endpoint started by the
// Electron main process ON EXPLICIT OPERATOR ACTION (the 📱 Compagnon button),
// serving the built renderer bundle to a phone on the SAME LAN and bridging
// the DeckApi protocol over WS (shared/companion.ts).
//
// Security model (EXPLORATION-mobile-lan §5.1/§5.5 — ephemeral session mode):
// - Off by default; nothing survives the process (closing the app revokes).
// - One-shot pairing token in the QR, exchanged for a per-run credential.
// - LAN only: bound to the detected private interface AND every peer address
//   is checked against isPrivateAddress (RFC1918/ULA static filter).
// - TLS with a STABLE self-signed cert persisted under app state (the browser
//   warning happens once, not at every app launch).
// - Anti-bruteforce lockout per address; every connect/deny hits the journal.

import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, WebSocket } from 'ws'
import type { Duplex } from 'node:stream'
import {
  CompanionAuth,
  COMPANION_HEARTBEAT_MS,
  LIGHT_MODE_BLOCKED_EVENTS,
  REMOTE_BLOCKED_CHANNELS,
  isPrivateAddress,
  parseClientFrame,
  type CompanionInfo,
  type CompanionServerFrame
} from '../shared/companion'
import { invokeRemote, sendRemote, addEventSink } from './api-registry'
import { reportError } from './log'
import { generate as generateCert } from 'selfsigned'

export interface CompanionDeps {
  /** Directory of the built renderer bundle (index.html + assets). */
  staticDir: string
  /** Directory for the persisted TLS material. */
  stateDir: string
  /** Activity journal hook (kind fixed to 'session' by the caller). */
  journal: (msg: string) => void
  /** Called whenever the public status changes (start/stop/clients). */
  onStatus: (info: CompanionInfo) => void
}

interface ClientCtx {
  ws: WebSocket
  addr: string
  authed: boolean
  mode: 'full' | 'light'
  removeSink: (() => void) | null
  alive: boolean
  /** Per-client backpressure latch: true while dropping pty:data for this
   * client, so the overflow is logged once per episode and re-logged after
   * the buffer recovers (not muted server-wide by the first slow client). */
  overflowing: boolean
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json'
}

/** Backpressure cap per client: beyond this, pty:data frames are dropped. */
const MAX_BUFFERED = 4 * 1024 * 1024

/** First non-internal private IPv4 of the host (the LAN address to bind). */
export function detectLanAddress(): string | null {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal && isPrivateAddress(net.address)) {
        return net.address
      }
    }
  }
  return null
}

/** Load-or-create the persisted self-signed cert (EXPLORATION §5.5: STABLE
 * across launches even though tokens are ephemeral). */
async function loadOrCreateCert(stateDir: string): Promise<{ key: string; cert: string }> {
  const file = join(stateDir, 'companion-cert.json')
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { key?: string; cert?: string }
      if (parsed.key && parsed.cert) return { key: parsed.key, cert: parsed.cert }
    }
  } catch (err) {
    reportError('companion', 'persisted cert unreadable — regenerating', err)
  }
  const pems = await generateCert([{ name: 'commonName', value: 'koryphaios-companion' }], {
    keySize: 2048
  })
  const material = { key: pems.private, cert: pems.cert }
  try {
    writeFileSync(file, JSON.stringify(material), { mode: 0o600 })
  } catch (err) {
    // Non-fatal: the server still runs, the browser warning just repeats
    // next launch. Trace it (no-silent-errors rule).
    reportError('companion', 'cert persistence failed', err)
  }
  return material
}

export class CompanionServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<ClientCtx>()
  private auth = new CompanionAuth()
  private hbTimer: NodeJS.Timeout | null = null
  private url: string | null = null
  private pairingToken: string | null = null

  constructor(private readonly deps: CompanionDeps) {}

  get info(): CompanionInfo {
    return {
      running: this.server !== null,
      url: this.url,
      pairingToken: this.pairingToken,
      clients: [...this.clients].filter((c) => c.authed).length
    }
  }

  /** Start (or restart with a fresh token). Throws with an operator-readable
   * message when the environment cannot serve (no LAN, no built bundle). */
  async start(): Promise<CompanionInfo> {
    await this.stop(true)
    if (!existsSync(join(this.deps.staticDir, 'index.html'))) {
      throw new Error(`renderer bundle not found (${this.deps.staticDir}) — run a build first`)
    }
    const lanAddr = detectLanAddress()
    if (!lanAddr) throw new Error('no private LAN interface detected')
    const { key, cert } = await loadOrCreateCert(this.deps.stateDir)

    const server = createServer({ key, cert }, (req, res) => this.serveStatic(req, res))
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const addr = req.socket.remoteAddress ?? ''
      if (!isPrivateAddress(addr) || this.auth.isLocked(addr)) {
        this.deps.journal(`companion: upgrade refused from ${addr || '?'}`)
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, addr))
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, lanAddr, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    this.server = server
    this.wss = wss
    this.url = `https://${lanAddr}:${port}`
    this.pairingToken = randomBytes(32).toString('base64url')
    this.auth.arm(this.pairingToken)
    this.hbTimer = setInterval(() => this.heartbeat(), COMPANION_HEARTBEAT_MS)
    this.deps.journal(`companion server started on ${this.url}`)
    this.deps.onStatus(this.info)
    return this.info
  }

  /** Stop and revoke everything (ephemeral mode: nothing survives). */
  async stop(silent = false): Promise<void> {
    if (!this.server) return
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = null
    for (const c of this.clients) {
      c.removeSink?.()
      try {
        c.ws.close(1001, 'host stopping')
      } catch {
        c.ws.terminate()
      }
    }
    this.clients.clear()
    this.auth.disarm()
    const server = this.server
    const wss = this.wss
    this.server = null
    this.wss = null
    this.url = null
    this.pairingToken = null
    await new Promise<void>((resolve) => {
      wss?.close(() => server.close(() => resolve()))
      // A lingering keep-alive socket must not wedge shutdown.
      setTimeout(resolve, 1500)
    })
    if (!silent) {
      this.deps.journal('companion server stopped')
      this.deps.onStatus(this.info)
    }
  }

  // ----- websocket lifecycle -----

  private attach(ws: WebSocket, addr: string): void {
    const ctx: ClientCtx = {
      ws,
      addr,
      authed: false,
      mode: 'full',
      removeSink: null,
      alive: true,
      overflowing: false
    }
    this.clients.add(ctx)
    // Unauthenticated sockets get 5 s to present a hello.
    const authDeadline = setTimeout(() => {
      if (!ctx.authed) ws.close(4401, 'auth timeout')
    }, 5_000)
    ws.on('pong', () => {
      ctx.alive = true
    })
    ws.on('message', (data) => {
      const frame = parseClientFrame(typeof data === 'string' ? data : data.toString('utf8'))
      if (!frame) return
      if (!ctx.authed) {
        if (frame.t !== 'hello') {
          ws.close(4401, 'hello required')
          return
        }
        const verdict = this.auth.hello(addr, frame, () => randomBytes(32).toString('base64url'))
        if (verdict.result === 'denied') {
          this.deps.journal(`companion: auth denied for ${addr}`)
          ws.close(4401, 'denied')
          return
        }
        clearTimeout(authDeadline)
        ctx.authed = true
        if (verdict.result === 'paired') {
          // Single-use token consumed — the QR is now dead.
          this.pairingToken = null
          this.send(ctx, { t: 'welcome', cred: verdict.cred })
          this.deps.journal(`companion: device paired from ${addr}`)
        } else {
          this.send(ctx, { t: 'welcome', cred: '' })
          this.deps.journal(`companion: device resumed from ${addr}`)
        }
        ctx.removeSink = addEventSink((channel, payload) => this.forward(ctx, channel, payload))
        this.deps.onStatus(this.info)
        return
      }
      this.dispatch(ctx, frame)
    })
    ws.on('close', () => {
      clearTimeout(authDeadline)
      ctx.removeSink?.()
      this.clients.delete(ctx)
      if (ctx.authed) {
        this.deps.journal(`companion: device disconnected (${addr})`)
        this.deps.onStatus(this.info)
      }
    })
    ws.on('error', (err) => reportError('companion', `ws error (${addr})`, err))
  }

  private dispatch(
    ctx: ClientCtx,
    frame: Exclude<ReturnType<typeof parseClientFrame>, null>
  ): void {
    switch (frame.t) {
      case 'req': {
        if (REMOTE_BLOCKED_CHANNELS.has(frame.ch)) {
          this.send(ctx, { t: 'res', id: frame.id, ok: false, error: 'remote-blocked' })
          return
        }
        invokeRemote(frame.ch, frame.args).then(
          (value) => this.send(ctx, { t: 'res', id: frame.id, ok: true, value }),
          (err: unknown) =>
            this.send(ctx, {
              t: 'res',
              id: frame.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
        )
        return
      }
      case 'send':
        if (!REMOTE_BLOCKED_CHANNELS.has(frame.ch)) sendRemote(frame.ch, frame.args)
        return
      case 'mode':
        ctx.mode = frame.mode
        return
      case 'hello':
        return // already authed; ignore
    }
  }

  private forward(ctx: ClientCtx, channel: string, payload: unknown): void {
    if (ctx.mode === 'light' && LIGHT_MODE_BLOCKED_EVENTS.has(channel)) return
    if (channel === 'pty:data' && ctx.ws.bufferedAmount > MAX_BUFFERED) {
      // Backpressure guard (MB5): drop terminal stream frames rather than
      // ballooning memory. Latched per-client, logged once per episode.
      if (!ctx.overflowing) {
        ctx.overflowing = true
        reportError('companion', `client ${ctx.addr} slow — dropping pty:data frames`)
      }
      return
    }
    // Buffer recovered for this client: allow the next episode to log again.
    if (ctx.overflowing) ctx.overflowing = false
    this.send(ctx, { t: 'ev', ch: channel, payload })
  }

  private send(ctx: ClientCtx, frame: CompanionServerFrame): void {
    if (ctx.ws.readyState !== WebSocket.OPEN) return
    try {
      ctx.ws.send(JSON.stringify(frame))
    } catch (err) {
      reportError('companion', 'ws send failed', err)
    }
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate()
        continue
      }
      c.alive = false
      try {
        c.ws.ping()
      } catch {
        c.ws.terminate()
      }
      if (c.authed) this.send(c, { t: 'hb' })
    }
  }

  // ----- static bundle -----

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const addr = req.socket.remoteAddress ?? ''
    if (!isPrivateAddress(addr)) {
      res.writeHead(403).end()
      return
    }
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/'
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    const root = normalize(this.deps.staticDir)
    const path = normalize(join(this.deps.staticDir, rel))
    // Containment check WITH the trailing separator: a bare startsWith(root)
    // would also accept a sibling dir sharing the prefix (out/renderer-x). No
    // such sibling exists today, but the separator makes the guard correct
    // regardless of the packaged layout.
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403).end()
      return
    }
    try {
      const body = readFileSync(path)
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      })
      res.end(body)
    } catch {
      // SPA fallback: unknown paths get the shell (hash routing only today).
      try {
        const index = readFileSync(join(this.deps.staticDir, 'index.html'))
        res.writeHead(200, { 'content-type': CONTENT_TYPES['.html'], 'cache-control': 'no-store' })
        res.end(index)
      } catch (err) {
        reportError('companion', `static serve failed for ${rel}`, err)
        res.writeHead(404).end()
      }
    }
  }
}
