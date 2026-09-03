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

// refusesParkedArchive runs isParked() in JS via Date.parse(), which reads a
// bare SQLite datetime string as local time on a non-UTC host, flipping the
// verdict.
// The fixture writes lock_parked_at as a JS-generated ISO string, matching
// every production writer of this column, to stay representative of the real
// write path.
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

// /roadmap/upsert can also drive a card directly to status='archived', stamping
// deleted_at exactly like /roadmap/archive does -- a second production call
// site for the same predicate.
// Proving the guard fires at one call site never proves it fires at the other,
// since each route reaches the database independently.

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

// keptParkedAt/keptParkedBy is keyed on author.operator_id vs
// existing.lock_parked_by, decoupled from lock reclaim: any write that moves
// the item out of in_progress used to null the park regardless of who signed
// it.
// A second upsert could then archive straight through refusesParkedArchive,
// which only sees the row state the prior write left behind.

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

// The lock guard and the park guard (refusesParkedArchive) are independent:
// refusesParkedArchive never reads `force`. by:'deck' would skip the lock guard
// unconditionally (by !== 'deck' is false), masking whether force actually
// matters.
// by:'operator' is the other RESERVED_PEER_IDS name: it goes through the same
// proven-author branch but, unlike 'deck', is not exempt from the lock guard,
// so force is genuinely the deciding clause here.

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
