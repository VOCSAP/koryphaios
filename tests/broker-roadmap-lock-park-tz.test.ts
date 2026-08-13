// Card aaf4537d, round-3 mutation review, item 2 (MAJOR, defect newly
// introduced by this lot): a park's survival depends on comparing
// `lock_parked_at` against "now" (shared/roadmap-lock.ts's `isParked`, used
// both by /roadmap/lock-park's TTL logic indirectly and by
// `refusesParkedArchive` on the archive path). SQLite's bare
// `datetime('now')` produces a marker-less string ("YYYY-MM-DD HH:MM:SS"),
// and `Date.parse()` reads a marker-less string as LOCAL time (V8
// behaviour) -- on a non-UTC host that silently shifts the parsed instant by
// the host's UTC offset, shrinking (or, for a negative offset, extending) a
// park's remaining life.
//
// `bun test` forces TZ=UTC in ITS OWN process (measured: process.env.TZ is
// unset there, local offset 0), so this bug is invisible to any test running
// in that process directly -- it can only be observed in a CHILD process
// (the broker) started with an explicit non-UTC TZ. Same `broker-*`-prefixed,
// local-gate-only precedent as the sibling files in this family.
//
// Two producers matter here, and both are proved:
//   A) broker.ts's /roadmap/lock-park route itself now writes an ISO string
//      (with 'Z'), immune to the local-time misparse regardless of host TZ.
//   B) shared/roadmap-lock.ts's `isParked` normalizes ANY marker-less string
//      as UTC, so a producer OTHER than lock-park (a restored/imported row,
//      a future write path) is covered too -- fixing the producer alone
//      would leave that domain unprotected.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import { Database } from "bun:sqlite";
import type { RoadmapItem } from "../shared/types.ts";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";

// A non-UTC, POSITIVE-offset zone (matches the team-lead's own measurement):
// under the pre-fix bug this makes a marker-less timestamp parse as EARLIER
// than its true UTC instant, so "elapsed since park" reads LARGER than
// reality -- the direction that causes premature expiry, not a false park.
const NON_UTC_TZ = "Europe/Paris";
const PARK_TTL_SEC = 3600; // 1h, same order of magnitude as the measured repro

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker({
    TZ: NON_UTC_TZ,
    CLAUDE_PEERS_LOCK_PARK_TTL_SEC: String(PARK_TTL_SEC),
  });
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/lock-park-tz-repo";

type UpsertRes = { item: RoadmapItem };
type LockParkRes = { parked?: string[]; failed?: string[]; error?: string };
type ArchiveRes = { item?: RoadmapItem; error?: string };

async function createItem(title: string): Promise<string> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    title,
  });
  expect(res.status).toBe(200);
  return res.body.item.id;
}

function lockDirectly(id: string, lockedByPeerId: string): void {
  const db = new Database(broker.dbPath);
  db.run(`UPDATE roadmap_items SET locked = 1, locked_by = ?, status = 'in_progress' WHERE id = ?`, [
    lockedByPeerId,
    id,
  ]);
  db.close();
}

// Simulates a producer OTHER than lock-park (e.g. a restored/imported row):
// writes the SQLite `datetime('now')` SHAPE directly -- true UTC instant,
// but with no timezone marker at all -- rather than going through the route.
function parkDirectlyMarkerless(id: string, parkedByOperatorId: string): void {
  const nowMarkerless = new Date().toISOString().replace("T", " ").split(".")[0];
  const db = new Database(broker.dbPath);
  db.run(`UPDATE roadmap_items SET lock_parked_at = ?, lock_parked_by = ? WHERE id = ?`, [
    nowMarkerless,
    parkedByOperatorId,
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

const OPERATOR_A = generateCredential();
const OPERATOR_B = generateCredential();

function authoredBy(payload: Record<string, unknown>, credential: typeof OPERATOR_A): Record<string, unknown> {
  const body = { ...payload, by: "deck", public_key: credential.publicKey };
  return {
    ...body,
    auth: buildAuthProof(credential.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(credential.publicKey),
    }),
  };
}

test("producer fix: on a non-UTC host, lock-park writes an ISO timestamp (with 'Z'), immune to the local-time misparse", async () => {
  const id = await createItem("tz: producer writes ISO");
  lockDirectly(id, "peer-tz-producer");

  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    authoredBy({ project_key: PK, peer_ids: ["peer-tz-producer"] }, OPERATOR_A)
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-tz-producer"]);

  const row = readItem(id);
  expect(row.lock_parked_at).not.toBeNull();
  // The decisive shape check: a bare SQLite datetime('now') string has no
  // 'Z' and no +HH:MM/-HH:MM suffix. This route must never write that shape.
  expect(row.lock_parked_at as string).toMatch(/Z$/);
});

test("producer fix, end-to-end: a park written by lock-park on a non-UTC host still refuses a foreign operator's archive immediately afterward (409), not silently expired", async () => {
  const id = await createItem("tz: producer end-to-end, foreign archive still refused");
  lockDirectly(id, "peer-tz-e2e");

  const parkRes = await post<LockParkRes>(
    `${broker.url}/roadmap/lock-park`,
    authoredBy({ project_key: PK, peer_ids: ["peer-tz-e2e"] }, OPERATOR_A)
  );
  expect(parkRes.status).toBe(200);
  expect(parkRes.body.parked).toEqual(["peer-tz-e2e"]);

  const archiveRes = await post<ArchiveRes>(
    `${broker.url}/roadmap/upsert`,
    authoredBy({ id, status: "archived" }, OPERATOR_B)
  );
  // Under the pre-fix bug (bare datetime('now'), Europe/Paris host, +2h
  // summer offset > this test's 1h TTL) this park read as already-expired
  // the instant it was written, and the archive would have gone through
  // (200) instead of being refused.
  expect(archiveRes.status).toBe(409);
  expect(archiveRes.body.error).toContain("parked");
});

test("consumer fix (domain coverage, not just this producer): a marker-less lock_parked_at written by a DIFFERENT producer is still normalized as UTC on a non-UTC host -- archive by a foreign operator refused 409, not silently expired", async () => {
  const id = await createItem("tz: consumer normalizes a marker-less legacy row");
  lockDirectly(id, "peer-tz-legacy");
  parkDirectlyMarkerless(id, deriveOperatorId(OPERATOR_A.publicKey));

  // Confirms the fixture actually wrote the marker-less shape under test --
  // otherwise this cell would silently degrade into a repeat of the
  // producer-fix test above instead of exercising isParked's own defense.
  const before = readItem(id);
  expect(before.lock_parked_at as string).not.toMatch(/Z$|[+-]\d{2}:\d{2}$/);

  const archiveRes = await post<ArchiveRes>(
    `${broker.url}/roadmap/upsert`,
    authoredBy({ id, status: "archived" }, OPERATOR_B)
  );
  expect(archiveRes.status).toBe(409);
  expect(archiveRes.body.error).toContain("parked");
});
