// Card aaf4537d: HTTP-level proof that broker.ts's handleRoadmapArchive
// actually WIRES refusesParkedArchive (shared/roadmap-lock.ts:143) into the
// live /roadmap/archive route -- the pure predicate truth table lives in
// tests/roadmap-parked-archive-predicate.test.ts (CI-collected,
// tests/roadmap-*.test.ts glob), this file proves the PRODUCTION CALL SITE
// (broker.ts:~2775) is not orphaned, same split as
// tests/broker-roadmap-inactive.test.ts / tests/roadmap-lock.test.ts.
//
// `broker-*` family (spawns a real broker daemon), deliberately EXEMPTED
// from the CI pure-modules glob (.github/workflows/desktop-build.yml) --
// local-only via `bun test`, same precedent as broker-roadmap-inactive.test.ts
// and broker-roadmap-operator-id.test.ts document in their own headers.
//
// Every assertion below was proven RED-then-GREEN in a detached git worktree
// (`git worktree add --detach <tmp> HEAD`), TWO separate production removals
// measured independently:
//   (1) the CALL SITE at broker.ts:~2775 (proves the predicate is actually
//       INVOKED by handleRoadmapArchive, not just defined)
//   (2) the predicate BODY at shared/roadmap-lock.ts:143-151 (proves the
//       predicate, once invoked, actually COMPUTES the refusal -- covered
//       independently by the pure truth-table file, repeated here to prove
//       the two layers compose end to end over HTTP)
// See the test-engineer's report to the team-lead for the exact removal/
// restore transcripts. Working checkout (broker.ts, shared/roadmap-lock.ts)
// was never touched -- all mutation happened in the throwaway worktree.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";
import type { RoadmapItem } from "../shared/types.ts";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";

let broker: TestBroker;

const PARK_TTL_SEC = 4;

beforeAll(async () => {
  broker = await startBroker({
    CLAUDE_PEERS_LOCK_PARK_TTL_SEC: String(PARK_TTL_SEC),
  });
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/parked-archive-repo";

type UpsertRes = { item: RoadmapItem };
type ArchiveRes = { item?: RoadmapItem; error?: string };

// Two DISTINCT operator credentials -- operator_id is the digest of the
// public key, so these are genuinely different identities even though both
// sign as by:'deck' (the exact ambiguity refusesParkedArchive's doc comment
// warns a `by`-based comparison would collapse).
const OPERATOR_A = generateCredential();
const OPERATOR_B = generateCredential();
const OPERATOR_A_ID = deriveOperatorId(OPERATOR_A.publicKey);
const OPERATOR_B_ID = deriveOperatorId(OPERATOR_B.publicKey);

function signedArchive(id: string, credential: typeof OPERATOR_A): Record<string, unknown> {
  const body = { id, by: "deck", public_key: credential.publicKey };
  return {
    ...body,
    auth: buildAuthProof(credential.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(credential.publicKey),
    }),
  };
}

async function createItem(title: string): Promise<string> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    title,
  });
  expect(res.status).toBe(200);
  return res.body.item.id;
}

// There is no HTTP route to PARK a card yet (lock-park is a later lot), so
// every fixture here sets lock_parked_at/lock_parked_by directly via sqlite,
// same discipline tests/broker-roadmap-lock.test.ts's park tests already use
// for the TTL-sweep clause. That precedent writes lock_parked_at via
// SQLite's own datetime('now', ...) because it is checked SERVER-SIDE, in
// SQL, by releaseStaleLocks. refusesParkedArchive is different: it runs
// isParked() in JS, via Date.parse(). A bare SQLite "YYYY-MM-DD HH:MM:SS"
// string (no 'Z', no offset) parses as LOCAL time in JS, not UTC -- on a
// non-UTC box (measured: Europe/Paris, UTC+2, on the box this suite ran on)
// that silently shifts the timestamp and flips isParked's verdict. Every
// production writer of this column (broker.ts's keptParkedAt path, the only
// one that exists today) carries forward a JS-generated ISO string, so this
// fixture writes one too, computed in JS, to stay representative of the
// real write path.
function parkDirectly(id: string, parkedByOperatorId: string, ageSeconds: number): void {
  const parkedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  const db = new Database(broker.dbPath);
  db.run(`UPDATE roadmap_items SET lock_parked_at = ?, lock_parked_by = ? WHERE id = ?`, [
    parkedAt,
    parkedByOperatorId,
    id,
  ]);
  db.close();
}

test("parked by operator A, archived by operator B (different operator): refused 409", async () => {
  const id = await createItem("parked, foreign archive attempt");
  parkDirectly(id, OPERATOR_A_ID, 0);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/archive`, signedArchive(id, OPERATOR_B));
  expect(res.status).toBe(409);
  expect(res.body.error).toContain("parked");
});

test("parked by operator A, archived by operator A (same operator reversing their own decision): allowed", async () => {
  const id = await createItem("parked, self-reversal");
  parkDirectly(id, OPERATOR_A_ID, 0);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/archive`, signedArchive(id, OPERATOR_A));
  expect(res.status).toBe(200);
  expect(res.body.item?.status).toBe("archived");
});

test("parked by operator A, archived by an unsigned ordinary agent write (no operator_id at all): refused, fail-closed", async () => {
  const id = await createItem("parked, unsigned archive attempt");
  parkDirectly(id, OPERATOR_A_ID, 0);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/archive`, { id, by: "some-agent-peer" });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain("parked");
});

test("parked by operator A but EXPIRED (past LOCK_PARK_TTL_SEC), archived by operator B: allowed, park no longer live", async () => {
  const id = await createItem("parked and expired, foreign archive attempt");
  parkDirectly(id, OPERATOR_A_ID, PARK_TTL_SEC + 1);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/archive`, signedArchive(id, OPERATOR_B));
  expect(res.status).toBe(200);
  expect(res.body.item?.status).toBe("archived");
});

test("unparked card: archive by any author proceeds, refusesParkedArchive never engages", async () => {
  const id = await createItem("never parked");

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/archive`, signedArchive(id, OPERATOR_B));
  expect(res.status).toBe(200);
  expect(res.body.item?.status).toBe("archived");
});

// ---------------------------------------------------------------------------
// Card bc0ccb17: a SECOND production call site for the same predicate.
// /roadmap/upsert can also drive a card to status='archived' directly
// (RoadmapStatus enum includes it, and the write stamps deleted_at exactly
// like /roadmap/archive does) -- that path bypassed refusesParkedArchive
// entirely before this card, a disguised fail-open of the guard the tests
// above already prove /roadmap/archive enforces. Same fixtures, same
// predicate, a DIFFERENT route -- wiring at one call site never proves
// wiring at the other.
// ---------------------------------------------------------------------------

function signedUpsertArchive(id: string, credential: typeof OPERATOR_A): Record<string, unknown> {
  const body = { id, by: "deck", status: "archived", public_key: credential.publicKey };
  return {
    ...body,
    auth: buildAuthProof(credential.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(credential.publicKey),
    }),
  };
}

// Gives the parked card a plausible work-lock owner (existing.locked_by),
// same discipline as parkDirectly's doc comment: direct SQL because there is
// no HTTP path in this suite that claims a lock for a specific peer_id.
function lockDirectly(id: string, lockedByPeerId: string): void {
  const db = new Database(broker.dbPath);
  db.run(`UPDATE roadmap_items SET locked = 1, locked_by = ?, status = 'in_progress' WHERE id = ?`, [
    lockedByPeerId,
    id,
  ]);
  db.close();
}

test("MANDATORY: unsigned write, by = the lock owner's own peer_id, status='archived' via upsert on a parked card: refused 409 (was 200 before card bc0ccb17 -- the disguised fail-open: status flips to archived while deleted_at stays stamped only because the write is otherwise well-formed)", async () => {
  const id = await createItem("upsert: parked, unsigned self-archive attempt");
  lockDirectly(id, "owning-peer");
  parkDirectly(id, OPERATOR_A_ID, 0);

  // `by` deliberately equals the lock's own owner: passes the EARLIER lock
  // guard for free (by === existing.locked_by), so 409 here can only be
  // this test's new guard, not a false positive from the older one.
  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, {
    id,
    by: "owning-peer",
    status: "archived",
  });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain("parked");
});

test("upsert: parked by operator A, archived via upsert by operator A (same operator reversing their own decision): allowed", async () => {
  const id = await createItem("upsert: parked, self-reversal");
  lockDirectly(id, "owning-peer");
  parkDirectly(id, OPERATOR_A_ID, 0);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, signedUpsertArchive(id, OPERATOR_A));
  expect(res.status).toBe(200);
  expect(res.body.item?.status).toBe("archived");
});

test("upsert: parked by operator A but EXPIRED, archived via upsert by operator B: allowed, park no longer live", async () => {
  const id = await createItem("upsert: parked and expired, foreign archive attempt");
  lockDirectly(id, "owning-peer");
  parkDirectly(id, OPERATOR_A_ID, PARK_TTL_SEC + 1);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, signedUpsertArchive(id, OPERATOR_B));
  expect(res.status).toBe(200);
  expect(res.body.item?.status).toBe("archived");
});

test("upsert: never parked card: archive via upsert by any author proceeds, refusesParkedArchive never engages", async () => {
  const id = await createItem("upsert: never parked");

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, signedUpsertArchive(id, OPERATOR_B));
  expect(res.status).toBe(200);
  expect(res.body.item?.status).toBe("archived");
});

// ---------------------------------------------------------------------------
// Card aaf4537d, round-3 mutation review, item 1 (BLOCKING): the two-upsert
// bypass. keptParkedAt/keptParkedBy (broker.ts's handleRoadmapUpsert) used to
// reuse isSameOwnerReclaim -- a predicate scoped to LOCK ownership (peer_id),
// not to PARK ownership (operator_id) -- to decide whether a write erases the
// park. Any write that moves the item OUT of in_progress (isSameOwnerReclaim
// becomes false the instant resolvedLock.locked is false) silently nulled
// BOTH lock_parked_at/lock_parked_by, regardless of who signed it or whether
// they were the operator who parked the card. A SECOND upsert then archives
// straight through refusesParkedArchive, which only ever sees the row state
// THIS call left behind -- it has no memory of a park a PRIOR write already
// erased. Fixed by parkOwnerIsAuthor/parkStillLive (broker.ts, keyed on
// author.operator_id vs existing.lock_parked_by, entirely decoupled from lock
// reclaim). Both variants below share the same second call (a foreign
// operator's archive attempt) and differ only in how the FIRST write releases
// the lock without touching the park directly.
// ---------------------------------------------------------------------------

function signedRelease(id: string, credential: typeof OPERATOR_A): Record<string, unknown> {
  const body = { id, by: "deck", status: "planned", public_key: credential.publicKey };
  return {
    ...body,
    auth: buildAuthProof(credential.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(credential.publicKey),
    }),
  };
}

test("two-upsert bypass, signed-foreign-operator variant: operator B releases the lock (status->planned, no archive), park by operator A must survive -- second upsert (archive) still refused 409", async () => {
  const id = await createItem("two-upsert bypass: signed foreign release");
  lockDirectly(id, "owning-peer-a");
  parkDirectly(id, OPERATOR_A_ID, 0);

  // First upsert: a legitimate lock-release, signed by a DIFFERENT operator
  // than the one who parked the card. `by:'deck'` clears the earlier lock
  // guard for free -- this write's only question is whether it should also
  // silently clear the park it has no authority over.
  const releaseRes = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, signedRelease(id, OPERATOR_B));
  expect(releaseRes.status).toBe(200);
  expect(releaseRes.body.item.locked).toBe(false);

  // Second upsert: archive attempt by the SAME foreign operator. Under the
  // pre-fix bug the first write already nulled the park, so this would go
  // straight through (200) -- the two-upsert service door around bc0ccb17's
  // own guard.
  const archiveRes = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, signedUpsertArchive(id, OPERATOR_B));
  expect(archiveRes.status).toBe(409);
  expect(archiveRes.body.error).toContain("parked");
});

test("two-upsert bypass, unsigned-as-lock-owner variant: the peer holding the lock releases it themselves (unsigned, no operator proof at all), park by operator A must survive -- second upsert (archive) still refused 409", async () => {
  const id = await createItem("two-upsert bypass: unsigned lock-owner release");
  lockDirectly(id, "owning-peer-b");
  parkDirectly(id, OPERATOR_A_ID, 0);

  // First upsert: an ordinary, UNSIGNED write by the peer that itself holds
  // the lock -- `by === existing.locked_by` clears the earlier lock guard
  // for free, same as the operator variant above, but this actor has no
  // operator_id at all (author.proven is false, author.operator_id is
  // undefined).
  const releaseRes = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id,
    by: "owning-peer-b",
    status: "planned",
  });
  expect(releaseRes.status).toBe(200);
  expect(releaseRes.body.item.locked).toBe(false);

  const archiveRes = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, signedUpsertArchive(id, OPERATOR_B));
  expect(archiveRes.status).toBe(409);
  expect(archiveRes.body.error).toContain("parked");
});

// ---------------------------------------------------------------------------
// Card aaf4537d, round-3 mutation review, extra cell (a): does `force:true`
// bypass the PARK guard the way it bypasses the LOCK guard? The two guards
// are independent clauses in handleRoadmapUpsert (broker.ts ~2540-2598): the
// lock guard reads `!(body.force === true && author.proven)`, the park guard
// (refusesParkedArchive) never reads `force` anywhere in its own signature or
// body. A naive test signed as `by:'deck'` would prove nothing here --
// `by !== "deck"` is already false for that name, so the lock guard is
// skipped UNCONDITIONALLY regardless of `force`, and the scenario would 409
// from the park guard alone with `force` never actually exercised.
// `by:'operator'` is the OTHER RESERVED_PEER_IDS name (see
// tests/broker-roadmap-lock.test.ts's TTL-sweep test, which documents this
// same distinction): it goes through the same signed branch of
// resolveRoadmapAuthor as 'deck' (author.proven === true, operator_id
// stamped) but, unlike 'deck', is NOT exempted from claiming or tripping the
// lock guard -- so `by !== existing.locked_by` and `by !== "deck"` are both
// genuinely true here, making `force` the actual deciding clause of whether
// the lock guard fires.
// ---------------------------------------------------------------------------

function signedOperatorArchive(
  id: string,
  credential: typeof OPERATOR_A,
  force: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = { id, by: "operator", status: "archived", public_key: credential.publicKey };
  if (force) body.force = true;
  return {
    ...body,
    auth: buildAuthProof(credential.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(credential.publicKey),
    }),
  };
}

test("extra cell (a), control: signed foreign operator WITHOUT force on a locked+parked card is refused by the LOCK guard first (409 'locked', not 'parked')", async () => {
  const id = await createItem("extra cell a: control, no force");
  lockDirectly(id, "owning-peer");
  parkDirectly(id, OPERATOR_A_ID, 0);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, signedOperatorArchive(id, OPERATOR_B, false));
  expect(res.status).toBe(409);
  expect(res.body.error).toContain("locked");
});

test("extra cell (a): force:true by a signed foreign operator bypasses the LOCK guard, but the PARK guard still refuses (409 'parked') -- force is not read by refusesParkedArchive", async () => {
  const id = await createItem("extra cell a: force true, foreign operator");
  lockDirectly(id, "owning-peer");
  parkDirectly(id, OPERATOR_A_ID, 0);

  const res = await post<ArchiveRes>(`${broker.url}/roadmap/upsert`, signedOperatorArchive(id, OPERATOR_B, true));
  expect(res.status).toBe(409);
  expect(res.body.error).toContain("parked");
});

// Card aaf4537d, round-4 mutation review, point 4: nobody pinned the EXPIRED
// branch of handleRoadmapUpsert's keptParkedAt/keptParkedBy ternary
// (`parkOwnerIsAuthor || !parkStillLive ? null : existing.lock_parked_XXX`).
// Forcing parkStillLive to true stayed green under the existing suite. A
// plain (non-archiving, non-owning) upsert that lands after the park's TTL
// has elapsed must clear both park columns, same as an upsert by the park's
// own owner already does.
test("extra cell (point 4): a plain upsert by a third party on an EXPIRED park clears the park columns", async () => {
  const id = await createItem("point 4: expired park cleared by third party");
  lockDirectly(id, "owning-peer");
  parkDirectly(id, OPERATOR_A_ID, PARK_TTL_SEC + 2);

  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id,
    by: "owning-peer",
    tags: ["touched-after-expiry"],
  });
  expect(res.status).toBe(200);
  expect(res.body.item.lock_parked_at).toBeNull();
  expect(res.body.item.lock_parked_by).toBeNull();
});
