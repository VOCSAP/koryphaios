// The three-way merge behind the `merge_reopen` resolution, exercised as the
// pure function the broker calls: which side wins per field, what the reopen
// rule does to status/deleted_at, and the no-common-ancestor case.

import { test, expect } from "bun:test";
import {
  contentEquals,
  isSweepOnlyStatusChange,
  mergeReopen,
  parseSyncContent,
  pickSyncContent,
} from "../shared/roadmap-sync.ts";
import { ROADMAP_SYNC_CONTENT_FIELDS, type RoadmapSyncContent } from "../shared/types.ts";

function content(overrides: Partial<RoadmapSyncContent> = {}): RoadmapSyncContent {
  return {
    kind: "feature",
    title: "base title",
    description: "base description",
    rationale: "base rationale",
    context: "base context",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    tags: ["a"],
    depends_on: [],
    deleted_at: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
    ...overrides,
  };
}

test("pickSyncContent carries exactly the fifteen content fields, and copies the lists", () => {
  const source = content({ tags: ["x", "y"] });
  const picked = pickSyncContent(source);
  expect(Object.keys(picked).sort()).toEqual([...ROADMAP_SYNC_CONTENT_FIELDS].sort());
  picked.tags.push("mutated");
  expect([
    "pickSyncContent must snapshot the lists, not alias the caller's arrays",
    source.tags,
  ]).toEqual(["pickSyncContent must snapshot the lists, not alias the caller's arrays", ["x", "y"]]);
});

test("contentEquals compares list fields element-wise, not by reference", () => {
  expect(contentEquals(content({ tags: ["a", "b"] }), content({ tags: ["a", "b"] }))).toBe(true);
  expect(contentEquals(content({ tags: ["a", "b"] }), content({ tags: ["b", "a"] }))).toBe(false);
  expect(contentEquals(content(), content({ inactive: true }))).toBe(false);
});

test("merge_reopen: a field only the local side changed keeps the local value", () => {
  const base = content();
  const local = content({ description: "local wrote this" });
  const remote = content();
  const merged = mergeReopen(base, local, remote);
  expect(merged.description).toBe("local wrote this");
});

test("merge_reopen: a field only the remote side changed takes the remote value", () => {
  const base = content();
  const local = content();
  const remote = content({ rationale: "remote wrote this", tags: ["a", "remote"] });
  const merged = mergeReopen(base, local, remote);
  expect(merged.rationale).toBe("remote wrote this");
  expect(merged.tags).toEqual(["a", "remote"]);
});

test("merge_reopen: when BOTH sides changed one field, the local side wins (documented rule)", () => {
  const base = content();
  const local = content({ title: "local title" });
  const remote = content({ title: "remote title" });
  expect([
    "both sides changed the field: the replica's own value is the one kept",
    mergeReopen(base, local, remote).title,
  ]).toEqual(["both sides changed the field: the replica's own value is the one kept", "local title"]);
});

test("merge_reopen: the card comes back open -- in_progress if either side was, else planned", () => {
  const base = content({ status: "planned" });
  const workedRemotely = mergeReopen(base, content({ status: "done" }), content({ status: "in_progress" }));
  expect(workedRemotely.status).toBe("in_progress");
  const workedLocally = mergeReopen(base, content({ status: "in_progress" }), content({ status: "archived" }));
  expect(workedLocally.status).toBe("in_progress");
  const neither = mergeReopen(base, content({ status: "done" }), content({ status: "archived" }));
  expect(neither.status).toBe("planned");
});

test("merge_reopen: the archive stamp is cleared even when both sides carried one", () => {
  const merged = mergeReopen(
    content(),
    content({ status: "archived", deleted_at: "2026-01-01T00:00:00.000Z" }),
    content({ status: "archived", deleted_at: "2026-02-02T00:00:00.000Z" })
  );
  expect([
    "a reopened card carries no archive stamp",
    merged.deleted_at,
    merged.status,
  ]).toEqual(["a reopened card carries no archive stamp", null, "planned"]);
});

test("merge_reopen: with no common ancestor every field counts as locally changed", () => {
  const local = content({ title: "offline title", description: "offline description" });
  const remote = content({ title: "upstream title", description: "upstream description" });
  const merged = mergeReopen(null, local, remote);
  expect(merged.title).toBe("offline title");
  expect(merged.description).toBe("offline description");
});

test("merge_reopen never mutates its inputs", () => {
  const base = content();
  const local = content({ tags: ["local"] });
  const remote = content({ tags: ["remote"], description: "remote description" });
  mergeReopen(base, local, remote);
  expect(local.description).toBe("base description");
  expect(remote.tags).toEqual(["remote"]);
});

test("parseSyncContent refuses a partial or malformed snapshot instead of half-filling one", () => {
  const complete = JSON.stringify(content({ title: "stored" }));
  expect(parseSyncContent(complete)?.title).toBe("stored");
  expect(parseSyncContent(null)).toBeNull();
  expect(parseSyncContent("not json")).toBeNull();
  const { title: _dropped, ...withoutTitle } = content();
  expect([
    "a snapshot missing a content field is unusable as a merge base",
    parseSyncContent(JSON.stringify(withoutTitle)),
  ]).toEqual(["a snapshot missing a content field is unusable as a merge base", null]);
  const listNotArray = { ...content(), tags: "a,b" };
  expect(parseSyncContent(JSON.stringify(listNotArray))).toBeNull();
});

test("the sweep auto-resolution reads the CONTENT: only a lone in_progress -> planned move qualifies", () => {
  const base = content({ status: "in_progress" });
  expect([
    "the sweep's own signature -- one status field, in_progress back to planned",
    isSweepOnlyStatusChange(base, content({ status: "planned" })),
  ]).toEqual(["the sweep's own signature -- one status field, in_progress back to planned", true]);
  expect([
    "a real upstream edit riding under the same status move is NOT auto-resolvable",
    isSweepOnlyStatusChange(base, content({ status: "planned", rationale: "a human wrote this" })),
  ]).toEqual([
    "a real upstream edit riding under the same status move is NOT auto-resolvable",
    false,
  ]);
  expect([
    "any other status transition is an ordinary divergence",
    isSweepOnlyStatusChange(base, content({ status: "done" })),
    isSweepOnlyStatusChange(content({ status: "planned" }), content({ status: "in_progress" })),
  ]).toEqual(["any other status transition is an ordinary divergence", false, false]);
  expect([
    "a card with no common ancestor has nothing to measure the sweep against",
    isSweepOnlyStatusChange(null, content({ status: "planned" })),
  ]).toEqual([
    "a card with no common ancestor has nothing to measure the sweep against",
    false,
  ]);
  expect([
    "an upstream that came back to the base changed nothing to arbitrate",
    isSweepOnlyStatusChange(base, content({ status: "in_progress" })),
  ]).toEqual(["an upstream that came back to the base changed nothing to arbitrate", true]);
});
