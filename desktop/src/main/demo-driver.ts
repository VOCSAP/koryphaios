import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import { createBrowserDriver } from './browser-drive'
import { startDemoControl } from './demo-control'

/**
 * Everything denied: the demo agent acts through its MCP tools only. The
 * utility read-only harness keeps Read/Grep/Glob; here even reading the
 * project is out of scope for an agent whose job is clicking a web page.
 */
export const DEMO_DISALLOWED_TOOLS =
  'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Grep,Glob,WebFetch,WebSearch,Task,Agent,Skill,ReadMcpResource,ListMcpResources,KillShell'

/**
 * CLAUDE_PEERS_TOOLS is read by both the claude-peers server and the
 * kory-roadmap server, each intersecting it with its own registry, so one list
 * names the messaging tools and the roadmap tools a demo tile keeps.
 */
export const DEMO_PEER_TOOLS = [
  'list_peers',
  'send_message',
  'check_messages',
  'whoami',
  'set_summary',
  'roadmap_list',
  'roadmap_get',
  'roadmap_update'
]

/** The only user-scope MCP servers a demo tile receives besides its own browser. */
const DEMO_GLOBAL_SERVERS = ['claude-peers', 'kory-roadmap'] as const

/**
 * The user's top-level `mcpServers` (global configuration, never a project
 * file). Errors carry the path and a fixed reason, never file content: an
 * entry's env may hold a secret.
 */
export function readUserMcpServers(file: string, readFile: (path: string) => string): unknown {
  let raw: string
  try {
    raw = readFile(file)
  } catch (e) {
    throw new Error(`the user MCP config ${file} could not be read (${(e as NodeJS.ErrnoException).code ?? 'unreadable'})`)
  }
  try {
    return (JSON.parse(raw) as { mcpServers?: unknown }).mcpServers
  } catch {
    throw new Error(`the user MCP config ${file} is not valid JSON`)
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
}

/**
 * Copy the claude-peers and kory-roadmap entries of the user's MCP config for a
 * demo tile, with CLAUDE_PEERS_TOOLS forced to the demo list over whatever the
 * entry declared. A missing or malformed entry refuses the whole spawn; no
 * fallback to a tile without it. Messages name the entry, never its content.
 */
export function demoGlobalServers(userServers: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const name of DEMO_GLOBAL_SERVERS) {
    const entry = (typeof userServers === 'object' && userServers !== null
      ? (userServers as Record<string, unknown>)[name]
      : undefined) as Record<string, unknown> | undefined
    const malformed = (why: string): Error => new Error(`the user MCP config has no usable "${name}" entry (${why})`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw malformed('missing')
    if (typeof entry.command !== 'string' || !entry.command) throw malformed('no command')
    if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === 'string'))) {
      throw malformed('args are not strings')
    }
    if (entry.env !== undefined && !isStringRecord(entry.env)) throw malformed('env is not a string map')
    // Windows env names are case-insensitive: any casing of the key goes, so ours cannot lose to a copy.
    const kept = Object.entries((entry.env as Record<string, string> | undefined) ?? {}).filter(
      ([key]) => key.toUpperCase() !== 'CLAUDE_PEERS_TOOLS'
    )
    out[name] = { ...entry, env: { ...Object.fromEntries(kept), CLAUDE_PEERS_TOOLS: DEMO_PEER_TOOLS.join(',') } }
  }
  return out
}

export interface DemoMcpConfigInput {
  /** Directory the config file is written into (Deck app-state dir). */
  dir: string
  /** Absolute path of the built demo-browser-mcp.mjs script. */
  mcpScriptPath: string
  /** Node-capable executable: the Electron binary (run as node) or plain node. */
  execPath: string
  controlUrl: string
  controlToken: string
  /** One name per tile so two configs never share a file. */
  fileName: string
  /** Servers written next to demo-browser, which always wins a name clash. */
  extraServers?: Record<string, unknown>
}

/** Write a demo tile's .mcp config file and return its path; the control URL and token are minted per tile. */
export function writeDemoMcpConfig(input: DemoMcpConfigInput): string {
  const config = {
    mcpServers: {
      ...input.extraServers,
      'demo-browser': {
        command: input.execPath,
        args: [input.mcpScriptPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DEMO_CONTROL_URL: input.controlUrl,
          DEMO_CONTROL_TOKEN: input.controlToken
        }
      }
    }
  }
  mkdirSync(input.dir, { recursive: true })
  const file = join(input.dir, input.fileName)
  writeFileSync(file, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return file
}

export interface DemoTileMint {
  mcpConfig: string
  /** Closes the tile's control server and deletes its config file; safe to call twice. */
  release(): void
}

export interface DemoTileMintInput {
  /** Every WebContents of the app; the single <webview> guest hosted by `host` is the demo's browser. */
  guests: readonly WebContents[]
  host: WebContents | null
  /** The user's top-level `mcpServers`; throws when the user config cannot be read. */
  readUserMcpServers(): unknown
  /** Writes the tile's .mcp config under this window's session dir and returns its path. */
  writeConfig(control: { url: string; token: string }, fileName: string, globals: Record<string, unknown>): string
  report: (scope: string, message: string, error?: unknown) => void
}

/**
 * The embedded browser is one <webview>: a demo needs exactly that one, hosted
 * by the Deck window, because the driver sends real input events to it.
 */
export function pickEmbeddedBrowser(
  guests: readonly WebContents[],
  host: WebContents | null
): { ok: true; guest: WebContents } | { ok: false; reason: string } {
  if (!host) return { ok: false, reason: 'the Deck window is not available' }
  const hosted = guests.filter((wc) => !wc.isDestroyed() && wc.getType() === 'webview' && wc.hostWebContents?.id === host.id)
  if (hosted.length === 0) {
    return { ok: false, reason: 'the embedded browser is not open: open the Browser view in the Deck first' }
  }
  if (hosted.length > 1) {
    return { ok: false, reason: 'more than one embedded browser is attached: a demo needs exactly one' }
  }
  return { ok: true, guest: hosted[0]! }
}

/**
 * One control server and one .mcp config per demo TILE. Its lifetime is the
 * tile's, not a run's: the caller releases it when the tile finally goes.
 */
export async function mintDemoTile(input: DemoTileMintInput): Promise<DemoTileMint> {
  const picked = pickEmbeddedBrowser(input.guests, input.host)
  if (!picked.ok) throw new Error(picked.reason)
  const globals = demoGlobalServers(input.readUserMcpServers())
  const control = await startDemoControl(createBrowserDriver(picked.guest))
  let mcpConfig: string
  try {
    mcpConfig = input.writeConfig(control, `demo-mcp-${randomBytes(4).toString('hex')}.json`, globals)
  } catch (e) {
    control.close()
    throw e
  }
  let released = false
  return {
    mcpConfig,
    release: () => {
      if (released) return
      released = true
      control.close()
      try {
        unlinkSync(mcpConfig)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          input.report('demo', `failed to remove the demo mcp config ${mcpConfig}`, e)
        }
      }
    }
  }
}
