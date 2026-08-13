// PLAN-v0.4 C3-M1: roadmap_items table + /roadmap/list|upsert|archive routes.
// Covers CRUD + defaults, enum validation, project_key isolation, tag filter,
// reversible archive, and the core lifecycle guarantee: items carry no FK to
// peers, so unregistering their author never touches them.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker , deckAuthored } from "./_helper.ts";
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
