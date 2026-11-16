// Workflow lane: atomic dispatch-queue rewrite via /roadmap/reorder.

import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker , deckAuthored, openBrokerDb } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

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
