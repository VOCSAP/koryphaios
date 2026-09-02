// wait_for_message only reads via the WS push frame and /peek-messages, never
// the consuming /poll-messages endpoint.
// A timed-out, cancelled, or filter-mismatched message is therefore never
// marked delivered and stays available for a later check_messages call.

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
 * Floor of 1s: timeout_sec is never validated against inputSchema, so true
 * (coerces to 1) and near-zero values are reachable inputs, not just hostile
 * test cases, and must not produce a de facto busy-poll.
 */
export const WAIT_FOR_MESSAGE_MIN_SEC = 1;

/**
 * Never throws for any input: only typeof and Number(string) are used, both
 * safe even on hostile values.
 * Accepts a numeric string as well as a number, since an LLM caller regularly
 * emits either.
 * NaN is rejected explicitly; anything invalid falls back to
 * WAIT_FOR_MESSAGE_DEFAULT_SEC.
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
 * Applies the same notifiedMessageIds filter pollFallback uses: a message
 * already dispatched via mcp.notification() stays undelivered=0, so without
 * this filter a fresh wait could resolve immediately with stale, already-seen
 * content.
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
 * Unlike clampWaitTimeoutSec, not proven to never throw:
 * a.timeout_sec/a.from_peer_id are plain property reads, which throw on a Proxy
 * whose get trap throws.
 * Not reachable from the real JSON-RPC boundary, but an in-process caller
 * should not assume the same guarantee.
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
 * Exactly one of four outcomes settles the call -- a peek match, a
 * later-registered waiter match, a timer, or cancellation -- guarded by a
 * single settled flag so none can double-fire.
 * The timer and the cancellation subscription are both armed before the peek
 * starts, not restarted after it.
 * deps.scheduleTimeout/onCancelled are responsible for aborting the in-flight
 * peek fetch when they fire; this function only reacts to the abstract signal.
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
