import { expect, test } from "bun:test";
import {
  QUEUE_DELTA_MAX_IDS,
  QUEUE_DELTA_MAX_OPS,
  applyQueueDelta,
  canonicalQueueDelta,
  parseQueueDeltaOps,
  queueDeltaCardIds,
  queueDeltaMovedIds,
  queueToWaves,
  wavesToRanks,
  type QueueDeltaOp,
} from "../shared/roadmap-queue-delta.ts";

function ops(raw: unknown): QueueDeltaOp[] {
  const parsed = parseQueueDeltaOps(raw);
  if (!parsed.ok) throw new Error(`unexpected refusal: ${parsed.error}`);
  return parsed.ops;
}

function apply(waves: string[][], raw: unknown) {
  return applyQueueDelta(waves, ops(raw));
}

const QUEUE = [["a"], ["b", "c"], ["d"]];

test("a queue is read as waves in rank order and ranks are derived from the wave index", () => {
  expect(queueToWaves([{ id: "d", queue: 3 }, { id: "c", queue: 2 }, { id: "a", queue: 1 }, { id: "b", queue: 2 }])).toEqual(QUEUE);
  expect([...wavesToRanks(QUEUE)]).toEqual([["a", 1], ["b", 2], ["c", 2], ["d", 3]]);
});

test("place puts the cards in a NEW wave before or after the wave of an anchor", () => {
  expect(apply(QUEUE, [{ op: "place", ids: ["x"], before: "b" }])).toEqual({ ok: true, waves: [["a"], ["x"], ["b", "c"], ["d"]] });
  expect(apply(QUEUE, [{ op: "place", ids: ["x", "y"], after: "c" }])).toEqual({ ok: true, waves: [["a"], ["b", "c"], ["x", "y"], ["d"]] });
});

test("place at start or end are explicit destinations", () => {
  expect(apply(QUEUE, [{ op: "place", ids: ["x"], at: "start" }])).toEqual({ ok: true, waves: [["x"], ["a"], ["b", "c"], ["d"]] });
  expect(apply(QUEUE, [{ op: "place", ids: ["x"], at: "end" }])).toEqual({ ok: true, waves: [["a"], ["b", "c"], ["d"], ["x"]] });
});

test("moving a card out of a wave is a placement and leaves the rest of the wave in place", () => {
  expect(apply(QUEUE, [{ op: "place", ids: ["b"], at: "end" }])).toEqual({ ok: true, waves: [["a"], ["c"], ["d"], ["b"]] });
});

test("a wave that loses its last card disappears instead of leaving a gap", () => {
  expect(apply(QUEUE, [{ op: "place", ids: ["a"], after: "d" }])).toEqual({ ok: true, waves: [["b", "c"], ["d"], ["a"]] });
});

test("join adds the cards to the wave of the anchor, leaving the wave they came from", () => {
  expect(apply(QUEUE, [{ op: "join", ids: ["d"], anchor: "a" }])).toEqual({ ok: true, waves: [["a", "d"], ["b", "c"]] });
  expect(apply(QUEUE, [{ op: "join", ids: ["x"], anchor: "c" }])).toEqual({ ok: true, waves: [["a"], ["b", "c", "x"], ["d"]] });
});

test("remove unqueues the cards and clear empties the queue, with no ids", () => {
  expect(apply(QUEUE, [{ op: "remove", ids: ["b", "d"] }])).toEqual({ ok: true, waves: [["a"], ["c"]] });
  expect(apply(QUEUE, [{ op: "clear" }])).toEqual({ ok: true, waves: [] });
});

test("operations are interpreted in order, each against the result of the previous one", () => {
  const result = apply(QUEUE, [
    { op: "place", ids: ["x"], at: "start" },
    { op: "join", ids: ["y"], anchor: "x" },
    { op: "place", ids: ["z"], after: "y" },
  ]);
  expect(result).toEqual({ ok: true, waves: [["x", "y"], ["z"], ["a"], ["b", "c"], ["d"]] });
});

test("an anchor that is not queued is refused, never replaced by the end of the queue", () => {
  const refused = apply(QUEUE, [{ op: "place", ids: ["x"], before: "gone" }]);
  expect(refused).toMatchObject({ ok: false, code: "unknown_anchor", op_index: 0, item_id: "gone" });
  expect(apply(QUEUE, [{ op: "place", ids: ["x"], at: "end" }, { op: "join", ids: ["y"], anchor: "gone" }])).toMatchObject({
    ok: false,
    code: "unknown_anchor",
    op_index: 1,
  });
});

test("an anchor that the same operation moves is refused", () => {
  expect(apply(QUEUE, [{ op: "place", ids: ["a", "b"], before: "b" }])).toMatchObject({ ok: false, code: "anchor_moved", item_id: "b" });
  expect(apply(QUEUE, [{ op: "join", ids: ["a"], anchor: "a" }])).toMatchObject({ ok: false, code: "anchor_moved" });
});

test("removing a card that is not queued is refused and names it", () => {
  expect(apply(QUEUE, [{ op: "remove", ids: ["a", "ghost"] }])).toMatchObject({ ok: false, code: "not_queued", item_id: "ghost" });
});

test("a queue of 1200 cards is rearranged whole, with no cap on the queue itself", () => {
  const big = Array.from({ length: 1200 }, (_, i) => [`c${i}`]);
  const result = applyQueueDelta(big, ops([{ op: "place", ids: ["c1199"], at: "start" }]));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.waves).toHaveLength(1200);
  expect(result.waves[0]).toEqual(["c1199"]);
  expect(result.waves[1]).toEqual(["c0"]);
});

test("the input waves are never mutated", () => {
  const input = [["a"], ["b"]];
  applyQueueDelta(input, ops([{ op: "join", ids: ["b"], anchor: "a" }]));
  expect(input).toEqual([["a"], ["b"]]);
});

test.each([
  ["not an array", "nope"],
  ["an empty list", []],
  ["a non-object operation", ["place"]],
  ["an unknown operation", [{ op: "swap", ids: ["a"] }]],
  ["place without a destination", [{ op: "place", ids: ["a"] }]],
  ["place with two destinations", [{ op: "place", ids: ["a"], before: "b", after: "c" }]],
  ["place with an unknown destination word", [{ op: "place", ids: ["a"], at: "middle" }]],
  ["an unknown key", [{ op: "remove", ids: ["a"], force: true }]],
  ["empty ids", [{ op: "remove", ids: [] }]],
  ["a repeated id", [{ op: "remove", ids: ["a", "a"] }]],
  ["a padded id", [{ op: "remove", ids: [" a"] }]],
  ["a non-string id", [{ op: "remove", ids: [7] }]],
  ["join without an anchor", [{ op: "join", ids: ["a"] }]],
  ["clear with an argument", [{ op: "clear", ids: ["a"] }]],
])("the parser refuses %s", (_name, raw) => {
  expect(parseQueueDeltaOps(raw)).toMatchObject({ ok: false, code: "malformed" });
});

test("the parser bounds the delta itself, by operations and by cards named", () => {
  const manyOps = Array.from({ length: QUEUE_DELTA_MAX_OPS + 1 }, () => ({ op: "clear" }));
  expect(parseQueueDeltaOps(manyOps)).toMatchObject({ ok: false, code: "too_large" });
  expect(parseQueueDeltaOps(manyOps.slice(0, QUEUE_DELTA_MAX_OPS)).ok).toBe(true);
  const ids = Array.from({ length: QUEUE_DELTA_MAX_IDS + 1 }, (_, i) => `c${i}`);
  expect(parseQueueDeltaOps([{ op: "remove", ids }])).toMatchObject({ ok: false, code: "too_large" });
  expect(parseQueueDeltaOps([{ op: "remove", ids: ids.slice(0, QUEUE_DELTA_MAX_IDS) }]).ok).toBe(true);
});

test("the cards an envelope names include its anchors, and the moved ones exclude them", () => {
  const list = ops([
    { op: "place", ids: ["x"], before: "b" },
    { op: "join", ids: ["y"], anchor: "a" },
    { op: "remove", ids: ["d"] },
    { op: "clear" },
  ]);
  expect(queueDeltaCardIds(list).sort()).toEqual(["a", "b", "d", "x", "y"]);
  expect(queueDeltaMovedIds(list).sort()).toEqual(["d", "x", "y"]);
});

test("the canonical text ignores key order and changes with any part of the meaning", () => {
  const a = canonicalQueueDelta("p", 3, ops([{ op: "place", ids: ["x"], before: "b" }]));
  const reordered = canonicalQueueDelta("p", 3, ops([{ before: "b", ids: ["x"], op: "place" }]));
  expect(reordered).toBe(a);
  expect(canonicalQueueDelta("p", 4, ops([{ op: "place", ids: ["x"], before: "b" }]))).not.toBe(a);
  expect(canonicalQueueDelta("q", 3, ops([{ op: "place", ids: ["x"], before: "b" }]))).not.toBe(a);
  expect(canonicalQueueDelta("p", 3, ops([{ op: "place", ids: ["x"], after: "b" }]))).not.toBe(a);
  expect(canonicalQueueDelta("p", 3, ops([{ op: "place", ids: ["x", "y"], before: "b" }]))).not.toBe(a);
});
