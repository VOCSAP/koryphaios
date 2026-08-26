// Pure logic for the `wait_for_message` MCP tool (server.ts). Card a21f1303,
// H4 volet 3 of docs/DESIGN-HERDR-ADOPTION.md. Filter matching, timeout
// clamping, and the waiter registry that lets the two EXISTING
// message-delivery paths (the WS push handler in connectWs, and the poll
// fallback in pollFallback) resolve a pending wait, instead of a third
// transport being invented -- the design brief is explicit that both paths
// already exist and there is nothing to build there.
//
// Zero dependency on bun:sqlite, fetch, or timers: everything here is a pure
// function over plain data, so tests/wait-for-message-logic.test.ts runs
// under `bun test` with no broker daemon and no bound port. That test file
// must NOT be named with a `broker-`/`server-` prefix, or
// scripts/pure-module-partition.ts's deny-list (EXEMPTIONS.familyPrefixes)
// exempts it from the CI cross-platform "pure modules" job -- verified
// against the real isExempt() in that test file, not assumed.
//
// wait_for_message deliberately never calls the broker's consuming
// /poll-messages endpoint (server.ts's check_messages tool keeps sole use of
// it). It only ever reads via the already-non-consuming paths -- the WS push
// frame, and /peek-messages -- so a timed-out or cancelled wait, and a
// message that does not match a filtered wait, are never marked delivered:
// they stay available for a later check_messages call, exactly like the
// pre-existing WS-push/poll-fallback discipline (server.ts:124, :267 --
// "Only check_messages marks delivered in the DB"). This is a design
// constraint, not an oversight: broker.ts is out of scope for this card, and
// it has no selective per-id delivered-marking endpoint, so selective
// consumption is not implementable without inventing a second acknowledgment
// discipline -- explicitly avoided per team-lead's arbitrage on card a21f1303.

/**
 * Hard ceiling for `timeout_sec`, in seconds. Measured 2026-08-26 against
 * Claude Code's own docs (code.claude.com/docs/en/env-vars, scraped that
 * day): a still-running MCP tool call in the main conversation silently
 * converts to a background task past CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS
 * (default 120_000 ms) -- not an error, but it makes this tool's documented
 * contract ("resolves with the message(s), or { timed_out: true }") false in
 * that mode: the call would return a task id instead, and the result would
 * arrive later as a task notification rather than as this call's own return
 * value. 115s stays strictly under that default. The stdio idle-timeout
 * (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, default 1_800_000 ms / 30 min for a
 * stdio server -- this one is stdio, per .mcp.json) is the NEXT limit up,
 * not the one that governs here. Both are Claude Code DEFAULTS the server
 * cannot detect an operator lowering.
 */
export const WAIT_FOR_MESSAGE_HARD_CAP_SEC = 115;

/** Used when `timeout_sec` is omitted or not a usable positive number. */
export const WAIT_FOR_MESSAGE_DEFAULT_SEC = 60;

/**
 * Floor for an explicit `timeout_sec`. Card a21f1303 R6 (team-lead review,
 * 2026-08-26): two reachable inputs used to slip through with no lower
 * bound -- `true` (coerced to the number 1, silently a legitimate-looking
 * 1-second wait) and `0.0001` (a ~0.1ms timer, functionally the very polling
 * loop this tool exists to remove). This server never validates MCP tool
 * arguments against inputSchema itself, so both are reachable from a live
 * call, not just from a hostile test.
 */
export const WAIT_FOR_MESSAGE_MIN_SEC = 1;

/**
 * Clamp a requested `timeout_sec` into [WAIT_FOR_MESSAGE_MIN_SEC,
 * WAIT_FOR_MESSAGE_HARD_CAP_SEC]. Provably never throws for ANY input,
 * including a hostile one (a `Symbol()`, or an object whose `valueOf`
 * throws): the only operations ever performed on `requested` are a `typeof`
 * check (never throws) and, when it is already a `string`, `Number(string)`
 * (never throws either -- a primitive string cannot trigger the ToPrimitive
 * path that lets a poisoned `valueOf`/`toString` on an OBJECT throw; `Number`
 * is only ever called on an already-`string` value here, never on an
 * arbitrary object). Anything that is neither a finite `number` nor a
 * `string` parsing to one -- wrong type (an object, `Symbol`, `bigint`,
 * `null`; `true`/`false`, which used to coerce to 1/0), NaN, Infinity, or
 * non-positive -- falls back to WAIT_FOR_MESSAGE_DEFAULT_SEC (CLAUDE.md: a
 * numeric validator must reject NaN explicitly -- every comparison against
 * NaN is false, so a naive clamp silently lets it through). Card a21f1303 U2
 * (team-lead review round 3, 2026-08-26): a numeric STRING (`"30"`) is a
 * realistic input -- this server never validates MCP tool args against its
 * own inputSchema, and an LLM caller regularly emits a JSON number as a
 * string -- so rejecting it by type alone silently substituted
 * WAIT_FOR_MESSAGE_DEFAULT_SEC for what the caller asked for, with no
 * signal. Accepting it here keeps every other hardening (`true`, `0.0001`,
 * `Symbol`, a throwing `valueOf`) closed.
 */
export function clampWaitTimeoutSec(requested: unknown): number {
  let n: number;
  if (typeof requested === "number") {
    n = requested;
  } else if (typeof requested === "string") {
    n = Number(requested);
  } else {
    return WAIT_FOR_MESSAGE_DEFAULT_SEC;
  }
  if (!Number.isFinite(n) || n <= 0) return WAIT_FOR_MESSAGE_DEFAULT_SEC;
  return Math.min(Math.max(n, WAIT_FOR_MESSAGE_MIN_SEC), WAIT_FOR_MESSAGE_HARD_CAP_SEC);
}

/**
 * The shape a candidate message needs for filter matching and for handing
 * back to the caller. Deliberately narrower than shared/types.ts's
 * DeliveredMessage (which also carries group_id/delivered): the WS push
 * frame (connectWs, server.ts) and the /peek-messages response
 * (pollFallback) both already carry exactly this subset, and requiring more
 * would force either call site to fetch fields it doesn't otherwise need.
 */
export interface WaitCandidateMessage {
  readonly id: number;
  readonly from_peer_id: string;
  readonly from_summary: string;
  readonly from_host: string;
  readonly from_cwd: string;
  readonly text: string;
  readonly sent_at: string;
}

/** True if `candidate` satisfies an optional from_peer_id filter. */
export function matchesWaitFilter(
  candidate: Pick<WaitCandidateMessage, "from_peer_id">,
  filterPeerId?: string | null
): boolean {
  return !filterPeerId || candidate.from_peer_id === filterPeerId;
}

/**
 * Excludes candidates already handed to the agent this session -- the exact
 * `!notifiedMessageIds.has(m.id)` filter pollFallback applies (server.ts)
 * before deciding what is "fresh", now shared so wait_for_message's own
 * opportunistic peek uses the SAME discipline instead of a second one that
 * can silently diverge. Without this, an id still sitting undelivered=0 (WS
 * push and /peek-messages never mark delivered) but already dispatched via
 * mcp.notification() earlier in the session would immediately "resolve" a
 * wait with stale, already-seen content instead of actually waiting for a
 * NEW message -- the tool's nominal use case (an agent that already
 * exchanged messages, now waiting for the next one) is exactly the case
 * this breaks if left unfiltered.
 */
export function selectFreshWaitCandidates(
  candidates: readonly WaitCandidateMessage[],
  notifiedIds: ReadonlySet<number>
): WaitCandidateMessage[] {
  return candidates.filter((m) => !notifiedIds.has(m.id));
}

/** A pending wait_for_message call, registered until it resolves or expires/is cancelled. */
export interface MessageWaiter {
  readonly filterPeerId?: string | null;
  readonly resolve: (matched: WaitCandidateMessage) => void;
}

/** The normalized decision server.ts's wait_for_message case acts on. */
export interface WaitPlan {
  readonly timeoutMs: number;
  readonly filterPeerId: string | undefined;
}

/**
 * Normalizes the raw MCP tool call args into a plan: clamps `timeout_sec`
 * (via clampWaitTimeoutSec) and converts it to milliseconds, trims
 * `from_peer_id` down to `undefined` when blank. Card a21f1303 R1
 * (team-lead review, 2026-08-26): these four transforms (clamp, seconds ->
 * milliseconds, trim, and -- via selectPeekMatch/buildWaiter below -- first-
 * peek-match selection and the filter's use at waiter registration) used to
 * be five separate inline expressions written directly in server.ts's case,
 * none of them reachable by any test that cannot import server.ts (it has no
 * exports and runs main() unconditionally at module scope, the established
 * reason server.ts itself is untestable in this repo). A mutation of any one
 * of them left tests/wait-for-message-logic.test.ts fully green, because the
 * only assertions touching server.ts were source-scan `toContain` checks --
 * true regardless of what the matched substring's own arguments did.
 * Collecting the decision here, tested by direct execution, closes that gap
 * for good: server.ts's case no longer WRITES any of these transforms
 * itself, it only reads the plan's fields.
 *
 * Unlike clampWaitTimeoutSec, this function is NOT proven never to throw:
 * `a.timeout_sec` / `a.from_peer_id` are plain property reads, which throw on
 * a Proxy whose `get` trap throws. Not reachable from the real MCP/JSON-RPC
 * boundary (JSON deserialization never produces a Proxy), so the risk is
 * theoretical today -- but a future in-process caller passing something
 * other than parsed JSON should not assume the same guarantee
 * clampWaitTimeoutSec makes (card a21f1303 U3, team-lead review round 3,
 * 2026-08-26).
 */
export function buildWaitPlan(args: unknown): WaitPlan {
  const a = (args ?? {}) as { timeout_sec?: unknown; from_peer_id?: unknown };
  const timeoutSec = clampWaitTimeoutSec(a.timeout_sec);
  const rawFilter = a.from_peer_id;
  const filterPeerId = typeof rawFilter === "string" && rawFilter.trim() ? rawFilter.trim() : undefined;
  return { timeoutMs: timeoutSec * 1000, filterPeerId };
}

/**
 * First candidate (in peek order) satisfying the plan's filter, if any.
 * Moved out of server.ts's case for the same reason as buildWaitPlan (see
 * its header): `fresh.find(m => matchesWaitFilter(m, filterPeerId))` written
 * inline there is not reachable by execution from a test that cannot import
 * server.ts.
 */
export function selectPeekMatch(
  fresh: readonly WaitCandidateMessage[],
  filterPeerId: string | undefined
): WaitCandidateMessage | undefined {
  return fresh.find((m) => matchesWaitFilter(m, filterPeerId));
}

/**
 * Builds the waiter object server.ts registers for the real (non-peek) wait.
 * Moves the ONE field mapping -- `filterPeerId: plan.filterPeerId` -- out of
 * an inline object literal in server.ts's case: team-lead flagged this as
 * the worst of the seven mutations found, because a `filterPeerId: undefined`
 * typo there would silently make the REAL wait ignore from_peer_id while the
 * opportunistic peek (which calls selectPeekMatch with the same plan)
 * kept honoring it -- acceptance criterion 1 would then hold on the peek
 * path and silently break on the wait path, the one that matters most since
 * it is what actually blocks.
 */
export function buildWaiter(plan: WaitPlan, onMatch: (m: WaitCandidateMessage) => void): MessageWaiter {
  return { filterPeerId: plan.filterPeerId, resolve: onMatch };
}

export interface ResolveWaitersResult {
  /** Waiters `candidate` did not satisfy; same objects, new array (input untouched). */
  remaining: MessageWaiter[];
  /** Waiters `candidate` satisfies, in registration order. Not yet removed by this call alone. */
  resolved: MessageWaiter[];
}

/**
 * Pure registry step: given the currently pending waiters and one incoming
 * candidate message, split them into what still waits and what `candidate`
 * satisfies. Never mutates `waiters`. Callers (connectWs's WS handler and
 * pollFallback, both in server.ts) are responsible for calling
 * `resolved[i].resolve(candidate)` themselves and for falling back to the
 * existing mcp.notification() when `resolved` is empty -- this function only
 * decides who matches, it never has side effects.
 */
export function tryResolveWaiters(
  waiters: readonly MessageWaiter[],
  candidate: WaitCandidateMessage
): ResolveWaitersResult {
  const remaining: MessageWaiter[] = [];
  const resolved: MessageWaiter[] = [];
  for (const w of waiters) {
    if (matchesWaitFilter(candidate, w.filterPeerId)) resolved.push(w);
    else remaining.push(w);
  }
  return { remaining, resolved };
}

/**
 * Remove one waiter (by identity) from a list, e.g. on timeout or
 * client-side cancellation. Pure: returns a new array, does not mutate
 * `waiters`.
 */
export function removeWaiter(
  waiters: readonly MessageWaiter[],
  toRemove: MessageWaiter
): MessageWaiter[] {
  return waiters.filter((w) => w !== toRemove);
}

// --- runWaitForMessage: the whole case, injected (card a21f1303 U1) ---
//
// Team-lead review round 3 (2026-08-26): moving only the VALUE transforms
// (buildWaitPlan/selectPeekMatch/buildWaiter above) into pure functions left
// the CONTROL FLOW -- when the peek's fetch is bounded, which filter a real
// waiter is registered under, whether the timer/cancellation actually drive
// the outcome -- written directly in server.ts's case, still unreachable by
// any test that cannot import server.ts. A mutation battery on that case
// found 12 of 13 mutations invisible: replacing buildWaitPlan's call with a
// literal object bypassed the clamp with every clamp test still green;
// dropping the filter at waiter registration made the REAL wait ignore
// from_peer_id while the peek kept honoring it; moving the timer/abort
// wiring after the peek made it unbounded and uncancellable again; calling
// selectFreshWaitCandidates and discarding its result passed the one
// existing scan, which only checked the token's PRESENCE, never that its
// result was USED.
//
// The fix is not a better scan: it is to make the defect unwritable in
// server.ts by moving the CONTROL FLOW here too, injected with its only
// impure dependencies (a non-consuming peek, a waiter registry, a timer, a
// cancellation source) so a test can drive the WHOLE decision -- peek match,
// waiter match, timeout, and cancellation, including mid-peek cancellation --
// by execution, with fake timers and no real socket. server.ts's case is
// reduced to wiring the REAL implementations of these five functions and
// formatting the returned outcome; it does not decide anything itself.
//
// This closes the residual accepted (not proven) in an earlier round: the
// expiration, cancellation, and WS-vs-poll-fallback separation criteria are
// now provable by direct execution against fake timers, not merely simulated
// candidate shapes plus wiring assertions.

/** The outcome of one wait_for_message call. */
export type WaitForMessageOutcome =
  | { readonly kind: "matched"; readonly message: WaitCandidateMessage }
  | { readonly kind: "timed_out" }
  | { readonly kind: "cancelled" };

/**
 * The impure operations runWaitForMessage needs, injected so its own logic
 * stays testable by direct execution. server.ts supplies the real
 * implementations (a bounded /peek-messages fetch, the pendingWaiters
 * registry, setTimeout/clearTimeout, extra.signal's abort event); a test
 * supplies fakes with no network and no real timer.
 */
export interface WaitForMessageDeps {
  /** One non-consuming peek at ALL currently pending (raw, unfiltered) candidates. */
  peek: () => Promise<WaitCandidateMessage[]>;
  /** Ids already notified this session -- read live, checked once right after `peek()` resolves. */
  notifiedIds: ReadonlySet<number>;
  /** Record that `id` has now been handed to the agent (peek match or waiter match). */
  markNotified: (id: number) => void;
  /** Register a real waiter for `plan`; call `onMatch` when a later WS/poll candidate resolves it. Returns an unregister function. */
  registerWaiter: (plan: WaitPlan, onMatch: (m: WaitCandidateMessage) => void) => () => void;
  /** Schedule `onExpire` after `ms`. Returns a cancel function. */
  scheduleTimeout: (ms: number, onExpire: () => void) => () => void;
  /** Subscribe to external (client-side) cancellation. Returns an unsubscribe function. */
  onCancelled: (onCancel: () => void) => () => void;
}

/**
 * The whole wait_for_message decision, injected. Exactly one of four things
 * settles the call, and each one cleans up every OTHER pending mechanism
 * (timer, cancellation subscription, waiter registration) before resolving,
 * via a single `settled` guard so none can double-fire or race:
 *
 * 1. The opportunistic peek finds an already-fresh match -> "matched",
 *    nothing is registered at all.
 * 2. No peek match -> a real waiter is registered; a later `onMatch` call
 *    (from server.ts's connectWs/pollFallback, via tryResolveWaiters) ->
 *    "matched".
 * 3. The timer (armed for the WHOLE call, peek included, from the very
 *    start -- not restarted after the peek) fires first -> "timed_out".
 * 4. `onCancelled` fires (client-side cancellation) at any point, including
 *    while the peek's own fetch is still in flight -> "cancelled".
 *
 * The timer and the cancellation subscription are both armed BEFORE the
 * peek starts, and deps.scheduleTimeout/onCancelled's OWN implementations
 * are responsible for actually aborting the in-flight peek fetch on fire
 * (server.ts's real implementations do, via a shared AbortController) --
 * this function only reacts to the abstract onExpire/onCancel signal, it
 * has no fetch of its own to abort.
 */
export async function runWaitForMessage(
  args: unknown,
  deps: WaitForMessageDeps
): Promise<WaitForMessageOutcome> {
  const plan = buildWaitPlan(args);

  return await new Promise<WaitForMessageOutcome>((resolve) => {
    let settled = false;
    let cleanupWaiter: (() => void) | null = null;
    let cancelTimer: () => void = () => {};
    let unsubscribeCancel: () => void = () => {};

    const finish = (outcome: WaitForMessageOutcome) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      unsubscribeCancel();
      cleanupWaiter?.();
      resolve(outcome);
    };

    cancelTimer = deps.scheduleTimeout(plan.timeoutMs, () => finish({ kind: "timed_out" }));
    unsubscribeCancel = deps.onCancelled(() => finish({ kind: "cancelled" }));

    (async () => {
      try {
        const rawPeeked = await deps.peek();
        if (settled) return; // already timed out or cancelled during the peek
        const fresh = selectFreshWaitCandidates(rawPeeked, deps.notifiedIds);
        const preMatch = selectPeekMatch(fresh, plan.filterPeerId);
        if (preMatch) {
          deps.markNotified(preMatch.id);
          finish({ kind: "matched", message: preMatch });
          return;
        }
      } catch {
        if (settled) return;
        // Transient peek error: fall through to the waiter path below, same
        // catch-and-continue discipline as pollFallback's own. This function
        // does not distinguish WHY peek() rejected (aborted vs a real broker
        // error) -- the `settled` check above already handles the abort
        // case; deps.peek()'s own implementation is responsible for logging
        // a real error (server.ts, card a21f1303 U4).
      }
      if (settled) return;
      cleanupWaiter = deps.registerWaiter(plan, (m) => finish({ kind: "matched", message: m }));
    })();
  });
}
