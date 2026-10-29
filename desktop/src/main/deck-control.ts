// 127.0.0.1 only; multiple bearer tokens can be live at once, each resolved to
// a callerId and optional tool allow-list in `callerTable`.
// Restart and worktree removal are allowed only on objects the same caller
// created through this endpoint (ownedSessions/ownedWorktrees); closing a
// session follows the role and lock rules of deck_close_session instead.
// The per-caller tool allow-list is enforced here at the request handler,
// before dispatch runs, not only by the client-side copy of the filter.
// Does not resist a hostile sibling tile reading another tile's mcp-config
// token file; it only separates two cooperating authorities by role.

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
import type { TemplateInput, TemplateResolveResult } from '../shared/template'
import { templateInputsOrEmpty } from '../shared/template-apply-outcome'
import { resolveDirectiveTargets, type DeckDirective } from './directive'
import { parseRunDirectiveArgs, type DeckDirectiveRunResult } from './directive-run'
import type { DemoTileMint } from './demo-driver'
import { EMBEDDED_AGENTS, getEmbeddedAgent, type EmbeddedAgent } from './team-embedded'
import { TEAM_PLAYBOOK } from './team-embedded'
import { TEAM_LEAD_DECK_TOOLS } from './supervisor'
import { createSpawnCap, SPAWN_CAP } from './spawn-cap'
import { reportError } from './log'

export { SPAWN_CAP } from './spawn-cap'

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
   * The free-form launch-args string, shown verbatim in the approval dialog so
   * the operator actually sees what they are approving. '' when absent.
   */
  args: string
}

/**
 * approveSpawn's result (card 02e1c07c): `pending` means the async grant is
 * still awaiting a verdict -- the caller retries the exact same tool call
 * with the exact same arguments, which re-attaches to the SAME in-flight
 * approval rather than raising a second one.
 */
export type SpawnApprovalResult = { pending: true } | { pending: false; decisions: boolean[] }

/** Tool-result note for a `pending` SpawnApprovalResult, shared by every dispatch case below. */
const SPAWN_APPROVAL_PENDING_NOTE = 'awaiting operator approval -- retry this exact call to check the verdict'

/** A session as deck-control sees it: the renderer-visible runtime plus the caller id minted for a team-lead tile. */
export type DeckControlSession = SessionRuntime & { mintedCallerId?: string | null }

export type CallerAuthority = 'author' | 'lead' | 'supervisor'

export interface DeckControlDeps {
  /**
   * Run mandates, one per caller, minted asynchronously by the main. A request
   * is never a grant: the mandate is usable only once the main has it ready.
   */
  inboxMandates: {
    request(callerRef: string, authority: CallerAuthority): void
    release(callerRef: string): void
  }
  listAgents(): string[]
  listModels(): ModelOption[]
  listPresets(): LaunchPreset[]
  /** Same path as the operator's create (worktree handling included). */
  spawnSession(
    input: CreateSessionInput,
    opts?: { hasDeckLeadTools?: boolean }
  ): Promise<SessionRuntime>
  listSessions(): DeckControlSession[]
  /** The operator's agent spawn cap, read at every reservation so a Settings change applies to the next spawn. */
  getSpawnCap(): number
  restartSession(id: string): Promise<void>
  closeSession(id: string): Promise<void>
  journal(message: string): void
  createWorktree(branch: string): Promise<WorktreeInfo>
  listWorktrees(): Promise<WorktreeInfo[]>
  removeWorktree(path: string): Promise<void>
  listTemplates(): TemplateSummary[]
  /** May prompt the operator and persist an approval, but never spawns, so the batch is approved before any tile exists. */
  resolveTemplate(path: string): Promise<TemplateResolveResult>
  spawnTemplateEntry(
    input: TemplateInput,
    opts: { checkpoint: boolean; hasLead: boolean }
  ): Promise<SessionRuntime>
  saveTemplate(name: string, local: boolean): string | null
  announce(text: string): Promise<number>
  /**
   * Trust-mode gate (TS4/card 02e1c07c): hands-free approves all without any
   * round trip; team-review raises ONE guarded approval for the whole batch
   * (all-or-nothing); full-control raises one per entry, and a batch's
   * decisions[i] is true only for the entry whose OWN approval was granted.
   * `callerId` is the server-known requester (never an agent-declared
   * tile_ref) -- it is what the operator sees as the author of the request.
   * `plan` is the RAW resolved entry per index in `entries` (a
   * SpawnPlanEntry, or a TemplateInput for deck_apply_template) -- what a
   * retry's footprint is computed over, kept separate from `entries` (the
   * truncated display summary) so a field the summary omits or truncates
   * (`announce`, the full `prompt`) cannot change without changing what the
   * caller is asking the operator to approve.
   * Never blocks on a dialog: a `pending` result means the caller must retry
   * this exact call to observe the verdict once it settles. Implemented by
   * index.ts.
   */
  approveSpawn(entries: SpawnSummary[], plan: unknown[], callerId: string): Promise<SpawnApprovalResult>
  /** Resolve a spawned session's peer_id, or null on timeout/exit (TS3). */
  waitForPeer(id: string, timeoutMs: number): Promise<string | null>
  /** Arm the async connection ack targeted at the supervisor (TS3). */
  armSpawnAck(id: string, name: string): void
  /** Write an embedded profile's prompt file and return its path (TS1). */
  writeEmbeddedPrompt(id: string): string
  /**
   * `token` and `callerId` come from a fresh mintCaller() call per team-lead
   * spawn, never the supervisor's, so a second mint cannot silently invalidate
   * the first spawn's config file.
   * `allowedTools` is the same array reference already passed to mintCaller, so
   * the server-side scope and the client-side filter cannot independently drift
   * apart.
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
  /** True while sandbox mode is on: the demo bridge is a host loopback endpoint a container cannot reach. */
  sandboxEnabled(): boolean
  /** One demo-control server and --mcp-config for a demo tile; throws a readable reason when the embedded browser cannot be driven. */
  mintDemoTile(): Promise<DemoTileMint>
  confirmSpawnShellFields(entry: { command?: string; args?: string }): Promise<boolean>
  /**
   * Run a shell command INSIDE this project's sandbox container
   * (PLAN-SANDBOX M2): "add this dependency to the instance". Rejected when
   * sandbox mode is off. The command never touches a host shell — the
   * sandbox service hands it to the container's bash as one argv element.
   */
  sandboxExec(command: string): Promise<SandboxExecResponse>
  runDirective(
    directive: DeckDirective,
    peerIds: string[],
    prompt: string | undefined,
    callerId: string,
    excludeSupervisor?: boolean,
    options?: { contextDepositId?: string }
  ): Promise<DeckDirectiveRunResult>
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
    allowedTools?: readonly string[] | null,
    authority?: CallerAuthority
  ): { token: string; callerId: string }
  /**
   * Revoke the caller minted for a team-lead SESSION on its final removal, keyed by the session id (the object index
   * caller ipc already has) rather than by callerId (which the caller would
   * have to have tracked separately). No-ops (returns null) for a session
   * that was never minted its own caller -- the supervisor tile, any
   * non-lead profile. Returns the revoked callerId on a real revocation, so
   * the caller can also delete the matching --mcp-config file.
   * A demo tile has no caller: the same call closes its demo-control server
   * and deletes its own config file, and returns null.
   */
  revokeCallerForSession(sessionId: string): string | null
  close(): void
}

/**
 * The Deck has one embedded <webview>, so one demo drives it at a time, tile or
 * headless run, whatever the number of endpoints: the slot belongs to the
 * process and has one holder. It is taken synchronously, before the first
 * await of either path, so two racing starts cannot both pass the check.
 */
interface DemoSlot {
  owner: 'tile' | 'headless'
  sessionId: string | null
  mint: DemoTileMint | null
}
let demoSlot: DemoSlot | null = null
const sessionDemoSlot = new Map<string, DemoSlot>()

function releaseDemoSlot(slot: DemoSlot): void {
  slot.mint?.release()
  if (slot.sessionId) sessionDemoSlot.delete(slot.sessionId)
  if (demoSlot === slot) demoSlot = null
}

/** The headless launcher's claim on the embedded browser; the holder must call `release` in a finally. */
export function acquireDemoBrowser(): { ok: true; release(): void } | { ok: false; reason: string } {
  if (demoSlot) {
    return {
      ok: false,
      reason: demoSlot.owner === 'tile' ? 'a demo tile is live on the embedded browser' : 'a demo scenario is already running'
    }
  }
  const slot: DemoSlot = { owner: 'headless', sessionId: null, mint: null }
  demoSlot = slot
  return { ok: true, release: () => releaseDemoSlot(slot) }
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
 * The recap shown by the approval dialog for a template batch (card 89cb66f9)
 * -- mirrors summarizeEntry above, but from a TemplateInput (which carries a
 * separate `command` field the shell-field-approval hash already covers, so
 * both are folded into `args` here for the operator to actually SEE what a
 * template entry runs, same reasoning as summarizeEntry's own `args`). A
 * `[clodex]` prefix names the wrapper that changes the launch binary. A
 * `[lead]` prefix flags an entry that will take the window's crown (PLAN
 * C18) -- otherwise the dialog never says a tile is about to become lead.
 */
function summarizeTemplateInput(input: TemplateInput): SpawnSummary {
  return {
    name: (input.bridge === 'clodex' ? '[clodex] ' : '') + (input.lead ? '[lead] ' : '') + (input.name ?? input.agent ?? 'peer'),
    agent: input.agent ?? '',
    embedded: '',
    model: input.model ?? '',
    effort: input.effort ?? '',
    cli: 'claude',
    worktree_branch: input.worktreeBranch ?? '',
    prompt_preview: (input.prompt ?? '').slice(0, 160),
    args: [input.command ?? '', input.args ?? ''].filter(Boolean).join(' ')
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
  /** Set by the provisioning path that minted the caller, never read from its label. */
  authority: CallerAuthority
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
  callerTable.set(token, { callerId: 'supervisor', allowedTools: null, authority: 'supervisor' })
  deps.inboxMandates.request('supervisor', 'supervisor')

  /**
   * Mint a fresh token/callerId pair (Card 6c380073). callerId includes a
   * random suffix so two mints of the same label (e.g. two team-lead spawns)
   * never collide -- each gets its own ownedSessions entries and its own
   * --mcp-config filename downstream.
   * The authority defaults to author: a 'team-lead' label alone elevates
   * nothing, only a lead provisioning path passing 'lead' does.
   */
  function mintCaller(
    label: string,
    allowedTools?: readonly string[] | null,
    authority: CallerAuthority = 'author'
  ): { token: string; callerId: string } {
    const mintedToken = randomBytes(24).toString('hex')
    const callerId = `${label}-${randomBytes(4).toString('hex')}`
    callerTable.set(mintedToken, {
      callerId,
      allowedTools: allowedTools ? [...allowedTools] : null,
      authority
    })
    deps.inboxMandates.request(callerId, authority)
    return { token: mintedToken, callerId }
  }

  /**
   * Reverse lookup over callerTable: the token is the map key and callerId only
   * lives in the value, so every token registered under callerId must be found
   * by scanning. No-op if callerId is not registered.
   */
  function revokeCaller(callerId: string): void {
    let revoked = false
    for (const [tok, entry] of callerTable) {
      if (entry.callerId === callerId) {
        callerTable.delete(tok)
        revoked = true
      }
    }
    if (revoked) deps.inboxMandates.release(callerId)
  }

  /** The caller id minted for this tile's own calls: runtime state first, then the spawn-time map. */
  function callerForSession(sessionId: string): string | null {
    return (
      deps.listSessions().find((session) => session.id === sessionId)?.mintedCallerId ??
      sessionMintedCallerId.get(sessionId) ??
      null
    )
  }

  /** Embedded team-lead tiles spawned under sandbox: born without the deck-control bridge. */
  const bridgeRefusedSessions = new Set<string>()

  function spawnedView(session: SessionRuntime): Record<string, unknown> {
    return bridgeRefusedSessions.has(session.id)
      ? { ...sessionView(session), bridge_note: 'bridge refused: sandbox -- this lead tile has no deck-control' }
      : sessionView(session)
  }

  function refuseDemoSpawn(reason: string): never {
    const message = `refused: ${reason}`
    reportError('deck-control', `demo spawn ${message}`)
    throw new Error(message)
  }

  function assertDemoSpawnAvailable(): void {
    if (deps.sandboxEnabled()) {
      refuseDemoSpawn(
        'a demo tile cannot start while sandbox mode is on (its browser bridge is a host loopback endpoint a container cannot reach)'
      )
    }
    if (demoSlot?.owner === 'headless') {
      refuseDemoSpawn('a headless demo scenario is running on the embedded browser -- wait for it or cancel it first')
    }
    if (demoSlot) {
      refuseDemoSpawn('a demo tile is already live: the Deck has a single embedded browser -- close that tile first')
    }
  }

  /** See DeckControlServer.revokeCallerForSession's own doc. */
  function revokeCallerForSession(sessionId: string): string | null {
    const demo = sessionDemoSlot.get(sessionId)
    if (demo) releaseDemoSlot(demo)
    bridgeRefusedSessions.delete(sessionId)
    const callerId = callerForSession(sessionId)
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
   * Session id -> the callerId MINTED FOR that session's own future calls (never the spawning caller's own callerId,
   * already tracked by ownedSessions above -- a distinct dimension). Only
   * populated for a team-lead spawn. Read by revokeCallerForSession on final
   * removal so a departed lead's token/file stop authorizing anything.
   */
  const sessionMintedCallerId = new Map<string, string>()
  /** A second deck_close_all would re-read tiles the first is closing and force their cleanup (a kill without /exit). */
  let closeAllInFlight = false

  const spawnCap = createSpawnCap(deps.listSessions, {
    getCap: () => deps.getSpawnCap(),
    onInvalidCap: (value) =>
      reportError('deck-control', `invalid agent spawn cap (${String(value).slice(0, 40)}), applying ${SPAWN_CAP}`)
  })

  /** Spawn one validated entry (shared by deck_spawn_session / deck_spawn_team). */
  async function spawnEntry(
    entry: SpawnPlanEntry,
    embedded: EmbeddedAgent | null,
    callerId: string
  ): Promise<SessionRuntime> {
    // Embedded team-lead lands as the window lead only when none is live
    // (same rule as templates, PLAN C18 -- never demote an operator's lead).
    const hasLiveLead = deps.listSessions().some((s) => s.lead && s.status !== 'exited')
    // A team-lead tile gets its OWN minted caller (never the spawning caller's), and
    // TEAM_LEAD_DECK_TOOLS is named once for both the server-side scope and the config's tool list.
    // Under sandbox the tile is born without the bridge, so a live lead credit would sit unused on the host.
    const bridgeRefused = embedded?.id === 'team-lead' && deps.sandboxEnabled()
    if (bridgeRefused) reportError('deck-control', 'team-lead bridge refused: sandbox mode is on')
    const leadMint =
      embedded?.id === 'team-lead' && !bridgeRefused ? mintCaller('team-lead', TEAM_LEAD_DECK_TOOLS, 'lead') : null
    const input: CreateSessionInput = {
      name: entry.name ?? embedded?.id,
      agent: entry.agent,
      model: entry.model,
      effort: entry.effort,
      args: entry.args,
      prompt: entry.prompt,
      worktreeBranch: entry.worktreeBranch,
      announce: entry.announce,
      appendSystemPromptFile: embedded ? deps.writeEmbeddedPrompt(embedded.id) : undefined,
      lead: embedded?.id === 'team-lead' && !hasLiveLead ? true : undefined,
      peerTools: embedded?.peerTools,
      strictMcpConfig: embedded?.strictMcpConfig,
      // Embedded read-only roles get their tool denial at harness level, on every launch.
      disallowedTools: embedded?.disallowedTools.length ? [...embedded.disallowedTools] : undefined,
      // The profile id, not `embedded.role` (a prose summary); an operator-profile spawn poses no role.
      role: embedded?.id,
      // Only the embedded team-lead gets the deck-control bridge.
      mcpConfig: leadMint
        ? deps.writeTeamLeadMcpConfig(leadMint.token, leadMint.callerId, TEAM_LEAD_DECK_TOOLS)
        : undefined
    }
    let demoSlotTaken: DemoSlot | null = null
    if (embedded?.id === 'demo') {
      assertDemoSpawnAvailable()
      demoSlotTaken = { owner: 'tile', sessionId: null, mint: null }
      demoSlot = demoSlotTaken
      try {
        demoSlotTaken.mint = await deps.mintDemoTile()
      } catch (e) {
        releaseDemoSlot(demoSlotTaken)
        reportError('deck-control', 'demo tile could not be minted', e)
        throw e
      }
      input.mcpConfig = demoSlotTaken.mint.mcpConfig
    }
    let created: SessionRuntime
    try {
      created = await deps.spawnSession(input, leadMint ? { hasDeckLeadTools: true } : undefined)
    } catch (e) {
      if (demoSlotTaken) releaseDemoSlot(demoSlotTaken)
      if (leadMint) {
        revokeCaller(leadMint.callerId)
        deps.revokeTeamLeadMcpConfig(leadMint.callerId)
      }
      throw e
    }
    ownedSessions.set(created.id, callerId)
    if (bridgeRefused) bridgeRefusedSessions.add(created.id)
    if (leadMint) sessionMintedCallerId.set(created.id, leadMint.callerId)
    if (demoSlotTaken) {
      demoSlotTaken.sessionId = created.id
      sessionDemoSlot.set(created.id, demoSlotTaken)
    }
    // First writer wins: a path collision must not let a second caller steal an existing worktree entry.
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
            disallowed_tools: a.disallowedTools.join(',') || null
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
        if (embedded?.id === 'demo') assertDemoSpawnAvailable()
        assertArgsAllowedForRestrictedCaller(entry, restricted)
        if (!(await deps.confirmSpawnShellFields({ args: entry.args }))) {
          throw new Error('refused: this launch carries unapproved shell arguments')
        }
        const releaseCapacity = spawnCap.reserve(1)
        let created!: SessionRuntime
        try {
          const approval = await deps.approveSpawn([summarizeEntry(entry, embedded)], [entry], callerId)
          if (approval.pending) {
            return { pending: true, note: SPAWN_APPROVAL_PENDING_NOTE }
          }
          if (!approval.decisions[0]) throw new Error('spawn refused by the operator')
          created = await spawnEntry(entry, embedded, callerId)
        } finally {
          releaseCapacity()
        }
        // Sync ack by default (single-agent contract, TS3): the result carries
        // the peer_id. wait_for_peer:false switches to the async targeted ack.
        if (args['wait_for_peer'] === false) {
          deps.armSpawnAck(created.id, created.name)
          return {
            session: spawnedView(created),
            note: 'async ack armed: the Deck will notify you when this session connects'
          }
        }
        const peerId = await deps.waitForPeer(created.id, WAIT_PEER_TIMEOUT_MS)
        if (peerId === null) {
          // Not resolved in time: fall back to the async ack so the supervisor
          // still hears about it (connected or failed) without polling.
          deps.armSpawnAck(created.id, created.name)
          return {
            session: spawnedView(created),
            peer_id: null,
            note: 'peer_id not resolved yet -- the Deck will notify you when this session connects (or fails to)'
          }
        }
        return { session: spawnedView(created), peer_id: peerId }
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
        const demoEntries = embeddeds.filter((embedded) => embedded?.id === 'demo').length
        if (demoEntries > 1) refuseDemoSpawn('a team can hold only one demo entry: the Deck has a single embedded browser')
        if (demoEntries === 1) assertDemoSpawnAvailable()
        for (const entry of entries) {
          assertArgsAllowedForRestrictedCaller(entry, restricted)
          if (!(await deps.confirmSpawnShellFields({ args: entry.args }))) {
            throw new Error('refused: this team plan carries unapproved shell arguments')
          }
        }
        const releaseCapacity = spawnCap.reserve(entries.length)
        try {
          const approval = await deps.approveSpawn(
            entries.map((entry, i) => summarizeEntry(entry, embeddeds[i] ?? null)),
            entries,
            callerId
          )
          if (approval.pending) {
            return { pending: true, note: SPAWN_APPROVAL_PENDING_NOTE }
          }
          const decisions = approval.decisions
          const spawned: Record<string, unknown>[] = []
          let refused = 0
          // The demo entry goes first: if another demo took the slot during the approval, it
          // throws before any other member of the team has been spawned.
          const order = entries
            .map((_, i) => i)
            .sort((a, b) => Number(embeddeds[b]?.id === 'demo') - Number(embeddeds[a]?.id === 'demo'))
          for (const i of order) {
            if (!decisions[i]) {
              refused++
              continue
            }
            const created = await spawnEntry(entries[i]!, embeddeds[i] ?? null, callerId)
            deps.armSpawnAck(created.id, created.name)
            spawned.push(spawnedView(created))
          }
          return {
            spawned,
            refused,
            note:
              spawned.length > 0
                ? 'async acks armed: the Deck will notify you as each session connects'
                : 'nothing spawned'
          }
        } finally {
          releaseCapacity()
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
        // Resolves the object first (its recorded owner, or undefined if never
        // seen), then asks whether this caller may act on it. An absent id
        // refuses the same way a wrong-owner id does, never falling back to a
        // default owner.
        if (ownedSessions.get(id) !== callerId) {
          throw new Error(
            'refused: only a session spawned by this same caller can be restarted -- ask the operator for the rest'
          )
        }
        const targetSession = deps.listSessions().find((session) => session.id === id)
        if (restricted && (targetSession?.lead || targetSession?.supervisor)) {
          throw new Error('refused: a team-lead cannot restart a lead or supervisor tile')
        }
        const releaseCapacity = targetSession?.status === 'exited' ? spawnCap.reserve(1) : null
        try {
          await deps.restartSession(id)
          return { ok: true }
        } finally {
          releaseCapacity?.()
        }
      }

      case 'deck_close_session': {
        const id = str(args, 'id')
        const peerId = str(args, 'peer_id')
        // The MCP schema requires neither argument and validates nothing: these
        // two lines are the exactly-one-of rule.
        if (id && peerId) throw new Error('id and peer_id are mutually exclusive -- pick one')
        if (!id && !peerId) throw new Error('id or peer_id is required')
        let target = id
        if (peerId) {
          const resolved = resolveDirectiveTargets([peerId], deps.listSessions())
          // Refused before `matched` is read: closing is irreversible, so an
          // annotated ambiguity must refuse whatever `matched` holds.
          if (resolved.ambiguous.length > 0) {
            throw new Error(
              `refused: peer_id "${peerId}" is ambiguous -- several live tiles carry it, close it by tile id instead`
            )
          }
          const hit = resolved.matched[0]
          if (!hit) throw new Error(`refused: no live session carries peer_id "${peerId}"`)
          target = hit.id
        }
        const targetSession = deps.listSessions().find((session) => session.id === target)
        if (!targetSession) throw new Error(`refused: no live session carries id "${target}"`)
        if (targetSession.locked) {
          deps.journal(`deck_close_session refused: peer verrouillé (${target})`)
          throw new Error('refused: peer verrouillé')
        }
        if (restricted) {
          if (callerForSession(target) === callerId) {
            throw new Error('refused: a team-lead cannot close its own tile')
          }
          if (targetSession.lead || targetSession.supervisor) {
            throw new Error('refused: a team-lead cannot close a lead or supervisor tile')
          }
        } else if (targetSession.supervisor) {
          throw new Error('refused: the supervisor cannot close a supervisor tile')
        }
        await deps.closeSession(target)
        ownedSessions.delete(target)
        return { ok: true }
      }

      case 'deck_close_all': {
        if (closeAllInFlight) throw new Error('refused: deck_close_all already running')
        closeAllInFlight = true
        try {
          const isLeadTile = (session: DeckControlSession): boolean =>
            !!session.lead || callerForSession(session.id) !== null
          const closed: string[] = []
          const locked: string[] = []
          const failed: { name: string; error: string }[] = []
          const handled = new Set<string>()
          const skipLocked = (session: DeckControlSession): void => {
            deps.journal(`deck_close_all skipped: peer verrouillé (${session.id})`)
            locked.push(session.name)
          }
          // The live list is re-read before each wave: a lock set or a tile
          // removed while the previous wave was closing must be honoured.
          for (const leadWave of [false, true]) {
            const wave: DeckControlSession[] = []
            for (const session of deps.listSessions()) {
              if (session.supervisor || (restricted && isLeadTile(session)) || handled.has(session.id) || isLeadTile(session) !== leadWave) continue
              handled.add(session.id)
              if (session.locked) {
                skipLocked(session)
                continue
              }
              wave.push(session)
            }
            const settled = await Promise.allSettled(wave.map(async (session) => deps.closeSession(session.id)))
            settled.forEach((outcome, i) => {
              const session = wave[i]!
              if (outcome.status === 'fulfilled') {
                ownedSessions.delete(session.id)
                closed.push(session.name)
                return
              }
              const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
              deps.journal(`deck_close_all failed for ${session.id}: ${error}`)
              failed.push({ name: session.name, error })
            })
          }
          // Tiles spawned during the call (a lead may spawn while the first wave closes).
          const remaining: string[] = []
          for (const session of deps.listSessions()) {
            if (session.supervisor || (restricted && isLeadTile(session)) || handled.has(session.id)) continue
            if (session.locked) skipLocked(session)
            else remaining.push(session.name)
          }
          return { closed, locked, failed, remaining }
        } finally {
          closeAllInFlight = false
        }
      }

      case 'deck_run_directive': {
        const { directive, peerIds, prompt, workstream, contextDepositId } = parseRunDirectiveArgs(args)
        if (restricted && directive === 'clear_reload') {
          const sessions = deps.listSessions()
          const { matched } = resolveDirectiveTargets(peerIds, sessions)
          const target = matched[0]
          if (peerIds.length !== 1 || matched.length !== 1 || !target) {
            throw new Error('refused: a team-lead may clear_reload exactly one live tile')
          }
          if (callerForSession(target.id) !== callerId) {
            const targetSession = sessions.find((session) => session.id === target.id)
            if (!targetSession) throw new Error(`refused: no live session carries id "${target.id}"`)
            if (targetSession.locked) {
              deps.journal(`deck_run_directive refused: peer verrouillé (${target.id})`)
              throw new Error('refused: peer verrouillé')
            }
            if (targetSession.lead || targetSession.supervisor || callerForSession(target.id) !== null) {
              throw new Error('refused: a team-lead cannot clear_reload a lead or supervisor tile')
            }
            if (!contextDepositId) {
              throw new Error("refused: a team-lead may clear_reload another peer only with that peer's context_deposit_id")
            }
          }
        }
        const run = await deps.runDirective(
          directive,
          peerIds,
          directive === 'clear_reload' ? workstream : prompt,
          callerId,
          restricted,
          contextDepositId ? { contextDepositId } : undefined
        )
        return {
          directive,
          injected: run.injected.map((t) => t.peerId),
          refused: run.refused.map((t) => ({ peerId: t.peerId, reason: t.reason })),
          pending: run.pending.map((t) => t.peerId),
          unreached: run.unreached,
          ...(run.error ? { error: run.error } : {})
        }
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
        const resolved = await deps.resolveTemplate(path)
        const inputs = templateInputsOrEmpty(resolved)
        if (inputs.length === 0) {
          return resolved.ok
            ? { spawned: 0, refused: 0 }
            : { spawned: 0, refused: 0, resolution: resolved.reason }
        }
        const releaseCapacity = spawnCap.reserve(inputs.length)
        try {
          const approval = await deps.approveSpawn(inputs.map(summarizeTemplateInput), inputs, callerId)
          if (approval.pending) {
            return { pending: true, note: SPAWN_APPROVAL_PENDING_NOTE }
          }
          const decisions = approval.decisions
          // hasLead is decided once for the whole batch.
          const hasLead = deps.listSessions().some((s) => s.lead && s.status !== 'exited')
          let spawned = 0
          // Counted, not derived, so a future skip reason stays distinct from an operator refusal.
          let refused = 0
          for (let i = 0; i < inputs.length; i++) {
            if (!decisions[i]) {
              refused++
              continue
            }
            const created = await deps.spawnTemplateEntry(inputs[i]!, {
              checkpoint: spawned === 0,
              hasLead
            })
            ownedSessions.set(created.id, callerId)
            spawned++
          }
          // Distinct from a resolved-but-empty template (spawned:0, refused:0
          // above): a total refusal by the operator must not read the same as
          // "there was nothing to spawn" (same shape as deck_spawn_team).
          return { spawned, refused }
        } finally {
          releaseCapacity()
        }
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
