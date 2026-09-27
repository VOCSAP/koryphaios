// No @shared import and no electron/deck-control import, so this module stays
// importable under a plain bun test run; session-service.ts itself cannot be,
// since it imports @shared/palette.
// Synchronous by design: the deck-control server is started proactively by the
// caller before create() runs, so the mint function here only ever reads
// whatever is currently available, never starts anything itself.
// The bridge marker is a function parameter, never a property of the create()
// input object, since that object is forwarded verbatim from a remote-reachable
// channel.
// This closes only the shortcut of forging the marker directly; a caller
// requesting agent: 'team-lead' through the normal path still gets the bridge
// by design.
import { TEAM_LEAD_DECK_TOOLS } from './supervisor'

export interface TeamLeadBridgeInput {
  /** Already-trimmed, may be empty/undefined -- an explicit value always wins. */
  mcpConfig?: string
  name?: string
}

export type MintTeamLeadBridge = () => { mcpConfig: string; callerId: string } | null

/**
 * Single source of truth for computing the `agent`-based deck-control bridge
 * marker (the `agent: 'team-lead'` field, exact match, no prefix/substring).
 * Every call site that needs it (ipc.ts's sessions:create and template:apply,
 * index.ts's spawnTemplateEntry and spawnSession) goes through this instead
 * of repeating the string comparison. Distinct from the `embedded_agent`
 * route's own team-lead decision (deck-control.ts's `embedded?.id ===
 * 'team-lead'`), which stays a separate check on a separate field.
 */
export function isTeamLeadAgent(agent: string | undefined): boolean {
  return agent === 'team-lead'
}

export interface EffectiveAgent {
  agent: string | undefined
  /** Set, with the reason, when a bridge is at stake and `args` cannot be read reliably; `agent` is then undefined. */
  ambiguity?: string
}

const FLAG_TOKEN = /^--[a-z][a-z-]*$/
// Unquoted values exclude brackets (a glob), a leading dash (a flag lookalike)
// and a leading @ (a PowerShell splat).
const BARE_VALUE_TOKEN = /^[A-Za-z0-9._:/][A-Za-z0-9._:@/-]*$/
const QUOTED_VALUE_TOKEN = /^"[A-Za-z0-9._:@/[\]-]+"$/

function isValueToken(token: string | undefined): token is string {
  return token !== undefined && (BARE_VALUE_TOKEN.test(token) || QUOTED_VALUE_TOKEN.test(token))
}

function namesTeamLeadAsAgent(source: string): boolean {
  const words = source.split(/\s+/)
  return words.some((w, i) => i > 0 && words[i - 1] === '--agent' && isTeamLeadAgent(w.replace(/^"(.*)"$/, '$1')))
}

/**
 * The agent the CLI will actually run: `args` is appended after the
 * `--agent` built from `agent`, and the CLI keeps the LAST `--agent`, so the
 * last `--agent` in `args` wins over `agent`. The text reading only matches
 * the shell's when `args` is an allow-listed sequence of flags and simple
 * values separated by single spaces; when a team-lead bridge is at stake (the
 * agent field, or a word right after an --agent, is team-lead), any other
 * shape yields an ambiguity instead of a guess.
 * A consistency check on text, not a security barrier: the barrier is the
 * shell-field approval every non-empty args goes through.
 */
export function effectiveAgent(agent: string | undefined, args: string | undefined): EffectiveAgent {
  const source = (args ?? '').trim()
  if (!source) return { agent }
  const bridgeAtStake = isTeamLeadAgent(agent) || namesTeamLeadAsAgent(source)
  const refuse = (reason: string): EffectiveAgent =>
    bridgeAtStake ? { agent: undefined, ambiguity: `args ${reason}` } : { agent: undefined }

  const tokens = source.split(' ')
  if (!tokens.every((t) => FLAG_TOKEN.test(t) || isValueToken(t))) {
    return refuse('are not a plain sequence of flags and simple values')
  }
  let resolved = agent
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--agents') return refuse('contain --agents, which can redefine an agent profile')
    if (tokens[i] !== '--agent') continue
    // The arity of the preceding flag is unknown here: the CLI may take this
    // --agent as that flag's value.
    if (i > 0 && FLAG_TOKEN.test(tokens[i - 1]!)) {
      return refuse('contain an --agent right after another flag, which may consume it as its value')
    }
    const value = tokens[i + 1]
    if (!isValueToken(value)) return refuse('contain an --agent not followed by a simple value')
    resolved = value.startsWith('"') ? value.slice(1, -1) : value
  }
  return { agent: resolved }
}

/**
 * True only when: no mcpConfig is already set, the caller-supplied
 * `marker` is `true` (a plain boolean, NEVER read off `input` -- see this
 * module's header), AND the (already sanitizeFlagValue'd) agent is exactly
 * 'team-lead'. All three are load-bearing -- dropping any one of them widens
 * which tile can receive the deck-control bridge.
 */
export function wantsTeamLeadBridge(
  input: TeamLeadBridgeInput,
  sanitizedAgent: string,
  marker: boolean
): boolean {
  return !input.mcpConfig?.trim() && marker === true && isTeamLeadAgent(sanitizedAgent)
}

/**
 * Resolves the mcpConfig to use: the input's own value if set, else a freshly
 * minted bridge, else undefined. Never throws: a mint failure is reported and
 * degrades to no bridge for this spawn.
 * marker is the only input trusted for the bridge decision beyond
 * mcpConfig/sanitizedAgent; callers must construct it from a channel a remote
 * payload cannot influence.
 */
export function resolveMcpConfig(
  input: TeamLeadBridgeInput,
  sanitizedAgent: string,
  marker: boolean,
  mint: MintTeamLeadBridge,
  report: (scope: string, message: string, error?: unknown) => void,
  ambiguity?: string
): string | undefined {
  const explicit = input.mcpConfig?.trim() || undefined
  if (explicit) return explicit
  const sessionName = input.name?.trim() || 'unnamed session'
  if (ambiguity) {
    report('session', `team-lead deck-control bridge refused for ${sessionName}: ${ambiguity}`)
    return undefined
  }
  if (!wantsTeamLeadBridge(input, sanitizedAgent, marker)) {
    if (isTeamLeadAgent(sanitizedAgent) && !marker) {
      report('session', `team-lead deck-control bridge refused for ${sessionName}: trusted marker is absent`)
    }
    return undefined
  }
  try {
    const bridge = mint()
    if (bridge) return bridge.mcpConfig
    report(
      'session',
      'team-lead deck-control bridge unavailable (deck-control server not started yet) -- tile opened without it'
    )
    return undefined
  } catch (e) {
    report('session', 'failed to mint the team-lead deck-control bridge', e)
    return undefined
  }
}

/** Minimal shape `buildMintTeamLeadBridge` needs from the real DeckControlServer (deck-control.ts) -- a structural subset, not an import of that type, so this module never pulls in deck-control.ts's own dependency graph. */
export interface DeckControlServerLike {
  url: string
  mintCaller(label: string, allowedTools?: readonly string[] | null): { token: string; callerId: string }
}

/**
 * getControlServer reads whatever is currently available; starting the server
 * is the caller's job, proactively, before create() is ever called.
 * write reuses the caller's existing writeTeamLeadMcpConfig rather than
 * reimplementing the state-dir/mcpScript resolution a second time, which could
 * drift from the first.
 * TEAM_LEAD_DECK_TOOLS is named once and passed to both mintCaller and write so
 * the server-side scope and the client-side tool list can never independently
 * drift.
 */
export function buildMintTeamLeadBridge(deps: {
  getControlServer: () => DeckControlServerLike | null
  /** Same contract as DeckControlDeps.writeTeamLeadMcpConfig (deck-control.ts). */
  write: (token: string, callerId: string, allowedTools: readonly string[]) => string
}): MintTeamLeadBridge {
  return () => {
    // Load-bearing: this closure is synchronous on purpose, with no await
    // between getControlServer() and write() below -- that is what guarantees
    // server.url (baked into the MCP config write produces) and the token
    // minted by this same server designate the identical deck-control instance.
    // Making this async would let a yield point between the two calls allow
    // controlServer to be reassigned to a different instance in between,
    // producing a token and URL that fail to match.
    const server = deps.getControlServer()
    if (!server) return null
    const { token, callerId } = server.mintCaller('team-lead', TEAM_LEAD_DECK_TOOLS)
    const mcpConfig = deps.write(token, callerId, TEAM_LEAD_DECK_TOOLS)
    return { mcpConfig, callerId }
  }
}
