import { test, expect } from "bun:test";
import {
  assignInProgress,
  markDirectiveDone,
  requestOperatorStop,
  unqueueDispatched,
  writeGuarded,
  type GuardedWriteIo,
  type GuardedWriteResult
} from "../desktop/src/main/roadmap-guarded-write.ts";
import { RoadmapRequestError } from "../desktop/src/main/roadmap-service.ts";
import { formatRoadmapStaleSaveError } from "../shared/roadmap-append.ts";
import type { RoadmapItem, RoadmapUpsertFields } from "../desktop/src/shared/types";

function card(over: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id: "c1",
    project_key: "k",
    kind: "feature",
    title: "t",
    description: "",
    rationale: "",
    context: "",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    triage: null,
    tags: [],
    depends_on: [],
    created_by: "x",
    updated_by: "x",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    content_updated_at: null,
    content_rev: 5,
    deleted_at: null,
    queue: 1,
    locked: false,
    locked_by: null,
    locked_at: null,
    locked_group: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
    sync_state: "clean",
    lock_scope: null,
    lock_contested_by: [],
    ...over
  } as RoadmapItem;
}

function casStore(initial: RoadmapItem, opts: { alwaysStale?: boolean; failWith?: Error } = {}) {
  let current: RoadmapItem | null = { ...initial };
  const writes: RoadmapUpsertFields[] = [];
  const traces: string[] = [];
  let reads = 0;
  const io: GuardedWriteIo = {
    read: async () => {
      reads++;
      return current;
    },
    write: async (fields) => {
      writes.push(fields);
      if (writes.length > 5) throw new Error("runaway retry");
      if (opts.failWith) throw opts.failWith;
      const stale = opts.alwaysStale || (fields.expected_content_rev !== undefined && fields.expected_content_rev !== current?.content_rev);
      if (stale) throw new RoadmapRequestError(formatRoadmapStaleSaveError("the card changed"), 409, "/roadmap/upsert");
      const { id: _id, expected_content_rev: _token, ...rest } = fields;
      current = { ...current!, ...(rest as Partial<RoadmapItem>), content_rev: (current!.content_rev ?? 0) + 1 };
      return current;
    },
    trace: (line) => traces.push(line)
  };
  return {
    io,
    writes,
    traces,
    reads: () => reads,
    current: () => current,
    concurrently: (patch: Partial<RoadmapItem>) => {
      current = { ...current!, ...patch, content_rev: (current!.content_rev ?? 0) + 1 };
    },
    disappears: () => {
      current = null;
    }
  };
}

type Site = {
  name: string;
  run: (snapshot: RoadmapItem, io: GuardedWriteIo) => Promise<GuardedWriteResult>;
  start: Partial<RoadmapItem>;
  applied: Partial<RoadmapItem>;
};

const SITES: Site[] = [
  { name: "directive done-write", run: markDirectiveDone, start: { kind: "directive", status: "planned" }, applied: { status: "done", queue: null } },
  { name: "dispatch unqueue", run: unqueueDispatched, start: { status: "idea" }, applied: { status: "planned", queue: null } },
  { name: "assignment", run: assignInProgress, start: { status: "planned" }, applied: { status: "in_progress", queue: null } },
  { name: "operator stop", run: requestOperatorStop, start: { status: "in_progress", locked: true, locked_by: "p1" }, applied: { status: "planned", locked: false } }
];

for (const site of SITES) {
  const snapshot = () => card(site.start);

  test(`${site.name}: the write carries the content_rev that was read`, async () => {
    const store = casStore(snapshot());
    const result = await site.run(snapshot(), store.io);
    expect(result.written).toBe(true);
    expect(store.writes.map((w) => w.expected_content_rev)).toEqual([5]);
    expect(store.current()).toMatchObject(site.applied);
  });

  for (const closed of ["done", "archived"] as const) {
    test(`${site.name}: a card turned ${closed} meanwhile keeps that state, one refused write, no retry`, async () => {
      const store = casStore(snapshot());
      store.concurrently({ status: closed });
      const result = await site.run(snapshot(), store.io);
      expect(result).toEqual({ written: false, reason: "ineligible" });
      expect(store.writes).toHaveLength(1);
      expect(store.current()?.status).toBe(closed);
      expect(store.traces).toHaveLength(1);
      expect(store.traces[0]).toContain("c1");
    });
  }

  test(`${site.name}: a card that left the list meanwhile is skipped as gone`, async () => {
    const store = casStore(snapshot());
    store.concurrently({ title: "edited" });
    store.disappears();
    const result = await site.run(snapshot(), store.io);
    expect(result).toEqual({ written: false, reason: "gone" });
    expect(store.writes).toHaveLength(1);
    expect(store.traces).toHaveLength(1);
  });

  test(`${site.name}: an edit that leaves the card eligible applies the decision once, with the fresh token`, async () => {
    const store = casStore(snapshot());
    store.concurrently({ title: "renamed" });
    const result = await site.run(snapshot(), store.io);
    expect(result.written).toBe(true);
    expect(store.writes.map((w) => w.expected_content_rev)).toEqual([5, 6]);
    expect(store.current()).toMatchObject({ title: "renamed", ...site.applied });
    expect(store.traces).toEqual([]);
  });

  test(`${site.name}: a second stale save is thrown after exactly two writes`, async () => {
    const store = casStore(snapshot(), { alwaysStale: true });
    const failure = await site.run(snapshot(), store.io).then(
      () => null,
      (e: unknown) => e
    );
    expect(failure).toBeInstanceOf(RoadmapRequestError);
    expect((failure as RoadmapRequestError).status).toBe(409);
    expect(store.writes).toHaveLength(2);
  });
}

test("the retry recomputes the decision from the fresh card, not from the snapshot", async () => {
  const store = casStore(card({ status: "idea" }));
  store.concurrently({ status: "in_progress" });
  const result = await unqueueDispatched(card({ status: "idea" }), store.io);
  expect(result.written).toBe(true);
  expect(store.writes[1]).toMatchObject({ queue: null, status: "in_progress" });
});

test("a stop is skipped once the card left the status it was read in, without a second write", async () => {
  const store = casStore(card({ status: "in_progress", locked: true }));
  store.concurrently({ status: "planned", locked: false });
  const result = await requestOperatorStop(card({ status: "in_progress", locked: true }), store.io);
  expect(result).toEqual({ written: false, reason: "ineligible" });
  expect(store.writes).toHaveLength(1);
});

test("a 409 that is not a stale save is rethrown without a re-read", async () => {
  const other = new RoadmapRequestError("unknown roadmap item", 409, "/roadmap/upsert");
  const store = casStore(card(), { failWith: other });
  await expect(markDirectiveDone(card(), store.io)).rejects.toBe(other);
  expect(store.reads()).toBe(0);
  expect(store.writes).toHaveLength(1);
});

test("a card read from an older broker (no content_rev) is written without a token", async () => {
  const store = casStore(card({ content_rev: undefined }));
  await markDirectiveDone(card({ content_rev: undefined }), store.io);
  expect(store.writes).toHaveLength(1);
  expect("expected_content_rev" in store.writes[0]!).toBe(false);
});

test("writeGuarded: a decision that is null on the snapshot writes nothing and reads nothing", async () => {
  const store = casStore(card());
  const result = await writeGuarded("probe", card(), () => null, store.io);
  expect(result).toEqual({ written: false, reason: "ineligible" });
  expect(store.writes).toEqual([]);
  expect(store.reads()).toBe(0);
});
