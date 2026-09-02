// Deck control endpoint (PLAN C5): a loopback HTTP server, started by the
// Electron main process, that lets the SUPERVISOR session pilot the app
// through the deck-control MCP server (desktop/mcp/deck-control-mcp.ts).
//
// Security model:
// - 127.0.0.1 only, random port. One process, one HTTP endpoint, but MULTIPLE
//   Bearer tokens can be live at once (Card 6c380073): the historical token
//   (injected into the supervisor tile's --mcp-config) and one minted per
//   embedded team-lead spawn via mintCaller() below. Each token resolves to
//   a callerId and an optional tool allow-list, both held in `callerTable`.
// - Destructive operations (close/restart a session, remove a worktree) are
//   allowed only on objects the SAME CALLER created through this endpoint --
//   enforced by `ownedSessions`/`ownedWorktrees` (Map<id, callerId>) checked
//   in the `deck_close_session` / `deck_restart_session` / `deck_remove_worktree`
//   cases below, never by which endpoint the request arrived through.
//   Anything else must go through the operator's UI.
// - The per-caller tool allow-list (three-state semantics: absent -> every
//   tool, array -> only those, empty array -> none) is enforced HERE, in the
//   request handler below, before dispatch() ever runs -- deck-control-mcp.ts
//   keeps its own copy of the same filter (piece 1) for tools/list UX, but it
//   is no longer the only barrier: a caller could always skip tools/list and
//   POST /call directly with a token that names a tool it should not have.
// - Honesty about what this does NOT resist: both the supervisor's and the
//   team-lead's --mcp-config files (each holding its own token) are written
//   into the same userData/APP_STATE_SUBDIR directory (index.ts). A
//   non-sandboxed agent hosted in a sibling tile could read the neighboring
//   file and borrow its token. This scheme separates two COOPERATING
//   authorities by role; it does not resist a deliberately hostile agent
//   (same framing as shared/types.ts's own reserved-by-role note).
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
import { resolveDirectiveTargets } from './directive'
import { EMBEDDED_AGENTS, getEmbeddedAgent, type EmbeddedAgent } from './team-embedded'
import { TEAM_PLAYBOOK } from './team-embedded'
import { TEAM_LEAD_DECK_TOOLS } from './supervisor'

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
  /**
   * Audit fix #1b (card 6c380073): the free-form launch-args string, shown
   * verbatim in the approval dialog (index.ts summaryLine) so the operator
   * actually SEES what they are approving -- previously invisible in every
   * trust mode above hands-free. '' when absent.
   */
  args: string
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
   * Write the team-lead's own deck-control --mcp-config and return its path
   * (Card ff091064, piece 2). Called once per team-lead spawn, from
   * spawnEntry below -- the same shared control server the supervisor uses,
   * scoped to `allowedTools` via DECK_CONTROL_TOOLS. `token` and `callerId`
   * come from a fresh mintCaller() call made by spawnEntry itself (Card
   * 6c380073): a distinct token per team-lead spawn, never the supervisor's,
   * and `callerId` is threaded through so the implementation (index.ts) can
   * give each spawn's config file a distinct name -- a second mint must not
   * silently invalidate the first one's file. `allowedTools` is the SAME
   * array reference spawnEntry already passed to mintCaller (audit fix #6,
   * card 6c380073) -- deliberately threaded through rather than re-imported
   * a second time here, so the server-side scope and the client-side
   * DECK_CONTROL_TOOLS filter can never independently drift apart.
   */
  writeTeamLeadMcpConfig(token: string, callerId: string, allowedTools: readonly string[]): string
  /**
   * Undo a writeTeamLeadMcpConfig() call whose spawn failed AFTER the token
   * was minted and the file already written (audit fix #2, card 6c380073) --
   * deletes the orphaned team-lead-mcp-<callerId>.json. Also called on final
   * removal of a team-lead tile (never on restart, which reuses the same
   * file). Best-effort: a missing file is not an error.
   */
  revokeTeamLeadMcpConfig(callerId: string): void
  /**
   * Audit fix #1c (card 6c380073): gate a spawn entry carrying a shell-bearing
   * field (`args` -- SpawnPlanEntry has no `command`) behind the same
   * operator-approval mechanism templates/workspace-restore already use for
   * the identical sink, but with the hands-free short-circuit that mechanism
   * itself lacks (see the implementation's own doc, index.ts). Returns true
   * when the spawn may proceed.
   */
  confirmSpawnShellFields(entry: { command?: string; args?: string }): boolean
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
  /** The historical, unrestricted token (callerId 'supervisor', allowedTools=null). */
  token: string
  /**
   * Mint a new caller: a fresh Bearer token, registered server-side with its
   * own callerId and tool allow-list (Card 6c380073). `allowedTools`
   * mirrors the three-state semantics of DECK_CONTROL_TOOLS (deck-control-mcp.ts):
   * omitted/null = every tool, an array = only those, an empty array = none.
   */
  mintCaller(
    label: string,
    allowedTools?: readonly string[] | null
  ): { token: string; callerId: string }
  /**
   * Audit fix #2 (card 6c380073): revoke the caller minted for a team-lead
   * SESSION on its final removal, keyed by the session id (the object index
   * caller ipc already has) rather than by callerId (which the caller would
   * have to have tracked separately). No-ops (returns null) for a session
   * that was never minted its own caller -- the supervisor tile, any
   * non-lead profile. Returns the revoked callerId on a real revocation, so
   * the caller can also delete the matching --mcp-config file.
   */
  revokeCallerForSession(sessionId: string): string | null
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
 * The reasoning-effort levels this endpoint accepts (card 6c380073, second
 * audit round). The SAME list is declared in deck-control-mcp.ts's JSON
 * schema and in the renderer's two pickers, but BOTH of those are
 * declarative: the MCP bridge's tools/call forwards `arguments` verbatim
 * without validating them against its own schema, and a picker constrains
 * only the UI. Measured: before this constant existed, the literal 'xhigh'
 * appeared nowhere in desktop/src/main at all, so nothing in the main
 * process ever checked this field on ANY path. This is the enforcing copy.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Validate one entry and resolve its embedded profile. Throws on: a non-claude
 * cli (v1 gate — the field is contract-frozen, the values are not), an effort
 * outside EFFORT_LEVELS, both agent and embedded_agent set, or an unknown
 * embedded id.
 */
function validateEntry(entry: SpawnPlanEntry): EmbeddedAgent | null {
  if (entry.cli && entry.cli !== 'claude') {
    throw new Error(
      `cli "${entry.cli}" is not supported yet — only 'claude' sessions can be spawned (the field is reserved for future multi-CLI support)`
    )
  }
  // Card 6c380073 (second audit round): `effort` used to reach the login-shell
  // command line unquoted and un-allow-listed (session-command.ts's
  // effortFlag, fixed there too). That fix alone would silently EMPTY a bad
  // value; refusing it BY NAME here is what tells the calling agent its
  // argument was rejected instead of quietly ignored -- same reasoning as the
  // `cli` refusal just above, and as the `args` refusal further down.
  if (entry.effort && !(EFFORT_LEVELS as readonly string[]).includes(entry.effort)) {
    throw new Error(
      `effort "${entry.effort}" is not a valid level -- expected one of: ${EFFORT_LEVELS.join(', ')}`
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
    prompt_preview: (entry.prompt ?? '').slice(0, 160),
    args: entry.args ?? ''
  }
}

/**
 * Audit fix #1a (card 6c380073): a caller scoped to a NARROWED tool
 * allow-list may never pass a free-form `args` string -- session-service.ts's
 * create() documents that every path reaching it is operator-authorized
 * (advanced menu, approved template, trusted companion cred) and is
 * therefore NOT further escaped before hitting a login shell
 * (session-command.ts -> shell-command.ts). An embedded team-lead calling
 * deck_spawn_session/deck_spawn_team is neither of those. Refuses explicitly
 * rather than silently dropping the field -- a silently dropped field reads
 * to the caller as "applied".
 */
function assertArgsAllowedForRestrictedCaller(entry: SpawnPlanEntry, restricted: boolean): void {
  if (restricted && entry.args) {
    throw new Error(
      'refused: this caller is scoped to a tool allow-list and may not pass a free-form `args` string (arbitrary shell arguments) -- ask the operator to spawn with custom args instead'
    )
  }
}

/** Trimmed session view exposed to the supervisor (no ids it must not need). */
function sessionView(s: SessionRuntime): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    peer_id: s.peerId,
    status: s.status,
    // Card f8082208: WIRE-CONTRACT CHANGE for third-party MCP agents -- was
    // a boolean ("is this tile busy"), now the ternary activity predicate
    // ('working' | 'idle' | 'unknown'), see docs/DESIGN-ACTIVITY-PREDICATE.md.
    // A supervisor agent reading `thinking` as a boolean truthy/falsy check
    // will now see 'idle'/'unknown' both as truthy strings -- flagged here
    // for the team-lead to announce, per that doc's own consumer table.
    thinking: s.activity,
    rate_limited: s.rateLimited,
    cwd: s.cwd,
    worktree_branch: s.worktree?.branch ?? null,
    supervisor: !!s.supervisor
  }
}

interface CallerEntry {
  callerId: string
  /** null = every tool, array = only those, empty array = none (Card 6c380073). */
  allowedTools: string[] | null
}

export function startDeckControl(
  deps: DeckControlDeps,
  opts: { port?: number } = {}
): Promise<DeckControlServer> {
  const token = randomBytes(24).toString('hex')
  // One entry per live Bearer token, resolved by the request handler below
  // BEFORE dispatch ever runs. The historical token is registered here as
  // callerId 'supervisor' with an unrestricted (null) allow-list.
  const callerTable = new Map<string, CallerEntry>()
  callerTable.set(token, { callerId: 'supervisor', allowedTools: null })

  /**
   * Mint a fresh token/callerId pair (Card 6c380073). callerId includes a
   * random suffix so two mints of the same label (e.g. two team-lead spawns)
   * never collide -- each gets its own ownedSessions entries and its own
   * --mcp-config filename downstream.
   */
  function mintCaller(
    label: string,
    allowedTools?: readonly string[] | null
  ): { token: string; callerId: string } {
    const mintedToken = randomBytes(24).toString('hex')
    const callerId = `${label}-${randomBytes(4).toString('hex')}`
    callerTable.set(mintedToken, {
      callerId,
      allowedTools: allowedTools ? [...allowedTools] : null
    })
    return { token: mintedToken, callerId }
  }

  /**
   * Audit fix #2 (card 6c380073): remove every token registered under
   * `callerId` -- a reverse lookup over callerTable since the token is the
   * map KEY and callerId only lives in its value. No-op if callerId is not
   * (or no longer) registered.
   */
  function revokeCaller(callerId: string): void {
    for (const [tok, entry] of callerTable) {
      if (entry.callerId === callerId) callerTable.delete(tok)
    }
  }

  /** See DeckControlServer.revokeCallerForSession's own doc. */
  function revokeCallerForSession(sessionId: string): string | null {
    const callerId = sessionMintedCallerId.get(sessionId)
    if (!callerId) return null
    revokeCaller(callerId)
    sessionMintedCallerId.delete(sessionId)
    return callerId
  }

  // Objects created THROUGH this endpoint, keyed by which CALLER created them
  // (Card 6c380073) -- not merely "created through this endpoint", now that a
  // second identity (the team-lead) shares it with the supervisor.
  const ownedSessions = new Map<string, string>()
  const ownedWorktrees = new Map<string, string>()
  /**
   * Audit fix #2 (card 6c380073): session id -> the callerId MINTED FOR that
   * session's own future calls (never the spawning caller's own callerId,
   * already tracked by ownedSessions above -- a distinct dimension). Only
   * populated for a team-lead spawn. Read by revokeCallerForSession on final
   * removal so a departed lead's token/file stop authorizing anything.
   */
  const sessionMintedCallerId = new Map<string, string>()

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
    embedded: EmbeddedAgent | null,
    callerId: string
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
    // Card 6c380073: a spawned team-lead tile gets its OWN minted token/callerId
    // (never the spawning caller's), so its future deck-control calls are
    // authorized under its own ownedSessions entries, not the supervisor's.
    // Audit fix #6: TEAM_LEAD_DECK_TOOLS is named ONCE here and threaded to
    // BOTH mintCaller (server-side scope) and writeTeamLeadMcpConfig
    // (client-side DECK_CONTROL_TOOLS) below -- never imported a second time
    // at either consumer, so the two can never independently drift apart.
    const leadMint = embedded?.id === 'team-lead' ? mintCaller('team-lead', TEAM_LEAD_DECK_TOOLS) : null
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
      lead: embedded?.id === 'team-lead' && !hasLiveLead ? true : undefined,
      // Card ff091064 (piece 2): only the embedded team-lead gets the
      // deck-control bridge -- every other embedded/operator profile spawned
      // through this same path (dev, reviewer, ...) stays without it.
      mcpConfig: leadMint
        ? deps.writeTeamLeadMcpConfig(leadMint.token, leadMint.callerId, TEAM_LEAD_DECK_TOOLS)
        : undefined
    }
    let created: SessionRuntime
    try {
      created = await deps.spawnSession(input)
    } catch (e) {
      // Audit fix #2 (card 6c380073): the mint AND the --mcp-config file
      // write both happen ABOVE, before the spawn -- if spawnSession then
      // fails, undo both rather than leaving an orphaned token/file that
      // authorizes a tile that was never created.
      if (leadMint) {
        revokeCaller(leadMint.callerId)
        deps.revokeTeamLeadMcpConfig(leadMint.callerId)
      }
      throw e
    }
    ownedSessions.set(created.id, callerId)
    if (leadMint) sessionMintedCallerId.set(created.id, leadMint.callerId)
    // Audit fix #4: first-writer-wins -- a path collision must never let a
    // second caller silently steal ownership of an existing worktree entry.
    if (created.worktree && !ownedWorktrees.has(created.worktree.path)) {
      ownedWorktrees.set(created.worktree.path, callerId)
    }
    return created
  }

  async function dispatch(
    tool: string,
    args: ToolArgs,
    callerId: string,
    restricted: boolean
  ): Promise<unknown> {
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
        // Audit fix #1a (card 6c380073): before capCheck/approval, never after.
        assertArgsAllowedForRestrictedCaller(entry, restricted)
        // Audit fix #1c: shell-bearing `args` needs operator approval (same
        // gate templates/workspace-restore use), unless already cached.
        if (!deps.confirmSpawnShellFields({ args: entry.args })) {
          throw new Error('refused: this launch carries unapproved shell arguments')
        }
        capCheck(1)
        const [approved] = await deps.approveSpawn([summarizeEntry(entry, embedded)])
        if (!approved) throw new Error('spawn refused by the operator')
        const created = await spawnEntry(entry, embedded, callerId)
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
        // Audit fix #1a/#1c: same two gates as deck_spawn_session, applied to
        // EVERY entry before the approval dialog / any spawn -- one bad entry
        // poisons the whole plan, same convention as validateEntry above.
        for (const entry of entries) {
          assertArgsAllowedForRestrictedCaller(entry, restricted)
          if (!deps.confirmSpawnShellFields({ args: entry.args })) {
            throw new Error('refused: this team plan carries unapproved shell arguments')
          }
        }
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
          const created = await spawnEntry(entries[i]!, embeddeds[i] ?? null, callerId)
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
        // Card 6c380073: resolve the OBJECT first (its recorded owner, or
        // undefined if never seen), THEN ask if THIS caller may act on it --
        // an absent id refuses the same way a wrong-owner id does, never
        // falling back to a default owner. Previously unguarded entirely.
        if (ownedSessions.get(id) !== callerId) {
          throw new Error(
            'refused: only a session spawned by this same caller can be restarted -- ask the operator for the rest'
          )
        }
        deps.restartSession(id)
        return { ok: true }
      }

      case 'deck_close_session': {
        const id = str(args, 'id')
        const peerId = str(args, 'peer_id')
        // Card c4cbb845: `peer_id` names the SAME target by its other name, it
        // is never a second target -- both set is refused rather than one
        // silently preferred (same discipline as validateEntry's
        // agent/embedded_agent above). The MCP schema
        // (desktop/mcp/deck-control-mcp.ts) declares both and requires
        // neither; it validates NOTHING, the handler receives arguments
        // verbatim, so these four lines ARE the exactly-one-of rule.
        if (id && peerId) throw new Error('id and peer_id are mutually exclusive -- pick one')
        if (!id && !peerId) throw new Error('id or peer_id is required')
        let target = id
        if (peerId) {
          // The one existing peer_id -> tile resolver main-side (directive.ts,
          // also used by index.ts and agent-stop.ts): reused, not
          // re-implemented. Closing a tile is irreversible, so zero match and
          // several matches both refuse and this path never picks.
          const resolved = resolveDirectiveTargets([peerId], deps.listSessions())
          // Ambiguity is refused BEFORE matched is read, on purpose. The
          // resolver already keeps an ambiguous peer_id out of `matched`
          // (directive.ts), but its own doc calls `ambiguous` an annotation of
          // WHY an id is missing -- a guarantee this case would merely be
          // BORROWING. Should that resolver ever be "improved" into pushing
          // the first match while still annotating, closing here must fail,
          // not pick. So the fail-closed is LOCAL: an annotated ambiguity
          // refuses whatever `matched` holds.
          if (resolved.ambiguous.length > 0) {
            throw new Error(
              `refused: peer_id "${peerId}" is ambiguous -- several live tiles carry it, close it by tile id instead`
            )
          }
          const hit = resolved.matched[0]
          if (!hit) throw new Error(`refused: no live session carries peer_id "${peerId}"`)
          target = hit.id
        }
        // Card 6c380073, extended by c4cbb845: resolve the OBJECT first, THEN
        // ask whether THIS caller may act on it -- so the guard bites on the
        // RESOLVED tile id, never on the argument as typed.
        //
        // Two refusal wordings, on purpose, and here is what backs the split.
        // This one is WORD FOR WORD the tile-id path's: a caller must not
        // learn from the ownership refusal whether the tile is someone
        // else's or absent. The unresolved/ambiguous refusals above ARE
        // distinct, which does tell the caller a live tile carries that
        // peer_id -- accepted because that enumeration is already available
        // to the same tile through another channel: the deck-control config
        // (supervisor.ts, buildDeckControlMcpConfig) scopes DECK_CONTROL_TOOLS
        // on the deck-control server ONLY, the tile's command line carries
        // `--mcp-config` and never `--strict-mcp-config` (session-command.ts),
        // so the repo's own .mcp.json claude-peers server is merged in and
        // list_peers already enumerates the live peer_ids. The split buys
        // diagnosability on the frequent error (a typo) without granting
        // anything the caller lacks.
        if (ownedSessions.get(target) !== callerId) {
          throw new Error(
            'refused: only a session spawned by this same caller can be closed -- ask the operator for the rest'
          )
        }
        deps.closeSession(target)
        ownedSessions.delete(target)
        // Card 6c380073 (review round 2, point 8): this case drops the
        // OWNERSHIP entry only. It deliberately does NOT call
        // revokeCallerForSession or touch sessionMintedCallerId -- that is
        // covered TRANSITIVELY, and the chain is worth naming because nothing
        // here hints at it. VERIFIED end to end: deps.closeSession is
        // `(id) => service.remove(id)` (index.ts's controlDeps), remove()'s
        // forceCleanup emits 'removed' (session-service.ts), and the single
        // production listener for that event (index.ts's service.on('removed'))
        // is what calls revokeCallerForSession and deletes the config file.
        // Measured: 'removed' has exactly three emit sites (remove, closeAll,
        // restoreFrom) and revokeCallerForSession exactly one production
        // caller, that listener. Revoking here as well would be a second,
        // divergence-prone path to the same guarantee.
        return { ok: true }
      }

      case 'deck_create_worktree': {
        const branch = str(args, 'branch')
        if (!branch) throw new Error('branch is required')
        const wt = await deps.createWorktree(branch)
        // Audit fix #4: first-writer-wins, same reasoning as spawnEntry's own
        // worktree-ownership write above.
        if (!ownedWorktrees.has(wt.path)) ownedWorktrees.set(wt.path, callerId)
        return { worktree: wt }
      }

      case 'deck_list_worktrees':
        return { worktrees: await deps.listWorktrees() }

      case 'deck_remove_worktree': {
        const path = str(args, 'path')
        if (!path) throw new Error('path is required')
        if (ownedWorktrees.get(path) !== callerId) {
          throw new Error(
            'refused: only a worktree created by this same caller can be removed -- ask the operator for the rest'
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
    // Card 6c380073: any token registered in callerTable authorizes the
    // request (no longer a single fixed comparison) -- an unknown/expired
    // token still 401s exactly as before this table existed.
    const auth = req.headers.authorization
    const bearerToken = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const caller = callerTable.get(bearerToken)
    if (!caller) return deny(401, 'unauthorized')
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
          // Card 6c380073: the allow-list now bites HERE, server-side, before
          // dispatch ever runs -- not only in deck-control-mcp.ts's tools/list
          // filter, which a caller could always bypass by POSTing /call
          // directly with a valid-but-narrower token. Same three-state
          // semantics as that client-side filter.
          if (caller.allowedTools !== null && !caller.allowedTools.includes(parsed.tool)) {
            return deny(403, `tool "${parsed.tool}" is not allowed for this caller`)
          }
          const result = await dispatch(
            parsed.tool,
            parsed.args ?? {},
            caller.callerId,
            caller.allowedTools !== null
          )
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
        mintCaller,
        revokeCallerForSession,
        close: () => server.close()
      })
    })
  })
}
