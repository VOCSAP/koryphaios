import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";
import {
  createSqliteRoadmapContextAppendCasStore,
  mapRoadmapContextAppendFailure,
  runRoadmapContextAppendCas,
} from "../shared/roadmap-append-cas.ts";
import {
  ROADMAP_APPEND_RESULT_MAX_CHARS,
  buildRoadmapAppendHeader,
  getRoadmapContextLiveLength,
  parseRoadmapContext,
  planRoadmapContextAppend,
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

function rawHeavyLivingContext(): string {
  let context = "";
  let previousTarget: string | undefined;

  for (let index = 0; index < 7; index += 1) {
    const nowIso = `2026-09-22T12:00:0${index}.000Z`;
    const plan = planRoadmapContextAppend({
      existingContext: context,
      text: "x".repeat(10000),
      author: "fixture",
      nowIso,
      supersedes: previousTarget ? [previousTarget] : [],
    });
    if (!plan.ok) throw new Error(plan.message);
    context = plan.result;
    previousTarget = nowIso;
  }

  return context;
}

test("CAS increments a colliding timestamp before constructing an append", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, context TEXT, content_rev INTEGER, operator_id TEXT)");
    const timestamp = "2026-09-22T12:00:00.000Z";
    db.run("INSERT INTO roadmap_items VALUES (?, ?, ?, ?)", ["item", buildRoadmapAppendHeader(timestamp, "a") + "first", 1, null]);

    const result = runRoadmapContextAppendCas({
      id: "item",
      author: "author",
      text: "replacement",
      now: () => timestamp,
      store: createSqliteRoadmapContextAppendCasStore(db),
    });

    expect(result).toMatchObject({ ok: true });
    const row = db.query("SELECT context FROM roadmap_items WHERE id = ?").get("item") as { context: string };
    const targets = parseRoadmapContext(row.context)
      .filter((unit) => unit.kind === "append")
      .map((unit) => unit.target);
    expect(targets).toEqual([timestamp, "2026-09-22T12:00:00.001Z"]);
  } finally {
    db.close();
  }
});

test("CAS chooses a new timestamp when a stale write consumes its first target", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, context TEXT, content_rev INTEGER, operator_id TEXT)");
    db.run("INSERT INTO roadmap_items VALUES (?, ?, ?, ?)", ["item", "original", 1, null]);
    const base = createSqliteRoadmapContextAppendCasStore(db);
    const timestamp = "2026-09-22T12:00:00.000Z";
    let writes = 0;
    const result = runRoadmapContextAppendCas({
      id: "item",
      author: "author",
      text: "replacement",
      now: () => timestamp,
      store: {
        read: base.read,
        append: (input) => {
          writes += 1;
          if (writes === 1) {
            db.run(
              "UPDATE roadmap_items SET context = context || ?, content_rev = content_rev + 1 WHERE id = ?",
              [buildRoadmapAppendHeader(timestamp, "interloper") + "intervening", "item"],
            );
          }
          return base.append(input);
        },
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(writes).toBe(2);
    const row = db.query("SELECT context FROM roadmap_items WHERE id = ?").get("item") as { context: string };
    const targets = parseRoadmapContext(row.context)
      .filter((unit) => unit.kind === "append")
      .map((unit) => unit.target);
    expect(targets).toEqual([timestamp, "2026-09-22T12:00:00.001Z"]);
  } finally {
    db.close();
  }
});

test("CAS retries a stale content revision and preserves the intervening context", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, context TEXT, content_rev INTEGER, operator_id TEXT)");
    db.run("INSERT INTO roadmap_items VALUES (?, ?, ?, ?)", ["item", "original", 1, null]);
    const base = createSqliteRoadmapContextAppendCasStore(db);
    let writes = 0;
    const result = runRoadmapContextAppendCas({
      id: "item",
      author: "author",
      text: "replacement",
      now: () => "2026-09-22T12:00:00.000Z",
      store: {
        read: base.read,
        append: (input) => {
          writes += 1;
          if (writes === 1) {
            db.run("UPDATE roadmap_items SET context = ?, content_rev = content_rev + 1 WHERE id = ?", ["intervening", "item"]);
          }
          return base.append(input);
        },
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(writes).toBe(2);
    const row = db.query("SELECT context FROM roadmap_items WHERE id = ?").get("item") as { context: string };
    expect(row.context).toContain("intervening");
    expect(row.context).toContain("replacement");
  } finally {
    db.close();
  }
});

test("CAS replans targets after a stale revision", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, context TEXT, content_rev INTEGER, operator_id TEXT)");
    const target = "2026-09-22T12:00:00.000Z";
    db.run("INSERT INTO roadmap_items VALUES (?, ?, ?, ?)", ["item", buildRoadmapAppendHeader(target, "a") + "obsolete", 1, null]);
    const base = createSqliteRoadmapContextAppendCasStore(db);
    let writes = 0;
    const result = runRoadmapContextAppendCas({
      id: "item",
      author: "author",
      text: "replacement",
      supersedes: [target],
      now: () => "2026-09-22T12:01:00.000Z",
      store: {
        read: base.read,
        append: (input) => {
          writes += 1;
          if (writes === 1) {
            db.run(
              "UPDATE roadmap_items SET context = ?, content_rev = content_rev + 1 WHERE id = ?",
              [buildRoadmapAppendHeader("2026-09-22T12:02:00.000Z", "b") + "replacement", "item"],
            );
          }
          return base.append(input);
        },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "supersede_target_missing" });
    expect(writes).toBe(1);
  } finally {
    db.close();
  }
});

test("appending leaves the lock TTL timestamp and author unchanged", async () => {
  const item = await seed({ status: "in_progress" });
  const expectedUpdatedAt = "2000-01-01 00:00:00";
  const db = new Database(broker.dbPath);
  try {
    db.run("UPDATE roadmap_items SET updated_at = ? WHERE id = ?", [expectedUpdatedAt, item.id]);
  } finally {
    db.close();
  }

  // A different author appends -- if this refreshed updated_at, it would
  // silently extend seed-fixture's lock TTL through releaseStaleLocks.
  const res = await append({ id: item.id, by: "a-third-party", text: "a note, not a lock refresh" });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.updated_at).toBe(expectedUpdatedAt);
  expect(after.updated_by).toBe("seed-fixture");
  expect(after.updated_by).not.toBe("a-third-party");
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
  const appendTargets = parseRoadmapContext(after.context)
    .filter((unit) => unit.kind === "append")
    .map((unit) => unit.target);
  expect(new Set(appendTargets).size).toBe(appendTargets.length);
});

test("SQLite and JavaScript code-point lengths agree for U+1F600", () => {
  const db = new Database(":memory:");
  try {
    const sqlite = db.query("SELECT length('😀') AS length").get() as { length: number };
    const text = "😀";

    expect(sqlite.length).toBe(1);
    expect([...text].length).toBe(1);
    expect(text.length).toBe(2);
  } finally {
    db.close();
  }
});

test("an append increments content_rev, the comparison key used by the route", async () => {
  const item = await seed();
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const before = db.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(item.id) as { content_rev: number };
    const res = await append({ id: item.id, by: "author", text: "a note" });
    const after = db.query("SELECT content_rev FROM roadmap_items WHERE id = ?").get(item.id) as { content_rev: number };

    expect(res.status).toBe(200);
    expect(after.content_rev).toBeGreaterThan(before.content_rev);
  } finally {
    db.close();
  }
});

test("live cap boundary: resulting lengths 15999 and 16000 succeed, 16001 is refused", async () => {
  const author = "author";
  const headerLen = headerLenFor(author);

  for (const target of [
    { total: ROADMAP_APPEND_RESULT_MAX_CHARS - 1, expectOk: true },
    { total: ROADMAP_APPEND_RESULT_MAX_CHARS, expectOk: true },
    { total: ROADMAP_APPEND_RESULT_MAX_CHARS + 1, expectOk: false },
  ]) {
    const text = "z";
    const existingLen = target.total - headerLen - text.length;
    const item = await seed({ context: "x".repeat(existingLen) });

    const res = await append({ id: item.id, by: author, text });
    if (target.expectOk) {
      expect(res.status).toBe(200);
      const body = res.body as AppendRes;
      expect(getRoadmapContextLiveLength(body.item.context)).toBe(target.total);
    } else {
      expect(res.status).toBe(409);
      const body = res.body as AppendErr;
      expect(body.error).toContain("supersedes");
      expect(body.error).toMatch(/child roadmap card.*id8/i);
    }
  }
});

test("living cap refusal names the oldest live target, timestamp, size, and current remedies", async () => {
  const author = "author";
  const oldestAt = "2026-09-22T12:00:00.000Z";
  const oldestHeader = buildRoadmapAppendHeader(oldestAt, "oldest-author");
  const appendedHeaderLen = headerLenFor(author);
  const text = "z";
  const item = await seed({
    context:
      oldestHeader +
      "x".repeat(ROADMAP_APPEND_RESULT_MAX_CHARS + 1 - oldestHeader.length - appendedHeaderLen - text.length),
  });

  const res = await append({ id: item.id, by: author, text });

  expect(res.status).toBe(409);
  const error = (res.body as AppendErr).error;
  const proposedTargets = [...error.matchAll(/target=([^;]+);/g)].map((match) => match[1]!);
  const persistedTargets = new Set(
    parseRoadmapContext((await listAll()).find((candidate) => candidate.id === item.id)!.context).map((unit) => unit.target),
  );

  expect(proposedTargets).toEqual([oldestAt]);
  expect(proposedTargets.every((target) => persistedTargets.has(target))).toBe(true);
  expect(error).toMatch(/size=\d+ chars/);
  expect(error).toContain("supersedes");
  expect(error).toMatch(/child roadmap card.*id8/i);
});

test("living cap advice excludes ambiguous targets and accepts every target it offers", async () => {
  const duplicateAt = "2026-09-22T12:00:00.000Z";
  const uniqueAt = "2026-09-22T12:00:00.001Z";
  const context =
    buildRoadmapAppendHeader(duplicateAt, "a") +
    "x".repeat(7000) +
    buildRoadmapAppendHeader(duplicateAt, "b") +
    "x".repeat(7000) +
    buildRoadmapAppendHeader(uniqueAt, "c") +
    "x".repeat(3000);
  const item = await seed({ context });

  const refused = await append({ id: item.id, by: "author", text: "replacement" });
  expect(refused.status).toBe(409);
  const advised = [...(refused.body as AppendErr).error.matchAll(/target=([^;]+);/g)].map((match) => match[1]!);
  expect(advised).toEqual([uniqueAt]);

  for (const target of advised) {
    const accepted = await append({ id: item.id, by: "author", text: "replacement", supersedes: [target] });
    expect(accepted.status).toBe(200);
  }
});

test("live cap negative control: an exact fit passes where one code point over is refused", async () => {
  const author = "negative-control";
  const headerLen = headerLenFor(author);
  const text = "z";
  const exact = await seed({
    context: "x".repeat(ROADMAP_APPEND_RESULT_MAX_CHARS - headerLen - text.length),
  });
  const over = await seed({
    context: "x".repeat(ROADMAP_APPEND_RESULT_MAX_CHARS - headerLen - text.length + 1),
  });

  const accepted = await append({ id: exact.id, by: author, text });
  const refused = await append({ id: over.id, by: author, text });

  expect(accepted.status).toBe(200);
  expect(refused.status).toBe(409);
});

test("a saturated live context accepts an append that supersedes more than it adds", async () => {
  const obsoleteAt = "2026-09-22T12:00:00.000Z";
  const obsoleteAuthor = "obsolete-author";
  const obsoleteHeader = buildRoadmapAppendHeader(obsoleteAt, obsoleteAuthor);
  const item = await seed({
    context: obsoleteHeader + "x".repeat(ROADMAP_APPEND_RESULT_MAX_CHARS - obsoleteHeader.length),
  });

  const res = await append({
    id: item.id,
    by: "replacement-author",
    text: "replacement",
    supersedes: [obsoleteAt],
  });

  expect(res.status).toBe(200);
  const body = res.body as AppendRes;
  expect(body.item.context).toContain(`supersedes ${obsoleteAt}`);
  expect(getRoadmapContextLiveLength(body.item.context)).toBeLessThan(ROADMAP_APPEND_RESULT_MAX_CHARS);
});

test("roadmap context column is non-null", () => {
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
  const item = await seed({ status: "in_progress" });
  expect(item.locked).toBe(true);
  expect(item.locked_by).toBe("seed-fixture");

  const res = await append({ id: item.id, by: "a-completely-different-peer", text: "note while locked" });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.context).toContain("note while locked");
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
  expect(after.deleted_at).not.toBeNull();
});

test("appending to an inactive card succeeds without changing inactive", async () => {
  const item = await seed();
  const db = new Database(broker.dbPath);
  try {
    db.run("UPDATE roadmap_items SET inactive = 1 WHERE id = ?", [item.id]);
  } finally {
    db.close();
  }

  const res = await append({ id: item.id, by: "author", text: "inactive note" });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.context).toContain("inactive note");
  expect(after.inactive).toBe(true);
});

test("status and locked cannot be set through this route -- the request shape carries neither field", async () => {
  const item = await seed({ status: "idea" });
  expect(item.locked).toBe(false);

  const res = await append({
    id: item.id,
    by: "sneaky-peer",
    text: "trying to sneak fields in",
    status: "done",
    locked: true,
  });
  expect(res.status).toBe(200);

  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.status).toBe("idea");
  expect(after.locked).toBe(false);
});

test("an append over the former per-call cap succeeds when its living result fits", async () => {
  const item = await seed();
  const res = await append({
    id: item.id,
    by: "author",
    text: "x".repeat(4001),
  });

  expect(res.status).toBe(200);
  const after = (await listAll()).find((i) => i.id === item.id)!;
  expect(after.context).toContain("x".repeat(4001));
});

test("supersession targets from the request body reject repeated, missing, and ambiguous units", async () => {
  const target = "2026-09-22T12:00:00.000Z";
  const missing = "2026-09-22T12:01:00.000Z";
  const unambiguous = await seed({ context: buildRoadmapAppendHeader(target, "a") + "first" });
  const ambiguous = await seed({
    context: buildRoadmapAppendHeader(target, "a") + "first" + buildRoadmapAppendHeader(target, "b") + "second",
  });

  const repeated = await append({
    id: unambiguous.id,
    by: "author",
    text: "replacement",
    supersedes: [target, target],
  });
  const absent = await append({
    id: unambiguous.id,
    by: "author",
    text: "replacement",
    supersedes: [missing],
  });
  const ambiguousTarget = await append({
    id: ambiguous.id,
    by: "author",
    text: "replacement",
    supersedes: [target],
  });

  for (const result of [repeated, absent, ambiguousTarget]) {
    expect(result.status).toBe(400);
  }
  expect((repeated.body as AppendErr).error).toContain("repeated");
  expect((absent.body as AppendErr).error).toContain("does not exist");
  expect((ambiguousTarget.body as AppendErr).error).toContain("ambiguous");
});

test("raw safety valve follows a fitting living result and names child-card deportation", async () => {
  const context = rawHeavyLivingContext();
  expect(context.length).toBeGreaterThan(64000);
  expect(getRoadmapContextLiveLength(context)).toBeLessThan(ROADMAP_APPEND_RESULT_MAX_CHARS);
  const item = await seed({ context });

  const res = await append({ id: item.id, by: "author", text: "replacement" });

  expect(res.status).toBe(409);
  const error = (res.body as AppendErr).error;
  expect(error).toContain("64000");
  expect(error).toMatch(/child roadmap card.*id8/i);
  expect(error).not.toContain("Oldest living units");
});

test("a fully living over-cap context reports the living ceiling before raw safety", async () => {
  const item = await seed({ context: "x".repeat(64000) });
  const before = (await listAll()).find((candidate) => candidate.id === item.id)!;
  expect(getRoadmapContextLiveLength(before.context)).toBe(64000);
  const res = await append({ id: item.id, by: "author", text: "replacement" });

  expect(res.status).toBe(409);
  const error = (res.body as AppendErr).error;
  expect(error).toContain("16000");
  expect(error).toContain("supersedes");
  expect(error).toMatch(/child roadmap card.*id8/i);
});

test("a 404 on an unknown id is distinguished from a 409 cap refusal", async () => {
  const res = await append({ id: "00000000-0000-0000-0000-000000000000", by: "author", text: "x" });
  expect(res.status).toBe(404);
});

test("append failure codes map to their HTTP statuses", () => {
  const plan = planRoadmapContextAppend({
    existingContext: "existing",
    text: "replacement",
    author: "author",
    nowIso: "2026-09-22T12:00:00.000Z",
  });
  if (!plan.ok) throw new Error(plan.message);

  expect(mapRoadmapContextAppendFailure({ ok: false, code: "unknown_roadmap_item" }, true).status).toBe(404);
  expect(mapRoadmapContextAppendFailure({ ok: false, code: "concurrent_change" }, true).status).toBe(409);

  for (const code of ["supersede_target_duplicate", "supersede_target_missing", "supersede_target_ambiguous"] as const) {
    expect(mapRoadmapContextAppendFailure({ ok: false, code, message: code }, true).status).toBe(400);
  }

  expect(mapRoadmapContextAppendFailure({ ok: false, code: "live_cap", plan, existingContext: "existing" }, true).status).toBe(409);
  expect(mapRoadmapContextAppendFailure({ ok: false, code: "raw_cap", plan }, true).status).toBe(409);
});
