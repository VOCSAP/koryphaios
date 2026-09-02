// Card 3c322f10 (piece 2, operator route): the pure decision + wiring glue for
// minting the team-lead deck-control bridge inside SessionService.create().
//
// Kept in its OWN module, deliberately with NO `@shared` import and no
// electron/deck-control import (only supervisor.ts, itself "Node builtins
// only, unit-testable under bun test" per its own header), so this whole
// module is importable under a plain `bun test` run from the repo root.
// session-service.ts itself is NOT: it imports `@shared/palette`, which has
// no path mapping outside desktop's own tsconfig.node.json (tests/ is a
// sibling of desktop/, not under its tsconfig scope) -- measured, `bun test`
// on a file that imports session-service.ts directly fails with "Cannot find
// module '@shared/palette'" before ever reaching node-pty. That is exactly
// why the two existing guards for session-service.ts internals
// (tests/desktop-session-role-env.test.ts, tests/desktop-session-peer-tools-
// wiring.test.ts) fall back to a source-text scan instead of a behavioural
// test. Extracting this decision (and the allow-list wiring below) here
// avoids needing that fallback for either.
//
// SYNC BY DESIGN (team-lead arbitration, Card 3c322f10): an earlier version
// made this async so the mint function could itself lazily start the
// deck-control server, which would have forced SessionService.create() to
// become async too -- inserting a microtask yield point BEFORE
// `this.defs.push(def)` on EVERY create() call, not only team-lead ones,
// making session creation non-atomic for a feature that never needed that
// cost. Rejected: the lazy start is instead PROACTIVE, awaited by ipc.ts's
// `sessions:create` handler (already async) BEFORE it ever calls into
// create() -- see index.ts's `ensureControlServer()`. By the time this
// module's mint function runs, the server is already up or the caller chose
// not to wait for it; `getControlServer` below is a plain synchronous getter
// reading whatever is currently available, never one that starts anything.
//
// THE MARKER IS DELIBERATELY NOT A PROPERTY OF `input`. An earlier version of
// this module read a `teamLeadDeckBridge` field off the same `input` object
// SessionService.create() receives -- but that object IS `CreateSessionInput`,
// the exact JSON shape ipc.ts's `sessions:create` handler forwards VERBATIM
// (no field-by-field reconstruction) from whichever caller invoked it, and
// that channel is CHANNEL_TIERS 2 (shared/companion.ts) -- remote-reachable
// by a paired companion/phone client via api-registry.ts's invokeRemote, not
// merely by the local renderer. A boolean living on that same object grants a
// capability to anyone who can write JSON on that channel, regardless of
// which convention says only main-side code should ever set it -- exactly
// the "comment asserts a guarantee nothing enforces" anti-pattern CLAUDE.md
// forbids, already carded generically as 28d63a42 for `mcpConfig`/
// `appendSystemPromptFile`/`supervisor`/`lead` (a separate, still-open card
// this module does NOT attempt to fix). Passing the marker as its OWN
// function parameter instead means there is no PROPERTY NAME a remote
// payload could carry that would ever reach this decision DIRECTLY.
//
// STATE THE BOUNDARY PRECISELY (security review correction, 2026-09-02): the
// PROPERTY is unreachable, the OUTCOME is not. `marker` is computed by
// ipc.ts's `sessions:create` handler as a pure function of `input.agent`,
// which the caller fully controls -- a paired companion requesting
// `agent: 'team-lead'` DOES get the bridge, by design, today. What this
// split closes is the SHORTCUT (granting the bridge to some OTHER agent, or
// to a template/workspace/one-shot-agent input, by forging the boolean
// directly), not remote reachability of the team-lead bridge itself. The
// residual reachability is an accepted operator arbitration: a paired
// companion already has CHANNEL_TIERS-1 `pty:input` into any live tile, i.e.
// arbitrary command execution by shell-prefix, so the 3 deck-control tools
// add no marginal power over what that channel already grants.
import { TEAM_LEAD_DECK_TOOLS } from './supervisor'

export interface TeamLeadBridgeInput {
  /** Already-trimmed, may be empty/undefined -- an explicit value always wins. */
  mcpConfig?: string
}

export type MintTeamLeadBridge = () => { mcpConfig: string; callerId: string } | null

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
  return !input.mcpConfig?.trim() && marker === true && sanitizedAgent === 'team-lead'
}

/**
 * Resolve the mcpConfig SessionService.create() should use: the input's own
 * value if already set, else a freshly minted team-lead bridge when
 * wantsTeamLeadBridge() says so, else undefined. Never throws: a
 * mintTeamLeadBridge failure (null return -- e.g. the deck-control server has
 * not been started by ipc.ts's proactive ensureControlServer() -- or a
 * thrown error) is reported via `report` and degrades to "no bridge for this
 * spawn", never blocks session creation.
 *
 * `marker` is the ONLY input this function trusts for the bridge decision
 * beyond `input.mcpConfig`/`sanitizedAgent` -- it is never derived from a
 * property of `input` itself (see module header). Callers must construct it
 * from a channel a remote/renderer payload cannot influence.
 */
export function resolveMcpConfig(
  input: TeamLeadBridgeInput,
  sanitizedAgent: string,
  marker: boolean,
  mint: MintTeamLeadBridge,
  report: (scope: string, message: string, error?: unknown) => void
): string | undefined {
  const explicit = input.mcpConfig?.trim() || undefined
  if (explicit) return explicit
  if (!wantsTeamLeadBridge(input, sanitizedAgent, marker)) return undefined
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
 * Build the REAL MintTeamLeadBridge for index.ts to inject into
 * SessionService's constructor. SYNC: `getControlServer` reads whatever is
 * CURRENTLY available (index.ts's module-scope `controlServer`, possibly
 * null) -- it does not start anything itself. Starting it is ipc.ts's
 * `sessions:create` handler's job, proactively, BEFORE calling into
 * create() at all (see index.ts's `ensureControlServer()` and this module's
 * own header for why that split exists).
 *
 * `write` is index.ts's EXISTING `controlDeps.writeTeamLeadMcpConfig` --
 * REUSED, not reimplemented: it already owns the controlServer-null check,
 * the deck-plugin-dir/mcpScript existsSync check (both throwing, which this
 * module's caller -- resolveMcpConfig -- already catches and degrades
 * gracefully), and the stateDir/mcpScriptPath/execPath resolution deck-
 * control.ts's own spawnEntry (agent route) already calls through the exact
 * same function. Duplicating that logic here (an earlier version of this
 * file did) would be a second copy able to drift from the first.
 *
 * TEAM_LEAD_DECK_TOOLS is imported from supervisor.ts and passed to BOTH
 * `mintCaller` (server-side scope) and `write` (client-side DECK_CONTROL_TOOLS)
 * -- named ONCE here, exactly like deck-control.ts's own spawnEntry already
 * does for the agent-spawned route (Card 6c380073's audit fix #6): a second,
 * hand-written allow-list at this call site would be able to drift from the
 * server-side scope silently. A mutation widening this array (or emptying
 * it) changes what BOTH functions receive, which is what
 * tests/desktop-team-lead-bridge.test.ts's allow-list proof pins against the
 * live `TEAM_LEAD_DECK_TOOLS` export.
 */
export function buildMintTeamLeadBridge(deps: {
  getControlServer: () => DeckControlServerLike | null
  /** Same contract as DeckControlDeps.writeTeamLeadMcpConfig (deck-control.ts). */
  write: (token: string, callerId: string, allowedTools: readonly string[]) => string
}): MintTeamLeadBridge {
  return () => {
    // LOAD-BEARING (security review note, 2026-09-02): this whole function
    // is SYNCHRONOUS, and specifically there is NO `await`/yield point
    // between `getControlServer()` and `write(...)` below -- that is what
    // guarantees `server.url` (baked into the --mcp-config `write` produces)
    // and the `token` minted by THIS SAME `server` designate the identical
    // deck-control instance. If this closure is ever made async (e.g. to let
    // `getControlServer` itself start the server -- already tried once and
    // reverted, see this file's header), a yield point inserted between
    // these two calls would let `controlServer` be reassigned to a DIFFERENT
    // instance in between (a restart, a second concurrent start before Card
    // 3c322f10's own race fix), producing a token and a URL that no longer
    // match. Keep both calls in the same synchronous tick.
    const server = deps.getControlServer()
    if (!server) return null
    const { token, callerId } = server.mintCaller('team-lead', TEAM_LEAD_DECK_TOOLS)
    const mcpConfig = deps.write(token, callerId, TEAM_LEAD_DECK_TOOLS)
    return { mcpConfig, callerId }
  }
}
