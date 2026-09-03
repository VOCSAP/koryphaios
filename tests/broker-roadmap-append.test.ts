import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";
import {
  ROADMAP_APPEND_RESULT_MAX_CHARS,
  ROADMAP_APPEND_PER_CALL_MAX_CHARS,
  buildRoadmapAppendHeader,
} from "../shared/roadmap-append.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/append-repo";

type UpsertRes = { item: RoadmapItem };
type AppendRes = { item: RoadmapItem };
type AppendErr = { error: string };

async function seed(body: Record<string, unknown> = {}): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "seed-fixture",
    title: "append target",
    ...body,
  });
  expect(res.status).toBe(200);
  return res.body.item;
}

async function listAll(): Promise<RoadmapItem[]> {
  const res = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: PK,
    include_archived: true, // an append test needs the archived-card probe to see its target
  });
  return res.body.items;
}

function append(body: Record<string, unknown>) {
  return post<AppendRes | AppendErr>(`${broker.url}/roadmap/append-context`, {
    project_key: PK,
    ...body,
  });
}

// The header's ISO-8601 timestamp is always exactly 24 characters
// (YYYY-MM-DDTHH:mm:ss.sssZ), so the header's total length for a given
// author is deterministic regardless of WHEN the broker actually appends --
// this lets cap-boundary math be exact without racing the broker's own clock.
function headerLenFor(author: string): number {
  return buildRoadmapAppendHeader("2026-01-01T00:00:00.000Z", author).length;
}

test("card 562fd9b5 review delta: append does NOT refresh updated_at/updated_by -- a third party must not extend another agent's lock TTL", async () => {
  const item = await seed({ status: "in_progress" }); // locked by seed-fixture, updated_at stamped at create time
  const before = (await listAll()).find((i) => i.id === item.id)!;

  // A different author appends -- if this refreshed updated_at, it would
  // silently extend seed-fixture's lock TTL through releaseStaleLocks.
  const res = await append({ id: item.id, by: "a-third-party", text: "a note, not a lock refresh" });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.updated_at).toBe(before.updated_at);
  expect(after.updated_by).toBe(before.updated_by);
  expect(after.updated_by).not.toBe("a-third-party"); // the appender never becomes the item's updated_by
});

test("two concurrent appenders both survive -- neither block overwrites the other", async () => {
  const item = await seed();

  const [r1, r2] = await Promise.all([
    append({ id: item.id, by: "peer-a", text: "note from peer-a" }),
    append({ id: item.id, by: "peer-b", text: "note from peer-b" }),
  ]);
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.context).toContain("note from peer-a");
  expect(after.context).toContain("note from peer-b");
});

test("cap boundary: exactly at the cap and one under both succeed, one over is refused (409)", async () => {
  const author = "author";
  const headerLen = headerLenFor(author);

  for (const target of [
    { total: ROADMAP_APPEND_RESULT_MAX_CHARS - 1, expectOk: true },
    { total: ROADMAP_APPEND_RESULT_MAX_CHARS, expectOk: true },
    { total: ROADMAP_APPEND_RESULT_MAX_CHARS + 1, expectOk: false },
  ]) {
    const text = "z"; // 1 char
    const existingLen = target.total - headerLen - text.length;
    const item = await seed({ context: "x".repeat(existingLen) });

    const res = await append({ id: item.id, by: author, text });
    if (target.expectOk) {
      expect(res.status).toBe(200);
      const body = res.body as AppendRes;
      expect(body.item.context.length).toBe(target.total);
    } else {
      expect(res.status).toBe(409);
      const body = res.body as AppendErr;
      // The refusal must name a remedy the refused caller can actually reach.
      expect(body.error).toMatch(/roadmap_update|roadmap-import|team lead/i);
    }
  }
});

test("card 562fd9b5 review delta: roadmap_items.context is NOT NULL -- this goes red the day that constraint is relaxed", () => {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const columns = db.query("PRAGMA table_info(roadmap_items)").all() as {
      name: string;
      notnull: number;
    }[];
    // The probe must SEE the schema before its silence can mean anything.
    expect(columns.length).toBeGreaterThan(10);
    const contextCol = columns.find((c) => c.name === "context");
    expect(contextCol).toBeDefined();
    expect(contextCol!.notnull).toBe(1);
  } finally {
    db.close();
  }
});

test("appending to a card locked by ANOTHER peer succeeds -- the work-lock does not apply to this route", async () => {
  const item = await seed({ status: "in_progress" }); // creates it already locked, by seed-fixture
  expect(item.locked).toBe(true);
  expect(item.locked_by).toBe("seed-fixture");

  const res = await append({ id: item.id, by: "a-completely-different-peer", text: "note while locked" });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.context).toContain("note while locked");
  // The lock itself is untouched -- proves this route never touches it.
  expect(after.locked).toBe(true);
  expect(after.locked_by).toBe("seed-fixture");
});

test("appending to an archived card succeeds -- deleted_at is not checked", async () => {
  const item = await seed();
  const archived = await post<UpsertRes>(`${broker.url}/roadmap/archive`, {
    id: item.id,
    by: "seed-fixture",
  });
  expect(archived.status).toBe(200);
  expect(archived.body.item.deleted_at).not.toBeNull();

  const res = await append({ id: item.id, by: "post-mortem-author", text: "post-mortem note" });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.context).toContain("post-mortem note");
  expect(after.deleted_at).not.toBeNull(); // still archived
});

test("status and locked cannot be set through this route -- the request shape carries neither field", async () => {
  const item = await seed({ status: "idea" });
  expect(item.locked).toBe(false);

  // Even if a caller stuffs extra JSON properties into the body, the handler
  // never reads them: it only pulls id/text/by/instance_token off the body.
  const res = await append({
    id: item.id,
    by: "sneaky-peer",
    text: "trying to sneak fields in",
    status: "done",
    locked: true,
  });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.status).toBe("idea"); // unchanged
  expect(after.locked).toBe(false); // unchanged
});

test("append text alone over the per-call cap is refused before any DB write, distinct from the result cap", async () => {
  const item = await seed();
  const res = await append({
    id: item.id,
    by: "author",
    text: "x".repeat(ROADMAP_APPEND_PER_CALL_MAX_CHARS + 1),
  });
  expect(res.status).toBe(400); // not 409 -- this is planRoadmapAppendText's pre-refusal, no DB write attempted
  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.context).toBe(""); // nothing landed
});

test("a 404 on an unknown id is distinguished from a 409 cap refusal", async () => {
  const res = await append({ id: "00000000-0000-0000-0000-000000000000", by: "author", text: "x" });
  expect(res.status).toBe(404);
});
