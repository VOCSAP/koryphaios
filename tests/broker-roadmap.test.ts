// PLAN-v0.4 C3-M1: roadmap_items table + /roadmap/list|upsert|archive routes.
// Covers CRUD + defaults, enum validation, project_key isolation, tag filter,
// reversible archive, and the core lifecycle guarantee: items carry no FK to
// peers, so unregistering their author never touches them.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker , deckAuthored, openBrokerDb } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/claude-peers-mcp";
const OTHER_PK = "github.com/vocsap/other-repo";

type UpsertRes = { item: RoadmapItem };
type ListRes = { items: RoadmapItem[] };

async function add(fields: Record<string, unknown>): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.item;
}

// ----- create -----

test("create applies defaults (kind=feature, priority=could, levels=medium, status=idea)", async () => {
  const item = await add({ title: "Add roadmap view" });
  expect(item.id.length).toBeGreaterThan(10);
  expect(item.project_key).toBe(PK);
  expect(item.kind).toBe("feature");
  expect(item.priority).toBe("could");
  expect(item.value).toBe("medium");
  expect(item.effort).toBe("medium");
  expect(item.status).toBe("idea");
  expect(item.tags).toEqual([]);
  expect(item.depends_on).toEqual([]);
  expect(item.created_by).toBe("test-peer");
  expect(item.updated_by).toBe("test-peer");
  expect(item.deleted_at).toBeNull();
  expect(item.created_at).toBeTruthy();
});

test("create rejects a missing title / project_key / by", async () => {
  const noTitle = await post(`${broker.url}/roadmap/upsert`, { project_key: PK, by: "p" });
  expect(noTitle.status).toBe(400);
  const noPk = await post(`${broker.url}/roadmap/upsert`, { title: "x", by: "p" });
  expect(noPk.status).toBe(400);
  const noBy = await post(`${broker.url}/roadmap/upsert`, { project_key: PK, title: "x" });
  expect(noBy.status).toBe(400);
});

test("create rejects invalid enums and a directly-archived status", async () => {
  const badKind = await post(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "p",
    title: "x",
    kind: "epic",
  });
  expect(badKind.status).toBe(400);
  const archived = await post(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "p",
    title: "x",
    status: "archived",
  });
  expect(archived.status).toBe(400);
});

// ----- patch -----

test("patch is partial: only sent fields move, updated_by/updated_at stamp", async () => {
  const created = await add({
    title: "Fix flaky reconnect",
    kind: "bug",
    priority: "must",
    value: "high",
    tags: ["broker", "ws"],
  });
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: created.id,
    by: "dev-2",
    status: "in_progress",
  });
  expect(res.status).toBe(200);
  const item = res.body.item;
  expect(item.status).toBe("in_progress");
  expect(item.title).toBe("Fix flaky reconnect");
  expect(item.kind).toBe("bug");
  expect(item.priority).toBe("must");
  expect(item.value).toBe("high");
  expect(item.tags).toEqual(["broker", "ws"]);
  expect(item.created_by).toBe("test-peer");
  expect(item.updated_by).toBe("dev-2");
});

// Card aaf4537d, round-3 mutation review, extra cell (b): handleRoadmapUpsert
// resolves `nextStatus` as `body.status ?? existing.status` (broker.ts
// ~2498) -- a partial upsert that never sends `status` at all must inherit
// whatever status the row already carries, not silently reset to a
// hardcoded default. Distinct from the "patch is partial" test above, which
// always sends `status` explicitly and so never exercises the `??` fallback
// itself.
test("partial upsert that sends no `status` field at all inherits the item's current status, not a hardcoded default", async () => {
  const created = await add({ title: "Status shape inheritance" });
  const claimed = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: created.id,
    by: "dev-3",
    status: "in_progress",
  });
  expect(claimed.body.item.status).toBe("in_progress");

  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: created.id,
    by: "dev-3",
    tags: ["reshaped"],
  });
  expect(res.status).toBe(200);
  expect(res.body.item.status).toBe("in_progress");
  expect(res.body.item.tags).toEqual(["reshaped"]);
});

test("patch of an unknown id -> 404; empty title -> 400", async () => {
  const missing = await post(`${broker.url}/roadmap/upsert`, {
    id: "00000000-0000-0000-0000-000000000000",
    by: "p",
    status: "done",
  });
  expect(missing.status).toBe(404);

  const created = await add({ title: "Titled" });
  const emptied = await post(`${broker.url}/roadmap/upsert`, {
    id: created.id,
    by: "p",
    title: "   ",
  });
  expect(emptied.status).toBe(400);
});

// ----- list + filters + isolation -----

test("list scopes by project_key and filters by kind/status/priority/tag", async () => {
  const a = await add({ title: "debt: split broker.ts", kind: "debt", tags: ["core"] });
  await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: OTHER_PK,
    by: "p",
    title: "other repo item",
  });

  const all = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  expect(all.status).toBe(200);
  expect(all.body.items.some((i) => i.id === a.id)).toBe(true);
  expect(all.body.items.every((i) => i.project_key === PK)).toBe(true);

  const debts = await post<ListRes>(`${broker.url}/roadmap/list`, {
    project_key: PK,
    kind: "debt",
  });
  expect(debts.body.items.every((i) => i.kind === "debt")).toBe(true);
  expect(debts.body.items.some((i) => i.id === a.id)).toBe(true);

  const tagged = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK, tag: "core" });
  expect(tagged.body.items.map((i) => i.id)).toContain(a.id);
  // Card 15952e09, decision 6: an unknown filter value is a 400, never a
  // silent empty list (a typo would otherwise read back as "no such card").
  const tagMiss = await post(`${broker.url}/roadmap/list`, {
    project_key: PK,
    tag: "nope",
  });
  expect(tagMiss.status).toBe(400);

  const missingPk = await post(`${broker.url}/roadmap/list`, {});
  expect(missingPk.status).toBe(400);
  const badFilter = await post(`${broker.url}/roadmap/list`, { project_key: PK, kind: "epic" });
  expect(badFilter.status).toBe(400);
});

// ----- archive (soft delete, reversible) -----

test("archive hides the item from default lists; restore via status patch", async () => {
  const item = await add({ title: "To be archived" });

  // Card 39c40571 layer 2: an operator-authored write is signed.
  const arch = await post<UpsertRes>(
    `${broker.url}/roadmap/archive`,
    deckAuthored({ id: item.id })
  );
  expect(arch.status).toBe(200);
  expect(arch.body.item.status).toBe("archived");
  expect(arch.body.item.deleted_at).toBeTruthy();
  expect(arch.body.item.updated_by).toBe("deck");

  const defaultList = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  expect(defaultList.body.items.some((i) => i.id === item.id)).toBe(false);

  const withArchived = await post<ListRes>(`${broker.url}/roadmap/list`, {
    project_key: PK,
    include_archived: true,
  });
  expect(withArchived.body.items.some((i) => i.id === item.id)).toBe(true);
  const filtered = await post<ListRes>(`${broker.url}/roadmap/list`, {
    project_key: PK,
    status: "archived",
  });
  expect(filtered.body.items.some((i) => i.id === item.id)).toBe(true);

  // Restore: any non-archived status clears the soft delete.
  const restored = await post<UpsertRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ id: item.id, status: "planned" })
  );
  expect(restored.body.item.status).toBe("planned");
  expect(restored.body.item.deleted_at).toBeNull();

  const unknown = await post(`${broker.url}/roadmap/archive`, { id: "nope", by: "p" });
  expect(unknown.status).toBe(404);
});

// ----- export / import (backup + local -> central migration) -----

test("export/import round-trips items with ids, statuses and timestamps intact", async () => {
  const item = await add({ title: "Survives migration", kind: "debt", tags: ["migration"] });
  await post(`${broker.url}/roadmap/archive`, deckAuthored({ id: item.id }));

  const exportRes = await fetch(
    `${broker.url}/roadmap/export?project_key=${encodeURIComponent(PK)}`
  );
  expect(exportRes.status).toBe(200);
  const dump = (await exportRes.json()) as {
    project_key: string;
    exported_at: string;
    items: RoadmapItem[];
  };
  expect(dump.project_key).toBe(PK);
  const exported = dump.items.find((i) => i.id === item.id);
  expect(exported).toBeDefined();
  expect(exported!.status).toBe("archived");

  // Import into a DIFFERENT project key (re-keying) on the same broker: ids,
  // statuses, authors and timestamps must arrive unchanged.
  const targetPk = "github.com/vocsap/migrated";
  // force:true -- the file's other test ("patch is partial...") left "Fix
  // flaky reconnect" locked (in_progress, author != 'deck'), so this export
  // genuinely carries a locked card. Card 40ddf1f5: import skips locked cards
  // unconditionally unless force is set; this round-trip is exercising a
  // deliberate, whole-file migration, so force is the correct, honest way to
  // reach it (not a workaround for the new guard).
  const imp = await post<{ imported: number; skipped: string[] }>(`${broker.url}/roadmap/import`, {
    project_key: targetPk,
    by: "importer-peer",
    force: true,
    items: dump.items,
  });
  expect(imp.status).toBe(200);
  expect(imp.body.imported).toBe(dump.items.length);
  expect(imp.body.skipped).toEqual([]);

  const migrated = await post<ListRes>(`${broker.url}/roadmap/list`, {
    project_key: targetPk,
    include_archived: true,
  });
  const twin = migrated.body.items.find((i) => i.id === item.id);
  expect(twin).toBeDefined();
  expect(twin!.project_key).toBe(targetPk);
  expect(twin!.status).toBe("archived");
  expect(twin!.created_at).toBe(exported!.created_at);
  // Card 40ddf1f5: `roadmap_items` is keyed by id alone (not id+project_key),
  // so this id already exists (created earlier in this same file, under PK)
  // -- import re-keys that SAME row rather than creating a new one, and
  // created_by is preserved from it (immutable attribution, like every other
  // write path), not re-stamped from the resolved `by` on this request.
  expect(twin!.created_by).toBe(item.created_by);
  expect(twin!.updated_by).toBe("importer-peer");
  expect(twin!.tags).toEqual(["migration"]);

  // Re-import is idempotent (INSERT OR REPLACE): created_by still comes from
  // the existing (now targetPk) row, only updated_by moves to the new author.
  const again = await post<{ imported: number }>(`${broker.url}/roadmap/import`, {
    project_key: targetPk,
    by: "re-importer-peer",
    force: true,
    items: dump.items,
  });
  expect(again.status).toBe(200);
  const after = await post<ListRes>(`${broker.url}/roadmap/list`, {
    project_key: targetPk,
    include_archived: true,
  });
  expect(after.body.items.length).toBe(migrated.body.items.length);
  const twinAgain = after.body.items.find((i) => i.id === item.id);
  expect(twinAgain!.created_by).toBe(item.created_by);
  expect(twinAgain!.updated_by).toBe("re-importer-peer");

  // Validation: bad payloads are rejected.
  const noPk = await fetch(`${broker.url}/roadmap/export`);
  expect(noPk.status).toBe(400);
  const badItem = await post(`${broker.url}/roadmap/import`, {
    project_key: targetPk,
    by: "importer-peer",
    items: [{ id: "x", title: "ok", kind: "epic" }],
  });
  expect(badItem.status).toBe(400);
});

// ----- depends_on resolution -----

type ErrRes = { error: string };

async function importAs(projectKey: string, items: Record<string, unknown>[]): Promise<void> {
  const res = await post(`${broker.url}/roadmap/import`, { project_key: projectKey, by: "dep-importer", items });
  expect(res.status).toBe(200);
}

function importable(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "feature", title, ...extra };
}

/** A random id whose id8 holds a letter, so upper-casing it really changes it. */
function idWithLetter(): string {
  return `a${crypto.randomUUID().slice(1)}`;
}

test("depends_on: an 8-hex prefix, in any case, is stored as the full id it names", async () => {
  const targetId = idWithLetter();
  await importAs(PK, [importable(targetId, "dependency target")]);
  const lower = await add({ title: "depends by id8", depends_on: [targetId.slice(0, 8)] });
  expect(lower.depends_on).toEqual([targetId]);
  const upper = await add({ title: "depends by upper id8", depends_on: [targetId.slice(0, 8).toUpperCase()] });
  expect(upper.depends_on).toEqual([targetId]);
  const full = await add({ title: "depends by full id", depends_on: [targetId] });
  expect(full.depends_on).toEqual([targetId]);
});

test("depends_on: an upper-case full id and a prefix carrying a dash are both stored as the full id", async () => {
  const targetId = idWithLetter();
  await importAs(PK, [importable(targetId, "dash prefix target")]);
  const upperFull = await add({ title: "depends by upper full id", depends_on: [targetId.toUpperCase()] });
  expect(upperFull.depends_on).toEqual([targetId]);
  const dashed = await add({ title: "depends by dashed prefix", depends_on: [targetId.slice(0, 13)] });
  expect(dashed.depends_on).toEqual([targetId]);

  const nonHexId = `imported-card-${crypto.randomUUID()}`;
  await importAs(PK, [importable(nonHexId, "non-hex id target")]);
  const upperNonHex = await add({ title: "depends by upper non-hex id", depends_on: [nonHexId.toUpperCase()] });
  expect(upperNonHex.depends_on).toEqual([nonHexId]);
});

test("depends_on: two entries naming the same card store its id once", async () => {
  const target = await add({ title: "named twice" });
  const card = await add({ title: "depends twice", depends_on: [target.id.slice(0, 8), target.id] });
  expect(card.depends_on).toEqual([target.id]);
});

test("depends_on: an unknown entry, a prefix under 8 characters or another project's id is refused with a 400 naming it", async () => {
  const target = await add({ title: "short prefix target" });
  const foreign = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: OTHER_PK,
    by: "test-peer",
    title: "card of another project",
  });
  expect(foreign.status).toBe(200);
  for (const entry of ["deadbeef-not-a-card", target.id.slice(0, 7), foreign.body.item.id.slice(0, 8), foreign.body.item.id]) {
    const res = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
      project_key: PK,
      by: "test-peer",
      title: "dangling dependency",
      depends_on: [entry],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`'${entry}'`);
  }
});

test("depends_on: a prefix two cards share is refused as ambiguous; the full id still resolves", async () => {
  const prefix = crypto.randomUUID().slice(0, 8);
  const first = `${prefix}-aaaa-4aaa-8aaa-000000000001`;
  await importAs(PK, [importable(first, "twin one"), importable(`${prefix}-aaaa-4aaa-8aaa-000000000002`, "twin two")]);

  const ambiguous = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    title: "ambiguous dependency",
    depends_on: [prefix],
  });
  expect(ambiguous.status).toBe(400);
  expect(ambiguous.body.error).toContain(`ambiguous id prefix '${prefix}' (2 matches)`);

  const exact = await add({ title: "exact twin dependency", depends_on: [first] });
  expect(exact.depends_on).toEqual([first]);
});

test("depends_on: a card cannot depend on itself", async () => {
  const card = await add({ title: "self dependent" });
  const res = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
    id: card.id,
    by: "test-peer",
    depends_on: [card.id.slice(0, 8)],
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("cannot depend on itself");
});

test("depends_on: a patch may keep an unresolvable entry already stored, but not add a new one", async () => {
  const id = crypto.randomUUID();
  await importAs(PK, [importable(id, "carries a dangling dependency", { depends_on: ["deadbeef-stored"] })]);
  const target = await add({ title: "new real dependency" });

  const kept = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id,
    by: "test-peer",
    depends_on: ["deadbeef-stored", target.id.slice(0, 8)],
  });
  expect(kept.status).toBe(200);
  expect(kept.body.item.depends_on).toEqual(["deadbeef-stored", target.id]);

  const added = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
    id,
    by: "test-peer",
    depends_on: ["deadbeef-stored", "deadbeef-new"],
  });
  expect(added.status).toBe(400);
  expect(added.body.error).toContain("'deadbeef-new'");
});

test("depends_on: a stored unresolvable entry sent back in another case is still recognised as kept", async () => {
  const id = crypto.randomUUID();
  await importAs(PK, [importable(id, "carries an upper-case dangling dependency", { depends_on: ["DEADBEEF"] })]);
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id,
    by: "test-peer",
    depends_on: ["deadbeef"],
  });
  expect(res.status).toBe(200);
  expect(res.body.item.depends_on).toEqual(["DEADBEEF"]);
});

test("import resolves an id8 against the project and its own batch, and keeps an unresolvable entry verbatim", async () => {
  const existing = await add({ title: "already in the project" });
  const foreign = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: OTHER_PK,
    by: "test-peer",
    title: "foreign card",
  });
  const twin = crypto.randomUUID().slice(0, 8);
  const laterInBatch = idWithLetter();
  const dependent = crypto.randomUUID();
  const entries = [
    existing.id.slice(0, 8),
    laterInBatch.slice(0, 8).toUpperCase(),
    twin,
    foreign.body.item.id.slice(0, 8),
    "deadbeef-unknown",
  ];
  await importAs(PK, [
    importable(dependent, "imported dependent", { depends_on: entries }),
    importable(existing.id, "already in the project, re-imported in the same batch"),
    importable(laterInBatch, "imported after its dependent"),
    importable(`${twin}-bbbb-4bbb-8bbb-000000000001`, "batch twin one"),
    importable(`${twin}-bbbb-4bbb-8bbb-000000000002`, "batch twin two"),
  ]);

  const list = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  const stored = list.body.items.find((i) => i.id === dependent)!;
  expect(stored.depends_on).toEqual([existing.id, laterInBatch, twin, foreign.body.item.id.slice(0, 8), "deadbeef-unknown"]);
});

// ----- lifecycle independence from peers -----

test("items survive their author peer's unregister (no FK, plain-text attribution)", async () => {
  // Register a real peer, author an item as it, then unregister the peer.
  const reg = await post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(),
    client_pid: livePid(),
    cwd: "/tmp/roadmap-author",
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  expect(reg.status).toBe(200);
  const authorId = reg.body.peer_id;

  // Card 39c40571: writing as a REGISTERED peer now requires its token. The
  // property under test (items outlive their author) is unchanged.
  const item = await add({
    title: "Outlives its author",
    by: authorId,
    instance_token: reg.body.instance_token,
  });
  expect(item.created_by).toBe(authorId);

  const unreg = await post(`${broker.url}/unregister`, {
    instance_token: reg.body.instance_token,
  });
  expect(unreg.status).toBe(200);

  const list = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  const survived = list.body.items.find((i) => i.id === item.id);
  expect(survived).toBeDefined();
  expect(survived!.created_by).toBe(authorId);
});

const LONG_AGO = "2020-01-01T00:00:00.000Z";
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function storedContentDate(id: string): string | null {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT content_updated_at FROM roadmap_items WHERE id = ?").get(id) as {
      content_updated_at: string | null;
    };
    return row.content_updated_at;
  } finally {
    db.close();
  }
}

function setStoredContentDate(id: string, value: string | null): void {
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run("UPDATE roadmap_items SET content_updated_at = ? WHERE id = ?", [value, id]);
  } finally {
    db.close();
  }
}

async function datedLongAgo(fields: Record<string, unknown> = {}): Promise<RoadmapItem> {
  const item = await add({ title: `dated ${crypto.randomUUID()}`, ...fields });
  setStoredContentDate(item.id, LONG_AGO);
  return item;
}

async function patchAs(id: string, fields: Record<string, unknown>, by = "test-peer") {
  return post<UpsertRes>(`${broker.url}/roadmap/upsert`, { id, by, ...fields });
}

test("create dates the card at its creation instant", async () => {
  const before = Date.now();
  const item = await add({ title: "born dated" });
  expect(item.content_updated_at).toMatch(ISO_MS);
  expect(Date.parse(item.content_updated_at!)).toBeGreaterThanOrEqual(before - 1000);
  expect(storedContentDate(item.id)).toBe(item.content_updated_at);
});

test("a real change to each content field dates the card", async () => {
  const other = await add({ title: "a dependency target" });
  const changes: [string, unknown][] = [
    ["kind", "bug"],
    ["title", "a renamed card"],
    ["description", "now described"],
    ["rationale", "now justified"],
    ["context", "now briefed"],
    ["priority", "must"],
    ["value", "high"],
    ["effort", "high"],
    ["status", "planned"],
    ["triage", "needs-info"],
    ["tags", ["a-new-tag"]],
    ["depends_on", [other.id]],
  ];
  for (const [field, value] of changes) {
    const item = await datedLongAgo();
    const res = await patchAs(item.id, { [field]: value });
    expect(res.status, `patching ${field}`).toBe(200);
    expect(res.body.item.content_updated_at, `${field} change dates the card`).toMatch(ISO_MS);
    expect(res.body.item.content_updated_at, `${field} change moves the date forward`).not.toBe(LONG_AGO);
  }
});

test("a real delta on directive or target_peer_ids dates the card, an identical one does not", async () => {
  const item = await datedLongAgo({ kind: "directive", directive: "clear", target_peer_ids: ["peer-a"] });
  const same = await patchAs(item.id, { directive: "clear", target_peer_ids: ["peer-a"] });
  expect(same.status).toBe(200);
  expect(same.body.item.content_updated_at, "an identical directive write").toBe(LONG_AGO);

  const retargeted = await patchAs(item.id, { target_peer_ids: ["peer-a", "peer-b"] });
  expect(retargeted.body.item.target_peer_ids).toEqual(["peer-a", "peer-b"]);
  expect(retargeted.body.item.content_updated_at, "a target delta").not.toBe(LONG_AGO);

  setStoredContentDate(item.id, LONG_AGO);
  const recommanded = await patchAs(item.id, { directive: "compact" });
  expect(recommanded.body.item.directive).toBe("compact");
  expect(recommanded.body.item.content_updated_at, "a directive delta").not.toBe(LONG_AGO);
});

test("release:true alone on a card in_progress dates it, the card goes back to planned", async () => {
  const item = await lockedInProgress();
  const released = await patchAs(item.id, { release: true }, "lock-holder");
  expect(released.status).toBe(200);
  expect(released.body.item.status).toBe("planned");
  expect(released.body.item.locked).toBe(false);
  expect(released.body.item.content_updated_at).not.toBe(LONG_AGO);
});

test("archiving and reopening a card date it, inactive toggling too", async () => {
  const item = await datedLongAgo();
  const archived = await patchAs(item.id, { status: "archived" });
  expect(archived.body.item.content_updated_at).not.toBe(LONG_AGO);
  setStoredContentDate(item.id, LONG_AGO);
  const reopened = await patchAs(item.id, { status: "idea" });
  expect(reopened.body.item.content_updated_at).not.toBe(LONG_AGO);
  setStoredContentDate(item.id, LONG_AGO);
  const toggled = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, deckAuthored({ id: item.id, inactive: true }));
  expect(toggled.status).toBe(200);
  expect(toggled.body.item.content_updated_at).not.toBe(LONG_AGO);
});

test("a write whose result equals the stored content leaves the date alone", async () => {
  const item = await datedLongAgo({ priority: "should", tags: ["same"], context: "same context" });
  const identical = await patchAs(item.id, {
    title: item.title,
    priority: "should",
    tags: ["same"],
    context: "same context",
    status: item.status,
    kind: item.kind,
  });
  expect(identical.status).toBe(200);
  expect(identical.body.item.content_updated_at, "an identical retry dates nothing").toBe(LONG_AGO);
  expect(identical.body.item.title).toBe(item.title);
});

test("attribution, queue and lock-only writes leave the date alone", async () => {
  const item = await datedLongAgo();
  const byOther = await patchAs(item.id, {}, "another-author");
  expect(byOther.body.item.updated_by).toBe("another-author");
  expect(byOther.body.item.content_updated_at, "attribution only").toBe(LONG_AGO);

  const signed = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, deckAuthored({ id: item.id }));
  expect(signed.body.item.operator_id).toBeTruthy();
  expect(signed.body.item.content_updated_at, "an operator signature alone").toBe(LONG_AGO);

  const queued = await patchAs(item.id, { queue: 7 });
  expect(queued.body.item.queue).toBe(7);
  expect(queued.body.item.content_updated_at, "queue move").toBe(LONG_AGO);
  const unqueued = await patchAs(item.id, { queue: null });
  expect(unqueued.body.item.queue).toBeNull();
  expect(unqueued.body.item.content_updated_at, "queue clear").toBe(LONG_AGO);

  const claimed = await patchAs(item.id, { status: "in_progress" });
  expect(claimed.body.item.content_updated_at, "taking the card in_progress is a status change").not.toBe(LONG_AGO);
  setStoredContentDate(item.id, LONG_AGO);
  const resumed = await patchAs(item.id, { locked: true });
  expect(resumed.status).toBe(200);
  expect(resumed.body.item.locked).toBe(true);
  expect(resumed.body.item.content_updated_at, "re-taking a lock already held").toBe(LONG_AGO);
});

test("a refused write dates nothing", async () => {
  const item = await datedLongAgo();
  const refused = await patchAs(item.id, { title: "x".repeat(5000) });
  expect(refused.status).toBe(400);
  const stale = await patchAs(item.id, { title: "stale save", expected_content_rev: 0 });
  expect(stale.status).toBe(409);
  expect(storedContentDate(item.id)).toBe(LONG_AGO);
});

async function lockedInProgress(): Promise<RoadmapItem> {
  const item = await datedLongAgo();
  const claimed = await patchAs(item.id, { status: "in_progress" }, "lock-holder");
  expect(claimed.body.item.locked).toBe(true);
  setStoredContentDate(item.id, LONG_AGO);
  return item;
}

const WATCHER_RELEASE = { status: "planned", locked: false, change_origin: "idle_lock_sweep" };

test("the idle-lock watcher's marked release moves status without dating the card", async () => {
  const item = await lockedInProgress();
  const res = await post<UpsertRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ id: item.id, project_key: PK, ...WATCHER_RELEASE })
  );
  expect(res.status).toBe(200);
  expect(res.body.item.status).toBe("planned");
  expect(res.body.item.locked).toBe(false);
  expect(res.body.item.content_updated_at).toBe(LONG_AGO);
});

test("the operator's stop, the same release without the marker, dates the card", async () => {
  const item = await lockedInProgress();
  const res = await post<UpsertRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ id: item.id, project_key: PK, status: "planned", locked: false })
  );
  expect(res.status).toBe(200);
  expect(res.body.item.status).toBe("planned");
  expect(res.body.item.content_updated_at).not.toBe(LONG_AGO);
});

test("the marker is refused, never silently honoured, outside the strict signed lock-release shape", async () => {
  const item = await lockedInProgress();
  const attempts: [string, Record<string, unknown>][] = [
    ["an unsigned write", { id: item.id, by: "test-peer", ...WATCHER_RELEASE }],
    ["a title change", deckAuthored({ id: item.id, title: "sneaky", ...WATCHER_RELEASE })],
    ["a context change", deckAuthored({ id: item.id, context: "sneaky", ...WATCHER_RELEASE })],
    ["a priority change", deckAuthored({ id: item.id, priority: "must", ...WATCHER_RELEASE })],
    ["a status other than planned", deckAuthored({ id: item.id, ...WATCHER_RELEASE, status: "done" })],
    ["no status", deckAuthored({ id: item.id, locked: false, change_origin: "idle_lock_sweep" })],
    ["a create", deckAuthored({ project_key: PK, title: "new", ...WATCHER_RELEASE })],
    ["an unknown origin", deckAuthored({ id: item.id, ...WATCHER_RELEASE, change_origin: "anything" })],
  ];
  for (const [what, body] of attempts) {
    const res = await post<ErrRes>(`${broker.url}/roadmap/upsert`, body);
    expect(res.status, what).toBe(400);
  }
  const after = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  const current = after.body.items.find((i) => i.id === item.id)!;
  expect(current.status, "no refused attempt moved the card").toBe("in_progress");
  expect(current.title).toBe(item.title);
  expect(storedContentDate(item.id)).toBe(LONG_AGO);
});

test("the marker never reopens a card that is not locked and in_progress", async () => {
  for (const status of ["done", "idea", "planned"] as const) {
    const item = await datedLongAgo({ status });
    const res = await post<ErrRes>(
      `${broker.url}/roadmap/upsert`,
      deckAuthored({ id: item.id, project_key: PK, ...WATCHER_RELEASE })
    );
    expect(res.status, `a marked release of a ${status} card`).toBe(400);
    expect(res.body.error).toContain("locked in_progress");
    const list = await post<ListRes>(`${broker.url}/roadmap/list`, { project_key: PK });
    const current = list.body.items.find((i) => i.id === item.id)!;
    expect(current.status, "the refused write moved nothing").toBe(status);
    expect(current.content_updated_at).toBe(LONG_AGO);
  }
  const archived = await datedLongAgo();
  await post(`${broker.url}/roadmap/archive`, { id: archived.id, by: "test-peer" });
  setStoredContentDate(archived.id, LONG_AGO);
  const refused = await post<ErrRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ id: archived.id, project_key: PK, ...WATCHER_RELEASE })
  );
  expect(refused.status, "a stale snapshot cannot reopen an archived card").toBe(400);
  expect(storedContentDate(archived.id)).toBe(LONG_AGO);
});

test("the archive route dates a real archive and leaves an already archived card alone", async () => {
  const item = await datedLongAgo();
  const first = await post<UpsertRes>(`${broker.url}/roadmap/archive`, { id: item.id, by: "test-peer" });
  expect(first.body.item.status).toBe("archived");
  expect(first.body.item.content_updated_at).not.toBe(LONG_AGO);
  setStoredContentDate(item.id, LONG_AGO);
  const second = await post<UpsertRes>(`${broker.url}/roadmap/archive`, { id: item.id, by: "test-peer" });
  expect(second.status).toBe(200);
  expect(second.body.item.content_updated_at, "archiving an archived card").toBe(LONG_AGO);
});
