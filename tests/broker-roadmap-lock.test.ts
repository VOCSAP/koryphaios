// PLAN K2: agent work-lock on roadmap items. Covers the implicit lock on
// in_progress writes (non-'deck' authors), the 409 guard against another
// peer's status writes, the deck/force bypasses, the release on leaving
// in_progress, and the stale-lock sweep (TTL + owner gone).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker , deckAuthored } from "./_helper.ts";
import { Database } from "bun:sqlite";
import { ROADMAP_IMPORT_COLUMNS, findUncoveredRoadmapColumns, type RoadmapItem } from "../shared/types.ts";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/lock-repo";

type UpsertRes = { item: RoadmapItem };

async function add(fields: Record<string, unknown>): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.item;
}

async function patch(
  id: string,
  by: string,
  fields: Record<string, unknown>
): Promise<{ status: number; item?: RoadmapItem; error?: string }> {
  // Card 39c40571 layer 2: 'deck' names the operator and its writes must now be
  // SIGNED. Signed here rather than swapped for another author, because these
  // tests are precisely about the deck's lock exemptions -- switching the
  // author would keep them green while they stopped covering that path.
  //
  // READ THIS BEFORE ADDING A TEST. The ternary signs EVERY by:'deck' write
  // that goes through this helper, silently and without the caller asking. So
  // an assertion written here to prove that an UNSIGNED deck write is REFUSED
  // would be signed on its way out and would pass while testing the opposite.
  // Any layer-2 refusal case must post its body directly, as
  // broker-roadmap-author-auth.test.ts does.
  const body =
    by === "deck" ? deckAuthored({ id, ...fields }) : { id, by, ...fields };
  const res = await post<UpsertRes & { error?: string }>(`${broker.url}/roadmap/upsert`, body);
  return { status: res.status, item: res.body.item, error: res.body.error };
}

// House pattern for every sweep-timing assertion in this file (card fc444eda
// review finding, then reused for the TTL-sweep test below on the same
// finding: a fixed `Bun.sleep` grounds the assertion in elapsed wall-clock
// time instead of the real condition, so it either wakes before the async
// sweep interval has ticked -- a flake, not a bug -- or, if padded to the
// worst case, wastes that margin on every fast run). Poll the real condition
// with a generous deadline instead: `check()` reports whether it's done and
// what it last observed; polling costs only the wall time actually used, so
// a wide ceiling is free when things are fast and honest when they are not.
async function pollUntil<T>(
  budgetMs: number,
  intervalMs: number,
  check: () => Promise<{ done: boolean; value: T }>
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const { done, value } = await check();
    last = value;
    if (done) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    `pollUntil timed out after ${budgetMs}ms; last observed: ${JSON.stringify(last)}`
  );
}

// ----- implicit lock / unlock -----

test("agent write of status=in_progress locks the item under its peer_id", async () => {
  const item = await add({ title: "lock me" });
  expect(item.locked).toBe(false);
  expect(item.locked_by).toBeNull();
  expect(item.locked_at).toBeNull();

  const r = await patch(item.id, "agent-a", { status: "in_progress" });
  expect(r.status).toBe(200);
  expect(r.item!.locked).toBe(true);
  expect(r.item!.locked_by).toBe("agent-a");
  expect(r.item!.locked_at).toBeTruthy();
});

test("deck write of status=in_progress does NOT lock (submitted, not started)", async () => {
  const item = await add({ title: "deck launches" });
  const r = await patch(item.id, "deck", { status: "in_progress" });
  expect(r.status).toBe(200);
  expect(r.item!.locked).toBe(false);
  // The agent then claims the deck-launched item with a same-status write.
  const claim = await patch(item.id, "agent-b", { status: "in_progress" });
  expect(claim.status).toBe(200);
  expect(claim.item!.locked).toBe(true);
  expect(claim.item!.locked_by).toBe("agent-b");
});

test("leaving in_progress releases the lock (done / planned / archive)", async () => {
  const item = await add({ title: "finish me", status: "in_progress" });
  expect(item.locked).toBe(true); // born in_progress from an agent => locked

  const done = await patch(item.id, "test-peer", { status: "done" });
  expect(done.item!.locked).toBe(false);
  expect(done.item!.locked_by).toBeNull();
  expect(done.item!.locked_at).toBeNull();

  const again = await add({ title: "archive me", status: "in_progress" });
  const arch = await post<UpsertRes>(`${broker.url}/roadmap/archive`, {
    id: again.id,
    by: "test-peer",
  });
  expect(arch.status).toBe(200);
  expect(arch.body.item.locked).toBe(false);
});

test("explicit locked:false releases while staying in_progress; true re-claims", async () => {
  const item = await add({ title: "explicit", status: "in_progress" });
  expect(item.locked).toBe(true);

  const release = await patch(item.id, "test-peer", { locked: false });
  expect(release.item!.status).toBe("in_progress");
  expect(release.item!.locked).toBe(false);

  const reclaim = await patch(item.id, "other-peer", { locked: true });
  expect(reclaim.item!.locked).toBe(true);
  expect(reclaim.item!.locked_by).toBe("other-peer");
});

test("same-owner re-claim keeps the original locked_at", async () => {
  const item = await add({ title: "stable timestamp", status: "in_progress" });
  const first = item.locked_at;
  const r = await patch(item.id, "test-peer", { status: "in_progress" });
  expect(r.item!.locked_at).toBe(first!);
});

// ----- guard -----

test("another peer's status write on a locked item is refused with 409", async () => {
  const item = await add({ title: "guarded", status: "in_progress" });

  const steal = await patch(item.id, "intruder", { status: "done" });
  expect(steal.status).toBe(409);
  expect(steal.error).toContain("locked by 'test-peer'");

  const claim = await patch(item.id, "intruder", { status: "in_progress" });
  expect(claim.status).toBe(409);

  const archive = await post<{ error?: string }>(`${broker.url}/roadmap/archive`, {
    id: item.id,
    by: "intruder",
  });
  expect(archive.status).toBe(409);

  // Non-status writes stay open (context enrichment by anyone).
  const enrich = await patch(item.id, "intruder", { context: "useful pointer" });
  expect(enrich.status).toBe(200);
  expect(enrich.item!.locked_by).toBe("test-peer");
});

test("a bare locked:false from a non-owner is refused with 409 (release-only steal, card e7b364dc)", async () => {
  // The guard used to gate on `body.locked === true` (claim) while the
  // resolution below honoured `body.locked !== undefined` (claim AND
  // release): an intruder could send {locked:false} ALONE -- no status
  // field -- walk past the guard, and clear locked_by. A second request
  // then claims the now-unlocked item. Proven by mutation: revert the
  // guard's `body.locked !== undefined` back to `body.locked === true` and
  // this assertion is the one that flips from 409 to 200.
  const item = await add({ title: "release-steal target", status: "in_progress" });
  expect(item.locked).toBe(true);
  expect(item.locked_by).toBe("test-peer");

  const bareRelease = await patch(item.id, "intruder", { locked: false });
  expect(bareRelease.status).toBe(409);
  expect(bareRelease.error).toContain("locked by 'test-peer'");

  const listed = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: PK,
  });
  const after = listed.body.items.find((i) => i.id === item.id)!;
  expect(after.locked).toBe(true);
  expect(after.locked_by).toBe("test-peer");
});

test("a bare locked:false with force:true from an unproven author is still refused with 409", async () => {
  // force is only honoured for a proven author (a real registered peer, not a
  // self-declared `by` string); an anonymous body cannot use it to launder a
  // release-steal either.
  const item = await add({ title: "release-steal target, forced", status: "in_progress" });
  expect(item.locked).toBe(true);

  const bareRelease = await patch(item.id, "intruder", { locked: false, force: true });
  expect(bareRelease.status).toBe(409);
});

// The lock-move guard is an effect check, not a field-name list:
// resolveRoadmapLock is called once, before the guard, and the guard fires when
// its resolved {locked, lockedBy} actually differs from `existing` (or
// body.status is set at all).
// A future field that feeds resolveRoadmapLock is covered automatically; one
// that bypasses it entirely is not, and needs the same audit this card did.
// /roadmap/import's locked/locked_by/locked_at are exempted by arbitration
// (card 39c40571): a --force import may write the lock columns from file
// content with no proven author.

test("owner, deck and force:true bypass the guard", async () => {
  const a = await add({ title: "owner moves", status: "in_progress" });
  const owner = await patch(a.id, "test-peer", { status: "done" });
  expect(owner.status).toBe(200);

  const b = await add({ title: "deck moves", status: "in_progress" });
  const deck = await patch(b.id, "deck", { status: "planned" });
  expect(deck.status).toBe(200);
  expect(deck.item!.locked).toBe(false);

  // Card 39c40571 layer 1: `force` is a claim of certainty, so it is now only
  // honoured for a caller that PROVED who it is. An anonymous body could
  // otherwise take any locked item by adding a single field.
  const c = await add({ title: "forced", status: "in_progress" });
  const anonymous = await patch(c.id, "intruder", { status: "planned", force: true });
  expect(anonymous.status).toBe(409);

  const reg = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/forcer", git_root: null, tty: null,
    summary: "", host: "h-force", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "default", group_secret_hash: null,
  });
  expect(reg.status).toBe(200);
  const forced = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: c.id,
    by: reg.body.peer_id,
    instance_token: reg.body.instance_token,
    status: "planned",
    force: true,
  });
  expect(forced.status).toBe(200);
});

test("locked rejects non-boolean values", async () => {
  const item = await add({ title: "typed" });
  const bad = await patch(item.id, "test-peer", { locked: "yes" });
  expect(bad.status).toBe(400);
});

// ----- stale-lock sweep -----

test("TTL sweep releases a lock with no recent write and drops status to planned", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "2",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "3600",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const res = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "agent-ttl",
      title: "stale",
      status: "in_progress",
    });
    expect(res.body.item.locked).toBe(true);

    // Backdate updated_at well past the 2s TTL, then poll for the next sweep
    // tick to observe it -- was a fixed `await Bun.sleep(2_500)` (card
    // fc444eda review finding). The TTL condition is already true from t=0
    // here (backdated -60s, well past the -2s threshold), so the only real
    // wait is for guardedInterval's 1s tick to fire and run the sweep -- an
    // unsynchronized setInterval a fixed sleep has no guarantee of catching.
    // Poll the real condition instead (pollUntil above, same discipline as
    // the owner-gone tests below): costs only the wall time actually used,
    // so a generous budget is free when the tick lands promptly.
    const db = new Database(b.dbPath);
    db.run("UPDATE roadmap_items SET updated_at = datetime('now', '-60 seconds') WHERE id = ?", [
      res.body.item.id,
    ]);
    db.close();

    const item = await pollUntil(12_000, 300, async () => {
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const found = after.body.items.find((i) => i.id === res.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    expect(item.locked).toBe(false);
    expect(item.locked_by).toBeNull();
    expect(item.status).toBe("planned");
    expect(item.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

// Card edefff05: releaseStaleLocks' shared release() helper clears
// operator_id to NULL alongside locked_by/locked_at -- an arbitration (the
// sweep erases attribution the same way it erases ownership), not an
// accident, so it needs its own pinned proof. Same false-coverage trap as
// the upsert-PATCH and archive cells found on this card: a cell that only
// asserts operator_id is NULL after the sweep is indistinguishable from
// "the column was never written in the first place" unless a signed write
// stamped a real value on the row BEFORE the sweep fires.
test("TTL sweep clears operator_id alongside locked_by, but only after a signed write stamped one", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "2",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "3600",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // resolveRoadmapLock (shared/roadmap-lock.ts) exempts `by === "deck"`
    // from ever claiming the lock (its own writes are "submitted, not
    // started"), so deckAuthored() can't be used to get locked=true here.
    // `by: "operator"` is also a RESERVED_PEER_IDS name -- goes through the
    // same signed reserved-author branch of resolveRoadmapAuthor as "deck"
    // does, so operator_id still gets stamped -- but it isn't exempted from
    // claiming the lock, so it actually stays locked to poll a real release.
    const credential = generateCredential();
    const operatorId = deriveOperatorId(credential.publicKey);
    const body = {
      project_key: PK,
      title: "stale-signed",
      status: "in_progress",
      by: "operator",
      public_key: credential.publicKey,
    };
    const res = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      ...body,
      auth: buildAuthProof(credential.privateKey, body, {
        kind: "operator",
        operator_id: operatorId,
      }),
    });
    expect(res.body.item.locked).toBe(true);
    expect(res.body.item.operator_id).toBe(operatorId);

    const db = new Database(b.dbPath);
    db.run("UPDATE roadmap_items SET updated_at = datetime('now', '-60 seconds') WHERE id = ?", [
      res.body.item.id,
    ]);
    db.close();

    const item = await pollUntil(12_000, 300, async () => {
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const found = after.body.items.find((i) => i.id === res.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    expect(item.locked).toBe(false);
    expect(item.locked_by).toBeNull();
    expect(item.operator_id).toBeUndefined();
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("owner-gone sweep releases after grace, but an active owner keeps the lock", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // A live registered peer holds one lock; a ghost peer_id holds another.
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/lock", git_root: null, tty: null,
      summary: "", host: "h-lock", client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    const held = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      // Card 39c40571: writing as a REGISTERED peer now requires its token.
      // ("ghost-peer" below names no peer row, so it stays token-free.)
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "held", status: "in_progress",
    });
    const ghost = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "ghost-peer", title: "abandoned", status: "in_progress",
    });
    // Prove the ghost lock is actually SET before waiting for it to fall --
    // otherwise a poll for "released" would pass instantly, and for the
    // wrong reason, the day locking itself breaks (card 365561ba review).
    expect(held.body.item.locked).toBe(true);
    expect(ghost.body.item.locked).toBe(true);

    // SQLite's datetime() truncates both sides to whole seconds, so combined
    // with the 1s sweep tick the release is only guaranteed observable within
    // grace_sec + sweep_period_sec, plus up to 1s of truncation aliasing.
    // Poll the real condition (pollUntil) rather than a fixed sleep: a wide
    // ceiling costs nothing when things are fast and stays honest when they are
    // not.
    let heldAfter: RoadmapItem | undefined;
    const ghostAfter = await pollUntil(12_000, 300, async () => {
      await post(`${b.url}/heartbeat`, { instance_token: reg.body.instance_token });
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      heldAfter = after.body.items.find((i) => i.id === held.body.item.id)!;
      const ghostItem = after.body.items.find((i) => i.id === ghost.body.item.id)!;
      // The live owner's lock must never be swept away while we wait for the
      // ghost's -- assert every iteration, not only at the end, so a
      // regression here can't hide behind "the ghost eventually released".
      expect(heldAfter.locked).toBe(true);
      return { done: ghostItem.locked === false, value: ghostItem };
    });
    expect(heldAfter!.status).toBe("in_progress");
    expect(ghostAfter.status).toBe("planned");
    expect(ghostAfter.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("owner-gone sweep (site c): a live homonym peer in a DIFFERENT group does not keep a dead true owner's lock alive", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const host = "h-e344fa79-sweep";
    const cwd = "/tmp/e344fa79-sweep-repo";

    const trueOwner = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd, git_root: null, tty: null,
      summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "e344fa79-sweep-group-a", group_secret_hash: null,
    });
    const homonym = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd, git_root: null, tty: null,
      summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
      project_key: PK, group_id: "e344fa79-sweep-group-b", group_secret_hash: null,
    });
    expect(homonym.body.peer_id).toBe(trueOwner.body.peer_id);

    const item = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: trueOwner.body.peer_id,
      instance_token: trueOwner.body.instance_token,
      title: "owned by the true owner, abandoned",
      status: "in_progress",
    });
    expect(item.body.item.locked).toBe(true);

    // Force the true owner's OWN peer row dormant and stale, directly via
    // sqlite -- the real dormancy path (sweepInactivePeers) floors both its
    // own interval and ACTIVE_STALE_SEC at 10s (broker.ts), which would make
    // this test slow and couple it to a second, unrelated sweep's timing.
    // Same discipline as the TTL/park tests above backdating columns no HTTP
    // route lets a caller set directly -- this test is about the OWNER-GONE
    // check alone, not about how a peer eventually becomes dormant.
    const db = new Database(b.dbPath);
    db.run(
      "UPDATE peers SET status = 'dormant', last_seen = datetime('now', '-3600 seconds') WHERE instance_token = ?",
      [trueOwner.body.instance_token]
    );
    db.close();

    const after = await pollUntil(12_000, 300, async () => {
      await post(`${b.url}/heartbeat`, { instance_token: homonym.body.instance_token });
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const found = listed.body.items.find((i) => i.id === item.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    expect(after.status).toBe("planned");
    expect(after.locked_by).toBeNull();
    expect(after.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

// A row locked before the group column existed has locked_group IS NULL (no
// backfill), and the owner-gone sweep's group term degrades to the old
// peer_id-only check on such a row.
// This proves the degrade actually releases a truly-abandoned legacy lock, not
// just that it declines to crash on NULL.
test("owner-gone sweep (site c): a legacy row (locked_group NULL, pre-migration) still releases normally once its owner is gone", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const item = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "legacy-ghost-peer", title: "locked pre-migration", status: "in_progress",
    });
    expect(item.body.item.locked).toBe(true);

    // Simulate a row written before locked_group existed: force it back to
    // NULL directly, the same way the TTL/park tests above backdate columns
    // no HTTP route lets a caller set directly.
    const db = new Database(b.dbPath);
    db.run("UPDATE roadmap_items SET locked_group = NULL WHERE id = ?", [item.body.item.id]);
    db.close();

    // "legacy-ghost-peer" names no registered peer row at all, so it is
    // owner-gone from the very first sweep tick, exactly like the "ghost"
    // half of the sibling test above.
    const after = await pollUntil(12_000, 300, async () => {
      const listed = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const found = listed.body.items.find((i) => i.id === item.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    expect(after.status).toBe("planned");
    expect(after.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

// rowToRoadmapItem is an explicit pick-list, not a `...row` rest-spread, so a
// future column stays invisible until named instead of shipping publicly the
// moment its migration runs.
// The response is read off a real round trip so operator_id -- RoadmapItem's
// one optional field -- is a real string rather than undefined: JSON.stringify
// drops an undefined key, which would otherwise read as a false positive on any
// ordinary agent-authored card.
test("card e344fa79: rowToRoadmapItem's response covers every roadmap_items column (pick-list coverage, not a rest-spread)", async () => {
  const db = new Database(broker.dbPath, { readonly: true });
  let schemaColumns: string[];
  try {
    schemaColumns = (
      db.query("PRAGMA table_info(roadmap_items)").all() as { name: string }[]
    ).map((c) => c.name);
  } finally {
    db.close();
  }
  // The probe must SEE the schema before its silence can mean anything.
  expect(schemaColumns.length).toBeGreaterThan(10);
  expect(schemaColumns).toContain("locked_group"); // the column this card added

  const credential = generateCredential();
  const operatorId = deriveOperatorId(credential.publicKey);
  const createBody = {
    project_key: PK,
    title: "pick-list coverage probe",
    by: "deck",
    public_key: credential.publicKey,
  };
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    ...createBody,
    auth: buildAuthProof(credential.privateKey, createBody, { kind: "operator", operator_id: operatorId }),
  });
  expect(res.status).toBe(200);
  expect(res.body.item.operator_id).toBe(operatorId); // proves it round-tripped as a real string

  const emittedColumns = Object.keys(res.body.item);
  const { missing, extra } = findUncoveredRoadmapColumns(schemaColumns, emittedColumns);
  // Replication bookkeeping (DESIGN-OFFLINE-REPLICA): revision counters, the
  // merge base, the relay heartbeat. They belong to the sync protocol, not to
  // the card an agent or the Deck reads, so the public projection drops them
  // ON PURPOSE -- listed here one by one so a column added later still has to
  // be classified rather than silently joining them. The three replication
  // fields the operator DOES see (sync_state, lock_scope, lock_contested_by)
  // are absent from this list precisely because they must be emitted.
  const INTERNAL_ONLY_COLUMNS = [
    "rev",
    "content_rev",
    "sync_base_rev",
    "sync_base",
    "sync_dirty",
    "sync_remote",
    "lock_relay",
    "lock_relay_seen",
    "lock_release_owner",
  ];
  // Equality, not a subset check: a public column dropped from the projection
  // and an unclassified new column both land here and both fail.
  expect(missing).toEqual(INTERNAL_ONLY_COLUMNS);
  expect(extra).toEqual([]); // a key in the response with no backing column

  // Sanity companion, not a substitute for the two checks above: the schema
  // and ROADMAP_IMPORT_COLUMNS (a list maintained independently, for a
  // different route) must name the same columns -- including the internal
  // ones above, which /roadmap/import has to carry over or REPLACE resets
  // them. If they ever diverge, that is itself worth knowing, but it is not
  // what this test polices.
  expect(findUncoveredRoadmapColumns(schemaColumns, ROADMAP_IMPORT_COLUMNS).missing).toEqual([]);
});

// ----- park (card aaf4537d, lots 1+2) -----

// releaseStaleLocks has no route to PARK a card yet (lock-park/lock-release
// HTTP routes are lot 3, out of scope for this cell) -- these tests set
// lock_parked_at/lock_parked_by directly via sqlite, same discipline the TTL
// and owner-gone tests above already use to backdate updated_at/locked_at.
test("park TTL sweep (clause 3): releases an EXPIRED park (T-(ttl+1s)) but leaves one still within TTL (T-(ttl-1s)) alone", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "3600",
    CLAUDE_PEERS_LOCK_PARK_TTL_SEC: "4",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const inside = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "agent-park-inside", title: "parked, still fresh", status: "in_progress",
    });
    const outside = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "agent-park-outside", title: "parked, expired", status: "in_progress",
    });
    expect(inside.body.item.locked).toBe(true);
    expect(outside.body.item.locked).toBe(true);

    const db = new Database(b.dbPath);
    // T-(ttl-1s): parked 3s ago against a 4s TTL -- 1s still remains, must
    // stay parked/locked.
    db.run(
      "UPDATE roadmap_items SET lock_parked_at = datetime('now', '-3 seconds'), lock_parked_by = 'operator-x' WHERE id = ?",
      [inside.body.item.id]
    );
    // T-(ttl+1s): parked 5s ago against the same 4s TTL -- 1s past expiry,
    // clause 3 must release it.
    db.run(
      "UPDATE roadmap_items SET lock_parked_at = datetime('now', '-5 seconds'), lock_parked_by = 'operator-x' WHERE id = ?",
      [outside.body.item.id]
    );
    db.close();

    const outsideAfter = await pollUntil(12_000, 300, async () => {
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const insideItem = after.body.items.find((i) => i.id === inside.body.item.id)!;
      const outsideItem = after.body.items.find((i) => i.id === outside.body.item.id)!;
      // The still-within-TTL park must never be swept while we wait for the
      // expired one's release -- assert every iteration (same discipline as
      // the owner-gone "active owner keeps the lock" test above).
      expect(insideItem.locked).toBe(true);
      expect(insideItem.lock_parked_at).toBeTruthy();
      return { done: outsideItem.locked === false, value: outsideItem };
    });
    expect(outsideAfter.status).toBe("planned");
    expect(outsideAfter.lock_parked_at).toBeNull();
    expect(outsideAfter.lock_parked_by).toBeNull();
    expect(outsideAfter.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("park immunity: clauses 1/2 (TTL, owner-gone) do not release a parked card even when otherwise stale, until the park itself expires", async () => {
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "1",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "1",
    CLAUDE_PEERS_LOCK_PARK_TTL_SEC: "4",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // ghost-peer names no registered peer row, so clause 2's owner-gone
    // condition is met from the very first sweep tick.
    const item = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: "ghost-peer", title: "parked and stale", status: "in_progress",
    });
    expect(item.body.item.locked).toBe(true);

    const db = new Database(b.dbPath);
    // Both updated_at and locked_at pushed well past LOCK_TTL_SEC/
    // LOCK_GRACE_SEC=1s -- clauses 1 and 2 would release this on the very
    // next tick if the park-immunity prefix were not there.
    db.run(
      `UPDATE roadmap_items SET
         updated_at = datetime('now', '-60 seconds'),
         locked_at = datetime('now', '-60 seconds'),
         lock_parked_at = datetime('now'), lock_parked_by = 'operator-x'
       WHERE id = ?`,
      [item.body.item.id]
    );
    db.close();

    // Poll a window comfortably inside the 4s park TTL and comfortably past
    // several 1s sweep ticks -- if the immunity prefix were missing, clause 1
    // or 2 would have released this already.
    await Bun.sleep(2_500);
    const stillParked = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
      project_key: PK,
    });
    const found = stillParked.body.items.find((i) => i.id === item.body.item.id)!;
    expect(found.locked).toBe(true);
    expect(found.lock_parked_at).toBeTruthy();

    // Now expire the park itself and confirm clause 3 (the ONLY clause that
    // may release a parked row) takes over.
    const db2 = new Database(b.dbPath);
    db2.run("UPDATE roadmap_items SET lock_parked_at = datetime('now', '-5 seconds') WHERE id = ?", [
      item.body.item.id,
    ]);
    db2.close();

    const released = await pollUntil(12_000, 300, async () => {
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const found2 = after.body.items.find((i) => i.id === item.body.item.id)!;
      return { done: found2.locked === false, value: found2 };
    });
    expect(released.status).toBe("planned");
    expect(released.lock_parked_at).toBeNull();
  } finally {
    await stopBroker(b);
  }
}, 20_000);

test("owner-gone sweep releases a NULL-project_key peer's lock on a DIFFERENT project's card, even while that peer stays active", async () => {
  // A NULL project_key is a value in its own right, not a wildcard: the
  // owner-gone liveness check is scoped on project_key, so a project-less peer
  // only counts as live for project-less cards, never for a real project's.
  const b = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "3600",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "2",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    // Registers with project_key: null (e.g. a cwd with no git remote
    // configured -- shared/summarize.ts computeProjectKey() returns null in
    // that case, and server.ts /register forwards it unchanged, no fallback).
    const reg = await post<{ instance_token: string; peer_id: string }>(`${b.url}/register`, {
      pid: livePid(), cwd: "/tmp/no-remote", git_root: null, tty: null,
      summary: "", host: "h-nullproj", client_pid: livePid(), claude_cli_pid: 1,
      project_key: null, group_id: "default", group_secret_hash: null,
    });
    expect(reg.status).toBe(200);

    // Same peer authors and locks a card under an UNRELATED real project (PK).
    const orphan = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK, by: reg.body.peer_id, instance_token: reg.body.instance_token,
      title: "squatted by null-project peer", status: "in_progress",
    });
    expect(orphan.body.item.locked).toBe(true);

    // Poll past the grace period while heartbeating the whole time -- proves
    // the release happens BECAUSE of the project mismatch, not because the
    // peer went stale (same polling discipline as card 365561ba, see the
    // sibling test above for the truncation-aliasing rationale; pollUntil
    // defined above).
    const orphanAfter = await pollUntil(12_000, 300, async () => {
      await post(`${b.url}/heartbeat`, { instance_token: reg.body.instance_token });
      const after = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, {
        project_key: PK,
      });
      const found = after.body.items.find((i) => i.id === orphan.body.item.id)!;
      return { done: found.locked === false, value: found };
    });
    expect(orphanAfter.status).toBe("planned");
    expect(orphanAfter.updated_by).toBe("lock-sweep");
  } finally {
    await stopBroker(b);
  }
}, 20_000);

// ----- group-aware lock ownership (card e344fa79) -----

// peers.UNIQUE(peer_id, group_id): a peer_id is unique only PER GROUP, but
// the roadmap is shared ACROSS every group on the same broker (same
// project_key, no group term in its scope -- operator ruling fc444eda).
// deriveDefaultId (broker.ts) derives its candidate from host+cwd alone and
// only consults the OTHER rows of the SAME group for collision, so the SAME
// host+cwd registered under two different group_ids mints the SAME peer_id
// in both -- measured on the live roadmap card, reproduced here.
test("a same-peer_id homonym registered in a DIFFERENT group cannot satisfy another group's lock (the accident measured on card e344fa79)", async () => {
  const host = "h-e344fa79";
  const cwd = "/tmp/e344fa79-lock-repo";

  const trueOwner = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-group-a", group_secret_hash: null,
  });
  expect(trueOwner.status).toBe(200);

  const homonym = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-group-b", group_secret_hash: null,
  });
  expect(homonym.status).toBe(200);

  // The whole premise of this test: two DIFFERENT, legitimately-registered
  // peers (different group_id, so a different row each) share the SAME
  // peer_id string.
  expect(homonym.body.peer_id).toBe(trueOwner.body.peer_id);

  const item = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: trueOwner.body.peer_id,
    instance_token: trueOwner.body.instance_token,
    title: "owned by group-a's peer",
    status: "in_progress",
  });
  expect(item.body.item.locked).toBe(true);
  expect(item.body.item.locked_by).toBe(trueOwner.body.peer_id);

  // The homonym, PROVEN (its own real instance_token, not a bare `by`
  // claim), attempts to move the card as if it were the owner. Before this
  // card, `by !== existing.locked_by` was the whole guard: same string,
  // so it read as the SAME owner and this would have been a 200.
  const stolen = await post<{ status?: number; error?: string }>(`${broker.url}/roadmap/upsert`, {
    id: item.body.item.id,
    by: homonym.body.peer_id,
    instance_token: homonym.body.instance_token,
    status: "done",
  });
  expect(stolen.status).toBe(409);
  expect(stolen.body.error).toContain(`locked by '${trueOwner.body.peer_id}'`);

  // The true owner, from its own group, is unaffected and can still move it.
  const legit = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: item.body.item.id,
    by: trueOwner.body.peer_id,
    instance_token: trueOwner.body.instance_token,
    status: "done",
  });
  expect(legit.status).toBe(200);
  expect(legit.body.item.locked).toBe(false);
});

test("the same accident, on /roadmap/archive: a same-peer_id homonym in a different group cannot archive another group's locked card", async () => {
  const host = "h-e344fa79-archive";
  const cwd = "/tmp/e344fa79-archive-repo";

  const trueOwner = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-archive-group-a", group_secret_hash: null,
  });
  const homonym = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-archive-group-b", group_secret_hash: null,
  });
  expect(homonym.body.peer_id).toBe(trueOwner.body.peer_id);

  const item = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: trueOwner.body.peer_id,
    instance_token: trueOwner.body.instance_token,
    title: "owned by archive group-a's peer",
    status: "in_progress",
  });
  expect(item.body.item.locked).toBe(true);

  const stolen = await post<{ status?: number; error?: string }>(`${broker.url}/roadmap/archive`, {
    id: item.body.item.id,
    by: homonym.body.peer_id,
    instance_token: homonym.body.instance_token,
  });
  expect(stolen.status).toBe(409);
});

// isSameOwnerReclaim's bare locked_by === resolvedLock.lockedBy comparison also
// decides whether locked_group is preserved from the row's prior owner or
// stamped fresh from the write's actual author.
// A force:true steal by a proven homonym in a different group passes the upsert
// guard on its own terms, but this comparison read same peer_id string as same
// owner and kept the victim's locked_group on a row now held by the intruder.
test("force:true steal by a proven homonym in a DIFFERENT group stamps the NEW owner's locked_group, not the victim's (card e344fa79, isSameOwnerReclaim)", async () => {
  const host = "h-e344fa79-force";
  const cwd = "/tmp/e344fa79-force-repo";

  const victim = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-force-group-victim", group_secret_hash: null,
  });
  const intruder = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-force-group-intruder", group_secret_hash: null,
  });
  expect(intruder.body.peer_id).toBe(victim.body.peer_id); // the homonym setup

  const item = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: victim.body.peer_id,
    instance_token: victim.body.instance_token,
    title: "victim's card, about to be force-stolen by its own homonym",
    status: "in_progress",
  });
  expect(item.body.item.locked).toBe(true);
  expect(item.body.item.locked_group).toBe("e344fa79-force-group-victim");

  // force:true + a PROVEN author (real instance_token) legitimately passes
  // the guard -- this is exactly what force exists for, and is not itself
  // the defect. `locked: true` makes resolveRoadmapLock set
  // lockedBy = intruder.peer_id (== victim.peer_id, same string).
  const forced = await post<UpsertRes & { error?: string }>(`${broker.url}/roadmap/upsert`, {
    id: item.body.item.id,
    by: intruder.body.peer_id,
    instance_token: intruder.body.instance_token,
    locked: true,
    force: true,
  });
  expect(forced.status).toBe(200);
  expect(forced.body.item.locked).toBe(true);
  expect(forced.body.item.locked_by).toBe(intruder.body.peer_id);

  // THE ASSERTION THAT MATTERS: locked_group must follow the intruder (the
  // actual new holder), never stay the victim's. Red without the fix
  // (isSameOwnerReclaim wrongly true on the bare peer_id match, preserving
  // "e344fa79-force-group-victim"); green with matchesLockOwner in place.
  expect(forced.body.item.locked_group).toBe("e344fa79-force-group-intruder");
});

test("card e344fa79, review round 3 (ROUTE-LEVEL): the Deck's ORDINARY signed write on a locked card preserves locked_by/locked_group -- the routine path, and the one review measured most expensive to break", async () => {
  const host = "h-e344fa79-ordinary-deck";
  const cwd = "/tmp/e344fa79-ordinary-deck-repo";

  const owner = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null,
    summary: "", host, client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-ordinary-deck-group", group_secret_hash: null,
  });

  const item = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: owner.body.peer_id,
    instance_token: owner.body.instance_token,
    title: "locked by its owner, about to receive an ordinary Deck save",
    status: "in_progress",
  });
  expect(item.body.item.locked).toBe(true);
  expect(item.body.item.locked_group).toBe("e344fa79-ordinary-deck-group");

  // Neither `status` nor `locked` in this body -- THAT is what makes it
  // ORDINARY (no lock-relevant field moves, so resolveRoadmapLock's claim
  // branches never fire and `claimed` resolves to false).
  const credential = generateCredential();
  const operatorId = deriveOperatorId(credential.publicKey);
  const ordinaryBody = {
    id: item.body.item.id,
    by: "deck",
    context: "an unrelated edit, saved by the Deck while the card stays locked",
    public_key: credential.publicKey,
  };
  const saved = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    ...ordinaryBody,
    auth: buildAuthProof(credential.privateKey, ordinaryBody, { kind: "operator", operator_id: operatorId }),
  });
  expect(saved.status).toBe(200);
  expect(saved.body.item.locked).toBe(true);
  expect(saved.body.item.locked_by).toBe(owner.body.peer_id);
  expect(saved.body.item.locked_group).toBe("e344fa79-ordinary-deck-group");
});

test("card e344fa79, review round 3 (ROUTE-LEVEL): an ORDINARY write from a peer in a DIFFERENT group, on a card it does not own, preserves the true owner's locked_by/locked_group", async () => {
  const owner = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/repo", git_root: null, tty: null,
    summary: "", host: "h-e344fa79-ord-owner", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-ordinary-tp-group-owner", group_secret_hash: null,
  });
  const thirdParty = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/repo", git_root: null, tty: null,
    summary: "", host: "h-e344fa79-ord-third", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "e344fa79-ordinary-tp-group-third", group_secret_hash: null,
  });
  expect(thirdParty.body.peer_id).not.toBe(owner.body.peer_id); // a genuine third party, not a homonym

  const item = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: owner.body.peer_id,
    instance_token: owner.body.instance_token,
    title: "locked by its owner, about to receive an ordinary third-party save",
    status: "in_progress",
  });
  expect(item.body.item.locked).toBe(true);
  expect(item.body.item.locked_group).toBe("e344fa79-ordinary-tp-group-owner");

  // Neither `status` nor `locked` -- the guard lets this through (nothing
  // lock-relevant moves), and it must not reassign locked_by/locked_group
  // to the third party's own identity.
  const saved = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: item.body.item.id,
    by: thirdParty.body.peer_id,
    instance_token: thirdParty.body.instance_token,
    context: "an unrelated edit from a third party while the card stays locked",
  });
  expect(saved.status).toBe(200);
  expect(saved.body.item.locked).toBe(true);
  expect(saved.body.item.locked_by).toBe(owner.body.peer_id);
  expect(saved.body.item.locked_group).toBe("e344fa79-ordinary-tp-group-owner");
});

test("card 4441e883 (Trou A1): a proven author's claim stamps locked_by_token = its own instance_token, read off the live route", async () => {
  const reg = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/4441e883-a1", git_root: null, tty: null,
    summary: "", host: "h-4441e883-a1", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "default", group_secret_hash: null,
  });
  expect(reg.status).toBe(200);

  const created = await add({ title: "A1: claimed via a proven author" });
  expect(created.locked_by_token).toBeNull(); // unlocked, no claim yet

  const claim = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: created.id,
    by: reg.body.peer_id,
    instance_token: reg.body.instance_token,
    status: "in_progress",
  });
  expect(claim.status).toBe(200);
  expect(claim.body.item.locked).toBe(true);
  expect(claim.body.item.locked_by).toBe(reg.body.peer_id);
  // THE ASSERTION THAT MATTERS: the response's own token, not a guess derived
  // from `by` -- resolveLockedByToken's whole reason to exist (RoadmapItem.
  // locked_by_token's doc comment: "LE BACKFILL NE DEVINE JAMAIS").
  expect(claim.body.item.locked_by_token).toBe(reg.body.instance_token);
});

test("card 4441e883 (Trou A2, the negative control that carries the weight): an ordinary third-party write on an already-locked card preserves the true owner's proven token, never overwrites or nulls it", async () => {
  const owner = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/4441e883-a2-owner", git_root: null, tty: null,
    summary: "", host: "h-4441e883-a2-owner", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "4441e883-a2-group-owner", group_secret_hash: null,
  });
  const thirdParty = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/4441e883-a2-third", git_root: null, tty: null,
    summary: "", host: "h-4441e883-a2-third", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "4441e883-a2-group-third", group_secret_hash: null,
  });
  expect(thirdParty.body.peer_id).not.toBe(owner.body.peer_id); // a genuine third party

  const item = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: owner.body.peer_id,
    instance_token: owner.body.instance_token,
    title: "A2: locked by its owner, about to receive an ordinary third-party save",
    status: "in_progress",
  });
  expect(item.body.item.locked).toBe(true);
  expect(item.body.item.locked_by_token).toBe(owner.body.instance_token);

  // Neither `status` nor `locked` -- an ORDINARY write, exactly the shape the
  // sibling locked_group test above uses. Must not reassign locked_by_token
  // to the third party's own proven token, and must not null it either.
  const saved = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: item.body.item.id,
    by: thirdParty.body.peer_id,
    instance_token: thirdParty.body.instance_token,
    context: "an unrelated edit from a third party while the card stays locked",
  });
  expect(saved.status).toBe(200);
  expect(saved.body.item.locked).toBe(true);
  expect(saved.body.item.locked_by).toBe(owner.body.peer_id);
  expect(saved.body.item.locked_by_token).toBe(owner.body.instance_token);
  expect(saved.body.item.locked_by_token).not.toBe(thirdParty.body.instance_token);
});
