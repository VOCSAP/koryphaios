import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, openBrokerDb, deckAuthored } from "./_helper.ts";
import type { RoadmapItem, RoadmapListResponse } from "../shared/types.ts";

let broker: Awaited<ReturnType<typeof startBroker>>;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/roadmap-search-fixture";
const PK2 = "github.com/vocsap/roadmap-search-fixture-2";

async function add(fields: Record<string, unknown>): Promise<RoadmapItem> {
  const res = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.item;
}

async function list(body: Record<string, unknown>) {
  return post<RoadmapListResponse>(`${broker.url}/roadmap/list`, { project_key: PK, ...body });
}

/** status='archived' is rejected at creation (broker-roadmap.test.ts); reach
 * it the only way the broker allows: create, then archive. */
async function archive(projectKey: string, id: string): Promise<void> {
  const res = await post(`${broker.url}/roadmap/archive`, { project_key: projectKey, by: "test-peer", id });
  expect(res.status).toBe(200);
}

// ----- retro-compatibility -----

test("the 5 legacy filters alone return exactly what they did before, no facets key", async () => {
  await add({ title: "Legacy filter probe", kind: "bug", priority: "must", tags: ["legacy-probe"] });
  const res = await list({ kind: "bug", priority: "must", tag: "legacy-probe", include_archived: false });
  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  expect(res.body.items.every((i) => i.kind === "bug" && i.priority === "must")).toBe(true);
  expect("facets" in res.body).toBe(false);
});

// ----- FTS5 free text -----

test("q matches non-contiguous terms, ordered by bm25", async () => {
  await add({ title: "broker must handle a public token carefully", kind: "feature" });
  const res = await list({ q: "broker token" });
  expect(res.status).toBe(200);
  expect(res.body.items.some((i) => i.title.includes("public token"))).toBe(true);
});

test("q_deep widens the search to rationale/context; default q does not match there", async () => {
  const item = await add({
    title: "Deep search fixture",
    rationale: "zzqxrationaleonly wording lives only in rationale",
  });
  const shallow = await list({ q: "zzqxrationaleonly" });
  expect(shallow.body.items.find((i) => i.id === item.id)).toBeUndefined();
  const deep = await list({ q: "zzqxrationaleonly", q_deep: true });
  expect(deep.body.items.find((i) => i.id === item.id)).toBeDefined();
});

test("blank/whitespace-only q returns the unfiltered list, never a MATCH '' error", async () => {
  const res = await list({ q: "   " });
  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThan(0);
});

test("an UPDATE that removes matched words drops the card out of MATCH results", async () => {
  const item = await add({ title: "zzqxupdateword should vanish after edit" });
  const before = await list({ q: "zzqxupdateword" });
  expect(before.body.items.some((i) => i.id === item.id)).toBe(true);

  const upd = await post(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "test-peer",
    id: item.id,
    title: "renamed with none of the old wording",
  });
  expect(upd.status).toBe(200);

  const after = await list({ q: "zzqxupdateword" });
  expect(after.body.items.map((i) => i.id)).not.toContain(item.id);
});

// ----- cross-project leak guard (#3b) -----

test("MATCH is scoped by project_key: a card in project 2 never appears in project 1's search", async () => {
  const shared = "zzqxcrossproject shared wording";
  const a = await add({ title: shared, tags: ["zzqxshared"] });
  const bRes = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: PK2,
    by: "test-peer",
    title: shared,
    tags: ["zzqxshared"],
  });
  expect(bRes.status).toBe(200);
  const b = bRes.body.item;

  const resA = await list({ q: "zzqxcrossproject" });
  expect(resA.body.items.map((i) => i.id)).toEqual([a.id]);

  const resB = await post<RoadmapListResponse>(`${broker.url}/roadmap/list`, {
    project_key: PK2,
    q: "zzqxcrossproject",
  });
  expect(resB.body.items.map((i) => i.id)).toEqual([b.id]);

  // Counter-probe, kept in the diff on purpose (a probe run once and dropped
  // proves nothing the next time this code changes): the SAME query with the
  // project_key join dropped leaks BOTH projects' cards. This is what the
  // "AND t.project_key = ?" clause in handleRoadmapList's FTS branch exists
  // to prevent.
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    const leaked = db
      .query(
        `SELECT t.id FROM roadmap_items t, roadmap_fts
          WHERE t.rowid = roadmap_fts.rowid AND roadmap_fts MATCH ?`
      )
      .all('"zzqxcrossproject"') as { id: string }[];
    const ids = leaked.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(leaked.length).toBe(2);
  } finally {
    db.close();
  }
});

// ----- plural filters union with singular, IN-composition -----

test("kinds/statuses/priorities/efforts/values filter via SQL IN, OR within a dimension", async () => {
  const bug = await add({ title: "plural filter bug", kind: "bug" });
  const chore = await add({ title: "plural filter chore", kind: "chore" });
  await add({ title: "plural filter feature (excluded)", kind: "feature" });

  const res = await list({ kinds: ["bug", "chore"] });
  const ids = res.body.items.map((i) => i.id);
  expect(ids).toContain(bug.id);
  expect(ids).toContain(chore.id);
});

test("tag filter runs in SQL (json_each), composing with other filters", async () => {
  const hit = await add({ title: "json_each tag hit", kind: "bug", tags: ["zzqxjsoneach"] });
  await add({ title: "json_each tag miss (wrong kind)", kind: "feature", tags: ["zzqxjsoneach"] });

  const res = await list({ tags: ["zzqxjsoneach"], kind: "bug" });
  expect(res.body.items.map((i) => i.id)).toEqual([hit.id]);
});

// ----- include_archived composition -----

test("include_archived composes with another filter instead of being overridden by it", async () => {
  const archived = await add({ title: "archived+kind compose", kind: "bug" });
  await archive(PK, archived.id);
  const noArchived = await list({ kind: "bug", include_archived: false });
  expect(noArchived.body.items.map((i) => i.id)).not.toContain(archived.id);
  const withArchived = await list({ kind: "bug", include_archived: true });
  expect(withArchived.body.items.map((i) => i.id)).toContain(archived.id);
});

// ----- unknown filter value = 400, never zero results -----

test("an unknown enum filter value (singular or plural) is a 400, not an empty list", async () => {
  const res1 = await list({ kind: "epic" });
  expect(res1.status).toBe(400);
  const res2 = await list({ kinds: ["bug", "epic"] });
  expect(res2.status).toBe(400);
  const res3 = await list({ efforts: ["extreme"] });
  expect(res3.status).toBe(400);
});

test("an unknown tag is a 400 that lists the project's actual tags", async () => {
  await add({ title: "known tag fixture", tags: ["zzqxknowntag"] });
  const res = await list({ tags: ["zzqxnosuchtag"] });
  expect(res.status).toBe(400);
  const body = res.body as unknown as { error: string };
  expect(body.error).toContain("zzqxnosuchtag");
  expect(body.error).toContain("zzqxknowntag");
});

// The reference set for the unknown-tag 400 check is the whole project,
// archived cards included, independent of the request's own include_archived
// filter.
test("a tag living only on an archived card still validates with include_archived:false", async () => {
  const created = await add({ title: "archived-only tag fixture", tags: ["zzqxarchivedonlytag"] });
  await archive(PK, created.id);
  const res = await list({ tags: ["zzqxarchivedonlytag"], include_archived: false });
  expect(res.status).toBe(200);
  const body = res.body as unknown as RoadmapListResponse;
  // The card itself is still excluded by the archived filter (include_archived
  // is false): this is "the tag validates", not "the archived card shows up".
  expect(body.items.some((i) => i.id === created.id)).toBe(false);
});

test("an id-prefix search returns the card whose id starts with it, not masked by a card that only mentions it", async () => {
  const target = await add({ title: "id prefix search target" });
  const prefix = target.id.slice(0, 8);
  const mentioner = await add({
    title: `card mentioning ${prefix} in its own text`,
    description: `see also ${prefix} for context`,
  });
  const res = await list({ q: prefix });
  expect(res.status).toBe(200);
  const ids = res.body.items.map((i) => i.id);
  expect(ids).toContain(target.id);
  expect(ids).toContain(mentioner.id);
});

// ----- facets -----

test("with_facets computes flat counts over the include_archived-only reference set", async () => {
  const pk = "github.com/vocsap/roadmap-search-facets";
  async function addTo(fields: Record<string, unknown>) {
    const res = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
      project_key: pk,
      by: "test-peer",
      ...fields,
    });
    expect(res.status).toBe(200);
    return res.body.item;
  }
  await addTo({ title: "facet bug", kind: "bug", tags: ["alpha"] });
  await addTo({ title: "facet bug 2", kind: "bug", tags: ["alpha", "beta"] });
  await addTo({ title: "facet chore", kind: "chore" });
  const archivedCard = await addTo({ title: "facet archived", kind: "feature" });
  await archive(pk, archivedCard.id);

  const res = await post<RoadmapListResponse>(`${broker.url}/roadmap/list`, {
    project_key: pk,
    kind: "bug", // a real filter must NOT narrow the facet counts
    with_facets: true,
  });
  expect(res.status).toBe(200);
  const facets = res.body.facets!;
  expect(facets).toBeDefined();

  // Fixed-enum dimensions enumerate every value, zero-count included.
  const kindValues = facets.kind.map((b) => b.value).sort();
  expect(kindValues).toEqual(["bug", "chore", "debt", "directive", "feature", "idea"].sort());
  const bugBucket = facets.kind.find((b) => b.value === "bug")!;
  expect(bugBucket.count).toBe(2);
  const directiveBucket = facets.kind.find((b) => b.value === "directive")!;
  expect(directiveBucket.count).toBe(0);

  // include_archived defaulted to false: the reference set excludes the
  // archived card, so it does not inflate the feature bucket either.
  const featureBucket = facets.kind.find((b) => b.value === "feature")!;
  expect(featureBucket.count).toBe(0);
  expect(facets.reference_total).toBe(3);

  // Dynamic dimension: only tags that occur, zero-count ones absent.
  const tagValues = facets.tags.map((b) => b.value).sort();
  expect(tagValues).toEqual(["alpha", "beta"]);
  expect(facets.tags.find((b) => b.value === "alpha")!.count).toBe(2);
  expect(facets.tags.find((b) => b.value === "beta")!.count).toBe(1);
});

test("triage is a fixed-enum facet dimension whose buckets never cover the untriaged population", async () => {
  const pk = "github.com/vocsap/roadmap-search-facets-triage";
  async function addTo(fields: Record<string, unknown>): Promise<RoadmapItem> {
    const res = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
      project_key: pk,
      by: "test-peer",
      ...fields,
    });
    expect(res.status).toBe(200);
    return res.body.item;
  }
  await addTo({ title: "triaged agent-ready", kind: "feature", triage: "ready-for-agent" });
  await addTo({ title: "triaged twin", kind: "feature", triage: "ready-for-agent" });
  await addTo({ title: "never triaged", kind: "bug" });

  const res = await post<RoadmapListResponse>(`${broker.url}/roadmap/list`, {
    project_key: pk,
    with_facets: true,
  });
  expect(res.status).toBe(200);
  const facets = res.body.facets!;

  const triageValues = facets.triage.map((b) => b.value).sort();
  expect(
    triageValues,
    "a fixed-enum dimension emits every role, so a zero-count one is still a bucket",
  ).toEqual(
    ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"].sort(),
  );
  expect(facets.triage.find((b) => b.value === "ready-for-agent")!.count).toBe(2);
  expect(facets.triage.find((b) => b.value === "needs-triage")!.count).toBe(0);

  const triageTotal = facets.triage.reduce((n, b) => n + b.count, 0);
  expect(facets.reference_total).toBe(3);
  expect(
    triageTotal,
    "the never-triaged card is counted in the reference total and in no bucket, and that gap is the only place the Deck can read it",
  ).toBe(2);
});

test("with_facets + include_archived:true widens the reference set the facets are computed over", async () => {
  const pk = "github.com/vocsap/roadmap-search-facets-archived";
  const res1 = await post<{ item: RoadmapItem }>(`${broker.url}/roadmap/upsert`, {
    project_key: pk,
    by: "test-peer",
    title: "archived-inclusive facet",
    kind: "feature",
  });
  expect(res1.status).toBe(200);
  await archive(pk, res1.body.item.id);

  const excluded = await post<RoadmapListResponse>(`${broker.url}/roadmap/list`, {
    project_key: pk,
    with_facets: true,
  });
  expect(excluded.body.facets!.status.find((b) => b.value === "archived")!.count).toBe(0);
  expect(excluded.body.facets!.reference_total).toBe(0);

  const included = await post<RoadmapListResponse>(`${broker.url}/roadmap/list`, {
    project_key: pk,
    include_archived: true,
    with_facets: true,
  });
  expect(included.body.facets!.status.find((b) => b.value === "archived")!.count).toBe(1);
  expect(included.body.facets!.reference_total).toBe(1);
});

const DPK = "github.com/vocsap/roadmap-date-fixture";
const DAY_MS = 86_400_000;

async function importCards(projectKey: string, cards: Record<string, unknown>[]): Promise<void> {
  const res = await post(`${broker.url}/roadmap/import`, { project_key: projectKey, by: "date-fixture", items: cards });
  expect(res.status).toBe(200);
}

function card(id: string, fields: Record<string, unknown>) {
  return { id, kind: "feature", title: `date fixture ${id.slice(0, 8)} zzdatefix`, ...fields };
}

async function dateList(body: Record<string, unknown>, projectKey = DPK) {
  return post<RoadmapListResponse & { error?: string }>(`${broker.url}/roadmap/list`, { project_key: projectKey, ...body });
}

function ids(res: { body: RoadmapListResponse }): string[] {
  return res.body.items.map((i) => i.id).sort();
}

const c1 = crypto.randomUUID();
const c2 = crypto.randomUUID();
const c3 = crypto.randomUUID();

test("date: [since, before) on each axis, boundaries exact, an unknown date matches no range", async () => {
  await importCards(DPK, [
    card(c1, { created_at: "2026-01-10T00:00:00.000Z", content_updated_at: "2026-02-10T00:00:00.000Z" }),
    card(c2, { created_at: "2026-01-11T00:00:00.000Z" }),
    card(c3, {
      created_at: "2026-01-12T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      content_updated_at: "2026-02-12T00:00:00.000Z",
    }),
  ]);
  const mine: string[] = [c1, c2, c3].sort();
  const only = (res: { body: RoadmapListResponse }) => ids(res).filter((id) => mine.includes(id));

  expect(only(await dateList({ date: { field: "created", since: "2026-01-11T00:00:00Z" } }))).toEqual([c2, c3].sort());
  expect(only(await dateList({ date: { field: "created", before: "2026-01-12T00:00:00Z" } }))).toEqual([c1, c2].sort());
  expect(only(await dateList({ date: { field: "created", since: "2026-01-11T00:00:00Z", before: "2026-01-12T00:00:00Z" } }))).toEqual([c2]);
  expect(only(await dateList({ date: { field: "created", since: "2026-01-11T02:00:00+02:00" } }))).toEqual([c2, c3].sort());

  expect(only(await dateList({ date: { field: "updated", since: "2026-02-01T00:00:00Z" } })), "an unknown date is not recent").toEqual(
    [c1, c3].sort()
  );
  expect(only(await dateList({ date: { field: "updated", before: "2026-02-11T00:00:00Z" } })), "an unknown date is not old either").toEqual([c1]);
  expect(only(await dateList({ date: { field: "updated", since: "2026-02-10T00:00:00Z", before: "2026-02-12T00:00:00Z" } }))).toEqual([c1]);
  expect(
    only(await dateList({ date: { field: "updated", since: "2026-01-01T00:00:00Z", before: "2026-01-02T00:00:00Z" } })),
    "the technical updated_at is not the content date"
  ).toEqual([]);
});

test("date: created_at in SQLite form and in ISO form are compared as instants", async () => {
  const sqliteForm = crypto.randomUUID();
  const isoForm = crypto.randomUUID();
  await importCards(DPK, [card(sqliteForm, {}), card(isoForm, { created_at: "2026-03-05T10:00:00.000Z" })]);
  const db = openBrokerDb(broker.dbPath);
  db.run("UPDATE roadmap_items SET created_at = '2026-03-05 10:00:00' WHERE id = ?", [sqliteForm]);
  db.close();

  const res = await dateList({ date: { field: "created", since: "2026-03-05T10:00:00Z", before: "2026-03-05T10:00:01Z" } });
  expect(ids(res).filter((id) => id === sqliteForm || id === isoForm)).toEqual([sqliteForm, isoForm].sort());
  const earlier = await dateList({ date: { field: "created", before: "2026-03-05T10:00:00Z" } });
  expect(ids(earlier)).not.toContain(sqliteForm);
  expect(ids(earlier)).not.toContain(isoForm);
});

test("date: every search branch inherits the clause, and it composes with the other filters", async () => {
  const fts = await dateList({ q: "zzdatefix", date: { field: "created", since: "2026-01-11T00:00:00Z", before: "2026-01-12T00:00:00Z" } });
  expect(ids(fts), "FTS branch").toEqual([c2]);

  const prefix = c2.slice(0, 8);
  const hit = await dateList({ q: prefix, date: { field: "created", since: "2026-01-11T00:00:00Z", before: "2026-01-12T00:00:00Z" } });
  expect(ids(hit), "FTS plus id-prefix branch").toEqual([c2]);
  const miss = await dateList({ q: prefix, date: { field: "created", since: "2026-01-12T00:00:00Z" } });
  expect(ids(miss), "the id-prefix match still obeys the range").toEqual([]);

  const plain = await dateList({ date: { field: "created", since: "2026-01-11T00:00:00Z", before: "2026-01-12T00:00:00Z" } });
  expect(ids(plain), "no-text branch").toEqual([c2]);

  const combined = await dateList({
    q: "zzdatefix",
    kinds: ["feature"],
    statuses: ["idea"],
    date: { field: "updated", since: "2026-02-11T00:00:00Z" },
  });
  expect(ids(combined), "date AND the other criteria").toEqual([c3]);
  const noMatch = await dateList({ q: "zzdatefix", kinds: ["bug"], date: { field: "updated", since: "2026-02-11T00:00:00Z" } });
  expect(ids(noMatch)).toEqual([]);
});

test("date: facets stay computed over the unfiltered reference set", async () => {
  const unfiltered = await dateList({ with_facets: true });
  const filtered = await dateList({ with_facets: true, date: { field: "created", since: "2026-01-12T00:00:00Z", before: "2026-01-13T00:00:00Z" } });
  expect(ids(filtered)).toEqual([c3]);
  expect(filtered.body.facets, "a date range narrows the items, never the facet counts").toEqual(unfiltered.body.facets);
});

test("date: a filter that is not a valid interval is refused 400 with a named reason", async () => {
  const refused: [string, unknown][] = [
    ["unknown axis", { field: "updated_at", since: "1d" }],
    ["not an object", "today"],
    ["no bound", { field: "created" }],
    ["zone-less date", { field: "created", since: "2026-01-11T00:00:00" }],
    ["impossible day", { field: "created", since: "2026-02-30T00:00:00Z" }],
    ["bound of the wrong type", { field: "created", since: 5 }],
    ["since after before", { field: "created", since: "2026-01-12T00:00:00Z", before: "2026-01-11T00:00:00Z" }],
    ["equal bounds", { field: "created", since: "2026-01-12T00:00:00Z", before: "2026-01-12T00:00:00Z" }],
    ["relative out of range", { field: "created", since: "999999999w" }],
  ];
  for (const [what, date] of refused) {
    const res = await dateList({ date });
    expect(res.status, what).toBe(400);
    expect(res.body.error, what).toContain("date");
  }
});

test("date: a card created yesterday and never touched is absent from 'created since 24h'", async () => {
  const pk = "github.com/vocsap/roadmap-date-acceptance-yesterday";
  const id = crypto.randomUUID();
  const yesterday = new Date(Date.now() - 30 * 3_600_000).toISOString();
  await importCards(pk, [card(id, { created_at: yesterday, content_updated_at: yesterday })]);
  const res = await dateList({ date: { field: "created", since: "24h" } }, pk);
  expect(res.status).toBe(200);
  expect(ids(res)).toEqual([]);
  const wider = await dateList({ date: { field: "created", since: "48h" } }, pk);
  expect(ids(wider)).toEqual([id]);
});

test("date: a card created last week and edited today is in 'updated since 24h' but not in 'created since 24h'", async () => {
  const pk = "github.com/vocsap/roadmap-date-acceptance-edited";
  const id = crypto.randomUUID();
  const lastWeek = new Date(Date.now() - 7 * DAY_MS).toISOString();
  await importCards(pk, [card(id, { created_at: lastWeek, content_updated_at: lastWeek })]);
  const edit = await post(`${broker.url}/roadmap/upsert`, { project_key: pk, by: "date-editor", id, description: "enriched today" });
  expect(edit.status).toBe(200);

  expect(ids(await dateList({ date: { field: "updated", since: "24h" } }, pk))).toEqual([id]);
  expect(ids(await dateList({ date: { field: "created", since: "24h" } }, pk))).toEqual([]);
});

test("date: a card only reordered is absent from 'updated since 24h'", async () => {
  const pk = "github.com/vocsap/roadmap-date-acceptance-reorder";
  const id = crypto.randomUUID();
  const lastWeek = new Date(Date.now() - 7 * DAY_MS).toISOString();
  await importCards(pk, [card(id, { status: "planned", created_at: lastWeek, content_updated_at: lastWeek })]);
  const reordered = await post<{ items: RoadmapItem[] }>(
    `${broker.url}/roadmap/reorder`,
    deckAuthored({ project_key: pk, ids: [id], waves: [[id]] })
  );
  expect(reordered.status).toBe(200);
  expect(reordered.body.items.find((i) => i.id === id)!.queue, "the reorder really moved the card").toBe(1);

  expect(ids(await dateList({ date: { field: "updated", since: "24h" } }, pk))).toEqual([]);
  expect(ids(await dateList({ date: { field: "updated", since: "8d" } }, pk))).toEqual([id]);
});

test("date: a card only released by the lock sweep is absent from 'updated since 24h'", async () => {
  const sweeping = await startBroker({
    CLAUDE_PEERS_LOCK_TTL_SEC: "2",
    CLAUDE_PEERS_LOCK_GRACE_SEC: "3600",
    CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
  });
  try {
    const pk = "github.com/vocsap/roadmap-date-acceptance-sweep";
    const claimed = await post<{ item: RoadmapItem }>(`${sweeping.url}/roadmap/upsert`, {
      project_key: pk,
      by: "sweep-victim",
      title: "claimed then abandoned",
      status: "in_progress",
    });
    expect(claimed.body.item.locked).toBe(true);
    const lastWeek = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const db = openBrokerDb(sweeping.dbPath);
    db.run(
      "UPDATE roadmap_items SET created_at = ?, content_updated_at = ?, updated_at = datetime('now', '-60 seconds') WHERE id = ?",
      [lastWeek, lastWeek, claimed.body.item.id]
    );
    db.close();

    const deadline = Date.now() + 12_000;
    let released: RoadmapItem | undefined;
    while (Date.now() < deadline) {
      const res = await post<RoadmapListResponse>(`${sweeping.url}/roadmap/list`, { project_key: pk });
      released = res.body.items.find((i) => i.id === claimed.body.item.id);
      if (released && !released.locked) break;
      await Bun.sleep(300);
    }
    expect(released?.locked, "the sweep released the card").toBe(false);
    expect(released?.status).toBe("planned");

    const recent = await post<RoadmapListResponse>(`${sweeping.url}/roadmap/list`, {
      project_key: pk,
      date: { field: "updated", since: "24h" },
    });
    expect(recent.body.items).toEqual([]);
  } finally {
    await stopBroker(sweeping);
  }
}, 30_000);
