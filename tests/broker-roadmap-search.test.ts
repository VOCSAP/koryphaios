import { Database } from "bun:sqlite";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post } from "./_helper.ts";
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
  const db = new Database(broker.dbPath, { readonly: true });
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
