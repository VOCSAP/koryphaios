// Workflow lane: atomic dispatch-queue rewrite via /roadmap/reorder.

import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker , deckAuthored, openBrokerDb } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";
import type { RoadmapLot } from "../shared/roadmap-lot.ts";
import { queuedItems } from "../desktop/src/shared/workflow.ts";
import type { RoadmapItem as DeckRoadmapItem } from "../desktop/src/shared/types.ts";

let broker: TestBroker;
const KEY = "github.com/test/reorder-repo";

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await stopBroker(broker);
});

async function upsert(fields: Record<string, unknown>) {
  // Card 39c40571 layer 2: by:'deck' carries an operator signature now.
  return post<{ item: RoadmapItem } | { error: string }>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: KEY, ...fields })
  );
}

async function reorder(fields: Record<string, unknown>) {
  return post<{ items: RoadmapItem[] } | { error: string }>(
    `${broker.url}/roadmap/reorder`,
    deckAuthored({ project_key: KEY, ...fields })
  );
}

async function create(title: string, extra: Record<string, unknown> = {}): Promise<RoadmapItem> {
  const res = await upsert({ title, status: "planned", ...extra });
  expect(res.status).toBe(200);
  return (res.body as { item: RoadmapItem }).item;
}

// D2 (card f12e34f1 lot 1) refuses any reorder whose `ids` omits a card the
// PROJECT already has queued -- every test below shares KEY, so a card left
// queued by one test would make the next test's own reorder calls fail on
// coverage for a reason that has nothing to do with what that test means to
// exercise. `ids: []` is exempt from the coverage check (see D2's own
// comment in broker.ts), so this always succeeds regardless of prior state.
beforeEach(async () => {
  await reorder({ ids: [], waves: [] });
});

test("reorder rewrites the whole queue: full-coverage ids get 1..N in the given order", async () => {
  const a = await create("wf a", { queue: 1 });
  const b = await create("wf b", { queue: 2 });
  const c = await create("wf c"); // unqueued so far

  const res = await reorder({ ids: [c.id, a.id, b.id], waves: [[c.id], [a.id], [b.id]] });
  expect(res.status).toBe(200);
  const items = (res.body as { items: RoadmapItem[] }).items;
  expect(items.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
  expect(items.map((i) => i.queue)).toEqual([1, 2, 3]);
});

test("D2: reorder REFUSES an ids that omits a card the project currently has queued, and touches nothing", async () => {
  const a = await create("wf d2 a", { queue: 1 });
  const b = await create("wf d2 b", { queue: 2 });
  const c = await create("wf d2 c"); // unqueued so far

  // Non-vacuity probe: the coverage check's own query must see a NON-EMPTY
  // currently-queued set here, or the negative assertion below would pass
  // vacuously (a broken/over-scoped WHERE clause finding zero missing ids
  // for ANY `ids`, including a genuinely incomplete one).
  const before = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  const queuedBefore = before.body.items.filter((i) => i.queue !== null);
  expect(queuedBefore.length).toBeGreaterThan(0);
  expect(queuedBefore.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

  // c joins, but b (currently queued) is omitted -- the exact shape that
  // used to silently desenfile it.
  const res = await reorder({ ids: [c.id, a.id], waves: [[c.id], [a.id]] });
  expect(res.status).toBe(400);
  expect((res.body as { error: string }).error).toContain(b.id);

  // Whole-batch refusal (transaction): a and b's ranks are untouched, c is
  // still unqueued.
  const after = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(after.body.items.find((i) => i.id === a.id)?.queue).toBe(1);
  expect(after.body.items.find((i) => i.id === b.id)?.queue).toBe(2);
  expect(after.body.items.find((i) => i.id === c.id)?.queue).toBeNull();
});

test("an empty ids array clears the queue entirely", async () => {
  const a = await create("wf clear", { queue: 1 });
  const res = await reorder({ ids: [], waves: [] });
  expect(res.status).toBe(200);
  expect((res.body as { items: RoadmapItem[] }).items).toEqual([]);
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  const a2 = list.body.items.find((i) => i.id === a.id);
  expect(a2?.queue).toBeNull();
  expect(a2?.updated_by).toBe("deck");
});

test("reorder validates authorship, project scope, duplicates and closed items", async () => {
  const a = await create("wf valid");
  const done = await create("wf done");
  await upsert({ id: done.id, status: "done" });

  // Sent RAW, not through the signing helper: the helper stamps by:'deck' over
  // whatever the caller passed, so routing this case through it would have
  // tested the helper instead of the empty-author rule.
  const noAuthor = await post<{ error: string }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    ids: [a.id],
    by: "",
  });
  expect(noAuthor.status).toBe(400);
  expect((await reorder({ ids: "nope" })).status).toBe(400);
  expect((await reorder({ ids: [a.id, a.id] })).status).toBe(400);
  expect((await reorder({ ids: ["missing-id"] })).status).toBe(404);
  expect((await reorder({ ids: [done.id] })).status).toBe(400);

  // Foreign project: the same id under another key is unknown.
  const foreign = await reorder({ project_key: "github.com/test/other", ids: [a.id] });
  expect(foreign.status).toBe(404);

  // A failed rewrite must not have touched the queue (transaction).
  await reorder({ ids: [a.id], waves: [[a.id]] });
  const before = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(before.body.items.find((i) => i.id === a.id)?.queue).toBe(1)
  expect((await reorder({ ids: [a.id, "missing-id"] })).status).toBe(404);
  const after = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(after.body.items.find((i) => i.id === a.id)?.queue).toBe(1);
});

test("reorder refuses the WHOLE batch, naming the offending id, when any item is inactive (403)", async () => {
  const a = await create("wf inactive a");
  const parked = await create("wf inactive parked", { inactive: true });

  const res = await reorder({ ids: [a.id, parked.id] });
  expect(res.status).toBe(403);
  expect((res.body as { error: string }).error).toContain(parked.id);

  // Whole-batch refusal: `a`'s queue must be untouched too (transaction).
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(list.body.items.find((i) => i.id === a.id)?.queue).toBeNull();
  expect(list.body.items.find((i) => i.id === parked.id)?.queue).toBeNull();
});

test("NEGATIVE CONTROL: a batch with no inactive item reorders normally", async () => {
  const a = await create("wf active a");
  const b = await create("wf active b");

  const res = await reorder({ ids: [a.id, b.id], waves: [[a.id], [b.id]] });
  expect(res.status).toBe(200);
  const items = (res.body as { items: RoadmapItem[] }).items;
  expect(items.map((i) => i.queue)).toEqual([1, 2]);
});

test("reorder caps the ids array", async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
  expect((await reorder({ ids })).status).toBe(400);
});

// Waves (roadmap card 42edc88b phase 1): additive optional grouping of ids
// into queue-position ties.

test("waves that flatten to exactly ids stamp same-wave items with a tied queue", async () => {
  const a = await create("wf wave a");
  const b = await create("wf wave b");
  const c = await create("wf wave c");

  const res = await reorder({ ids: [a.id, b.id, c.id], waves: [[a.id], [b.id, c.id]] });
  expect(res.status).toBe(200);
  const items = (res.body as { items: RoadmapItem[] }).items;
  const byId = new Map(items.map((i) => [i.id, i]));
  expect(byId.get(a.id)?.queue).toBe(1);
  expect(byId.get(b.id)?.queue).toBe(2);
  expect(byId.get(c.id)?.queue).toBe(2);
});

// D1 (card f12e34f1 lot 1): `waves` is the only way to express a tie, so
// omitting it must refuse the request rather than stamp a flat 1..N order.
test("D1: reorder REFUSES a request whose waves field is omitted entirely", async () => {
  const a = await create("wf noWaves a");
  const b = await create("wf noWaves b");
  const res = await reorder({ ids: [a.id, b.id] });
  expect(res.status).toBe(400);
  expect((res.body as { error: string }).error).toContain("waves");

  // Whole-batch refusal: nothing got queued by the rejected request.
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(list.body.items.find((i) => i.id === a.id)?.queue).toBeNull();
  expect(list.body.items.find((i) => i.id === b.id)?.queue).toBeNull();
});

test("waves rejected when they do not flatten to exactly ids (set mismatch, order mismatch, length mismatch)", async () => {
  const a = await create("wf mismatch a");
  const b = await create("wf mismatch b");

  // Order mismatch: same set, wrong order.
  expect((await reorder({ ids: [a.id, b.id], waves: [[b.id], [a.id]] })).status).toBe(400);
  // Set mismatch: an id in waves that is not in ids.
  expect((await reorder({ ids: [a.id], waves: [[a.id, b.id]] })).status).toBe(400);
  // Length mismatch: waves flattens to fewer ids than ids.
  expect((await reorder({ ids: [a.id, b.id], waves: [[a.id]] })).status).toBe(400);
});

test("waves rejects an empty wave", async () => {
  const a = await create("wf empty wave");
  expect((await reorder({ ids: [a.id], waves: [[], [a.id]] })).status).toBe(400);
});

test("a directive-kind item may not share a wave of size > 1, but a singleton wave is fine", async () => {
  const feature = await create("wf directive peer");
  const directive = await create("wf directive card", {
    kind: "directive",
    directive: "clear",
  });

  // Grouped with another item: rejected.
  const grouped = await reorder({
    ids: [feature.id, directive.id],
    waves: [[feature.id, directive.id]],
  });
  expect(grouped.status).toBe(400);

  // Alone in its own wave: accepted.
  const singleton = await reorder({
    ids: [feature.id, directive.id],
    waves: [[feature.id], [directive.id]],
  });
  expect(singleton.status).toBe(200);
});

test("an empty waves array alongside an empty ids array clears the queue", async () => {
  const a = await create("wf clear via waves", { queue: 1 });
  const res = await reorder({ ids: [], waves: [] });
  expect(res.status).toBe(200);
  expect((res.body as { items: RoadmapItem[] }).items).toEqual([]);
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(list.body.items.find((i) => i.id === a.id)?.queue).toBeNull();
});

// Reviewer NIT (12d9048): the broker trimmed `ids` (via cleanList) but
// compared it to a raw, untrimmed `waves.flat()`. Symmetric trim fix.

test("wave ids padded the same way as ids are accepted (symmetric trim)", async () => {
  const a = await create("wf trim a");
  const b = await create("wf trim b");

  const res = await reorder({ ids: [` ${a.id} `, b.id], waves: [[` ${a.id} `], [b.id]] });
  expect(res.status).toBe(200);
  const items = (res.body as { items: RoadmapItem[] }).items;
  expect(items.map((i) => i.id)).toEqual([a.id, b.id]);
});

test("a non-string or whitespace-only wave id is rejected explicitly, not silently dropped", async () => {
  const a = await create("wf bad wave id");

  const nonString = await reorder({ ids: [a.id], waves: [[123 as unknown as string]] });
  expect(nonString.status).toBe(400);

  const blank = await reorder({ ids: [a.id], waves: [["   "]] });
  expect(blank.status).toBe(400);
});

// V-A (roadmap card f12e34f1 lot 1): a reorder touching a card locked by a
// DIFFERENT group is refused (409); the caller's own group, and the
// operator ('deck'), keep authority over it -- same convention as
// handleRoadmapUpsert's own lock guard.

async function registerPeer(
  host: string,
  groupId: string
): Promise<{ peer_id: string; instance_token: string }> {
  const res = await post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: "/tmp/va-reorder-repo",
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: livePid(),
    claude_cli_pid: 1,
    project_key: KEY,
    group_id: groupId,
    group_secret_hash: null,
  });
  expect(res.status).toBe(200);
  return res.body;
}

test("V-A: reorder REFUSES touching the rank of a card locked by a DIFFERENT group, whole batch", async () => {
  const owner = await registerPeer("h-va-refuse-owner", "va-refuse-group-owner");
  const outsider = await registerPeer("h-va-refuse-outsider", "va-refuse-group-outsider");

  const locked = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    title: "wf va locked",
    status: "in_progress",
  });
  expect(locked.body.item.locked).toBe(true);
  const free = await create("wf va free");

  const res = await post<{ error: string }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: outsider.peer_id,
    instance_token: outsider.instance_token,
    ids: [locked.body.item.id, free.id],
    waves: [[locked.body.item.id], [free.id]],
  });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain(locked.body.item.id);

  // Whole-batch refusal: the free card was not queued either.
  const list = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(list.body.items.find((i) => i.id === free.id)?.queue).toBeNull();
});

// NEGATIVE CONTROL, both directions: neither the true owner's own group nor
// the operator is blocked by the guard the test above measured.

test("V-A NEGATIVE CONTROL: reorder ALLOWS a card locked by a peer in the caller's OWN group", async () => {
  const owner = await registerPeer("h-va-same-owner", "va-same-group");
  const teammate = await registerPeer("h-va-same-teammate", "va-same-group");

  const locked = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    title: "wf va same-group locked",
    status: "in_progress",
  });
  expect(locked.body.item.locked).toBe(true);

  const res = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: teammate.peer_id,
    instance_token: teammate.instance_token,
    ids: [locked.body.item.id],
    waves: [[locked.body.item.id]],
  });
  expect(res.status).toBe(200);
});

test("V-A NEGATIVE CONTROL: the operator ('deck') keeps cross-group authority over a locked card", async () => {
  const owner = await registerPeer("h-va-deck-owner", "va-deck-group");
  const locked = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    title: "wf va deck locked",
    status: "in_progress",
  });
  expect(locked.body.item.locked).toBe(true);

  const res = await reorder({ ids: [locked.body.item.id], waves: [[locked.body.item.id]] });
  expect(res.status).toBe(200);
});

// V-A composes with D2's empty-ids exemption: an empty `ids` skips the
// per-id loop entirely, yet the transaction still unqueues every currently
// queued row of the project -- the same rank-moving act V-A refuses above,
// applied to rows the loop never saw.

test("V-A: an empty-ids clear REFUSES to unqueue a card locked by a DIFFERENT group", async () => {
  const owner = await registerPeer("h-va-clear-owner", "va-clear-group-owner");
  const outsider = await registerPeer("h-va-clear-outsider", "va-clear-group-outsider");

  const locked = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    title: "wf va clear locked",
    status: "in_progress",
  });
  expect(locked.body.item.locked).toBe(true);
  await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    ids: [locked.body.item.id],
    waves: [[locked.body.item.id]],
  });

  const res = await post<{ error: string }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: outsider.peer_id,
    instance_token: outsider.instance_token,
    ids: [],
    waves: [],
  });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain(locked.body.item.id);

  const after = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: KEY,
  });
  expect(after.body.items.find((i) => i.id === locked.body.item.id)?.queue).toBe(1);
});

test("V-A NEGATIVE CONTROL: an empty-ids clear from the SAME group, or 'deck', still empties a queue holding a locked card", async () => {
  const owner = await registerPeer("h-va-clear-ok-owner", "va-clear-ok-group");
  const teammate = await registerPeer("h-va-clear-ok-teammate", "va-clear-ok-group");

  const locked = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    title: "wf va clear ok locked",
    status: "in_progress",
  });
  await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    ids: [locked.body.item.id],
    waves: [[locked.body.item.id]],
  });

  const sameGroup = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: teammate.peer_id,
    instance_token: teammate.instance_token,
    ids: [],
    waves: [],
  });
  expect(sameGroup.status).toBe(200);

  // Re-queue it, then confirm 'deck' clears past it too.
  await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/reorder`, {
    project_key: KEY,
    by: owner.peer_id,
    instance_token: owner.instance_token,
    ids: [locked.body.item.id],
    waves: [[locked.body.item.id]],
  });
  const deckClear = await reorder({ ids: [], waves: [] });
  expect(deckClear.status).toBe(200);
});

test("reorder and dequeue move the queue and leave every card's content date alone", async () => {
  const a = await create("wf date a", { queue: 1 });
  const b = await create("wf date b", { queue: 2 });
  const pinned = "2020-01-01T00:00:00.000Z";
  const db = openBrokerDb(broker.dbPath);
  db.run("UPDATE roadmap_items SET content_updated_at = ? WHERE id IN (?, ?)", [pinned, a.id, b.id]);
  db.close();

  const swapped = await reorder({ ids: [b.id, a.id], waves: [[b.id], [a.id]] });
  expect(swapped.status).toBe(200);
  const items = (swapped.body as { items: RoadmapItem[] }).items;
  expect(items.map((i) => [i.id, i.queue])).toEqual([[b.id, 1], [a.id, 2]]);
  expect(items.map((i) => i.content_updated_at), "a rewritten rank dates nothing").toEqual([pinned, pinned]);

  const dequeued = await upsert({ id: a.id, queue: null });
  const afterDequeue = (dequeued.body as { item: RoadmapItem }).item;
  expect(afterDequeue.queue).toBeNull();
  expect(afterDequeue.status).toBe("planned");
  expect(afterDequeue.content_updated_at, "a dequeue planned -> planned dates nothing").toBe(pinned);
});

test("a status-only patch to done or archived drops the card's queue rank", async () => {
  const toDone = await create("wf terminal done", { queue: 1 });
  const toArchived = await create("wf terminal archived", { queue: 2 });
  expect(toDone.queue, "non-vacuity: the card starts ranked").toBe(1);

  const done = await upsert({ id: toDone.id, status: "done" });
  expect(done.status).toBe(200);
  expect((done.body as { item: RoadmapItem }).item.queue, "done keeps no rank").toBeNull();

  const archived = await upsert({ id: toArchived.id, status: "archived" });
  expect(archived.status).toBe(200);
  expect((archived.body as { item: RoadmapItem }).item.queue, "archived keeps no rank").toBeNull();
});

test("a legacy done card with a rank does not block a reorder of the active set, and loses its rank", async () => {
  const active = await create("wf legacy active", { queue: 1 });
  const legacy = await create("wf legacy done");
  const db = openBrokerDb(broker.dbPath);
  db.run("UPDATE roadmap_items SET status = 'done', queue = 7, lot_id = 'default' WHERE id = ?", [legacy.id]);
  const seeded = db.query("SELECT status, queue FROM roadmap_items WHERE id = ?").get(legacy.id);
  expect(seeded, "non-vacuity: the legacy row is done and ranked").toEqual({ status: "done", queue: 7 });

  const res = await reorder({ ids: [active.id], waves: [[active.id]] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((res.body as { items: RoadmapItem[] }).items.map((i) => [i.id, i.queue])).toEqual([[active.id, 1]]);

  const after = db.query("SELECT queue FROM roadmap_items WHERE id = ?").get(legacy.id);
  db.close();
  expect(after, "the wide unqueue UPDATE cleans the legacy rank").toEqual({ queue: null });
});

test("a card created done with a rank is stored unranked, and a ranked card created planned keeps its rank", async () => {
  const ranked = await create("wf born planned", { queue: 1 });
  expect(ranked.queue, "negative control: a non-terminal birth keeps its rank").toBe(1);

  const born = await create("wf born done", { status: "done", queue: 2 });
  expect(born.status).toBe("done");
  expect(born.queue, "a terminal birth stores no rank").toBeNull();
  const reordered = await reorder({ ids: [ranked.id], waves: [[ranked.id]] });
  expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
});

test("archiving a ranked card drops its rank, so the active set reorders without it", async () => {
  const kept = await create("wf archive kept", { queue: 1 });
  const archived = await create("wf archive gone", { queue: 2 });
  const res = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/archive`, deckAuthored({ id: archived.id }));
  expect(res.status).toBe(200);
  expect(res.body.item.status).toBe("archived");
  expect(res.body.item.queue, "an archived card holds no rank").toBeNull();

  const reordered = await reorder({ ids: [kept.id], waves: [[kept.id]] });
  expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
});

const lotPost = <T = { error: string }>(path: string, body: Record<string, unknown>) =>
  post<T>(`${broker.url}${path}`, deckAuthored(body));

async function createLot(project: string, name = "lot"): Promise<RoadmapLot> {
  const res = await lotPost<{ lot: RoadmapLot }>("/roadmap/lot/create", { project_key: project, name });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.lot;
}

const moveLot = (project: string, ids: string[], from: string | null, to: string | null) =>
  lotPost<{ items: RoadmapItem[]; error?: string }>("/roadmap/lot/move", { project_key: project, ids, from, to });

function sqlOnBroker(statement: string, ...params: (string | number | null)[]): void {
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run(statement, params);
  } finally {
    db.close();
  }
}

function storedPlace(id: string): [string | null, number | null] {
  const db = openBrokerDb(broker.dbPath);
  try {
    const row = db.query("SELECT lot_id, queue FROM roadmap_items WHERE id = ?").get(id) as {
      lot_id: string | null;
      queue: number | null;
    };
    return [row.lot_id, row.queue];
  } finally {
    db.close();
  }
}

async function placeOf(project: string, id: string): Promise<[string | null | undefined, number | null | undefined]> {
  const res = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, { project_key: project });
  const item = res.body.items.find((i) => i.id === id);
  return [item?.lot_id, item?.queue];
}

test("a lot is born open, dated in ISO 8601 UTC, with the lowest colour no open lot holds", async () => {
  const project = "github.com/test/lot-colour";
  const born = [await createLot(project, "one"), await createLot(project, "two"), await createLot(project, "three")];
  expect(born.map((lot) => [lot.name, lot.color, lot.closed_at, lot.created_by])).toEqual([
    ["one", 0, null, "deck"],
    ["two", 1, null, "deck"],
    ["three", 2, null, "deck"],
  ]);
  expect(born[0]!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  sqlOnBroker("UPDATE roadmap_lots SET closed_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", born[1]!.id);
  expect([(await createLot(project)).color, (await createLot(project)).color]).toEqual([1, 3]);
  expect((await createLot("github.com/test/lot-colour-other")).color).toBe(0);

  const listed = await post<{ lots: RoadmapLot[] }>(`${broker.url}/roadmap/lot/list`, { project_key: project });
  expect(listed.body.lots).toHaveLength(5);
  expect(listed.body.lots.map((lot) => lot.id)).toEqual(expect.arrayContaining(born.map((lot) => lot.id)));
});

test("ranking an existing card outside every lot by upsert puts it in the default lot", async () => {
  const card = await create("lot queued later");
  expect(card.lot_id).toBeNull();

  expect((await upsert({ id: card.id, queue: 1 })).status).toBe(200);

  expect(await placeOf(KEY, card.id)).toEqual(["default", 1]);
});

test("a lot name must hold 1 to 120 characters", async () => {
  for (const name of ["", "   ", "x".repeat(121)]) {
    const res = await lotPost("/roadmap/lot/create", { project_key: "github.com/test/lot-name", name });
    expect([name.length, res.status]).toEqual([name.length, 400]);
  }
});

test("a move into an unknown, foreign or closed lot is refused and the card keeps its place", async () => {
  const card = await create("lot refused destination", { queue: 1 });
  const closed = await createLot(KEY, "closed");
  sqlOnBroker("UPDATE roadmap_lots SET closed_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", closed.id);
  const foreign = await createLot("github.com/test/lot-foreign");

  const statuses = [];
  for (const to of ["no-such-lot", foreign.id, closed.id]) {
    statuses.push((await moveLot(KEY, [card.id], "default", to)).status);
  }

  expect(statuses).toEqual([404, 404, 409]);
  expect(await placeOf(KEY, card.id)).toEqual(["default", 1]);
});

test("a move names its source: it drops the rank and keeps membership, and a wrong source changes nothing", async () => {
  const card = await create("lot transfer", { queue: 1 });
  const lot = await createLot(KEY);

  expect((await moveLot(KEY, [card.id], null, lot.id)).status).toBe(409);
  expect((await moveLot(KEY, [card.id], "default", "default")).status).toBe(400);
  expect(await placeOf(KEY, card.id)).toEqual(["default", 1]);

  const moved = await moveLot(KEY, [card.id], "default", lot.id);
  expect(moved.body.items.map((i) => [i.id, i.lot_id, i.queue])).toEqual([[card.id, lot.id, null]]);
  expect((await moveLot(KEY, [card.id], "default", null)).status).toBe(409);
  expect((await moveLot(KEY, [card.id], lot.id, null)).status).toBe(200);
  expect(await placeOf(KEY, card.id)).toEqual([null, null]);
});

test("a move holding an unknown card, or one of another project, moves nothing", async () => {
  const card = await create("lot all or nothing", { queue: 1 });
  const elsewhere = await create("lot other project", { project_key: "github.com/test/lot-elsewhere", queue: 1 });

  expect((await moveLot(KEY, [card.id, "missing-card"], "default", null)).status).toBe(404);
  expect((await moveLot(KEY, [card.id, elsewhere.id], "default", null)).status).toBe(404);
  expect(await placeOf(KEY, card.id)).toEqual(["default", 1]);
});

test("a card another group holds does not change lot, except by the operator", async () => {
  const card = await create("lot foreign lock", { queue: 1 });
  sqlOnBroker("UPDATE roadmap_items SET locked = 1, locked_by = 'holder', locked_group = 'other' WHERE id = ?", card.id);

  const agent = await post(`${broker.url}/roadmap/lot/move`, {
    project_key: KEY,
    by: "unregistered-lot-agent",
    ids: [card.id],
    from: "default",
    to: null,
  });

  expect(agent.status).toBe(409);
  expect(await placeOf(KEY, card.id)).toEqual(["default", 1]);
  expect((await moveLot(KEY, [card.id], "default", null)).status).toBe(200);
});

test("no queue write reaches a named lot, and clearing the default queue leaves its ranks alone", async () => {
  const lot = await createLot(KEY);
  const named = await create("lot named member", { queue: 1 });
  expect((await moveLot(KEY, [named.id], "default", lot.id)).status).toBe(200);
  expect((await upsert({ id: named.id, queue: 5 })).status).toBe(400);
  sqlOnBroker("UPDATE roadmap_items SET queue = 1 WHERE id = ?", named.id);
  const plain = await create("lot default member", { queue: 1 });
  expect(plain.lot_id).toBe("default");

  const reordered = await reorder({ ids: [plain.id], waves: [[plain.id]] });
  expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
  expect((reordered.body as { items: RoadmapItem[] }).items.map((i) => i.id)).toEqual([plain.id]);
  expect((await reorder({ ids: [plain.id, named.id], waves: [[plain.id], [named.id]] })).status).toBe(400);
  expect((await reorder({ ids: [], waves: [] })).status).toBe(200);
  expect(storedPlace(named.id)).toEqual([lot.id, 1]);
  expect(await placeOf(KEY, named.id)).toEqual([lot.id, null]);
  expect(await placeOf(KEY, plain.id), "a dequeued card stays in its lot").toEqual(["default", null]);

  expect((await upsert({ id: named.id, description: "edited" })).status).toBe(200);
  expect(storedPlace(named.id)).toEqual([lot.id, 1]);
  expect((await upsert({ id: named.id, status: "done" })).status).toBe(200);
  expect(storedPlace(named.id)).toEqual([lot.id, null]);
});

/** A named lot's card holding a rank, a state no route writes: the row a newer broker would leave. */
async function rankedNamedCard(title: string): Promise<{ card: RoadmapItem; lot: RoadmapLot }> {
  const lot = await createLot(KEY);
  const card = await create(title, { context: "a context worth deporting" });
  expect((await moveLot(KEY, [card.id], null, lot.id)).status).toBe(200);
  sqlOnBroker("UPDATE roadmap_items SET queue = 1 WHERE id = ?", card.id);
  return { card, lot };
}

test("the card list serves a named lot's card without its rank, while the default lot keeps its own", async () => {
  const { card, lot } = await rankedNamedCard("lot rank hidden from the list");
  const plain = await create("lot rank shown in the default lot", { queue: 2 });

  expect(await placeOf(KEY, card.id)).toEqual([lot.id, null]);
  expect(await placeOf(KEY, plain.id)).toEqual(["default", 2]);
  expect(storedPlace(card.id), "the stored rank survives the read").toEqual([lot.id, 1]);
});

test("the Deck's queue read over the card list holds the default lot alone", async () => {
  const { card } = await rankedNamedCard("lot rank hidden from the Deck queue");
  const first = await create("lot default queue first", { queue: 1 });
  const second = await create("lot default queue second", { queue: 2 });

  const listed = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, { project_key: KEY });
  const queued = queuedItems(listed.body.items as unknown as DeckRoadmapItem[]).map((i) => i.id);

  expect(queued).toEqual([first.id, second.id]);
  expect(listed.body.items.some((i) => i.id === card.id), "non-vacuity: the named card is listed").toBe(true);
});

test("the export, a backup, carries the stored rank of a named lot's card", async () => {
  const { card, lot } = await rankedNamedCard("lot rank kept by the export");
  const res = await fetch(`${broker.url}/roadmap/export?project_key=${encodeURIComponent(KEY)}`);
  const exported = (await res.json()) as { items: RoadmapItem[] };
  const saved = exported.items.find((i) => i.id === card.id);

  expect([saved?.lot_id, saved?.queue]).toEqual([lot.id, 1]);
});

test("an upsert answers a named lot's card without its rank and leaves the stored one", async () => {
  const { card } = await rankedNamedCard("lot rank hidden from the upsert reply");
  const res = await upsert({ id: card.id, description: "edited" });

  expect((res.body as { item: RoadmapItem }).item.queue).toBeNull();
  expect(storedPlace(card.id)[1]).toBe(1);
});

test("a context append and a context deportation answer a named lot's card without its rank", async () => {
  const { card } = await rankedNamedCard("lot rank hidden from the context replies");
  const appended = await lotPost<{ item: RoadmapItem }>("/roadmap/append-context", { id: card.id, text: "a note" });
  const deported = await lotPost<{ item: RoadmapItem }>("/roadmap/context-document/deport", {
    id: card.id,
    project_key: KEY,
    targets: ["body"],
  });

  expect([appended.status, deported.status], JSON.stringify([appended.body, deported.body])).toEqual([200, 200]);
  expect([appended.body.item.queue, deported.body.item.queue]).toEqual([null, null]);
  expect(storedPlace(card.id)[1]).toBe(1);
});
