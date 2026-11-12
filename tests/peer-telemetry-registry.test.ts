import { describe, expect, test } from "bun:test";
import {
  createPeerTelemetryImportCache,
  createPeerTelemetryRegistry,
  MAX_CLOSED_DESKS_PER_RUN,
  MAX_CLOSED_LAUNCHES_PER_DESK,
  MAX_REPORTED_TELEMETRY_REFUSALS,
} from "../shared/peer-telemetry-registry.ts";

const RUN = { operatorId: "operator-a", runRef: "run-a", groupId: "group-a" };

const snapshot = {
  model: "Claude Opus 4.6",
  modelId: "claude-opus-4-6",
  contextPct: 42,
  contextWindow: 200_000,
  observedAt: 1_731_234_567_890,
};

function link(instanceToken: string, over: Record<string, string> = {}) {
  return {
    instanceToken,
    operatorId: "operator-a",
    runRef: "run-a",
    groupId: "group-a",
    deskSessionHash: "desk-a",
    capabilityHash: "a".repeat(64),
    ...over,
  };
}

describe("peer telemetry registry", () => {
  test("removes an attributed observation when a second active launch collides", () => {
    const live = new Set(["one", "two"]);
    const registry = createPeerTelemetryRegistry({ isLive: (token) => live.has(token) });
    registry.register(link("one"));
    expect(registry.publish({ ...link("one"), snapshot })).toEqual({ outcome: "updated" });
    expect(registry.telemetryFor("one")).toEqual(snapshot);
    registry.register(link("one"));
    expect(registry.telemetryFor("one")).toEqual(snapshot);

    registry.register(link("two"));
    expect(registry.telemetryFor("one")).toBeNull();
    expect(registry.publish({ ...link("one"), snapshot: { ...snapshot, observedAt: snapshot.observedAt + 1 } })).toEqual({
      outcome: "ambiguous",
    });
  });

  test("a snapshot removed by a collision does not come back when the second launch ends", () => {
    const live = new Set(["one", "two"]);
    const registry = createPeerTelemetryRegistry({ isLive: (token) => live.has(token) });
    registry.register(link("one"));
    registry.publish({ ...link("one"), snapshot });
    registry.register(link("two"));
    live.delete("two");
    expect(registry.telemetryFor("one"), "the observation predates the collision and was dropped by it").toBeNull();
  });

  test("a snapshot on show is hidden while a second member of its launch is live", () => {
    const live = new Set(["one"]);
    const registry = createPeerTelemetryRegistry({ isLive: (token) => live.has(token) });
    registry.register(link("one"));
    registry.register(link("two"));
    expect(registry.publish({ ...link("one"), snapshot })).toEqual({ outcome: "updated" });
    expect(registry.telemetryFor("one")).toEqual(snapshot);

    live.add("two");
    expect(registry.telemetryFor("one"), "two live peers of one launch cannot be told apart").toBeNull();
    expect(registry.telemetryFor("two")).toBeNull();
  });

  test("matches all launch dimensions before assigning a snapshot", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    for (const over of [
      { groupId: "group-b" },
      { runRef: "run-b" },
      { deskSessionHash: "desk-b" },
      { capabilityHash: "b".repeat(64) },
      { operatorId: "operator-b" },
    ]) {
      expect(registry.publish({ ...link("one"), ...over, snapshot })).toEqual({ outcome: "unattributed" });
    }
  });

  test("keeps source time and rejects conflicting or older samples", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    expect(registry.publish({ ...link("one"), snapshot })).toEqual({ outcome: "updated" });
    expect(registry.publish({ ...link("one"), snapshot })).toEqual({ outcome: "unchanged" });
    expect(registry.publish({ ...link("one"), snapshot: { ...snapshot, observedAt: snapshot.observedAt - 1 } })).toEqual({
      outcome: "stale",
    });
    expect(registry.publish({ ...link("one"), snapshot: { ...snapshot, contextPct: 43 } })).toEqual({
      outcome: "conflict",
    });
    expect(registry.telemetryFor("one")).toEqual(snapshot);
  });

  test("stop closes one launch until its run is released", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    registry.publish({ ...link("one"), snapshot });
    registry.stop(link("one"));
    expect(registry.telemetryFor("one")).toBeNull();
    registry.register(link("late"));
    expect(registry.publish({ ...link("late"), snapshot })).toEqual({ outcome: "closed" });
    registry.forgetRun({ operatorId: "operator-a", runRef: "run-a", groupId: "group-a" });
    registry.register(link("new"));
    expect(registry.publish({ ...link("new"), snapshot })).toEqual({ outcome: "updated" });
  });

  test.each([
    ["with an earlier snapshot on show", true],
    ["as the first publication of the launch", false],
  ] as const)("a stop applied while a publication is in flight leaves nothing, %s", async (_label, hadEarlier) => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    if (hadEarlier) registry.publish({ ...link("one"), snapshot });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = gate.then(() =>
      registry.publish({ ...link("one"), snapshot: { ...snapshot, observedAt: snapshot.observedAt + 1 } })
    );
    registry.stop(link("one"));
    release();

    expect(await inFlight, "the publication that settles after the stop is refused").toEqual({ outcome: "closed" });
    expect(registry.telemetryFor("one"), "the late sample must not resurrect the launch").toBeNull();
  });

  test("a publication that settles before a stop is purged by it", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    expect(registry.publish({ ...link("one"), snapshot })).toEqual({ outcome: "updated" });
    registry.stop(link("one"));
    expect(registry.telemetryFor("one")).toBeNull();
  });

  test("a register after a stop recreates neither a snapshot nor a link of the closed launch", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    registry.stop(link("one"));
    registry.register(link("late"));
    expect(registry.publish({ ...link("late"), snapshot })).toEqual({ outcome: "closed" });
    expect(registry.telemetryFor("late")).toBeNull();
    registry.forgetRun({ operatorId: "operator-a", runRef: "run-a", groupId: "group-a" });
    expect(registry.runs(), "neither the stopped launch nor the late one outlives the release of the run").toEqual([]);
  });

  test("a register of a closed launch inserts no link", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    registry.publish({ ...link("one"), snapshot });
    registry.stop(link("other", { deskSessionHash: "desk-b" }));

    registry.register(link("one", { deskSessionHash: "desk-b" }));
    expect(
      registry.telemetryFor("one"),
      "the token left its open launch, so that launch's snapshot is no longer its own"
    ).toBeNull();
  });

  test("a stopped run stays listed after its last peer leaves, so its release reaches the marker", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("one"));
    registry.stop(link("one"));
    registry.forgetOwner("one");
    expect(registry.runs()).toEqual([RUN]);
    expect(registry.publish({ ...link("one"), snapshot })).toEqual({ outcome: "closed" });

    registry.forgetRun(RUN);
    expect(registry.runs()).toEqual([]);
    registry.register(link("again"));
    expect(registry.publish({ ...link("again"), snapshot })).toEqual({ outcome: "updated" });
  });

  test("one desk restarted past the cap closes that desk only, and its late launches stay refused", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    const cap = (n: number) => ({ capabilityHash: String(n).padStart(64, "0") });
    registry.register(link("sibling", { deskSessionHash: "desk-b" }));
    for (let n = 0; n <= MAX_CLOSED_LAUNCHES_PER_DESK; n++) registry.stop(link("t", cap(n)));

    for (const n of [0, MAX_CLOSED_LAUNCHES_PER_DESK, MAX_CLOSED_LAUNCHES_PER_DESK + 1]) {
      expect(
        registry.publish({ ...link("t", cap(n)), snapshot }),
        `launch ${n} of the closed desk is refused`
      ).toEqual({ outcome: "closed" });
    }
    registry.register(link("t", cap(999)));
    expect(registry.telemetryFor("t")).toBeNull();
    expect(
      registry.publish({ ...link("sibling", { deskSessionHash: "desk-b" }), snapshot }),
      "a sibling desk of the same run keeps publishing"
    ).toEqual({ outcome: "updated" });

    registry.forgetRun(RUN);
    registry.register(link("t", cap(0)));
    expect(registry.publish({ ...link("t", cap(0)), snapshot })).toEqual({ outcome: "updated" });
  });

  test("closing one launch on each of more desks than the closed-desk cap keeps the run open", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    registry.register(link("sibling", { deskSessionHash: "desk-sibling" }));
    for (let n = 0; n <= MAX_CLOSED_DESKS_PER_RUN; n++) registry.stop(link("t", { deskSessionHash: `desk-${n}` }));

    expect(
      registry.publish({ ...link("sibling", { deskSessionHash: "desk-sibling" }), snapshot }),
      "desks holding a single closed launch do not close the run"
    ).toEqual({ outcome: "updated" });
    expect(registry.publish({ ...link("t", { deskSessionHash: "desk-0" }), snapshot })).toEqual({
      outcome: "closed",
    });
  });

  test("past the cap of closed desks the whole run closes, and no old launch reopens", () => {
    const registry = createPeerTelemetryRegistry({ isLive: () => true });
    const desk = (n: number) => ({ deskSessionHash: `desk-${n}` });
    for (let n = 0; n <= MAX_CLOSED_DESKS_PER_RUN; n++) {
      for (let c = 0; c <= MAX_CLOSED_LAUNCHES_PER_DESK; c++) {
        registry.stop(link("t", { ...desk(n), capabilityHash: String(c).padStart(64, "0") }));
      }
    }

    expect(
      registry.publish({ ...link("t", desk(0)), snapshot }),
      "the oldest closed launch is still refused"
    ).toEqual({ outcome: "closed" });
    registry.register(link("brand-new", { deskSessionHash: "desk-brand-new" }));
    expect(
      registry.publish({ ...link("brand-new", { deskSessionHash: "desk-brand-new" }), snapshot }),
      "a launch never stopped is refused once the run is closed whole"
    ).toEqual({ outcome: "closed" });
    expect(registry.runs()).toEqual([RUN]);

    registry.forgetRun(RUN);
    registry.register(link("after", { deskSessionHash: "desk-after" }));
    expect(registry.publish({ ...link("after", { deskSessionHash: "desk-after" }), snapshot })).toEqual({
      outcome: "updated",
    });
  });
});

describe("imported peer telemetry", () => {
  test("rejects invalid, stale and conflicting snapshots without changing the visible value", () => {
    const cache = createPeerTelemetryImportCache();
    expect(cache.applyNamespace("upstream", new Map([["token-a", snapshot]])).refusedCount).toBe(0);
    expect(cache.read("upstream", "token-a")).toEqual(snapshot);

    const invalid = cache.applyNamespace("upstream", new Map([["token-a", { ...snapshot, contextPct: 101 }]]));
    expect(invalid).toEqual({ refusedCount: 1, refused: [{ token: "token-a", reason: "invalid" }] });
    expect(cache.read("upstream", "token-a")).toEqual(snapshot);

    const stale = cache.applyNamespace("upstream", new Map([["token-a", { ...snapshot, observedAt: snapshot.observedAt - 1 }]]));
    expect(stale).toEqual({ refusedCount: 1, refused: [{ token: "token-a", reason: "stale" }] });
    const conflict = cache.applyNamespace("upstream", new Map([["token-a", { ...snapshot, contextPct: 43 }]]));
    expect(conflict).toEqual({ refusedCount: 1, refused: [{ token: "token-a", reason: "conflict" }] });
    expect(cache.read("upstream", "token-a")).toEqual(snapshot);
  });

  test("a refused peer freezes only itself: the others advance and absent tokens are retracted", () => {
    const cache = createPeerTelemetryImportCache();
    const at = (observedAt: number) => ({ ...snapshot, observedAt });
    cache.applyNamespace("upstream", new Map([["token-a", at(10)], ["token-b", at(10)], ["token-c", at(10)]]));
    const result = cache.applyNamespace("upstream", new Map([["token-a", at(11)], ["token-b", at(9)]]));
    expect(result).toEqual({ refusedCount: 1, refused: [{ token: "token-b", reason: "stale" }] });
    expect(["the valid peer advances", cache.read("upstream", "token-a")?.observedAt]).toEqual(["the valid peer advances", 11]);
    expect(["the stale peer keeps its own value", cache.read("upstream", "token-b")?.observedAt]).toEqual([
      "the stale peer keeps its own value",
      10,
    ]);
    expect(["an absent token is retracted", cache.read("upstream", "token-c")]).toEqual(["an absent token is retracted", null]);
  });

  test("an invalid entry next to a valid one is refused alone, and a new invalid token stays absent", () => {
    const cache = createPeerTelemetryImportCache();
    cache.applyNamespace("upstream", new Map([["token-b", snapshot]]));
    const result = cache.applyNamespace(
      "upstream",
      new Map<string, unknown>([
        ["token-a", { ...snapshot, observedAt: snapshot.observedAt + 1 }],
        ["token-b", { ...snapshot, contextPct: 101 }],
        ["token-d", { ...snapshot, contextPct: 101 }],
      ])
    );
    expect(result.refusedCount).toBe(2);
    expect(["the valid peer is imported", cache.read("upstream", "token-a")?.observedAt]).toEqual([
      "the valid peer is imported",
      snapshot.observedAt + 1,
    ]);
    expect(["the invalid peer keeps its visible value", cache.read("upstream", "token-b")]).toEqual([
      "the invalid peer keeps its visible value",
      snapshot,
    ]);
    expect(["an invalid peer without a value stays absent", cache.read("upstream", "token-d")]).toEqual([
      "an invalid peer without a value stays absent",
      null,
    ]);
  });

  test("the reported refusals are bounded while the count stays exact", () => {
    const cache = createPeerTelemetryImportCache();
    const directory = new Map<string, unknown>();
    for (let i = 0; i < MAX_REPORTED_TELEMETRY_REFUSALS + 5; i++) directory.set(`token-${i}`, { bad: true });
    const result = cache.applyNamespace("upstream", directory);
    expect([result.refusedCount, result.refused.length]).toEqual([
      MAX_REPORTED_TELEMETRY_REFUSALS + 5,
      MAX_REPORTED_TELEMETRY_REFUSALS,
    ]);
  });

  test("removes absent entries and accepts the same source timestamp after removal", () => {
    const cache = createPeerTelemetryImportCache();
    cache.applyNamespace("upstream", new Map([["token-a", snapshot]]));
    expect(cache.applyNamespace("upstream", new Map()).refusedCount).toBe(0);
    expect(cache.read("upstream", "token-a")).toBeNull();
    expect(cache.applyNamespace("upstream", new Map([["token-a", snapshot]])).refusedCount).toBe(0);
    expect(cache.read("upstream", "token-a")).toEqual(snapshot);
  });

  test("keeps namespace directories isolated", () => {
    const cache = createPeerTelemetryImportCache();
    cache.applyNamespace("upstream", new Map([["token-a", snapshot]]));
    cache.applyNamespace("replica", new Map([["token-b", { ...snapshot, contextPct: null, contextWindow: null }]]));
    cache.applyNamespace("upstream", new Map());
    expect(cache.read("upstream", "token-a")).toBeNull();
    expect(cache.read("replica", "token-b")).toEqual({ ...snapshot, contextPct: null, contextWindow: null });
  });
});
