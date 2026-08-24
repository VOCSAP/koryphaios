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
import type { DesignPickEvent, ElementPick, ElementSelector } from '../shared/types'
import {
  containsSecret,
  isAriaAttributeName,
  PICK_ATTRIBUTE_ALLOWLIST,
  PICK_BUDGET,
  sanitizePickUrl
} from '../shared/pick-security'

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

/** Redact a string in place if it matches a secret pattern; otherwise pass through. */
function redactIfSecret(v: string): string {
  return containsSecret(v) ? '[redacted]' : v
}

/** Coerce an untrusted attributes-shaped value: allowlist, cap, redact, sanitize URLs. */
function sanitizeAttributes(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= PICK_BUDGET.attributesMaxEntries) break
    if (typeof value !== 'string') continue
    if (!PICK_ATTRIBUTE_ALLOWLIST.includes(name) && !isAriaAttributeName(name)) continue
    if (containsSecret(value)) {
      out[name] = '[redacted]'
      continue
    }
    if (name === 'href' || name === 'src') {
      const sanitized = sanitizePickUrl(value)
      if (!sanitized) continue // drop rather than emit an empty href/src
      out[name] = sanitized
      continue
    }
    out[name] = value.slice(0, PICK_BUDGET.attributeValueMaxLength)
  }
  return Object.keys(out).length ? out : undefined
}

/** Coerce an untrusted styles-shaped value: cap entries and value length, redact secrets. */
function sanitizeStyles(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= PICK_BUDGET.stylesMaxEntries) break
    if (typeof value !== 'string') continue
    // Keys are attacker-controlled too (no allowlist here, unlike attributes):
    // an oversized key would ride into the prompt uncapped. Drop, don't slice --
    // a truncated CSS property name is noise, not signal.
    if (!name || name.length > PICK_BUDGET.styleNameMaxLength) continue
    out[name] = redactIfSecret(value).slice(0, PICK_BUDGET.styleValueMaxLength)
  }
  return Object.keys(out).length ? out : undefined
}

/** Coerce an untrusted array-of-strings value: cap entry count and length, skip secret entries. */
function sanitizeStringArray(raw: unknown, maxEntries: number, entryCap: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (out.length >= maxEntries) break
    if (typeof item !== 'string') continue
    const v = item.slice(0, entryCap)
    if (!v || containsSecret(v)) continue
    out.push(v)
  }
  return out.length ? out : undefined
}

/** Coerce an untrusted body into a clean ElementPick; null when hopeless. */
export function sanitizePick(raw: unknown): ElementPick | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const tagName = str(p.tagName, 64)
  if (!tagName) return null
  const selectors: ElementSelector[] = Array.isArray(p.selectors)
    ? p.selectors
        .filter((s): s is { type: string; value: string } => {
          const o = s as Record<string, unknown>
          return !!o && typeof o.type === 'string' && typeof o.value === 'string'
        })
        .slice(0, PICK_BUDGET.selectorsMaxEntries)
        .map((s) => ({
          type: (['qa', 'attr', 'id', 'css'].includes(s.type) ? s.type : 'css') as
            | 'qa'
            | 'attr'
            | 'id'
            | 'css',
          value: s.value.slice(0, PICK_BUDGET.selectorValueMaxLength)
        }))
        .filter((s) => !containsSecret(s.value))
    : []

  const rawId = str(p.id, PICK_BUDGET.idMaxLength)
  const id = rawId && !containsSecret(rawId) ? rawId : ''
  const rawText = str(p.text, PICK_BUDGET.textMaxLength)
  const text = rawText && containsSecret(rawText) ? '[redacted]' : rawText

  const pick: ElementPick = {
    tagName,
    id,
    classes: Array.isArray(p.classes)
      ? p.classes.filter((c) => typeof c === 'string').slice(0, PICK_BUDGET.classesMaxEntries)
      : [],
    text,
    selectors,
    width: typeof p.width === 'number' && isFinite(p.width) ? Math.round(p.width) : 0,
    height: typeof p.height === 'number' && isFinite(p.height) ? Math.round(p.height) : 0,
    pageUrl: typeof p.pageUrl === 'string' ? sanitizePickUrl(p.pageUrl.slice(0, PICK_BUDGET.pageUrlMaxLength)) : ''
  }

  // ----- Optional OD1 fields: absent on the untrusted body stays absent on
  // the sanitized pick (never defaulted to '' / {} / []), so an older
  // deck-design.js bundle that never sent them behaves exactly as before.
  if (typeof p.x === 'number' && isFinite(p.x)) pick.x = Math.round(p.x)
  if (typeof p.y === 'number' && isFinite(p.y)) pick.y = Math.round(p.y)
  if (typeof p.isFixed === 'boolean') pick.isFixed = p.isFixed
  if (typeof p.role === 'string' && p.role) pick.role = redactIfSecret(p.role.slice(0, PICK_BUDGET.roleMaxLength))
  if (typeof p.accessibleName === 'string' && p.accessibleName) {
    pick.accessibleName = redactIfSecret(p.accessibleName.slice(0, PICK_BUDGET.accessibleNameMaxLength))
  }
  const attributes = sanitizeAttributes(p.attributes)
  if (attributes) pick.attributes = attributes
  const styles = sanitizeStyles(p.styles)
  if (styles) pick.styles = styles
  if (typeof p.html === 'string' && p.html) {
    const truncated = p.html.length > PICK_BUDGET.htmlMaxLength
    const html = truncated ? p.html.slice(0, PICK_BUDGET.htmlMaxLength) + ' …' : p.html
    if (!containsSecret(html)) pick.html = html
  }
  const nearbyText = sanitizeStringArray(p.nearbyText, PICK_BUDGET.nearbyTextMaxEntries, PICK_BUDGET.nearbyTextEntryMaxLength)
  if (nearbyText) pick.nearbyText = nearbyText
  const ancestors = sanitizeStringArray(p.ancestors, PICK_BUDGET.ancestorsMaxEntries, PICK_BUDGET.ancestorEntryMaxLength)
  if (ancestors) pick.ancestors = ancestors

  // ----- OD3 fields (React dev metadata): a redacted path helps nobody, so a
  // secret-bearing sourceFile is dropped entirely rather than kept as
  // '[redacted]' -- unlike role/accessibleName/attributes/styles above, which
  // still carry useful signal even redacted.
  if (typeof p.reactComponents === 'string' && p.reactComponents) {
    const reactComponents = p.reactComponents.slice(0, PICK_BUDGET.reactComponentsMaxLength)
    if (!containsSecret(reactComponents)) pick.reactComponents = reactComponents
  }
  if (typeof p.sourceFile === 'string' && p.sourceFile) {
    const sourceFile = p.sourceFile.slice(0, PICK_BUDGET.sourceFileMaxLength)
    if (!containsSecret(sourceFile)) pick.sourceFile = sourceFile
  }

  return pick
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
