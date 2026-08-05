// Card 37a2b8c7, volets 2 + 3: authenticate __sentinel__-adjacent authority.
//
// Volet 2 (Chain A): a client-declared sentinel-shaped instance_token/from_token
// is an impersonation/leak attempt, never a legitimate identity. Measured before
// the fix: 0 of 8 routes that trust a client-declared instance_token as identity
// proof refused it -- only resolveRoadmapAuthor (unrelated feature) had the shape
// guard wired. Review (reviewer -10 / team-lead -13) found the first pass only
// covered 3 of the 8 (/send-message, /poll-messages, /peek-messages); this file
// now covers all 8, including /unregister, whose unguarded path would DESTROY
// the sentinel's row and every undelivered operator-inbox message across every
// group in one call -- the same prerequisite as the disclosure routes, a
// different (destructive) primitive.
//
// Volet 3: SENTINEL_DEFINITIONS (shared/types.ts) is the single enumerable
// source of truth the 4 processing sites (DB seed, TTL exemption, sender-meta
// resolution, RESERVED_PEER_IDS/set_id refusal) now derive from, replacing 4
// hardcoded per-constant copies. The tests below iterate SENTINEL_DEFINITIONS
// directly instead of hardcoding "deck"/"operator", so a third sentinel added
// to the array tomorrow is automatically covered by the SAME test with zero
// test-code changes -- the failure mode this must catch is "array grows, a
// processing site silently doesn't", not "someone forgets to update a test".
// All 4 axes (seeded / TTL-exempt / mapped / set_id-reserved) are asserted
// below, matching this file's own header claim (review MINOR: a prior draft
// promised 4 and asserted 3).
//
// Reciprocity (review MAJOR-1): the PROCESSING-direction guarantee above only
// holds if every *_INSTANCE_TOKEN/*_PEER_ID export actually derives from this
// array -- nothing stopped a hardcoded literal export from bypassing that.
// findUnbackedInstanceTokenExports/findUnbackedPeerIdExports (shared/types.ts)
// make it checkable; the tests below assert it holds for the REAL module
// namespace, and separately (negative control) that the same function catches
// a synthetic supervisor-shaped export that isn't backed -- proving the check
// discriminates rather than being vacuously green, mirroring the reviewer's
// own /tmp probe.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, groupId, sha256Hex, type TestBroker } from "./_helper.ts";
import * as sharedTypes from "../shared/types.ts";
import {
  SENTINEL_DEFINITIONS,
  SENTINEL_INSTANCE_TOKENS,
  RESERVED_PEER_IDS,
  findUnbackedInstanceTokenExports,
  findUnbackedPeerIdExports,
} from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker({
    CLAUDE_PEERS_DORMANT_TTL_HOURS: "0",
    CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1",
  });
});
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, group: { id: string; hash: string } | null = null) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: 1,
    project_key: null,
    group_id: group?.id ?? "default",
    group_secret_hash: group?.hash ?? null,
  });
}

function db(): Database {
  return new Database(broker.dbPath, { readonly: true });
}

// ---------------------------------------------------------------------------
// Volet 2: shape-based refusal at the 3 vulnerable routes
// ---------------------------------------------------------------------------

test("send-message refuses a sentinel-shaped from_token", async () => {
  const b = await register("hsp1", "/sp1");
  for (const sentinel of [...SENTINEL_INSTANCE_TOKENS, "__anything__"]) {
    const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_token: sentinel,
      to_peer_id: b.body.peer_id,
      text: "impersonation attempt",
    });
    expect(res.status).toBe(200); // this route always answers 200; refusal is in the body shape
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error ?? "")).toMatch(/sentinel/i);
  }
});

// Non-vacuous by construction: a real message addressed to the sentinel token
// is planted directly in the DB FIRST, then poll/peek are asked to drain it AS
// that sentinel. If the guard were missing, this would succeed and return the
// message -- exactly the leak the code comment at handlePollMessages describes
// ("drain ... every group's messages addressed to that sentinel"). An
// empty-inbox call proves nothing; this does. Direct DB insertion (rather than
// routing "__anything__" through send-message, which the fix also refuses) is
// what makes the probe independent of volet 2's OWN send-message guard: this
// test must fail if poll/peek's guard is missing, regardless of send-message's.
async function plantMessageTo(instanceToken: string, text: string): Promise<void> {
  const conn = new Database(broker.dbPath);
  try {
    // FK requires a peers row for a non-seeded token like "__anything__".
    conn.run(
      `INSERT OR IGNORE INTO peers
         (instance_token, peer_id, group_id, pid, cwd, summary, registered_at, last_seen, host, client_pid, status)
       VALUES (?, ?, 'default', 0, '', '', datetime('now'), datetime('now'), '', 0, 'dormant')`,
      [instanceToken, `probe-${instanceToken}`]
    );
    const sender = await register(`hsp-plant-${text}`, `/sp-plant-${text}`);
    conn.run(
      `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
       VALUES (?, ?, 'default', ?, datetime('now'), 0)`,
      [sender.body.instance_token, instanceToken, text]
    );
  } finally {
    conn.close();
  }
}

function countUndelivered(instanceToken: string): number {
  const conn = db();
  try {
    const row = conn
      .query("SELECT COUNT(*) as n FROM messages WHERE to_token = ? AND delivered = 0")
      .get(instanceToken) as { n: number };
    return row.n;
  } finally {
    conn.close();
  }
}

test("poll-messages refuses a sentinel-shaped instance_token (worst path: no group_id filter)", async () => {
  for (const sentinel of [...SENTINEL_INSTANCE_TOKENS, "__anything__"]) {
    await plantMessageTo(sentinel, `poll-leak-probe-${sentinel}`);
    const before = countUndelivered(sentinel);
    const res = await post<{ messages: unknown[] }>(`${broker.url}/poll-messages`, {
      instance_token: sentinel,
    });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    // Poll must not have drained (marked delivered) the planted message either.
    expect(countUndelivered(sentinel)).toBe(before);
  }
});

test("peek-messages refuses a sentinel-shaped instance_token", async () => {
  for (const sentinel of [...SENTINEL_INSTANCE_TOKENS, "__anything__"]) {
    await plantMessageTo(sentinel, `peek-leak-probe-${sentinel}`);
    const res = await post<{ messages: unknown[] }>(`${broker.url}/peek-messages`, {
      instance_token: sentinel,
    });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  }
});

test("a real, non-sentinel from_token is not caught by the guard (negative control)", async () => {
  const a = await register("hsp2", "/sp2");
  const b = await register("hsp3", "/sp3");
  const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
    from_token: a.body.instance_token,
    to_peer_id: b.body.peer_id,
    text: "legitimate",
  });
  expect(res.body.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Review MAJOR-2: the same shape refusal, extended to the other 5 routes that
// trust a client-declared instance_token as identity proof. Each test proves
// the row is untouched (not merely that the response says ok:false), which is
// what makes these non-vacuous the same way plantMessageTo/countUndelivered
// made poll/peek non-vacuous above.
// ---------------------------------------------------------------------------

function peerRow(instanceToken: string): { status: string; peer_id: string } | null {
  const conn = db();
  try {
    return conn
      .query("SELECT status, peer_id FROM peers WHERE instance_token = ?")
      .get(instanceToken) as { status: string; peer_id: string } | null;
  } finally {
    conn.close();
  }
}

// Review pass 2, MINOR-2: SENTINEL_DEFINITIONS alone only proves the guard
// matches the KNOWN list -- it would stay green even if the guard silently
// narrowed from isSentinelInstanceToken's shape check to
// SENTINEL_INSTANCE_TOKENS.includes(token), losing the exact property volet 2
// was written to guarantee. "__anything__" (matches the shape, absent from
// the enumerated list) closes that gap, mirroring the send-message/poll/peek
// loops above. ensureDormantRow seeds a row for the synthetic probe only --
// real sentinels are already seeded at boot, so this is a harmless no-op for
// them (INSERT OR IGNORE).
const guardProbes: ReadonlyArray<{ peerId: string; instanceToken: string }> = [
  ...SENTINEL_DEFINITIONS.map((d) => ({ peerId: d.peerId, instanceToken: d.instanceToken })),
  { peerId: "__anything__", instanceToken: "__anything__" },
];

async function ensureDormantRow(instanceToken: string): Promise<void> {
  const conn = new Database(broker.dbPath);
  try {
    conn.run(
      `INSERT OR IGNORE INTO peers
         (instance_token, peer_id, group_id, pid, cwd, summary, registered_at, last_seen, host, client_pid, status)
       VALUES (?, ?, 'default', 0, '', '', datetime('now'), datetime('now'), '', 0, 'dormant')`,
      [instanceToken, `probe-${instanceToken}`]
    );
  } finally {
    conn.close();
  }
}

for (const sentinel of guardProbes) {
  test(`heartbeat refuses a sentinel-shaped instance_token (${sentinel.peerId})`, async () => {
    const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/heartbeat`, {
      instance_token: sentinel.instanceToken,
    });
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error ?? "")).toMatch(/sentinel/i);
  });

  test(`set-summary refuses a sentinel-shaped instance_token (${sentinel.peerId})`, async () => {
    const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/set-summary`, {
      instance_token: sentinel.instanceToken,
      summary: "attacker-controlled summary",
    });
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error ?? "")).toMatch(/sentinel/i);
  });

  test(`disconnect refuses a sentinel-shaped instance_token, row stays 'dormant' unset (${sentinel.peerId})`, async () => {
    await ensureDormantRow(sentinel.instanceToken);
    const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/disconnect`, {
      instance_token: sentinel.instanceToken,
    });
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error ?? "")).toMatch(/sentinel/i);
    // Sentinel rows are already permanently dormant; this only proves the
    // handler never reached the UPDATE (the value wouldn't move regardless,
    // so the outcome shape is what's asserted, not the status transition).
    expect(peerRow(sentinel.instanceToken)?.status).toBe("dormant");
  });

  test(`set-id refuses a sentinel-shaped CALLER instance_token even for a non-reserved target name (${sentinel.peerId})`, async () => {
    await ensureDormantRow(sentinel.instanceToken);
    const before = peerRow(sentinel.instanceToken);
    const res = await post<{ error?: string }>(`${broker.url}/set-id`, {
      instance_token: sentinel.instanceToken,
      new_peer_id: "renamed-by-attacker",
    });
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? "")).toMatch(/sentinel/i);
    // The sentinel's peer_id must survive unrenamed.
    expect(peerRow(sentinel.instanceToken)?.peer_id).toBe(before?.peer_id);
  });

  test(`unregister refuses a sentinel-shaped instance_token -- worst case: does NOT delete the row or drain its inbox (${sentinel.peerId})`, async () => {
    await plantMessageTo(sentinel.instanceToken, `unregister-destruction-probe-${sentinel.peerId}`);
    const before = countUndelivered(sentinel.instanceToken);
    expect(before).toBeGreaterThan(0);

    const res = await post<{ ok: boolean; error?: string }>(`${broker.url}/unregister`, {
      instance_token: sentinel.instanceToken,
    });
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error ?? "")).toMatch(/sentinel/i);

    // The row must still exist (unregister's third DELETE, on `peers`, never ran).
    expect(peerRow(sentinel.instanceToken)).not.toBeNull();
    // And the planted message must not have been erased either (unregister's
    // first DELETE, on `messages`, never ran).
    expect(countUndelivered(sentinel.instanceToken)).toBe(before);
  });

  // The 9th route (review pass 2): non-vacuous by the same discipline as
  // poll/peek above -- plant a REAL "target" peer in 'default', then confirm
  // via a SECOND real peer's own token (handleListPeers excludes the caller
  // itself from its own results, so the control call can't reuse the target's
  // token) that /list-peers legitimately surfaces the target -- proving the
  // empty result asserted next isn't just an empty group to begin with. Then
  // ask as the sentinel and require the target to be absent -- that absence
  // is the entire guard, since the route's implicit group filter would
  // otherwise resolve the sentinel's own 'default' group and hand back every
  // real peer in it.
  test(`list-peers refuses a sentinel-shaped instance_token -- does not leak the caller's resolved group (${sentinel.peerId})`, async () => {
    // Seed a row for the caller token so the guard is what's under test, not
    // an accidental "no callerRow -> []" fail-closed for the synthetic
    // "__anything__" probe (which has no row otherwise). Harmless no-op for
    // the two real sentinels, already seeded at boot.
    await ensureDormantRow(sentinel.instanceToken);
    const target = await register(`hsp-list-target-${sentinel.peerId}`, `/sp-list-target-${sentinel.peerId}`);
    const viewer = await register(`hsp-list-viewer-${sentinel.peerId}`, `/sp-list-viewer-${sentinel.peerId}`);
    const control = await post<Array<{ peer_id: string }>>(`${broker.url}/list-peers`, {
      scope: "machine",
      instance_token: viewer.body.instance_token,
      cwd: "",
      git_root: null,
    });
    expect(control.body.some((p) => p.peer_id === target.body.peer_id)).toBe(true);

    const res = await post<Array<{ peer_id: string }>>(`${broker.url}/list-peers`, {
      scope: "machine",
      instance_token: sentinel.instanceToken,
      cwd: "",
      git_root: null,
    });
    expect(res.body.some((p) => p.peer_id === target.body.peer_id)).toBe(false);
  });
}

// ---------------------------------------------------------------------------
// Volet 3: SENTINEL_DEFINITIONS-driven coverage of the processing sites.
// Every assertion below iterates the array -- it does not name "deck" or
// "operator" anywhere -- so it re-checks itself automatically against any
// future third entry.
// ---------------------------------------------------------------------------

test("every SENTINEL_DEFINITIONS entry has a dormant seed row in 'default'", () => {
  const conn = db();
  try {
    for (const sentinel of SENTINEL_DEFINITIONS) {
      const row = conn
        .query("SELECT peer_id, group_id, status FROM peers WHERE instance_token = ?")
        .get(sentinel.instanceToken) as { peer_id: string; group_id: string; status: string } | null;
      expect(row).not.toBeNull();
      expect(row!.peer_id).toBe(sentinel.peerId);
      expect(row!.group_id).toBe("default");
      expect(row!.status).toBe("dormant");
    }
  } finally {
    conn.close();
  }
});

test("every SENTINEL_DEFINITIONS row survives cleanStalePeers regardless of TTL", async () => {
  // TTL=0 + a 1s clean interval (beforeAll) mean any ordinary dormant peer gets
  // purged almost immediately. Backdate every sentinel row's last_seen the same
  // way, then confirm cleanStalePeers's own reserved-token exemption (broker.ts,
  // "Phase 2") -- built from SENTINEL_INSTANCE_TOKENS, not a hardcoded pair --
  // still leaves every entry standing after several sweeps.
  const conn = new Database(broker.dbPath);
  try {
    for (const sentinel of SENTINEL_DEFINITIONS) {
      conn.run("UPDATE peers SET last_seen = ? WHERE instance_token = ?", [
        "2000-01-01T00:00:00Z",
        sentinel.instanceToken,
      ]);
    }
  } finally {
    conn.close();
  }

  await Bun.sleep(3000);

  const conn2 = db();
  try {
    for (const sentinel of SENTINEL_DEFINITIONS) {
      const row = conn2
        .query("SELECT instance_token FROM peers WHERE instance_token = ?")
        .get(sentinel.instanceToken);
      expect(row).not.toBeNull();
    }
  } finally {
    conn2.close();
  }
}, 15_000);

test("resolveSenderMeta maps every SENTINEL_DEFINITIONS entry's instance_token to its peer_id", async () => {
  // resolveSenderMeta is only reachable indirectly (toDeliveredMessage, called
  // from poll/peek), and no live handler currently emits a message FROM a
  // sentinel other than 'deck' via /announce -- 'operator' only ever RECEIVES.
  // Insert the row directly (same technique as tests/broker-fk-cleanup.test.ts)
  // to exercise the read-side mapping for every array entry regardless of which
  // write paths exist today; this is deliberately robust to volet-1 adding a
  // legitimate operator-authored send path later.
  const g = { id: await groupId("sentinel-meta"), hash: await sha256Hex("sentinel-meta") };
  const target = await register("hsp-meta", "/sp-meta", g);

  const conn = new Database(broker.dbPath);
  try {
    for (const sentinel of SENTINEL_DEFINITIONS) {
      conn.run(
        `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
         VALUES (?, ?, ?, ?, datetime('now'), 0)`,
        [sentinel.instanceToken, target.body.instance_token, g.id, `from ${sentinel.peerId}`]
      );
    }
  } finally {
    conn.close();
  }

  const res = await post<{ messages: { from_peer_id: string; text: string }[] }>(
    `${broker.url}/peek-messages`,
    { instance_token: target.body.instance_token }
  );
  expect(res.status).toBe(200);
  for (const sentinel of SENTINEL_DEFINITIONS) {
    const match = res.body.messages.find((m) => m.text === `from ${sentinel.peerId}`);
    expect(match).toBeDefined();
    expect(match!.from_peer_id).toBe(sentinel.peerId);
  }
});

test("set_id refuses every SENTINEL_DEFINITIONS peer_id as a rename TARGET (4th processing site, review MINOR)", async () => {
  // This file's header claims 4 processing sites (seed, TTL exemption,
  // sender-meta, and RESERVED_PEER_IDS/set_id); the prior draft asserted only
  // 3. RESERVED_PEER_IDS is built by mapping SENTINEL_DEFINITIONS (plus
  // "system"), so this closes the gap the same way as the other three: by
  // iterating the array, not a hardcoded "deck"/"operator" pair.
  const caller = await register("hsp-setid-target", "/sp-setid-target");
  for (const sentinel of SENTINEL_DEFINITIONS) {
    const res = await post<{ error?: string }>(`${broker.url}/set-id`, {
      instance_token: caller.body.instance_token,
      new_peer_id: sentinel.peerId,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error ?? "")).toMatch(/reserved/i);
  }
});

// ---------------------------------------------------------------------------
// Review MAJOR-1: reciprocity. The PROCESSING-direction comment in
// shared/types.ts claims every *_INSTANCE_TOKEN/*_PEER_ID export derives from
// SENTINEL_DEFINITIONS/RESERVED_PEER_IDS. These two tests make that checkable:
// the first proves it holds for the REAL module (must be empty); the second
// is a negative control proving the same function actually catches a
// supervisor-shaped export that doesn't derive from the array -- without it,
// an always-empty result would be indistinguishable from "the check never
// fires" (exactly the vacuous-test failure mode this file's own poll/peek
// tests were fixed for, earlier in this file).
// ---------------------------------------------------------------------------

test("every real *_INSTANCE_TOKEN / *_PEER_ID export is backed by a SENTINEL_DEFINITIONS entry", () => {
  const unbackedTokens = findUnbackedInstanceTokenExports(sharedTypes as unknown as Record<string, unknown>);
  const unbackedPeerIds = findUnbackedPeerIdExports(sharedTypes as unknown as Record<string, unknown>);
  expect(unbackedTokens).toEqual([]);
  expect(unbackedPeerIds).toEqual([]);
});

test("reciprocity check is non-vacuous: it catches a supervisor-shaped export that bypasses SENTINEL_DEFINITIONS (negative control)", () => {
  // Mirrors the reviewer's own /tmp probe: a hardcoded literal export, never
  // added to SENTINEL_DEFINITIONS, matches the naming convention and the
  // __x__ shape but has no backing entry.
  const fakeModule = {
    ...sharedTypes,
    SUPERVISOR_INSTANCE_TOKEN: "__supervisor__",
    SUPERVISOR_PEER_ID: "supervisor",
  } as unknown as Record<string, unknown>;

  expect(findUnbackedInstanceTokenExports(fakeModule)).toEqual(["SUPERVISOR_INSTANCE_TOKEN"]);
  expect(findUnbackedPeerIdExports(fakeModule)).toEqual(["SUPERVISOR_PEER_ID"]);
  // And confirm the real exports it derived from are untouched by the spread.
  expect(SENTINEL_INSTANCE_TOKENS.includes("__supervisor__" as never)).toBe(false);
  expect(RESERVED_PEER_IDS.includes("supervisor" as never)).toBe(false);
});
