// PLAN K2: agent work-lock on roadmap items. Covers the implicit lock on
// in_progress writes (non-'deck' authors), the 409 guard against another
// peer's status writes, the deck/force bypasses, the release on leaving
// in_progress, and the stale-lock sweep (TTL + owner gone).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker , deckAuthored } from "./_helper.ts";
import { Database } from "bun:sqlite";
import type { RoadmapItem } from "../shared/types.ts";

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

  // The lock must still be intact -- the whole point is that this single
  // field can no longer silently clear it.
  const listed = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: PK,
  });
  const after = listed.body.items.find((i) => i.id === item.id)!;
  expect(after.locked).toBe(true);
  expect(after.locked_by).toBe("test-peer");
});

test("a bare locked:false with force:true from an unproven author is still refused with 409", async () => {
  // Same release-steal shape as the test above, but with `force: true` added.
  // Card 39c40571 layer 1 only honours `force` for a PROVEN author (a real
  // registered peer, not a self-declared `by` string) -- an anonymous body
  // cannot use `force` to launder the release-steal either. This cell's
  // outcome flipped 200 -> 409 as a side effect of the e7b364dc guard fix
  // above (the guard now also gates on `body.locked !== undefined`), but
  // nothing asserted it until now.
  const item = await add({ title: "release-steal target, forced", status: "in_progress" });
  expect(item.locked).toBe(true);

  const bareRelease = await patch(item.id, "intruder", { locked: false, force: true });
  expect(bareRelease.status).toBe(409);
});

// The domain here is six fields across two endpoints (measured by walking
// the request interfaces, not the handlers): /roadmap/upsert's `locked`,
// `status` (an in_progress write implicitly claims/releases) and `force`
// (claims-of-certainty, honoured only for a proven author -- see the next
// test); /roadmap/import's `locked`, `locked_by`, `locked_at` (whole-row
// restore, EXEMPTED BY ARBITRATION, not by an oversight: card 39c40571 rules
// that a --force import is allowed to write the three lock columns straight
// from file content with no proven author at all, because import skips a
// locked row outright unless force -- see tests/broker-roadmap-import.test.ts
// card 40ddf1f5, which already carries the negative controls for it; this is
// a pointer, not a duplicate). /roadmap/archive releases the lock with no
// body field at all, but is already gated by an owner/deck-only check
// (see "another peer's status write on a locked item is refused with 409"
// above, which asserts the archive-by-intruder 409 case) -- nothing to fix
// there, card e7b364dc's own text describing it as open predates that guard.
//
// Growth-of-domain answer (Part B, card e7b364dc): the guard used to be an
// enumerated OR-list of body FIELD NAMES -- fails open the instant a new
// request field also moves the lock, until someone adds it by hand. It is
// now an EFFECT check: shared/roadmap-lock.ts's resolveRoadmapLock is called
// once, before the guard, and the guard fires when its resolved
// {locked, lockedBy} actually differs from `existing` (OR body.status is set
// at all, which must survive on its own -- see the truth table in
// tests/roadmap-lock.test.ts for the same-status-already-locked cell that
// resolves to zero delta yet must still 409). A hypothetical 7th field that
// feeds resolveRoadmapLock is covered automatically, by construction, as
// long as it flows through that one function -- the guard no longer needs to
// name it. A 7th field that bypasses resolveRoadmapLock entirely (writes lock
// state through some other path) is not covered by this and would need the
// same audit this card just did; that limit is structural, not a gap in this
// fix.

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

    // Card 365561ba: releaseStaleLocks' owner-gone check is
    // `datetime(locked_at) < datetime('now', -GRACE seconds)`, and SQLite's
    // datetime() truncates BOTH sides to whole seconds. Combined with the 1s
    // sweep tick, the release is only guaranteed observable within
    // grace_sec + sweep_period_sec, plus up to 1s more of truncation
    // aliasing depending on which second locked_at floors into relative to
    // the tick schedule -- measured worst case ~4s for this grace=2s/
    // sweep=1s config (instrumented repro: iter1 still-locked at +3865ms,
    // the boundary tick's `<` missed by the floor, released only on the
    // NEXT tick). A single fixed sleep budget close to that worst case
    // reproduces the flake on a slower/busier machine -- poll the real
    // condition instead (pollUntil above). Budget generous margin over the
    // measured worst case, not a value that skims it: polling only costs
    // the wall time actually used, so a wide ceiling is free when things
    // are fast and honest when they are not.
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

test("owner-gone sweep releases a NULL-project_key peer's lock on a DIFFERENT project's card, even while that peer stays active", async () => {
  // Card fc444eda (operator ruling, 2026-08-11): the owner-gone liveness
  // check is scoped on project_key alone, and a NULL project_key is a value
  // in its own right, not a wildcard -- a project-less peer only "counts as
  // live" for project-less cards, never for a real project's. Before the
  // fix, `(p.project_key IS NULL OR p.project_key = roadmap_items.project_key)`
  // let a NULL-project peer squat locks on ANY project forever, as long as
  // it kept heartbeating -- regardless of whether that project was actually
  // its own. This proves the opposite of the sibling "owner-gone" test
  // above: there the SAME-project owner stays active and keeps its lock;
  // here a MISMATCHED-project owner stays active and still LOSES it.
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
