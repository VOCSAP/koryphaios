// Design endpoint (PLAN D2b): a loopback HTTP server, started by the Electron
// main process, that receives ELEMENT PICKS from external apps in design mode
// — a Tauri dev build, another Electron app, any webview-based UI running the
// deck-design client script (deck-plugin/design/deck-design.js).
//
// Why not the broker? The broker may live on a REMOTE, headless machine (HTTP
// mode); routing local, interactive design picks through it would add a WAN
// round-trip, force broker auth into target apps, and break its outbound-only
// Deck philosophy. Picks are a strictly local concern: target app and Deck run
// on the same PC, so the deck-control loopback pattern (C5) applies verbatim.
//
// Security model (same as deck-control.ts):
// - 127.0.0.1 only, random port, token minted per app launch. The pair is
//   handed out ONLY through the env of PTYs the Deck itself spawns
//   (CLAUDE_DECK_DESIGN_URL / CLAUDE_DECK_DESIGN_TOKEN), so an app launched
//   from a Deck session terminal inherits it; nothing is persisted.
// - Bodies are size-capped and shape-checked; the endpoint only ever forwards
//   a sanitized pick to the renderer, it exposes zero read/control surface.
//
// Dependency-free (node http/crypto only) so it stays unit-testable.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { DesignPickEvent, ElementPick } from '../shared/types'

export interface DesignEndpoint {
  url: string
  token: string
  close(): void
}

const MAX_BODY = 256 * 1024

/** CORS: the client script POSTs from arbitrary webview origins (fetch). */
function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-deck-token')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function str(v: unknown, cap: number): string {
  return typeof v === 'string' ? v.slice(0, cap) : ''
}

/** Coerce an untrusted body into a clean ElementPick; null when hopeless. */
export function sanitizePick(raw: unknown): ElementPick | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const tagName = str(p.tagName, 64)
  if (!tagName) return null
  const selectors = Array.isArray(p.selectors)
    ? p.selectors
        .filter((s): s is { type: string; value: string } => {
          const o = s as Record<string, unknown>
          return !!o && typeof o.type === 'string' && typeof o.value === 'string'
        })
        .slice(0, 8)
        .map((s) => ({
          type: (['qa', 'attr', 'id', 'css'].includes(s.type) ? s.type : 'css') as
            | 'qa'
            | 'attr'
            | 'id'
            | 'css',
          value: s.value.slice(0, 512)
        }))
    : []
  return {
    tagName,
    id: str(p.id, 128),
    classes: Array.isArray(p.classes) ? p.classes.filter((c) => typeof c === 'string').slice(0, 8) : [],
    text: str(p.text, 200),
    selectors,
    width: typeof p.width === 'number' && isFinite(p.width) ? Math.round(p.width) : 0,
    height: typeof p.height === 'number' && isFinite(p.height) ? Math.round(p.height) : 0,
    pageUrl: str(p.pageUrl, 1024)
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = ''
    let dead = false
    req.on('data', (chunk: Buffer) => {
      if (dead) return
      body += chunk.toString('utf8')
      if (body.length > MAX_BODY) {
        dead = true
        resolve(null)
      }
    })
    req.on('end', () => {
      if (!dead) resolve(body)
    })
    req.on('error', () => resolve(null))
  })
}

export function startDesignEndpoint(
  onPick: (event: DesignPickEvent) => void,
  opts: { port?: number } = {}
): Promise<DesignEndpoint> {
  const token = randomBytes(24).toString('hex')

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'OPTIONS') {
        cors(res)
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === 'GET' && req.url === '/design/health') {
        // Unauthenticated on purpose: lets a client script probe reachability
        // without holding the token; discloses nothing.
        json(res, 200, { ok: true })
        return
      }
      if (req.method !== 'POST' || req.url !== '/design/pick') {
        json(res, 404, { error: 'not found' })
        return
      }
      const auth = req.headers.authorization ?? ''
      const alt = req.headers['x-deck-token']
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : typeof alt === 'string' ? alt : ''
      if (presented !== token) {
        json(res, 401, { error: 'bad token' })
        return
      }
      const body = await readBody(req)
      if (body === null) {
        json(res, 413, { error: 'body too large' })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        json(res, 400, { error: 'invalid json' })
        return
      }
      const wrap = (parsed ?? {}) as Record<string, unknown>
      const pick = sanitizePick(wrap.pick)
      if (!pick) {
        json(res, 400, { error: 'invalid pick' })
        return
      }
      onPick({ source: str(wrap.source, 64), pick })
      json(res, 200, { ok: true })
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('design endpoint: no address'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        token,
        close: () => server.close()
      })
    })
  })
}
