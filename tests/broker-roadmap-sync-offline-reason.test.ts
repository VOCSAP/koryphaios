// Card 7974fb83: a replica offline for three different reasons must not
// collapse into the same "unreachable" state -- a transport failure (the
// network really is down), an upstream that predates replication (404 on a
// sync route), and an upstream that is reachable but refuses to serve
// replicas (403). Each is reproduced against a REAL broker process, a REAL
// closed port, or a real HTTP proxy in front of one, never a mocked fetch: a
// mock would keep passing after the status code it exercises drifted from
// what the real route actually sends.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { startUpstreamProxy } from "./_upstream-proxy.ts";
import type { RoadmapSyncStatus } from "../shared/types.ts";

// Not a real credential: a fixed fixture value shared by two test-only broker
// processes on loopback ports, torn down at the end of each test.
const AUTH = "offline-reason-fixture-shared-secret";

async function post<T = unknown>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AUTH}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function syncStatus(replica: TestBroker): Promise<RoadmapSyncStatus> {
  return (await post<RoadmapSyncStatus>(`${replica.url}/roadmap/sync/status`, {})).body;
}

async function pollUntil<T>(
  label: string,
  check: () => Promise<{ done: boolean; value: T }>,
  budgetMs = 15_000,
  intervalMs = 60
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const { done, value } = await check();
    last = value;
    if (done) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`${label}: timed out after ${budgetMs}ms; last observed ${JSON.stringify(last)}`);
}

/**
 * Waits for the replica to report offline WITH a reason, whatever it turns
 * out to be -- not merely `online === false`, which the sync loop's initial
 * default ALSO reads as (`syncPublished` starts `{ online: false, ... }`
 * before the first pass has even run). Without this, a poll that starts
 * polling immediately after the broker is spawned can observe that
 * unfired initial state and return instantly, well before any real pass -- let
 * alone the two failures the hysteresis requires -- has been attempted.
 */
async function waitOffline(replica: TestBroker, label: string): Promise<RoadmapSyncStatus> {
  return pollUntil(label, async () => {
    const status = await syncStatus(replica);
    return { done: status.online === false && status.offline_reason != null, value: status };
  });
}

/** A port nobody listens on: bound then immediately released, same technique as _helper.ts's own port reservation. */
function reserveClosedPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = probe.port;
  probe.stop(true);
  return port;
}

// One upstream serving replicas, shared by the tests that put a proxy in
// front of a healthy broker: each replica below is its own broker, the
// upstream behind its proxy is never mutated.
let servingUpstream: TestBroker;

beforeAll(async () => {
  servingUpstream = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: AUTH, CLAUDE_PEERS_SERVE_REPLICAS: "1" });
});

afterAll(async () => {
  await stopBroker(servingUpstream);
});

test("a real transport failure (connection refused on a closed port) reports offline_reason 'transport'", async () => {
  const closedPort = reserveClosedPort();
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${closedPort}`,
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "150",
  });
  try {
    const status = await waitOffline(replica, "replica reports the outage");
    expect(
      status.offline_reason,
      `expected offline_reason 'transport', got ${JSON.stringify(status)}`
    ).toBe("transport");
  } finally {
    await stopBroker(replica);
  }
}, 30_000);

test("an upstream answering 404 on the pull route reports offline_reason 'stale_upstream'", async () => {
  const upstream = servingUpstream;
  const proxy = startUpstreamProxy(upstream.url);
  // The same shape broker-peer-federation.test.ts already uses for "an
  // upstream of an older version": the one route this replica always calls,
  // even with an empty queue, is /roadmap/sync/pull.
  proxy.intercept = (path) =>
    path === "/roadmap/sync/pull" ? Response.json({ error: "not found" }, { status: 404 }) : null;
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: proxy.url,
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "150",
  });
  try {
    const status = await waitOffline(replica, "replica reports the stale upstream");
    expect(
      status.offline_reason,
      `expected offline_reason 'stale_upstream', got ${JSON.stringify(status)}`
    ).toBe("stale_upstream");
  } finally {
    proxy.stop();
    await stopBroker(replica);
  }
}, 30_000);

test("a 404 rendered as HTML (a reverse proxy's default error page, not JSON) still reports offline_reason 'stale_upstream'", async () => {
  const upstream = servingUpstream;
  const proxy = startUpstreamProxy(upstream.url);
  proxy.intercept = (path) =>
    path === "/roadmap/sync/pull"
      ? new Response("<html><body>404 Not Found</body></html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        })
      : null;
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: proxy.url,
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "150",
  });
  try {
    const status = await waitOffline(replica, "replica reports the stale upstream despite an HTML body");
    expect(
      status.offline_reason,
      `expected offline_reason 'stale_upstream', got ${JSON.stringify(status)}`
    ).toBe("stale_upstream");
  } finally {
    proxy.stop();
    await stopBroker(replica);
  }
}, 30_000);

test("a reachable upstream not configured to serve replicas reports offline_reason 'refused'", async () => {
  // No CLAUDE_PEERS_SERVE_REPLICAS: a real, unmodified broker that simply
  // never opted into the role. The 403 is genuine, no proxy involved.
  const upstream = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: AUTH });
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: upstream.url,
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: "150",
  });
  try {
    const status = await waitOffline(replica, "replica reports the refusing upstream");
    expect(
      status.offline_reason,
      `expected offline_reason 'refused', got ${JSON.stringify(status)}`
    ).toBe("refused");
  } finally {
    await stopBroker(replica);
    await stopBroker(upstream);
  }
}, 30_000);

test("a transition (online, then stale upstream, then a real outage) reports each reason truthfully -- never a stuck one, never published while still online", async () => {
  const upstream = servingUpstream;
  const proxy = startUpstreamProxy(upstream.url);
  // A tick wider than the floor, deliberately: the window this test asserts
  // on -- the first failed pass, before the second one flips online false --
  // is only as wide as one tick, and it is polled every WINDOW_POLL_MS. A
  // window missed by the poll times the test out (red), it never passes a
  // mutant that publishes the reason unconditionally.
  const SLOW_TICK_MS = "1000";
  const WINDOW_POLL_MS = 10;
  const replica = await startBroker({
    CLAUDE_PEERS_BROKER_URL: proxy.url,
    CLAUDE_PEERS_BROKER_TOKEN: AUTH,
    CLAUDE_PEERS_OFFLINE_REPLICA: "1",
    CLAUDE_PEERS_SYNC_TICK_MS: SLOW_TICK_MS,
  });
  try {
    // `online` only ever reads true once a pass has SUCCEEDED at least once
    // (its own initial default is false, same as a genuine outage) -- so the
    // proxy is left passing through at first, until a real success is seen,
    // before the intercept goes up. Without this, "online === true" could
    // never become true for a replica whose very first pass fails, and the
    // window below would never open.
    await pollUntil("replica completes a real successful pass first", async () => {
      const status = await syncStatus(replica);
      return { done: status.online === true && status.last_error === null, value: status };
    });

    proxy.intercept = (path) =>
      path === "/roadmap/sync/pull" ? Response.json({ error: "not found" }, { status: 404 }) : null;

    // Right after the FIRST failed pass, the hysteresis has not yet flipped
    // online false (SYNC_OFFLINE_AFTER_FAILURES = 2): a classified reason may
    // already exist internally, but it must not be published while the
    // broker still claims to be online -- this is what kills a mutant that
    // publishes offline_reason unconditionally. `online: true` is part of the
    // DONE condition, not just an assertion after the fact: otherwise a poll
    // landing one tick late would observe the (also truthful, unmutated)
    // post-flip state instead.
    const firstFailure = await pollUntil(
      "replica sees its first failed pass while still online",
      async () => {
        const status = await syncStatus(replica);
        return { done: status.online === true && status.last_error != null, value: status };
      },
      15_000,
      WINDOW_POLL_MS
    );
    expect(
      firstFailure.offline_reason,
      `offline_reason must stay null while still online, got ${JSON.stringify(firstFailure)}`
    ).toBeNull();

    const stale = await waitOffline(replica, "replica reports the stale upstream");
    expect(stale.offline_reason, `expected 'stale_upstream', got ${JSON.stringify(stale)}`).toBe(
      "stale_upstream"
    );

    // The link now breaks for real: the proxy itself stops answering. A
    // mutant that keeps the FIRST reason forever (never re-reads the fresh
    // exception) would still report 'stale_upstream' here.
    proxy.stop();
    // A generous budget: once offline the exponential backoff (capped at
    // SYNC_BACKOFF_MAX_MS = 60s) governs the next attempt, which can be
    // several ticks away.
    const cut = await pollUntil(
      "replica reports the real outage that followed",
      async () => {
        const status = await syncStatus(replica);
        return { done: status.offline_reason === "transport", value: status };
      },
      70_000
    );
    expect(cut.offline_reason, `expected 'transport' after the proxy stopped, got ${JSON.stringify(cut)}`).toBe(
      "transport"
    );
  } finally {
    await stopBroker(replica);
  }
}, 60_000);
