// Card 6aa32af4, proof step 1 (reviewer's regression probe on card
// fc444eda): the owner-gone sweep's NULL-safe `IS` comparison
// (`p.project_key IS roadmap_items.project_key`, broker.ts releaseStaleLocks)
// only recognizes an active peer as "this card's owner" when the peer's
// REGISTERED project_key matches the card's project_key EXACTLY -- a NULL
// registered project_key is a value in its own right, not a wildcard.
//
// Before this card's alignment, server.ts's /register sent the raw,
// possibly-null computeProjectKey() result, while roadmap cards were always
// scoped under roadmapProjectKey()'s non-null local:<hash> fallback. A
// live peer with no git remote therefore registered project_key=null while
// its own in_progress card carried project_key="local:<hash>" -- a
// mismatch the `IS` clause reads as "not this peer's card", so the peer's
// OWN lock got swept as owner-gone after one grace period even though the
// peer was actively heartbeating. This is broker-level: it reproduces from
// raw HTTP with mismatched values alone, independent of which server.ts
// build sent them -- which is exactly why it is a regression risk of the
// fc444eda fix landing without this alignment, not a scenario that needs a
// real server.ts process to observe.
//
// The two tests below pin both ends: the mismatched shape (what an
// unaligned server.ts produced) still gets swept, and the matched shape
// (what server.ts's /register now sends, via roadmapProjectKey() --
// card 6aa32af4) stays held. tests/roadmap-broker-lock.test.ts's own
// owner-gone case stays a SEPARATE, still-relevant scenario: a raw client
// posting project_key:null on both sides (the ghost-peer-never-registered
// squat), unaffected by this alignment.

import { test, expect } from "bun:test";
import { startBroker, stopBroker, post, livePid } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

const LOCAL_FALLBACK_KEY = "local:6c4c222bfb64bc07";

type UpsertRes = { item: RoadmapItem };
type RegisterRes = { instance_token: string; peer_id: string };

async function waitForSweepOutcome(
  brokerUrl: string,
  projectKey: string,
  itemId: string,
  instanceToken: string,
  budgetMs: number
): Promise<RoadmapItem> {
  const pollIntervalMs = 300;
  const deadline = Date.now() + budgetMs;
  let last: RoadmapItem | undefined;
  while (Date.now() < deadline) {
    await post(`${brokerUrl}/heartbeat`, { instance_token: instanceToken });
    const after = await post<{ items: RoadmapItem[] }>(`${brokerUrl}/roadmap/list`, {
      project_key: projectKey,
    });
    last = after.body.items.find((i) => i.id === itemId);
    if (last && last.locked === false) break;
    await Bun.sleep(pollIntervalMs);
  }
  if (!last) throw new Error("item never observed in /roadmap/list");
  return last;
}

test("mismatched registered project_key (pre-alignment shape) lets an active peer's own lock be swept as owner-gone", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // Simulates an unaligned server.ts: registers with the raw, null
    // project_key a no-remote repo's computeProjectKey() returns.
    const reg = await post<RegisterRes>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/no-remote-repo", git_root: "/tmp/no-remote-repo", tty: null,
      summary: "", host: "h-mismatch", client_pid: livePid(), claude_cli_pid: 1,
      project_key: null, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    // Simulates roadmapProjectKey()'s own local:<hash> fallback -- always
    // non-null, independent of what was just registered.
    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: LOCAL_FALLBACK_KEY, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "own card, no-remote repo", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    const after = await waitForSweepOutcome(
      b.url, LOCAL_FALLBACK_KEY, held.body.item.id, reg.body.instance_token, 12_000
    );
    // This IS the regression: the peer is alive (heartbeating throughout)
    // and never released the card itself, yet the mismatch reads as
    // owner-gone.
    expect(after.locked).toBe(false);
    expect(after.status).toBe("planned");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("matched registered project_key (post-alignment shape, card 6aa32af4) keeps an active peer's own lock held past the grace period", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // Simulates the aligned server.ts: /register now sends
    // roadmapProjectKey()'s resolved value, matching what roadmap cards
    // for the same session are scoped under.
    const reg = await post<RegisterRes>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/no-remote-repo", git_root: "/tmp/no-remote-repo", tty: null,
      summary: "", host: "h-matched", client_pid: livePid(), claude_cli_pid: 1,
      project_key: LOCAL_FALLBACK_KEY, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: LOCAL_FALLBACK_KEY, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "own card, no-remote repo", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    // Poll for a fixed window past the grace period, asserting every
    // iteration -- the lock must never flip false while the peer is alive.
    const pollIntervalMs = 300;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await post(`${b.url}/heartbeat`, { instance_token: reg.body.instance_token });
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: LOCAL_FALLBACK_KEY,
      });
      const item = after.body.items.find((i) => i.id === held.body.item.id)!;
      expect(item.locked).toBe(true);
      await Bun.sleep(pollIntervalMs);
    }
  } finally {
    await stopBroker(b);
  }
}, 20_000);
