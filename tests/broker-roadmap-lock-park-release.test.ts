// HTTP-level proof for /roadmap/lock-park and /roadmap/lock-release.
// Wire contract matched against the desktop caller (roadmap-service.ts's
// lockPark/lockRelease): POST body {project_key, peer_ids, by:'deck', +
// operator Ed25519 proof}, response {parked|released: string[], failed?:
// string[]}.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, deckAuthored, FIXTURE_OPERATOR_ID, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";
import type { RoadmapItem } from "../shared/types.ts";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/lock-park-release-repo";

type UpsertRes = { item: RoadmapItem };
type LockParkRes = { parked?: string[]; released?: string[]; failed?: string[]; error?: string };

async function createItem(title: string): Promise<string> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    title,
  });
  expect(res.status).toBe(200);
  return res.body.item.id;
}

// No HTTP route claims a lock for a SPECIFIC peer_id in this suite (the
// ordinary /roadmap/upsert lock-claim path stamps `by` as locked_by, and `by`
// here would collide with the fixture's other authors) -- same discipline as
// broker-roadmap-parked-archive.test.ts's lockDirectly/parkDirectly: direct
// SQL, mirroring the exact columns the production write path touches.
function lockDirectly(id: string, lockedByPeerId: string): void {
  const db = new Database(broker.dbPath);
  db.run(`UPDATE roadmap_items SET locked = 1, locked_by = ?, status = 'in_progress' WHERE id = ?`, [
    lockedByPeerId,
    id,
  ]);
  db.close();
}

function readItem(id: string): RoadmapItem {
  const db = new Database(broker.dbPath);
  const row = db.query(`SELECT * FROM roadmap_items WHERE id = ?`).get(id) as RoadmapItem;
  db.close();
  return row;
}

// `by` deliberately a non-reserved name here: 'deck' unsigned is refused
// upstream by resolveRoadmapAuthor itself (401, proof required for a
// reserved name) before ever reaching this route's own operator_id check --
// that 401 is resolveRoadmapAuthor's discipline, not this route's. An
// ordinary peer-shaped `by` passes resolveRoadmapAuthor (proven=false,
// operator_id undefined), which is what isolates THIS route's own explicit
// "operator_id === undefined -> 403" gate (arbitration #1: unconditional,
// no exemption for an ordinary agent write).
test("lock-park: refused without operator proof (ordinary unsigned agent write)", async () => {
  const id = await createItem("lock-park: unproven write");
  lockDirectly(id, "some-peer");

  const res = await post<LockParkRes>(`${broker.url}/roadmap/lock-park`, {
    project_key: PK,
    by: "some-agent-peer",
    peer_ids: ["some-peer"],
  });
  expect(res.status).toBe(403);
  expect(res.body.error).toContain("operator-signed");

  // Refused write must not have touched the row.
  const row = readItem(id);
  expect(row.lock_parked_at).toBeNull();
});

test("lock-release: refused without operator proof (ordinary unsigned agent write)", async () => {
  const id = await createItem("lock-release: unproven write");
  lockDirectly(id, "some-peer");

  const res = await post<LockParkRes>(`${broker.url}/roadmap/lock-release`, {
    project_key: PK,
    by: "some-agent-peer",
    peer_ids: ["some-peer"],
  });
  expect(res.status).toBe(403);
  expect(res.body.error).toContain("operator-signed");

  const row = readItem(id);
  expect(row.locked).toBe(1);
});

test("lock-park: parks only the subset of peer_ids that actually hold a lock under this project_key", async () => {
  const heldId = await createItem("lock-park: subset, held");
  const unheldId = await createItem("lock-park: subset, never locked");
  lockDirectly(heldId, "peer-held");

  const res = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    deckAuthored({ project_key: PK, peer_ids: ["peer-held", "peer-with-no-lock"] })
  );
  expect(res.status).toBe(200);
  // Team-lead arbitration: a peer_id holding no lock is absent from BOTH
  // `parked` and `failed`, never a failure.
  expect(res.body.parked).toEqual(["peer-held"]);
  expect(res.body.failed ?? []).toEqual([]);

  const heldRow = readItem(heldId);
  expect(heldRow.lock_parked_at).not.toBeNull();
  expect(heldRow.lock_parked_by).toBe(FIXTURE_OPERATOR_ID);
  // Parking preserves the underlying lock -- only the park columns move.
  expect(heldRow.locked).toBe(1);
  expect(heldRow.locked_by).toBe("peer-held");

  const unheldRow = readItem(unheldId);
  expect(unheldRow.lock_parked_at).toBeNull();
});

test("lock-release: fully frees the card (locked, locked_by, park columns cleared; in_progress reverts to planned), same end state as releaseStaleLocks", async () => {
  const id = await createItem("lock-release: full release");
  lockDirectly(id, "peer-to-release");
  // Also park it first, so this proves release clears park columns too, not
  // just the lock -- Hard Stop's promise per this route's doc comment.
  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    deckAuthored({ project_key: PK, peer_ids: ["peer-to-release"] })
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-to-release"]);

  const res = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-release`,
    deckAuthored({ project_key: PK, peer_ids: ["peer-to-release"] })
  );
  expect(res.status).toBe(200);
  expect(res.body.released).toEqual(["peer-to-release"]);
  expect(res.body.failed ?? []).toEqual([]);

  const row = readItem(id);
  expect(row.locked).toBe(0);
  expect(row.locked_by).toBeNull();
  expect(row.lock_parked_at).toBeNull();
  expect(row.lock_parked_by).toBeNull();
  expect(row.status).toBe("planned");
});

// lock-park must write an operator_id into lock_parked_by, not a peer_id:
// refusesParkedArchive compares actorOperatorId against lock_parked_by, and a
// peer_id there would make the park owner's own archive refuse forever.
// These two tests park via the route (not direct SQL) and archive via upsert
// with two distinct operator credentials, so a same-operator vs
// different-operator mismatch can't hide behind one shared identity.

const OPERATOR_A = generateCredential();
const OPERATOR_B = generateCredential();

function lockParkAuthored(payload: Record<string, unknown>, credential: typeof OPERATOR_A): Record<string, unknown> {
  const body = { ...payload, by: "deck", public_key: credential.publicKey };
  return {
    ...body,
    auth: buildAuthProof(credential.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(credential.publicKey),
    }),
  };
}

type ArchiveRes = { item?: RoadmapItem; error?: string };

test("end-to-end: parked via the lock-park ROUTE by operator A, archived via upsert by the SAME operator A: allowed", async () => {
  const id = await createItem("e2e: route-parked, self-reversal");
  lockDirectly(id, "peer-e2e-a");

  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-a"] }, OPERATOR_A)
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-e2e-a"]);
  // Confirms the write this decision hinges on, before the archive call.
  expect(readItem(id).lock_parked_by).toBe(deriveOperatorId(OPERATOR_A.publicKey));

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, lockParkAuthored({ id, status: "archived" }, OPERATOR_A));
  expect(res.status).toBe(200);
  expect(res.body.item?.status).toBe("archived");
});

test("end-to-end: parked via the lock-park ROUTE by operator A, archived via upsert by a DIFFERENT operator B: refused 409", async () => {
  const id = await createItem("e2e: route-parked, foreign archive attempt");
  lockDirectly(id, "peer-e2e-b");

  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-b"] }, OPERATOR_A)
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-e2e-b"]);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, lockParkAuthored({ id, status: "archived" }, OPERATOR_B));
  expect(res.status).toBe(409);
  expect(res.body.error).toContain("parked");
});

// An unrestricted release would open a bypass: operator B releases operator A's
// park, and by the time B's own upsert tries to archive the card it is not
// parked anymore, so refusesParkedArchive never engages.
// This restriction is scoped to parked rows only -- a not-parked row still lets
// Hard Stop apply with its full admin-wide reach.

test("lock-release: a park set by operator A is REFUSED by a lock-release call signed by a different operator B -- the peer_id lands in `failed`, the park and lock survive untouched", async () => {
  const id = await createItem("e2e: release refused, foreign park");
  lockDirectly(id, "peer-e2e-release");

  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-release"] }, OPERATOR_A)
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-e2e-release"]);

  const releaseRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-release`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-release"] }, OPERATOR_B)
  );
  expect(releaseRes.status).toBe(200);
  expect(releaseRes.body.released ?? []).toEqual([]);
  expect(releaseRes.body.failed).toEqual(["peer-e2e-release"]);

  // The park and the underlying lock must both survive intact -- a partial
  // clear (e.g. park cleared but locked left standing, or vice versa) would
  // still be a bypass in one direction or the other.
  const row = readItem(id);
  expect(row.locked).toBe(1);
  expect(row.locked_by).toBe("peer-e2e-release");
  expect(row.lock_parked_by).toBe(deriveOperatorId(OPERATOR_A.publicKey));
});

test("full bypass chain, in one test: A parks, B's release is refused, B's archive attempt is still refused 409 -- the service door bc0ccb17 exists to close stays closed", async () => {
  const id = await createItem("e2e: full bypass chain");
  lockDirectly(id, "peer-e2e-chain");

  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-chain"] }, OPERATOR_A)
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-e2e-chain"]);

  const releaseRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-release`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-chain"] }, OPERATOR_B)
  );
  expect(releaseRes.status).toBe(200);
  expect(releaseRes.body.failed).toEqual(["peer-e2e-chain"]);

  const archiveRes = await post<ArchiveRes>(
    `${broker.url}/roadmap/upsert`,
    lockParkAuthored({ id, status: "archived" }, OPERATOR_B)
  );
  expect(archiveRes.status).toBe(409);
  expect(archiveRes.body.error).toContain("parked");
});

// ---------------------------------------------------------------------------
// Legitimate cells that must stay green, per team-lead's exact scope: the
// restriction bites ONLY on a row whose lock_parked_by is non-NULL and
// differs from the releasing operator. A locked-but-never-parked row, or a
// row released by its own parker, must keep working exactly as lot 2 shipped.
// ---------------------------------------------------------------------------

test("lock-release: a card that is locked but was NEVER parked is released by any operator-proven write (Hard Stop keeps its admin-wide reach)", async () => {
  const id = await createItem("e2e: never parked, released by a stranger operator");
  lockDirectly(id, "peer-e2e-neverparked");

  const releaseRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-release`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-neverparked"] }, OPERATOR_B)
  );
  expect(releaseRes.status).toBe(200);
  expect(releaseRes.body.released).toEqual(["peer-e2e-neverparked"]);
  expect(releaseRes.body.failed ?? []).toEqual([]);

  const row = readItem(id);
  expect(row.locked).toBe(0);
});

test("lock-release: a mixed batch of peer_ids yields a genuine PARTIAL result -- one released (own park), one failed (foreign park) -- never a global refusal", async () => {
  const ownId = await createItem("e2e: mixed batch, own park");
  const foreignId = await createItem("e2e: mixed batch, foreign park");
  lockDirectly(ownId, "peer-e2e-mixed-own");
  lockDirectly(foreignId, "peer-e2e-mixed-foreign");

  const parkOwn = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-mixed-own"] }, OPERATOR_B)
  );
  expect(parkOwn.status).toBe(200);
  const parkForeign = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-mixed-foreign"] }, OPERATOR_A)
  );
  expect(parkForeign.status).toBe(200);

  // Operator B releases both in one call: B parked the first itself (own
  // park, releasable), A parked the second (foreign to B, refused).
  const releaseRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-release`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-e2e-mixed-own", "peer-e2e-mixed-foreign"] }, OPERATOR_B)
  );
  expect(releaseRes.status).toBe(200);
  expect(releaseRes.body.released).toEqual(["peer-e2e-mixed-own"]);
  expect(releaseRes.body.failed).toEqual(["peer-e2e-mixed-foreign"]);

  expect(readItem(ownId).locked).toBe(0);
  expect(readItem(foreignId).locked).toBe(1);
});

test("lock-park: project_key required", async () => {
  const res = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    deckAuthored({ project_key: "", peer_ids: ["some-peer"] })
  );
  expect(res.status).toBe(400);
});

test("lock-park: peer_ids must be a non-empty array", async () => {
  const res = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    deckAuthored({ project_key: PK, peer_ids: [] })
  );
  expect(res.status).toBe(400);
});

test("lock-park: over LOCK_BATCH_MAX_TARGETS (65) is refused 400, loudly, before any row is touched", async () => {
  const ids = await Promise.all(
    Array.from({ length: 3 }, (_, i) => createItem(`lock-park: over-cap fixture ${i}`))
  );
  await Promise.all(ids.map((id, i) => lockDirectly(id, `peer-overcap-park-${i}`)));

  const peerIds = Array.from({ length: 65 }, (_, i) => `peer-overcap-park-${i}`);
  const res = await post<LockParkRes>(`${broker.url}/roadmap/lock-park`, deckAuthored({ project_key: PK, peer_ids: peerIds }));
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("too many peer_ids");

  // Refused loudly BEFORE the loop -- none of the fixture rows that do hold a
  // lock got touched, unlike a silent truncation which would still park the
  // first 16.
  for (const id of ids) {
    expect(readItem(id).lock_parked_at).toBeNull();
  }
});

test("lock-park: exactly at LOCK_BATCH_MAX_TARGETS (64) -- nothing lost, every single target parked", async () => {
  const n = 64;
  const ids: string[] = [];
  const peerIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await createItem(`lock-park: at-cap fixture ${i}`);
    const peerId = `peer-atcap-park-${i}`;
    lockDirectly(id, peerId);
    ids.push(id);
    peerIds.push(peerId);
  }

  const res = await post<LockParkRes>(`${broker.url}/roadmap/lock-park`, deckAuthored({ project_key: PK, peer_ids: peerIds }));
  expect(res.status).toBe(200);
  expect(res.body.parked?.length).toBe(n);
  expect(res.body.failed ?? []).toEqual([]);

  // Decisive: the LAST entry specifically, the one a default maxLen=16 would
  // have silently dropped.
  expect(readItem(ids[n - 1]).lock_parked_at).not.toBeNull();
});

test("lock-release: over LOCK_BATCH_MAX_TARGETS (65) is refused 400, loudly, before any row is touched", async () => {
  const ids = await Promise.all(
    Array.from({ length: 3 }, (_, i) => createItem(`lock-release: over-cap fixture ${i}`))
  );
  await Promise.all(ids.map((id, i) => lockDirectly(id, `peer-overcap-release-${i}`)));

  const peerIds = Array.from({ length: 65 }, (_, i) => `peer-overcap-release-${i}`);
  const res = await post<LockParkRes>(`${broker.url}/roadmap/lock-release`, deckAuthored({ project_key: PK, peer_ids: peerIds }));
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("too many peer_ids");

  for (const id of ids) {
    expect(readItem(id).locked).toBe(1);
  }
});

test("lock-release: exactly at LOCK_BATCH_MAX_TARGETS (64) -- nothing lost, every single target released", async () => {
  const n = 64;
  const ids: string[] = [];
  const peerIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await createItem(`lock-release: at-cap fixture ${i}`);
    const peerId = `peer-atcap-release-${i}`;
    lockDirectly(id, peerId);
    ids.push(id);
    peerIds.push(peerId);
  }

  const res = await post<LockParkRes>(`${broker.url}/roadmap/lock-release`, deckAuthored({ project_key: PK, peer_ids: peerIds }));
  expect(res.status).toBe(200);
  expect(res.body.released?.length).toBe(n);
  expect(res.body.failed ?? []).toEqual([]);

  // Decisive: the LAST entry, same off-by-16 risk as the lock-park cell above.
  expect(readItem(ids[n - 1]).locked).toBe(0);
});

// ---------------------------------------------------------------------------
// Round-4 mutation review, point 1 (MAJOR): handleRoadmapLockPark's UPDATE had
// no condition on the row's EXISTING lock_parked_by -- operator B re-parking a
// card operator A already parked silently OVERWROUND lock_parked_by to B, the
// exact two-upsert-shaped bypass item 1 (round 3) closed on the upsert path,
// reopened here on the park route itself (refusesParkedArchive only ever
// compares against the CURRENT lock_parked_by, so B's own later archive would
// then sail through). Fixed by mirroring lock-release's existing foreign-park
// refusal: SELECT-first, foreign park pushed to `failed`, the UPDATE's WHERE
// gains `AND (lock_parked_by IS NULL OR lock_parked_by = ?)`.
// ---------------------------------------------------------------------------

test("lock-park: a card already parked by operator A is REFUSED when operator B tries to park it too -- lock_parked_by stays A's, and B's later archive attempt is still refused 409", async () => {
  const id = await createItem("point 1: re-park by a different operator");
  lockDirectly(id, "peer-repark");

  const parkA = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-repark"] }, OPERATOR_A)
  );
  expect(parkA.status).toBe(200);
  expect(parkA.body.parked).toEqual(["peer-repark"]);

  const parkB = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-repark"] }, OPERATOR_B)
  );
  expect(parkB.status).toBe(200);
  expect(parkB.body.parked ?? []).toEqual([]);
  expect(parkB.body.failed).toEqual(["peer-repark"]);

  // The row must still be owned by A, untouched by B's attempt.
  expect(readItem(id).lock_parked_by).toBe(deriveOperatorId(OPERATOR_A.publicKey));

  const archiveRes = await post<ArchiveRes>(
    `${broker.url}/roadmap/upsert`,
    lockParkAuthored({ id, status: "archived" }, OPERATOR_B)
  );
  expect(archiveRes.status).toBe(409);
  expect(archiveRes.body.error).toContain("parked");
});

// ---------------------------------------------------------------------------
// Round-4 mutation review, point 2 (MINOR but doctrinal): handleRoadmapLockRelease
// ignored park EXPIRATION -- an expired-but-still-foreign park landed in
// `failed` and blocked release, contradicting shared/roadmap-lock.ts's own
// doc comment that isParked is the threshold every guard must agree with
// (refusesParkedArchive, the upsert-path keptParkedAt/parkStillLive pair, and
// releaseStaleLocks's own SQL sweep clause 3 all already used it). Fixed by
// applying the same isParked threshold to both the pre-write predicate and
// the UPDATE's WHERE (`datetime(lock_parked_at) < datetime('now', ?)`,
// matching releaseStaleLocks's clause 3 exactly).
// ---------------------------------------------------------------------------

function backdatePark(id: string, secondsAgo: number): void {
  const db = new Database(broker.dbPath);
  const backdated = new Date(Date.now() - secondsAgo * 1000).toISOString();
  db.run(`UPDATE roadmap_items SET lock_parked_at = ? WHERE id = ?`, [backdated, id]);
  db.close();
}

test("lock-release: an EXPIRED park (past LOCK_PARK_TTL_SEC) by operator A no longer blocks release by a different operator B -- treated as absent, lock actually returned", async () => {
  const id = await createItem("point 2: release past an expired foreign park");
  lockDirectly(id, "peer-expired-park");

  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-expired-park"] }, OPERATOR_A)
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-expired-park"]);

  // This suite's broker runs the default LOCK_PARK_TTL_SEC (86400s, no env
  // override in this file's beforeAll) -- backdate well past it rather than
  // touching the shared broker's TTL, which would risk the other tests here.
  backdatePark(id, 86400 + 60);

  const releaseRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-release`,
    lockParkAuthored({ project_key: PK, peer_ids: ["peer-expired-park"] }, OPERATOR_B)
  );
  expect(releaseRes.status).toBe(200);
  expect(releaseRes.body.released).toEqual(["peer-expired-park"]);
  expect(releaseRes.body.failed ?? []).toEqual([]);

  const row = readItem(id);
  expect(row.locked).toBe(0);
  expect(row.locked_by).toBeNull();
  expect(row.lock_parked_at).toBeNull();
  expect(row.lock_parked_by).toBeNull();
});
