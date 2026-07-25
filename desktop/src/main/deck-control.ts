// Deck control endpoint (PLAN C5): a loopback HTTP server, started by the
// Electron main process, that lets the SUPERVISOR session pilot the app
// through the deck-control MCP server (desktop/mcp/deck-control-mcp.ts).
//
// Security model:
// - 127.0.0.1 only, random port, Bearer token minted per app launch. The pair
//   is injected ONLY into the supervisor tile's generated --mcp-config file,
//   never into normal agent sessions, project files or the shell env.
// - Destructive operations (close a session, remove a worktree) are allowed
//   only on objects the supervisor itself created through this endpoint;
//   anything else must go through the operator's UI.
// - A spawn cap keeps a runaway supervisor from flooding the window.
//
// The module is dependency-injected (no electron / node-pty imports) so the
// full dispatch + guard logic is unit-testable under `bun test`.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type {
  CreateSessionInput,
  LaunchPreset,
  ModelOption,
  SandboxExecResponse,
  SessionRuntime,
  TemplateSummary
} from '../shared/types'
import type { WorktreeInfo } from './worktree-service'
import { EMBEDDED_AGENTS, getEmbeddedAgent, type EmbeddedAgent } from './team-embedded'
import { TEAM_PLAYBOOK } from './team-embedded'

/** Live sessions cap enforced on deck_spawn_session / deck_spawn_team. */
export const SPAWN_CAP = 8

/** Sync wait for a spawned session's peer_id (deck_spawn_session default). */
export const WAIT_PEER_TIMEOUT_MS = 90_000

/**
 * One entry of a spawn request (deck_spawn_session, or one deck_spawn_team
 * member). `cli` is part of the v1 contract but only 'claude' is accepted
 * (TS2 decision: the field is frozen now so v2 multi-CLI is not a breaking
 * change).
 */
export interface SpawnPlanEntry {
  name?: string
  agent?: string
  embeddedAgent?: string
  model?: string
  effort?: string
  args?: string
  prompt?: string
  worktreeBranch?: string
  announce?: string
  cli?: string
}

/** What the operator sees in an approval dialog (trust modes 2/3, TS4). */
export interface SpawnSummary {
  name: string
  agent: string
  embedded: string
  model: string
  effort: string
  cli: string
  worktree_branch: string
  prompt_preview: string
}

export interface DeckControlDeps {
  listAgents(): string[]
  listModels(): ModelOption[]
  listPresets(): LaunchPreset[]
  /** Same path as the operator's create (worktree handling included). */
  spawnSession(input: CreateSessionInput): Promise<SessionRuntime>
  listSessions(): SessionRuntime[]
  restartSession(id: string): void
  closeSession(id: string): void
  createWorktree(branch: string): Promise<WorktreeInfo>
  listWorktrees(): Promise<WorktreeInfo[]>
  removeWorktree(path: string): Promise<void>
  listTemplates(): TemplateSummary[]
  /** Append-only from the supervisor ('replace' would kill its own tile). */
  applyTemplate(path: string): Promise<number>
  saveTemplate(name: string, local: boolean): string | null
  announce(text: string): Promise<number>
  /**
   * Trust-mode gate (TS4): one decision per entry. hands-free approves all
   * without UI; team-review shows ONE recap dialog (all-or-nothing);
   * full-control asks per entry. Implemented by index.ts.
   */
  approveSpawn(entries: SpawnSummary[]): Promise<boolean[]>
  /** Resolve a spawned session's peer_id, or null on timeout/exit (TS3). */
  waitForPeer(id: string, timeoutMs: number): Promise<string | null>
  /** Arm the async connection ack targeted at the supervisor (TS3). */
  armSpawnAck(id: string, name: string): void
  /** Write an embedded profile's prompt file and return its path (TS1). */
  writeEmbeddedPrompt(id: string): string
  /**
   * Run a shell command INSIDE this project's sandbox container
   * (PLAN-SANDBOX M2): "add this dependency to the instance". Rejected when
   * sandbox mode is off. The command never touches a host shell — the
   * sandbox service hands it to the container's bash as one argv element.
   */
  sandboxExec(command: string): Promise<SandboxExecResponse>
}

export interface DeckControlServer {
  url: string
  token: string
  close(): void
}

type ToolArgs = Record<string, unknown>

function str(args: ToolArgs, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** One spawn entry from tool args (deck_spawn_session or a team member). */
function parseEntry(args: ToolArgs): SpawnPlanEntry {
  return {
    name: str(args, 'name') || undefined,
    agent: str(args, 'agent') || undefined,
    embeddedAgent: str(args, 'embedded_agent') || undefined,
    model: str(args, 'model') || undefined,
    effort: str(args, 'effort') || undefined,
    args: str(args, 'args') || undefined,
    prompt: str(args, 'prompt') || undefined,
    worktreeBranch: str(args, 'worktree_branch') || undefined,
    announce: str(args, 'announce') || undefined,
    cli: str(args, 'cli') || undefined
  }
}

/**
 * Validate one entry and resolve its embedded profile. Throws on: a non-claude
 * cli (v1 gate — the field is contract-frozen, the values are not), both agent
 * and embedded_agent set, or an unknown embedded id.
 */
function validateEntry(entry: SpawnPlanEntry): EmbeddedAgent | null {
  if (entry.cli && entry.cli !== 'claude') {
    throw new Error(
      `cli "${entry.cli}" is not supported yet — only 'claude' sessions can be spawned (the field is reserved for future multi-CLI support)`
    )
  }
  if (entry.agent && entry.embeddedAgent) {
    throw new Error('agent and embedded_agent are mutually exclusive — pick one')
  }
  if (!entry.embeddedAgent) return null
  const embedded = getEmbeddedAgent(entry.embeddedAgent)
  if (!embedded) {
    throw new Error(
      `unknown embedded agent "${entry.embeddedAgent}" — available: ${EMBEDDED_AGENTS.map((a) => a.id).join(', ')}`
    )
  }
  return embedded
}

/** The recap shown by the approval dialogs (trust modes 2/3). */
function summarizeEntry(entry: SpawnPlanEntry, embedded: EmbeddedAgent | null): SpawnSummary {
  return {
    name: entry.name ?? embedded?.id ?? entry.agent ?? 'peer',
    agent: entry.agent ?? '',
    embedded: embedded?.id ?? '',
    model: entry.model ?? '',
    effort: entry.effort ?? '',
    cli: entry.cli ?? 'claude',
    worktree_branch: entry.worktreeBranch ?? '',
    prompt_preview: (entry.prompt ?? '').slice(0, 160)
  }
}

/** Trimmed session view exposed to the supervisor (no ids it must not need). */
function sessionView(s: SessionRuntime): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    peer_id: s.peerId,
    status: s.status,
    thinking: s.thinking,
    rate_limited: s.rateLimited,
    cwd: s.cwd,
    worktree_branch: s.worktree?.branch ?? null,
    supervisor: !!s.supervisor
  }
}

export function startDeckControl(
  deps: DeckControlDeps,
  opts: { port?: number } = {}
): Promise<DeckControlServer> {
  const token = randomBytes(24).toString('hex')
  // Objects created THROUGH this endpoint: the only ones destructive ops touch.
  const ownedSessions = new Set<string>()
  const ownedWorktrees = new Set<string>()

  /** Enforce the live-session cap for a batch of n upcoming spawns. */
  function capCheck(n: number): void {
    const live = deps.listSessions().filter((s) => s.status !== 'exited').length
    if (live + n > SPAWN_CAP) {
      throw new Error(
        `spawn cap: ${live} live session(s) + ${n} requested exceeds the ${SPAWN_CAP} cap -- close sessions or spawn in waves`
      )
    }
  }

  /** Spawn one validated entry (shared by deck_spawn_session / deck_spawn_team). */
  async function spawnEntry(
    entry: SpawnPlanEntry,
    embedded: EmbeddedAgent | null
  ): Promise<SessionRuntime> {
    // Embedded read-only roles get their tool denial at harness level.
    const args = [
      entry.args ?? '',
      embedded?.disallowedTools ? `--disallowedTools "${embedded.disallowedTools}"` : ''
    ]
      .filter(Boolean)
      .join(' ')
    // Embedded team-lead lands as the window lead only when none is live
    // (same rule as templates, PLAN C18 -- never demote an operator's lead).
    const hasLiveLead = deps.listSessions().some((s) => s.lead && s.status !== 'exited')
    const input: CreateSessionInput = {
      name: entry.name ?? embedded?.id,
      agent: entry.agent,
      model: entry.model,
      effort: entry.effort,
      args: args || undefined,
      prompt: entry.prompt,
      worktreeBranch: entry.worktreeBranch,
      announce: entry.announce,
      appendSystemPromptFile: embedded ? deps.writeEmbeddedPrompt(embedded.id) : undefined,
      lead: embedded?.id === 'team-lead' && !hasLiveLead ? true : undefined
    }
    const created = await deps.spawnSession(input)
    ownedSessions.add(created.id)
    if (created.worktree) ownedWorktrees.add(created.worktree.path)
    return created
  }

  async function dispatch(tool: string, args: ToolArgs): Promise<unknown> {
    switch (tool) {
      case 'deck_list_agents':
        return { agents: deps.listAgents() }

      case 'deck_team_playbook':
        return { playbook: TEAM_PLAYBOOK }

      case 'deck_team_agents':
        return {
          agents: EMBEDDED_AGENTS.map((a) => ({
            id: a.id,
            role: a.role,
            recommended_tier: a.recommendedTier,
            disallowed_tools: a.disallowedTools || null
          })),
          note: 'Embedded fallback profiles (fixed by the app). Prefer the operator profiles from deck_list_agents; spawn these via deck_spawn_session/deck_spawn_team embedded_agent.'
        }
      case 'deck_list_models':
        return { models: deps.listModels() }
      case 'deck_list_presets':
        return { presets: deps.listPresets() }

      case 'deck_spawn_session': {
        const entry = parseEntry(args)
        const embedded = validateEntry(entry)
        capCheck(1)
        const [approved] = await deps.approveSpawn([summarizeEntry(entry, embedded)])
        if (!approved) throw new Error('spawn refused by the operator')
        const created = await spawnEntry(entry, embedded)
        // Sync ack by default (single-agent contract, TS3): the result carries
        // the peer_id. wait_for_peer:false switches to the async targeted ack.
        if (args['wait_for_peer'] === false) {
          deps.armSpawnAck(created.id, created.name)
          return {
            session: sessionView(created),
            note: 'async ack armed: the Deck will notify you when this session connects'
          }
        }
        const peerId = await deps.waitForPeer(created.id, WAIT_PEER_TIMEOUT_MS)
        if (peerId === null) {
          // Not resolved in time: fall back to the async ack so the supervisor
          // still hears about it (connected or failed) without polling.
          deps.armSpawnAck(created.id, created.name)
          return {
            session: sessionView(created),
            peer_id: null,
            note: 'peer_id not resolved yet -- the Deck will notify you when this session connects (or fails to)'
          }
        }
        return { session: sessionView(created), peer_id: peerId }
      }

      case 'deck_spawn_team': {
        const raw = args['team']
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new Error('team must be a non-empty array of spawn entries')
        }
        // Validate EVERYTHING before the approval dialog / any spawn: a bad
        // entry must not leave a half-spawned team behind.
        const entries = raw.map((e) => {
          if (!e || typeof e !== 'object') throw new Error('each team entry must be an object')
          return parseEntry(e as ToolArgs)
        })
        const embeddeds = entries.map((entry) => validateEntry(entry))
        capCheck(entries.length)
        const decisions = await deps.approveSpawn(
          entries.map((entry, i) => summarizeEntry(entry, embeddeds[i] ?? null))
        )
        const spawned: Record<string, unknown>[] = []
        let refused = 0
        for (let i = 0; i < entries.length; i++) {
          if (!decisions[i]) {
            refused++
            continue
          }
          const created = await spawnEntry(entries[i]!, embeddeds[i] ?? null)
          // Team contract (TS3): always async -- the Deck notifies the
          // supervisor as each session connects (or fails to).
          deps.armSpawnAck(created.id, created.name)
          spawned.push(sessionView(created))
        }
        return {
          spawned,
          refused,
          note:
            spawned.length > 0
              ? 'async acks armed: the Deck will notify you as each session connects'
              : 'nothing spawned'
        }
      }

      case 'deck_list_sessions':
        return { sessions: deps.listSessions().map(sessionView) }

      case 'deck_sandbox_exec': {
        const command = str(args, 'command')
        if (!command) throw new Error('command is required')
        // The Deck owns the boundary: the string is handed to the CONTAINER's
        // bash as one argv element (never glued into a host command line),
        // the container is the project's own, and every call is journaled.
        return deps.sandboxExec(command)
      }

      case 'deck_restart_session': {
        const id = str(args, 'id')
        if (!id) throw new Error('id is required')
        deps.restartSession(id)
        return { ok: true }
      }

      case 'deck_close_session': {
        const id = str(args, 'id')
        if (!id) throw new Error('id is required')
        if (!ownedSessions.has(id)) {
          throw new Error(
            'refused: only sessions spawned by the supervisor can be closed -- ask the operator for the rest'
          )
        }
        deps.closeSession(id)
        ownedSessions.delete(id)
        return { ok: true }
      }

      case 'deck_create_worktree': {
        const branch = str(args, 'branch')
        if (!branch) throw new Error('branch is required')
        const wt = await deps.createWorktree(branch)
        ownedWorktrees.add(wt.path)
        return { worktree: wt }
      }

      case 'deck_list_worktrees':
        return { worktrees: await deps.listWorktrees() }

      case 'deck_remove_worktree': {
        const path = str(args, 'path')
        if (!path) throw new Error('path is required')
        if (!ownedWorktrees.has(path)) {
          throw new Error(
            'refused: only worktrees created by the supervisor can be removed -- ask the operator for the rest'
          )
        }
        await deps.removeWorktree(path) // git still refuses dirty trees (never forced)
        ownedWorktrees.delete(path)
        return { ok: true }
      }

      case 'deck_list_templates':
        return { templates: deps.listTemplates() }

      case 'deck_apply_template': {
        const path = str(args, 'path')
        if (!path) throw new Error('path is required')
        return { spawned: await deps.applyTemplate(path) }
      }

      case 'deck_save_template': {
        const name = str(args, 'name')
        if (!name) throw new Error('name is required')
        const saved = deps.saveTemplate(name, args['local'] === true)
        if (!saved) throw new Error('template save failed')
        return { path: saved }
      }

      case 'deck_announce': {
        const text = str(args, 'text')
        if (!text) throw new Error('text is required')
        return { sent: await deps.announce(text) }
      }

      default:
        throw new Error(`unknown tool: ${tool}`)
    }
  }

  const server: Server = createServer((req, res) => {
    const deny = (code: number, msg: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: msg }))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, 'unauthorized')
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.method !== 'POST' || req.url !== '/call') return deny(404, 'not found')

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024) req.destroy() // oversized payload
    })
    req.on('end', () => {
      void (async () => {
        try {
          const parsed = JSON.parse(body) as { tool?: string; args?: ToolArgs }
          if (!parsed.tool) return deny(400, 'tool is required')
          const result = await dispatch(parsed.tool, parsed.args ?? {})
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result }))
        } catch (e) {
          deny(400, e instanceof Error ? e.message : String(e))
        }
      })()
    })
  })

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('no address'))
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        token,
        close: () => server.close()
      })
    })
  })
}
