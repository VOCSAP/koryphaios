// CT1: roadmap directive cards — a 'directive' kind carrying a closed-enum
// `directive` command and a sanitized `target_peer_ids` list. Covers create /
// patch coherence, target sanitization, kind switching, and export/import.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, get, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/directive-test";

type UpsertRes = { item: RoadmapItem };
type ErrRes = { error: string };

async function add(fields: Record<string, unknown>) {
  return post<UpsertRes & ErrRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "deck",
    ...fields,
  });
}

test("non-directive items default directive=null and target_peer_ids=[]", async () => {
  const res = await add({ title: "A plain feature" });
  expect(res.status).toBe(200);
  expect(res.body.item.directive).toBeNull();
  expect(res.body.item.target_peer_ids).toEqual([]);
});

test("create a directive card with command + targets", async () => {
  const res = await add({
    kind: "directive",
    title: "Clear the devs",
    directive: "clear",
    target_peer_ids: ["host-dev", "host-reviewer"],
  });
  expect(res.status).toBe(200);
  expect(res.body.item.kind).toBe("directive");
  expect(res.body.item.directive).toBe("clear");
  expect(res.body.item.target_peer_ids).toEqual(["host-dev", "host-reviewer"]);
});

test("kind 'directive' without a directive is rejected", async () => {
  const res = await add({ kind: "directive", title: "no command" });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("directive");
});

test("a directive on a non-directive kind is rejected", async () => {
  const res = await add({ kind: "feature", title: "bad", directive: "clear" });
  expect(res.status).toBe(400);
});

test("an invalid directive command is rejected", async () => {
  const res = await add({ kind: "directive", title: "bad cmd", directive: "wipe" });
  expect(res.status).toBe(400);
});

test("target_peer_ids are sanitized: reserved, malformed and dupes dropped", async () => {
  // Raw length stays <= 16 here; the over-cap case is covered by its own test.
  const some = Array.from({ length: 6 }, (_, i) => `peer-${i}`);
  const res = await add({
    kind: "directive",
    title: "sanitize",
    directive: "compact",
    target_peer_ids: [
      "good-peer",
      "good-peer", // dup
      "operator", // reserved
      "deck", // reserved
      "Bad Peer!", // malformed
      "",
      ...some,
    ],
  });
  expect(res.status).toBe(200);
  const targets = res.body.item.target_peer_ids;
  expect(targets).not.toContain("operator");
  expect(targets).not.toContain("deck");
  expect(targets).not.toContain("Bad Peer!");
  expect(targets.filter((t) => t === "good-peer").length).toBe(1);
  expect(targets.length).toBeLessThanOrEqual(16);
});

test("target_peer_ids must be an array", async () => {
  const res = await add({
    kind: "directive",
    title: "not an array",
    directive: "clear",
    target_peer_ids: "host-dev",
  });
  expect(res.status).toBe(400);
});

test("more than 16 targets is rejected loudly, not truncated silently", async () => {
  const res = await add({
    kind: "directive",
    title: "too many",
    directive: "clear",
    target_peer_ids: Array.from({ length: 17 }, (_, i) => `peer-${i}`),
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("too many");
});

test("patch: omitted directive/targets keep, set replaces", async () => {
  const created = await add({
    kind: "directive",
    title: "patch me",
    directive: "clear",
    target_peer_ids: ["one"],
  });
  const id = created.body.item.id;

  const renamed = await add({ id, title: "patch me (renamed)" });
  expect(renamed.body.item.directive).toBe("clear");
  expect(renamed.body.item.target_peer_ids).toEqual(["one"]);

  const changed = await add({ id, directive: "magic_compact", target_peer_ids: ["two", "three"] });
  expect(changed.body.item.directive).toBe("magic_compact");
  expect(changed.body.item.target_peer_ids).toEqual(["two", "three"]);
});

test("switching a directive card to a work kind clears directive + targets", async () => {
  const created = await add({
    kind: "directive",
    title: "will become a feature",
    directive: "compact",
    target_peer_ids: ["one"],
  });
  const id = created.body.item.id;
  const switched = await add({ id, kind: "feature" });
  expect(switched.status).toBe(200);
  expect(switched.body.item.kind).toBe("feature");
  expect(switched.body.item.directive).toBeNull();
  expect(switched.body.item.target_peer_ids).toEqual([]);
});

test("import rejects an incoherent directive row (kind directive, no command)", async () => {
  const OTHER = "github.com/vocsap/directive-import-bad";
  const imp = await post<{ imported: number } & ErrRes>(`${broker.url}/roadmap/import`, {
    project_key: OTHER,
    by: "test-peer",
    items: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        kind: "directive",
        title: "no command",
        // directive missing on purpose
      },
    ],
  });
  expect(imp.status).toBe(400);
  expect(imp.body.error).toContain("directive");
});

test("export/import round-trip preserves directive + targets", async () => {
  await add({
    kind: "directive",
    title: "round trip directive",
    directive: "magic_compact",
    target_peer_ids: ["rt-peer"],
  });
  const exported = await get<{ items: RoadmapItem[] }>(
    `${broker.url}/roadmap/export?project_key=${encodeURIComponent(PK)}`
  );
  expect(exported.status).toBe(200);

  const OTHER = "github.com/vocsap/directive-import-target";
  const imp = await post<{ imported: number }>(`${broker.url}/roadmap/import`, {
    project_key: OTHER,
    by: "test-peer",
    items: exported.body.items,
  });
  expect(imp.status).toBe(200);

  const listed = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: OTHER,
    kind: "directive",
    include_archived: true,
  });
  const back = listed.body.items.find((i) => i.title === "round trip directive")!;
  expect(back.directive).toBe("magic_compact");
  expect(back.target_peer_ids).toEqual(["rt-peer"]);
});
