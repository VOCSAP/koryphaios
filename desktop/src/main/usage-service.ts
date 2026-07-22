// Usage-limit gauges (usage modal): read the subscription quota meters of the
// installed frontier CLIs — the numbers their own `/usage` / `/status` screens
// show — so the operator sees how much runway each account has left without
// opening three terminals.
//
// Per-provider mechanism (recherche 2026-07, none is a public documented API —
// the endpoints are the ones each CLI itself calls, mirrored from the
// community trackers CodexBar / openusage / Claude-Code-Usage-Monitor):
// - claude:      GET api.anthropic.com/api/oauth/usage with the OAuth token
//                Claude Code maintains in ~/.claude/.credentials.json (macOS:
//                Keychain). Requires a `claude-code/<version>` User-Agent or
//                the endpoint rate-limits aggressively.
// - codex:       `codex app-server` JSON-RPC over stdio, method
//                account/rateLimits/read (typed schema shipped in the codex
//                repo). Fallback: the newest ~/.codex/sessions rollout file —
//                every turn persists a rate_limits snapshot (marked stale).
// - antigravity: POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
//                with the OAuth token the CLI keeps in the OS keyring
//                (service "gemini", account "antigravity"), refreshed via
//                oauth2.googleapis.com when expired. Buckets gemini-*/3p-*
//                carry remainingFraction + resetTime per 5h/weekly window.
//
// Gemini CLI is deliberately NOT a provider: Google cut individual-account
// service on 2026-06-18 (migrated to Antigravity); only org Code Assist seats
// still answer, and the operator asked for the Antigravity path instead.
//
// Design rules: tokens NEVER leave this module (reports carry percentages
// only); every network/spawn failure degrades to a per-provider status, the
// modal never throws; pure parsers are exported for the bun test suite and
// all effectful deps are injectable.

import { execFile, spawn } from 'node:child_process'
import { open, readFile, readdir } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { buildShellInvocation } from './shell-command'
import { buildDetectCommand } from './model-registry'
import { reportError } from './log'
import type {
  UsageCredits,
  UsageProviderId,
  UsageProviderReport,
  UsageSnapshot,
  UsageWindow
} from '../shared/types'

// ---------------------------------------------------------------------------
// Small shared helpers

const clampPct = (n: number): number => Math.min(100, Math.max(0, Math.round(n * 10) / 10))

/** Tolerant number reader (APIs drift between number and numeric string). */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Epoch ms from an ISO string or unix seconds/ms number; null when absent. */
function toEpochMs(v: unknown): number | null {
  const n = num(v)
  if (n !== null) return n > 1e12 ? n : n > 1e9 ? n * 1000 : null
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------
// Claude — api.anthropic.com/api/oauth/usage

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** Used when `claude --version` cannot be read; a plausible recent version. */
const CLAUDE_UA_FALLBACK = 'claude-code/2.1.90'

/** Parse the /api/oauth/usage response into gauges. Pure, exported for tests. */
export function parseClaudeUsage(json: unknown): {
  windows: UsageWindow[]
  credits: UsageCredits | null
} {
  const windows: UsageWindow[] = []
  let credits: UsageCredits | null = null
  if (!isRecord(json)) return { windows, credits }

  const block = (v: unknown): { usedPercent: number; resetsAt: number | null } | null => {
    if (!isRecord(v)) return null
    const pct = num(v.utilization)
    if (pct === null) return null
    return { usedPercent: clampPct(pct), resetsAt: toEpochMs(v.resets_at) }
  }

  const session = block(json.five_hour)
  if (session) windows.push({ key: 'session', label: null, ...session })
  const week = block(json.seven_day)
  if (week) windows.push({ key: 'week', label: null, ...week })
  // Per-model weekly blocks are plan/era-dependent (seven_day_opus today,
  // possibly other model names tomorrow) — accept any non-null seven_day_*.
  for (const [k, v] of Object.entries(json)) {
    const m = /^seven_day_(.+)$/.exec(k)
    if (!m) continue
    const b = block(v)
    if (!b) continue
    const name = m[1] ?? ''
    windows.push({ key: 'week-model', label: name.charAt(0).toUpperCase() + name.slice(1), ...b })
  }

  const extra = json.extra_usage
  if (isRecord(extra)) {
    credits = {
      enabled: extra.is_enabled === true,
      used: num(extra.used_credits),
      limit: num(extra.monthly_limit),
      utilization: num(extra.utilization)
    }
  }
  return { windows, credits }
}

/** Extract the OAuth access token from a .credentials.json blob (or null). */
export function parseClaudeCredentials(json: unknown): string | null {
  if (!isRecord(json)) return null
  const oauth = json.claudeAiOauth
  if (!isRecord(oauth)) return null
  const token = oauth.accessToken
  return typeof token === 'string' && token.length > 0 ? token : null
}

async function readClaudeToken(env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN
  if (typeof envToken === 'string' && envToken.length > 0) return envToken
  const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  try {
    const raw = await readFile(join(dir, '.credentials.json'), 'utf8')
    const token = parseClaudeCredentials(JSON.parse(raw))
    if (token) return token
  } catch {
    // Missing/invalid file is the normal signed-out state; macOS falls through
    // to the Keychain where Claude Code actually stores the credentials.
  }
  if (platform() === 'darwin') {
    try {
      const raw = await execFileText(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        10_000
      )
      return parseClaudeCredentials(JSON.parse(raw.trim()))
    } catch {
      return null // no Keychain entry = signed out; not an error
    }
  }
  return null
}

/** Session-lifetime cache: version probes spawn login shells. */
let claudeUaCache: string | null = null

async function claudeUserAgent(shell: string): Promise<string> {
  if (claudeUaCache) return claudeUaCache
  try {
    const inv = buildShellInvocation({ command: 'claude --version', shell, interactive: false })
    const out = await execFileText(inv.file, inv.args, 15_000)
    const m = /(\d+\.\d+\.\d+)/.exec(out)
    claudeUaCache = m ? `claude-code/${m[1]}` : CLAUDE_UA_FALLBACK
  } catch {
    claudeUaCache = CLAUDE_UA_FALLBACK // probe failure only degrades the UA
  }
  return claudeUaCache
}

async function readClaudeUsage(deps: Required<UsageDeps>): Promise<UsageProviderReport> {
  const base: UsageProviderReport = {
    provider: 'claude',
    status: 'error',
    plan: null,
    windows: [],
    credits: null,
    stale: false,
    error: null
  }
  const token = await readClaudeToken(deps.env, deps.home)
  if (!token) return { ...base, status: 'not-connected' }
  let res: Response
  try {
    res = await deps.fetchImpl(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': await deps.claudeUa(deps.shell)
      },
      signal: AbortSignal.timeout(10_000)
    })
  } catch (err) {
    deps.report('claude usage fetch failed', err)
    return { ...base, error: String((err as Error)?.message ?? err) }
  }
  if (res.status === 401 || res.status === 403) {
    // Expired token: Claude Code refreshes it itself when it runs.
    return { ...base, status: 'not-connected' }
  }
  if (!res.ok) {
    deps.report(`claude usage endpoint HTTP ${res.status}`)
    return { ...base, error: `HTTP ${res.status}` }
  }
  try {
    const parsed = parseClaudeUsage(await res.json())
    return { ...base, status: 'ok', ...parsed }
  } catch (err) {
    deps.report('claude usage parse failed', err)
    return { ...base, error: 'unexpected response shape' }
  }
}

// ---------------------------------------------------------------------------
// Codex — `codex app-server` JSON-RPC, fallback newest session rollout file

/** Read one RateLimitWindow-ish object in either camelCase or snake_case. */
function codexWindow(v: unknown, key: UsageWindow['key']): UsageWindow | null {
  if (!isRecord(v)) return null
  const pct = num(v.usedPercent ?? v.used_percent)
  if (pct === null) return null
  return {
    key,
    label: null,
    usedPercent: clampPct(pct),
    resetsAt: toEpochMs(v.resetsAt ?? v.resets_at ?? v.reset_at)
  }
}

/** Parse an account/rateLimits/read result. Pure, exported for tests. */
export function parseCodexRateLimits(result: unknown): {
  windows: UsageWindow[]
  plan: string | null
} {
  const windows: UsageWindow[] = []
  let plan: string | null = null
  const snap = isRecord(result)
    ? isRecord(result.rateLimits)
      ? result.rateLimits
      : isRecord(result.rate_limits)
        ? result.rate_limits
        : result
    : null
  if (!snap) return { windows, plan }
  const primary = codexWindow(snap.primary ?? snap.primary_window, 'session')
  if (primary) windows.push(primary)
  const secondary = codexWindow(snap.secondary ?? snap.secondary_window, 'week')
  if (secondary) windows.push(secondary)
  if (typeof snap.planType === 'string') plan = snap.planType
  else if (typeof snap.plan_type === 'string') plan = snap.plan_type
  else if (typeof snap.plan === 'string') plan = snap.plan
  return { windows, plan }
}

/**
 * Scan a session rollout file's text (newest last) for the latest token_count
 * event carrying a rate_limits snapshot. Pure, exported for tests.
 */
export function parseCodexSessionText(text: string): {
  windows: UsageWindow[]
  plan: string | null
} | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"rate_limits"')) continue
    try {
      const row: unknown = JSON.parse(line)
      if (!isRecord(row)) continue
      const payload = isRecord(row.payload) ? row.payload : row
      const rl = payload.rate_limits ?? payload.rateLimits
      if (!isRecord(rl)) continue
      const parsed = parseCodexRateLimits({ rateLimits: rl })
      if (parsed.windows.length > 0) return parsed
    } catch {
      continue // truncated tail line of a live session file — keep scanning up
    }
  }
  return null
}

/** Newest rollout file under sessions/YYYY/MM/DD (names sort lexically). */
async function newestCodexSessionFile(root: string): Promise<string | null> {
  const newestDir = async (dir: string): Promise<string | null> => {
    try {
      const entries = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name)
        .sort()
      const last = entries[entries.length - 1]
      return last ? join(dir, last) : null
    } catch {
      return null // no sessions dir = codex never ran; normal state
    }
  }
  let dir: string | null = root
  for (let depth = 0; depth < 3 && dir; depth++) dir = await newestDir(dir)
  if (!dir) return null
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort()
    const last = files[files.length - 1]
    return last ? join(dir, last) : null
  } catch {
    return null
  }
}

/**
 * One-shot JSON-RPC exchange with `codex app-server` over stdio: initialize,
 * initialized, account/rateLimits/read, kill. Rejects on timeout/exit.
 */
function runCodexAppServer(shell: string, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const inv = buildShellInvocation({ command: 'codex app-server', shell, interactive: false })
    const child = spawn(inv.file, inv.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdin = child.stdin
    const stdout = child.stdout
    if (!stdin || !stdout) {
      reject(new Error('codex app-server: no stdio pipes'))
      return
    }
    let buf = ''
    let settled = false
    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // already gone — the exchange is over either way
      }
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('codex app-server timeout')), timeoutMs)
    const send = (msg: Record<string, unknown>): void => {
      stdin.write(`${JSON.stringify(msg)}\n`)
    }
    child.on('error', (err) => finish(err))
    child.on('exit', () => finish(new Error('codex app-server exited early')))
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          continue // banners/log noise on stdout are expected, skip them
        }
        if (!isRecord(msg)) continue
        if (msg.id === 1) {
          if (isRecord(msg.error)) {
            finish(new Error(`initialize rejected: ${String(msg.error.message ?? '')}`))
            return
          }
          send({ jsonrpc: '2.0', method: 'initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })
        } else if (msg.id === 2) {
          if (isRecord(msg.error)) finish(new Error(String(msg.error.message ?? 'rpc error')))
          else finish(null, msg.result)
          return
        }
      }
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'koryphaios', title: 'Koryphaios', version: '1.0' } }
    })
  })
}

async function readCodexUsage(deps: Required<UsageDeps>): Promise<UsageProviderReport> {
  const base: UsageProviderReport = {
    provider: 'codex',
    status: 'error',
    plan: null,
    windows: [],
    credits: null,
    stale: false,
    error: null
  }
  const codexHome = deps.env.CODEX_HOME || join(deps.home, '.codex')
  let connected = true
  try {
    await readFile(join(codexHome, 'auth.json'), 'utf8')
  } catch {
    connected = false // signed-out state; the app-server would fail anyway
  }
  if (!connected) return { ...base, status: 'not-connected' }
  try {
    const result = await deps.runCodexRpc(deps.shell)
    const parsed = parseCodexRateLimits(result)
    if (parsed.windows.length > 0) return { ...base, status: 'ok', ...parsed }
  } catch (err) {
    deps.report('codex app-server rate-limits read failed', err)
  }
  // Fallback: last persisted snapshot from the newest session rollout.
  try {
    const file = await newestCodexSessionFile(join(codexHome, 'sessions'))
    if (file) {
      const text = await readFile(file, 'utf8')
      const parsed = parseCodexSessionText(text)
      if (parsed) return { ...base, status: 'ok', stale: true, ...parsed }
    }
  } catch (err) {
    deps.report('codex session-file fallback failed', err)
  }
  return { ...base, error: 'app-server unreachable, no local snapshot' }
}

// ---------------------------------------------------------------------------
// Antigravity — cloudcode-pa retrieveUserQuotaSummary (openusage mechanism)

const ANTIGRAVITY_QUOTA_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// The CLI's public installed-app OAuth client id (an identifier, not a
// secret); Google may rotate it — the refresh then degrades gracefully.
const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

/**
 * The matching client "secret" is NOT embedded here: even though Google ships
 * it in every Antigravity install (installed-app flow — it is not actually
 * confidential), committing the literal trips GitHub secret scanning. It is
 * read at runtime instead: KORY_ANTIGRAVITY_CLIENT_SECRET env override, else
 * extracted from the local `agy` binary the way community trackers do. When
 * neither works the token refresh is skipped and the stored access token is
 * used as-is (Antigravity itself refreshes the keyring while it runs).
 */
export function findGoogleClientSecret(text: string): string | null {
  const m = /GOCSPX-[A-Za-z0-9_-]{10,60}/.exec(text)
  return m ? m[0] : null
}

/** undefined = not probed yet; null = probed, nothing found (session cache). */
let antigravitySecretCache: string | null | undefined

async function antigravityClientSecret(deps: Required<UsageDeps>): Promise<string | null> {
  const override = deps.env.KORY_ANTIGRAVITY_CLIENT_SECRET
  if (typeof override === 'string' && override.length > 0) return override
  if (antigravitySecretCache !== undefined) return antigravitySecretCache
  antigravitySecretCache = null
  if (platform() === 'win32') return null // no `command -v` path resolution
  try {
    const inv = buildShellInvocation({ command: 'command -v agy', shell: deps.shell, interactive: false })
    const binPath = (await execFileText(inv.file, inv.args, 15_000)).trim().split('\n')[0]
    if (!binPath) return null
    // Chunked scan (the Go binary weighs tens of MB); overlap keeps a match
    // that straddles a chunk boundary detectable.
    const fh = await open(binPath, 'r')
    try {
      const chunk = Buffer.alloc(8 * 1024 * 1024)
      let carry = ''
      for (;;) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, null)
        if (bytesRead <= 0) break
        const text = carry + chunk.subarray(0, bytesRead).toString('latin1')
        const found = findGoogleClientSecret(text)
        if (found) {
          antigravitySecretCache = found
          return found
        }
        carry = text.slice(-80)
      }
    } finally {
      await fh.close()
    }
  } catch (err) {
    deps.report('antigravity client-secret extraction failed (refresh disabled)', err)
  }
  return antigravitySecretCache
}

/** Map a bucketId (gemini-5h / 3p-weekly…) to a window key + pool label. */
export function antigravityBucketMeta(
  bucketId: string
): { key: UsageWindow['key']; label: string } | null {
  const m = /^(gemini|3p)-(5h|weekly)$/.exec(bucketId)
  if (!m) return null
  return {
    key: m[2] === '5h' ? 'session' : 'week',
    label: m[1] === 'gemini' ? 'Gemini' : '3p'
  }
}

/** Parse a retrieveUserQuotaSummary response. Pure, exported for tests. */
export function parseAntigravityQuota(json: unknown): { windows: UsageWindow[] } {
  const windows: UsageWindow[] = []
  const root = isRecord(json) && isRecord(json.response) ? json.response : json
  if (!isRecord(root)) return { windows }
  const groups = Array.isArray(root.groups) ? root.groups : [root]
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || typeof bucket.bucketId !== 'string') continue
      const meta = antigravityBucketMeta(bucket.bucketId)
      const remaining = num(bucket.remainingFraction)
      if (!meta || remaining === null) continue
      windows.push({
        ...meta,
        usedPercent: clampPct((1 - remaining) * 100),
        resetsAt: toEpochMs(bucket.resetTime)
      })
    }
  }
  // Stable display order: session gauges first, Gemini pool before 3p.
  const rank = (w: UsageWindow): number =>
    (w.key === 'session' ? 0 : 2) + (w.label === 'Gemini' ? 0 : 1)
  windows.sort((a, b) => rank(a) - rank(b))
  return { windows }
}

export interface AntigravityToken {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms, or null when the blob had no usable expiry. */
  expiresAt: number | null
}

/** Parse the go-keyring blob (raw or base64-wrapped JSON). Exported for tests. */
export function parseAntigravityKeyring(raw: string): AntigravityToken | null {
  let text = raw.trim()
  const prefixed = /^go-keyring-base64:(.*)$/s.exec(text)
  if (prefixed) text = Buffer.from(prefixed[1] ?? '', 'base64').toString('utf8')
  else if (!text.startsWith('{')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8')
      if (decoded.trim().startsWith('{')) text = decoded
    } catch {
      // not base64 either — fall through to the JSON.parse failure below
    }
  }
  try {
    const json: unknown = JSON.parse(text)
    if (!isRecord(json)) return null
    const tok = isRecord(json.token) ? json.token : json
    const access = tok.access_token ?? tok.accessToken ?? tok.bearerToken ?? tok.id_token
    if (typeof access !== 'string' || access.length === 0) return null
    const refresh = tok.refresh_token ?? tok.refreshToken
    return {
      accessToken: access,
      refreshToken: typeof refresh === 'string' && refresh.length > 0 ? refresh : null,
      expiresAt: toEpochMs(tok.expiry ?? tok.expires_at ?? tok.expiresAt)
    }
  } catch {
    return null
  }
}

/** Read the Antigravity OAuth blob from the OS keyring (null = signed out). */
async function readAntigravityKeyring(): Promise<AntigravityToken | null> {
  const plat = platform()
  try {
    if (plat === 'darwin') {
      const raw = await execFileText(
        'security',
        ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
        10_000
      )
      return parseAntigravityKeyring(raw)
    }
    if (plat === 'linux') {
      // go-keyring stores through libsecret with service/username attributes.
      const raw = await execFileText(
        'secret-tool',
        ['lookup', 'service', 'gemini', 'username', 'antigravity'],
        10_000
      )
      return parseAntigravityKeyring(raw)
    }
  } catch {
    return null // keyring tool missing or entry absent = signed out
  }
  // Windows Credential Manager has no scriptable read; treat as signed out.
  return null
}

/** Refreshed access tokens live ~1h; keep them in memory only, never on disk. */
let antigravityRefreshed: { accessToken: string; expiresAt: number } | null = null

async function antigravityAccessToken(
  deps: Required<UsageDeps>
): Promise<string | null> {
  const now = deps.now()
  if (antigravityRefreshed && antigravityRefreshed.expiresAt - now > 60_000) {
    return antigravityRefreshed.accessToken
  }
  const stored = await readAntigravityKeyring()
  if (!stored) return null
  if (stored.expiresAt === null || stored.expiresAt - now > 60_000) return stored.accessToken
  if (!stored.refreshToken) return stored.accessToken // try it anyway; 401 degrades
  const clientSecret = await antigravityClientSecret(deps)
  if (!clientSecret) return stored.accessToken // refresh impossible; 401 degrades
  try {
    const res = await deps.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: clientSecret
      }).toString(),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) {
      deps.report(`antigravity token refresh HTTP ${res.status}`)
      return stored.accessToken
    }
    const json: unknown = await res.json()
    if (isRecord(json) && typeof json.access_token === 'string') {
      const ttl = num(json.expires_in) ?? 3600
      antigravityRefreshed = {
        accessToken: json.access_token,
        expiresAt: now + ttl * 1000
      }
      return antigravityRefreshed.accessToken
    }
  } catch (err) {
    deps.report('antigravity token refresh failed', err)
  }
  return stored.accessToken
}

async function readAntigravityUsage(deps: Required<UsageDeps>): Promise<UsageProviderReport> {
  const base: UsageProviderReport = {
    provider: 'antigravity',
    status: 'error',
    plan: null,
    windows: [],
    credits: null,
    stale: false,
    error: null
  }
  const token = await antigravityAccessToken(deps)
  if (!token) return { ...base, status: 'not-connected' }
  try {
    const res = await deps.fetchImpl(ANTIGRAVITY_QUOTA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'antigravity'
      },
      body: '{}',
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 401 || res.status === 403) return { ...base, status: 'not-connected' }
    if (!res.ok) {
      deps.report(`antigravity quota endpoint HTTP ${res.status}`)
      return { ...base, error: `HTTP ${res.status}` }
    }
    const parsed = parseAntigravityQuota(await res.json())
    if (parsed.windows.length === 0) return { ...base, error: 'no quota buckets in response' }
    return { ...base, status: 'ok', ...parsed }
  } catch (err) {
    deps.report('antigravity quota fetch failed', err)
    return { ...base, error: String((err as Error)?.message ?? err) }
  }
}

// ---------------------------------------------------------------------------
// Used-provider tracking (amphora gauge): the rail icon's fill level averages
// the REMAINING session quota of the providers this app run actually drew
// down — inference engines mark their targets here, and live Claude tiles are
// folded in at snapshot time (liveClis dep). Session-lifetime, in-memory.

const usedProviders = new Set<UsageProviderId>()

/** Record that an inference ran through `cli` (unknown/local clis ignored). */
export function markProviderUsed(cli: string): void {
  if (cli === 'claude' || cli === 'codex' || cli === 'antigravity') usedProviders.add(cli)
}

// ---------------------------------------------------------------------------
// Orchestration: detection, cache, snapshot

export interface UsageDeps {
  shell: string
  home?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  /** Injectable binary probe (defaults to the login-shell `command -v`). */
  probe?: (bin: string, shell: string) => Promise<boolean>
  /** Injectable codex JSON-RPC runner. */
  runCodexRpc?: (shell: string) => Promise<unknown>
  /** Injectable Claude User-Agent resolver (defaults to `claude --version`). */
  claudeUa?: (shell: string) => Promise<string>
  report?: (msg: string, err?: unknown) => void
  now?: () => number
  /** CLIs of the LIVE session tiles (today always 'claude'), for the gauge. */
  liveClis?: () => string[]
}

/** Binaries probed per provider ('agy' is the Antigravity CLI). */
export const USAGE_BINS: { provider: UsageProviderId; bin: string }[] = [
  { provider: 'claude', bin: 'claude' },
  { provider: 'codex', bin: 'codex' },
  { provider: 'antigravity', bin: 'agy' }
]

function execFileText(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function probeBin(bin: string, shell: string): Promise<boolean> {
  const inv = buildShellInvocation({ command: buildDetectCommand(bin), shell, interactive: false })
  return execFileText(inv.file, inv.args, 15_000).then(
    () => true,
    () => false
  )
}

const CACHE_MS = 3 * 60_000
let snapshotCache: { at: number; snapshot: UsageSnapshot } | null = null
/** Session-lifetime probe cache (same trade-off as model-registry). */
let binCache: Record<UsageProviderId, boolean> | null = null

function fill(deps: UsageDeps): Required<UsageDeps> {
  return {
    shell: deps.shell,
    home: deps.home ?? homedir(),
    env: deps.env ?? process.env,
    fetchImpl: deps.fetchImpl ?? fetch,
    probe: deps.probe ?? probeBin,
    runCodexRpc: deps.runCodexRpc ?? runCodexAppServer,
    claudeUa: deps.claudeUa ?? claudeUserAgent,
    report: deps.report ?? ((msg, err) => reportError('usage', msg, err)),
    now: deps.now ?? Date.now,
    liveClis: deps.liveClis ?? (() => [])
  }
}

/** Union of the marked inference targets and the live tiles' CLIs. */
function currentUsedProviders(deps: Required<UsageDeps>): UsageProviderId[] {
  const all = new Set(usedProviders)
  for (const cli of deps.liveClis()) {
    if (cli === 'claude' || cli === 'codex' || cli === 'antigravity') all.add(cli)
  }
  return [...all]
}

/**
 * Snapshot of every detected provider's gauges. Cached for 3 min (the Claude
 * endpoint rate-limits sub-3-min polling); `refresh` bypasses the cache and
 * re-probes the binaries.
 */
export async function readUsage(
  rawDeps: UsageDeps,
  opts: { refresh?: boolean } = {}
): Promise<UsageSnapshot> {
  const deps = fill(rawDeps)
  const now = deps.now()
  if (!opts.refresh && snapshotCache && now - snapshotCache.at < CACHE_MS) {
    // usedProviders may have grown since the cached fetch — recompose it.
    return { ...snapshotCache.snapshot, usedProviders: currentUsedProviders(deps) }
  }
  if (!binCache || opts.refresh) {
    const results = await Promise.all(USAGE_BINS.map(({ bin }) => deps.probe(bin, deps.shell)))
    binCache = { claude: false, codex: false, antigravity: false }
    USAGE_BINS.forEach(({ provider }, i) => {
      ;(binCache as Record<UsageProviderId, boolean>)[provider] = !!results[i]
    })
  }
  const readers: Record<
    UsageProviderId,
    (d: Required<UsageDeps>) => Promise<UsageProviderReport>
  > = {
    claude: readClaudeUsage,
    codex: readCodexUsage,
    antigravity: readAntigravityUsage
  }
  const active = USAGE_BINS.filter(({ provider }) => binCache?.[provider])
  const providers = await Promise.all(active.map(({ provider }) => readers[provider](deps)))
  const snapshot: UsageSnapshot = {
    fetchedAt: deps.now(),
    providers,
    usedProviders: currentUsedProviders(deps)
  }
  snapshotCache = { at: now, snapshot }
  return snapshot
}

/** Test seam: drop every module-level cache. */
export function resetUsageCaches(): void {
  snapshotCache = null
  binCache = null
  claudeUaCache = null
  antigravityRefreshed = null
  antigravitySecretCache = undefined
  usedProviders.clear()
}
