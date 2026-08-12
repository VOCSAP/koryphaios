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
