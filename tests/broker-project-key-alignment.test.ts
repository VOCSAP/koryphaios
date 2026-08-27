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
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, deckAuthored } from "./_helper.ts";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";
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

// ----- Card c92614ed lot L0: control-character/framing deny-list on
// project_key at every write ingress -- register, mint, roadmap/upsert
// (create), roadmap/import, and (MAJOR 3, team-lead review round 1) the
// three UPDATE-scoping handlers lock-park/lock-release/reorder, which
// select-then-write on project_key and are not read-only filters. Behavioural
// probes against the REAL handlers (raw HTTP through the spawned broker.ts,
// same shape as the tests above), not just shared/project-key.ts's
// validateProjectKey in isolation: an extracted pure predicate proves
// nothing about whether the handler calls it and uses the result (see this
// repo's own wiring-mutation-audit rule).
//
// Which OTHER handlers are exempt is deliberately NOT enumerated here: an
// enumerated list goes stale the moment a ninth site is added (measured at
// review time -- a decommented sweep found a site this comment's earlier
// draft had missed) and a list living in a test file is invisible to
// whoever writes that ninth site while working in broker.ts. The actual
// criterion lives once, at the call site every wired handler already
// imports: see the "WIRING CRITERION" paragraph in validateProjectKey's
// docstring (shared/project-key.ts).

function peerProjectKeyByToken(dbPath: string, instanceToken: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query("SELECT project_key FROM peers WHERE instance_token = ?")
      .get(instanceToken) as { project_key: string | null } | null;
    return row ? row.project_key : null;
  } finally {
    db.close();
  }
}

test("register: a project_key carrying a NUL control character is rejected to NULL, not stored verbatim", async () => {
  const b = await startBroker();
  try {
    const reg = await post<{ instance_token: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/l0-register-nul", git_root: null, tty: null,
      summary: "", host: "h-l0-nul", client_pid: livePid(), claude_cli_pid: 1,
      project_key: "github.com/evil/\u0000inject", group_id: "default", group_secret_hash: null,
    });
    // Register must never hard-fail on a malformed project_key -- same
    // reject-to-null philosophy as normalizeRole's malformed-role branch.
    expect(reg.status).toBe(200);
    expect(peerProjectKeyByToken(b.dbPath, reg.body.instance_token)).toBeNull();
  } finally {
    await stopBroker(b);
  }
});

test("register: an invalid project_key's NULL collapse costs this peer its own lock to the owner-gone sweep (MAJOR 1 consequence, not a sweep bug)", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // A hostile/malformed client -- the only kind that still reaches this
    // collapse post-MAJOR-1-fix, since resolveProjectKey now falls back to a
    // valid local:<hash> for the one LEGITIMATE trigger (over-length).
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/l0-consequence", git_root: "/tmp/l0-consequence", tty: null,
      summary: "", host: "h-l0-consequence", client_pid: livePid(), claude_cli_pid: 1,
      project_key: "github.com/evil/foo\tbar", group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);
    expect(peerProjectKeyByToken(b.dbPath, reg.body.instance_token)).toBeNull();

    // The peer still claims a card under a REAL project -- this is the
    // consequence, not a second bug: NULL never matches a NOT NULL
    // roadmap_items.project_key, so this peer owns none of its own cards as
    // far as releaseStaleLocks is concerned.
    const claimKey = "github.com/vocsap/l0-consequence";
    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: claimKey, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "own card, collapsed project_key", status: "in_progress",
    });
    expect(held.body.item.locked).toBe(true);

    const after = await waitForSweepOutcome(
      b.url, claimKey, held.body.item.id, reg.body.instance_token, 12_000
    );
    // Heartbeating throughout (waitForSweepOutcome does it on every poll) and
    // never released by itself, yet swept -- this IS the documented tradeoff,
    // not a regression to fix here. Note on what this half actually proves:
    // under a mutant that returns the raw (unvalidated) key instead of null,
    // the sweep would ALSO release this lock -- the raw value would not
    // match claimKey either, so this half alone cannot distinguish "collapsed
    // to null" from "stored some other wrong value". The line 206 assertion
    // above (peerProjectKeyByToken === null) is what actually falsifies under
    // that mutant; this half only documents the real-world consequence once
    // the collapse is independently established.
    expect(after.locked).toBe(false);
    expect(after.status).toBe("planned");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("register: a project_key with an embedded newline is rejected to NULL, not stored verbatim", async () => {
  const b = await startBroker();
  try {
    const reg = await post<{ instance_token: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/l0-register-newline", git_root: null, tty: null,
      summary: "", host: "h-l0-newline", client_pid: livePid(), claude_cli_pid: 1,
      project_key: "github.com/evil/foo\nbar", group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);
    expect(peerProjectKeyByToken(b.dbPath, reg.body.instance_token)).toBeNull();
  } finally {
    await stopBroker(b);
  }
});

test("register: a legitimate non-ASCII project_key is stored verbatim (negative control, deny-list is not an ASCII allow-list)", async () => {
  const b = await startBroker();
  try {
    const nonAsciiKey = "github.com/vocsap/été";
    const reg = await post<{ instance_token: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/l0-register-nonascii", git_root: null, tty: null,
      summary: "", host: "h-l0-nonascii", client_pid: livePid(), claude_cli_pid: 1,
      project_key: nonAsciiKey, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);
    expect(peerProjectKeyByToken(b.dbPath, reg.body.instance_token)).toBe(nonAsciiKey);
  } finally {
    await stopBroker(b);
  }
});

test("mint (/approval/token-mint): a project_key over 256 chars is refused with 400, not silently truncated", async () => {
  const b = await startBroker();
  try {
    const opCred = generateCredential();
    const operatorId = deriveOperatorId(opCred.publicKey);
    const sessionCred = generateCredential();
    const mintBody = {
      session_public_key: sessionCred.publicKey,
      session_ref: "l0-mint-toolong",
      project_key: "x".repeat(257),
      public_key: opCred.publicKey,
    };
    const auth = buildAuthProof(opCred.privateKey, mintBody, {
      kind: "operator",
      operator_id: operatorId,
    });
    const res = await post<{ error: string }>(`${b.url}/approval/token-mint`, { ...mintBody, auth });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");

    // The proof that matters: nothing landed under a truncated 256-char key.
    const db = new Database(b.dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT COUNT(*) AS n FROM approval_session_tokens WHERE project_key = ?")
        .get("x".repeat(256)) as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await stopBroker(b);
  }
});

test("mint (/approval/token-mint): a project_key with a control character is refused with 400", async () => {
  const b = await startBroker();
  try {
    const opCred = generateCredential();
    const operatorId = deriveOperatorId(opCred.publicKey);
    const sessionCred = generateCredential();
    const mintBody = {
      session_public_key: sessionCred.publicKey,
      session_ref: "l0-mint-control",
      project_key: "github.com/evil/foo\tbar",
      public_key: opCred.publicKey,
    };
    const auth = buildAuthProof(opCred.privateKey, mintBody, {
      kind: "operator",
      operator_id: operatorId,
    });
    const res = await post<{ error: string }>(`${b.url}/approval/token-mint`, { ...mintBody, auth });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/upsert (create): a project_key with a control character is refused with 400, nothing created", async () => {
  const b = await startBroker();
  try {
    const badKey = "github.com/evil/foo\rbar";
    const res = await post<{ error: string }>(`${b.url}/roadmap/upsert`, {
      project_key: badKey, by: "l0-author", title: "should never land",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");

    // Card c92614ed lot L0 (MAJOR 2, team-lead review): scoping this COUNT by
    // `badKey` only proves "nothing under THIS exact key" -- a mutant that
    // sanitizes the raw value before inserting (instead of refusing) would
    // insert under the SANITIZED key and this assertion would stay green,
    // seeing nothing. The broker is fresh in this test (startBroker() per
    // test, no shared fixture), so an unscoped COUNT proves the stronger
    // claim that actually matters: nothing landed AT ALL, under any key.
    const db = new Database(b.dbPath, { readonly: true });
    try {
      const row = db.query("SELECT COUNT(*) AS n FROM roadmap_items").get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/upsert (create): a legitimate non-ASCII project_key with internal whitespace still creates the item (negative control)", async () => {
  const b = await startBroker();
  try {
    const legitKey = "local path/été projet";
    const res = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: legitKey, by: "l0-author", title: "legit project_key",
    });
    expect(res.status).toBe(200);
    expect(res.body.item.project_key).toBe(legitKey);
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/import: a project_key with a control character refuses the whole batch with 400", async () => {
  const b = await startBroker();
  try {
    const badKey = "github.com/evil/foo\u0000bar";
    const id = crypto.randomUUID();
    const res = await post<{ error: string }>(`${b.url}/roadmap/import`, {
      project_key: badKey, by: "l0-importer",
      items: [
        { id, kind: "feature", title: "should never land", priority: "could", value: "medium", effort: "medium", status: "idea" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");

    const db = new Database(b.dbPath, { readonly: true });
    try {
      const row = db.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?").get(id) as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await stopBroker(b);
  }
});

// ----- MAJOR 3 (team-lead review round 1): lock-park/lock-release/reorder
// scope an UPDATE on project_key, so they need the same refuse-not-trim
// discipline as create/import, not the read-only-filter exemption. Decisive
// probe that found the gap: the SAME leading-whitespace string refused by
// /roadmap/upsert (400) was silently trimmed and ACCEPTED (200, write
// happened) by /roadmap/reorder -- one caller-declared string, two
// disciplines, in the very lot that establishes the discipline.

test("roadmap/lock-park: a project_key with leading whitespace is refused with 400, not silently trimmed", async () => {
  const b = await startBroker();
  try {
    const res = await post<{ error: string }>(
      `${b.url}/roadmap/lock-park`,
      deckAuthored({ project_key: " local:probe", peer_ids: ["some-peer"] })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/lock-release: a project_key with leading whitespace is refused with 400, not silently trimmed", async () => {
  const b = await startBroker();
  try {
    const res = await post<{ error: string }>(
      `${b.url}/roadmap/lock-release`,
      deckAuthored({ project_key: " local:probe", peer_ids: ["some-peer"] })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/reorder: a project_key with leading whitespace is refused with 400, not silently trimmed (the exact gap the reviewer measured)", async () => {
  const b = await startBroker();
  try {
    // Positive control first: prove the un-padded key is a legitimate,
    // reachable project with a real item to reorder, so the 400 below is
    // provably about the padding, not about an unrelated empty project.
    const goodKey = "local:probe";
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: goodKey, by: "l0-reorder-author", title: "reorder target",
    });
    expect(created.status).toBe(200);

    const res = await post<{ error: string }>(`${b.url}/roadmap/reorder`, {
      project_key: ` ${goodKey}`, by: "l0-reorder-author", ids: [created.body.item.id],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");
  } finally {
    await stopBroker(b);
  }
});
