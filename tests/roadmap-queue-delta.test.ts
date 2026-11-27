import { expect, test } from "bun:test";
import {
  QUEUE_DELTA_MAX_IDS,
  QUEUE_DELTA_MAX_OPS,
  applyLotQueueDelta,
  applyQueueDelta,
  canonicalLotQueueDelta,
  canonicalQueueDelta,
  diffToDeltaOps,
  fitsQueueDeltaLimits,
  lotQueueDeltaCardIds,
  lotQueueDeltaMovedIds,
  parseLotQueueDelta,
  parseQueueDeltaOps,
  queueDeltaCardIds,
  queueDeltaMovedIds,
  queueToWaves,
  rankMoveToDeltaOps,
  wavesToRanks,
  type LotQueueDeltaOp,
  type LotQueueDeltaState,
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

// A receipt keeps the hash of this text: a byte that moves turns an in-flight retry into mutation_reused.
test("the canonical text of a v1 envelope keeps its exact bytes", () => {
  const envelope = ops([
    { before: "b", ids: ["x"], op: "place" },
    { op: "place", after: "b", ids: ["y", "z"] },
    { ids: ["w"], op: "place", at: "end" },
    { anchor: "a", op: "join", ids: ["v"] },
    { ids: ["u"], op: "remove" },
    { op: "clear" },
  ]);

  expect(canonicalQueueDelta("github.com/o/r", 7, envelope)).toBe(
    '{"v":1,"project_key":"github.com/o/r","expected_queue_rev":7,"ops":[' +
      '{"op":"place","ids":["x"],"before":"b"},' +
      '{"op":"place","ids":["y","z"],"after":"b"},' +
      '{"op":"place","ids":["w"],"at":"end"},' +
      '{"op":"join","ids":["v"],"anchor":"a"},' +
      '{"op":"remove","ids":["u"]},' +
      '{"op":"clear"}]}'
  );
});

const at = (lot_id: string, expected_queue_rev = 0) => ({ lot_id, expected_queue_rev });

function lotOps(raw: unknown[], lots: string[]): LotQueueDeltaOp[] {
  const parsed = parseLotQueueDelta(lots.map((lot) => at(lot)), raw);
  if (!parsed.ok) throw new Error(`unexpected refusal: ${parsed.error}`);
  return parsed.ops;
}

const move = (ids: string[], from: string | null, to: string | null) => ({ op: "move_members", ids, from, to });

test("a v2 envelope reads queue operations scoped to a lot and moves between lots", () => {
  const raw = [{ op: "place", lot_id: "A", ids: ["x"], at: "end" }, move(["y"], "B", null), { op: "clear", lot_id: "C" }];

  expect(parseLotQueueDelta([at("C", 3), at("A", 1), at("B", 2)], raw)).toEqual({
    ok: true,
    lots: [at("C", 3), at("A", 1), at("B", 2)],
    ops: raw as LotQueueDeltaOp[],
  });
});

test.each([
  ["no operation", [at("A")], []],
  ["an operation without its lot", [at("A")], [{ op: "remove", ids: ["x"] }]],
  ["an operation with a padded lot", [at("A")], [{ op: "remove", lot_id: " A", ids: ["x"] }]],
  ["an unknown key on a queue operation", [at("A")], [{ op: "remove", lot_id: "A", ids: ["x"], force: true }]],
  ["a move without a destination", [at("A")], [{ op: "move_members", ids: ["x"], from: "A" }]],
  ["a move without a source", [at("A")], [{ op: "move_members", ids: ["x"], to: "A" }]],
  ["a move onto its source", [at("A")], [move(["x"], "A", "A")]],
  ["a move naming a lot twice", [at("A"), at("B")], [{ ...move(["x"], "A", "B"), lot_id: "A" }]],
  ["a move of no card", [at("A"), at("B")], [move([], "A", "B")]],
  ["no list of lots", undefined, [{ op: "clear", lot_id: "A" }]],
  ["a touched lot left out", [at("A")], [move(["x"], "A", "B")]],
  ["a lot the operations do not touch", [at("A"), at("B")], [{ op: "clear", lot_id: "A" }]],
  ["a lot listed twice", [at("A"), at("A")], [{ op: "clear", lot_id: "A" }]],
  ["a negative revision", [at("A", -1)], [{ op: "clear", lot_id: "A" }]],
  ["a missing revision", [{ lot_id: "A" }], [{ op: "clear", lot_id: "A" }]],
  ["an unknown key on a lot", [{ ...at("A"), rev: 0 }], [{ op: "clear", lot_id: "A" }]],
])("the v2 parser refuses %s", (_name, lots, raw) => {
  expect(parseLotQueueDelta(lots, raw)).toMatchObject({ ok: false, code: "malformed" });
});

test("the v2 parser names the operation that lacks its lot", () => {
  const raw = [{ op: "clear", lot_id: "A" }, { op: "clear" }];

  expect(parseLotQueueDelta([at("A")], raw)).toMatchObject({ ok: false, code: "malformed", op_index: 1 });
});

test("the v2 parser bounds the whole envelope, by operations and by cards named across them", () => {
  const clears = Array.from({ length: QUEUE_DELTA_MAX_OPS + 1 }, () => ({ op: "clear", lot_id: "A" }));
  expect(parseLotQueueDelta([at("A")], clears)).toMatchObject({ ok: false, code: "too_large" });
  const half = (prefix: string) => Array.from({ length: QUEUE_DELTA_MAX_IDS / 2 + 1 }, (_, i) => `${prefix}${i}`);
  const split = [{ op: "remove", lot_id: "A", ids: half("a") }, move(half("b"), "A", null)];
  expect(parseLotQueueDelta([at("A")], split)).toMatchObject({ ok: false, code: "too_large", op_index: 1 });
});

test("the v2 canonical text keeps its bytes, whatever the order of the lots and of the keys", () => {
  const raw = [{ ids: ["x"], at: "end", lot_id: "B", op: "place" }, { to: "B", from: "A", ids: ["y"], op: "move_members" }];
  const parsed = lotOps(raw, ["A", "B"]);

  const text = canonicalLotQueueDelta("p", [at("B", 4), at("A", 2)], parsed);

  expect(text).toBe(
    '{"v":2,"project_key":"p","lots":[{"lot_id":"A","expected_queue_rev":2},{"lot_id":"B","expected_queue_rev":4}],' +
      '"ops":[{"lot_id":"B","op":"place","ids":["x"],"at":"end"},{"op":"move_members","ids":["y"],"from":"A","to":"B"}]}'
  );
  expect(canonicalLotQueueDelta("p", [at("A", 2), at("B", 4)], parsed)).toBe(text);
});

const lotState = (): LotQueueDeltaState => ({
  membership: new Map<string, string | null>([["a1", "A"], ["a2", "A"], ["b1", "B"], ["free", null]]),
  waves: new Map([["A", [["a1"], ["a2"]]], ["B", [["b1"]]]]),
});

test("each lot's queue moves alone, and a moved card leaves its source queue unranked", () => {
  const start = lotState();
  const result = applyLotQueueDelta(start, lotOps([{ op: "place", lot_id: "A", ids: ["a2"], before: "a1" }, move(["a1"], "A", "B"), move(["free"], null, "B"), { op: "join", lot_id: "B", ids: ["free"], anchor: "b1" }], ["A", "B"]));

  if (!result.ok) throw new Error(result.error);
  expect(Object.fromEntries(result.waves)).toEqual({ A: [["a2"]], B: [["b1", "free"]] });
  expect(Object.fromEntries(result.membership)).toEqual({ a1: "B", a2: "A", b1: "B", free: "B" });
  expect(start, "the input state is never mutated").toEqual(lotState());
});

test("a card leaves every lot by a move to none", () => {
  const result = applyLotQueueDelta(lotState(), lotOps([move(["b1"], "B", null)], ["B"]));

  if (!result.ok) throw new Error(result.error);
  expect([result.membership.get("b1"), result.waves.get("B")]).toEqual([null, []]);
});

test.each([
  ["placing a card of another lot", [{ op: "place", lot_id: "B", ids: ["a1"], at: "end" }], ["B"], "lot_mismatch", "a1"],
  ["placing a card in no lot", [{ op: "place", lot_id: "A", ids: ["free"], at: "end" }], ["A"], "lot_mismatch", "free"],
  ["removing a card of another lot", [{ op: "remove", lot_id: "A", ids: ["b1"] }], ["A"], "lot_mismatch", "b1"],
  ["a move naming the wrong source", [move(["a1"], "B", "A")], ["A", "B"], "lot_mismatch", "a1"],
  ["an anchor queued in another lot", [{ op: "join", lot_id: "A", ids: ["a1"], anchor: "b1" }], ["A"], "unknown_anchor", "b1"],
])("the v2 application refuses %s", (_name, raw, lots, code, item_id) => {
  expect(applyLotQueueDelta(lotState(), lotOps(raw, lots))).toMatchObject({ ok: false, code, item_id, op_index: 0 });
});

test("a v2 refusal names the operation that failed", () => {
  const parsed = lotOps([{ op: "clear", lot_id: "B" }, { op: "join", lot_id: "A", ids: ["a1"], anchor: "gone" }], ["A", "B"]);

  expect(applyLotQueueDelta(lotState(), parsed)).toMatchObject({ ok: false, code: "unknown_anchor", op_index: 1 });
});

test("the cards a v2 envelope names include anchors and moved members, the moved ones exclude anchors", () => {
  const parsed = lotOps([{ op: "join", lot_id: "A", ids: ["x"], anchor: "k" }, move(["y"], "A", null)], ["A"]);

  expect(lotQueueDeltaCardIds(parsed).sort()).toEqual(["k", "x", "y"]);
  expect(lotQueueDeltaMovedIds(parsed).sort()).toEqual(["x", "y"]);
});

const sortedWaves = (waves: readonly (readonly string[])[]): string[][] => waves.map((wave) => [...wave].sort());

function applied(before: string[][], after: string[][]): string[][] {
  const result = applyQueueDelta(before, diffToDeltaOps(before, after));
  if (!result.ok) throw new Error(`the diff was refused: ${result.error}`);
  return sortedWaves(result.waves);
}

test("a swap in a queue of five names one card out of the five", () => {
  const before = [["a"], ["b"], ["c"], ["d"], ["e"]];
  const after = [["b"], ["a"], ["c"], ["d"], ["e"]];
  const delta = diffToDeltaOps(before, after);
  expect(delta.map((op) => (op.op === "clear" ? [] : op.ids)).flat()).toHaveLength(1);
  expect(delta).toHaveLength(1);
  expect(applied(before, after)).toEqual(after);
});

test("a swap replayed on an upstream queue holding a card the author never saw leaves that card where it was", () => {
  const delta = diffToDeltaOps([["a"], ["b"]], [["b"], ["a"]]);
  const upstream = applyQueueDelta([["x"], ["a"], ["b"], ["y"]], delta);
  expect(upstream).toEqual({ ok: true, waves: [["x"], ["b"], ["a"], ["y"]] });
});

test("the diff leaves a queue that did not change with nothing to say", () => {
  expect(diffToDeltaOps(QUEUE, QUEUE)).toEqual([]);
  expect(diffToDeltaOps([], [])).toEqual([]);
});

test("emptying a queue removes the cards it held, and filling an empty one places the waves in order", () => {
  expect(diffToDeltaOps(QUEUE, [])).toEqual([{ op: "remove", ids: ["a", "b", "c", "d"] }]);
  expect(applied([], [["x", "y"], ["z"]])).toEqual([["x", "y"], ["z"]]);
  expect(diffToDeltaOps([], [["x", "y"], ["z"]])).toEqual([
    { op: "place", ids: ["x", "y"], at: "start" },
    { op: "place", ids: ["z"], after: "x" },
  ]);
});

test("a card that joins a wave of cards that stay is a join on one of them", () => {
  expect(diffToDeltaOps([["a"], ["b"], ["c"]], [["a", "c"], ["b"]])).toEqual([{ op: "join", ids: ["c"], anchor: "a" }]);
});

test("a wave split in two moves the smaller part and keeps the wave in place", () => {
  const before = [["a", "b", "c"], ["d"]];
  const after = [["a", "b"], ["c"], ["d"]];
  expect(applied(before, after)).toEqual(after);
  expect(queueDeltaMovedIds(diffToDeltaOps(before, after))).toEqual(["c"]);
});

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function randomWaves(next: () => number, pool: string[]): string[][] {
  const picked = pool.filter(() => next() < 0.8).sort(() => next() - 0.5);
  const waves: string[][] = [];
  for (const id of picked) {
    if (waves.length > 0 && next() < 0.3) waves[waves.length - 1]!.push(id);
    else waves.push([id]);
  }
  return waves;
}

/** The most cards that can keep their place: pairwise, they compare the same way in both queues. */
function mostThatCanStay(before: string[][], after: string[][]): number {
  const [b, a] = [wavesToRanks(before), wavesToRanks(after)];
  const common = [...b.keys()].filter((id) => a.has(id));
  let best = 0;
  for (let mask = 0; mask < 1 << common.length; mask++) {
    const subset = common.filter((_, i) => (mask & (1 << i)) !== 0);
    const consistent = subset.every((x) =>
      subset.every((y) => Math.sign(b.get(x)! - b.get(y)!) === Math.sign(a.get(x)! - a.get(y)!))
    );
    if (consistent) best = Math.max(best, subset.length);
  }
  return best;
}

test("on random queues the diff rebuilds the target and names exactly the cards that cannot stay", () => {
  const next = rng(20251120);
  const pool = ["a", "b", "c", "d", "e", "f", "g"];
  for (let round = 0; round < 400; round++) {
    const before = randomWaves(next, pool);
    const after = randomWaves(next, pool);
    expect(applied(before, after), `round ${round}: ${JSON.stringify([before, after])}`).toEqual(sortedWaves(after));
    const [b, a] = [wavesToRanks(before), wavesToRanks(after)];
    const common = [...b.keys()].filter((id) => a.has(id)).length;
    const added = [...a.keys()].filter((id) => !b.has(id)).length;
    const named = diffToDeltaOps(before, after)
      .flatMap((op) => (op.op === "clear" || op.op === "remove" ? [] : op.ids))
      .length;
    expect(named, `round ${round}: ${JSON.stringify([before, after])}`).toBe(common - mostThatCanStay(before, after) + added);
  }
});

test("operations fit one envelope up to the operation and card limits, and not past them", () => {
  const place = (n: number): QueueDeltaOp => ({ op: "place", ids: [`c${n}`], at: "end" });
  expect(fitsQueueDeltaLimits(Array.from({ length: QUEUE_DELTA_MAX_OPS }, (_, i) => place(i)))).toBe(true);
  expect(fitsQueueDeltaLimits(Array.from({ length: QUEUE_DELTA_MAX_OPS + 1 }, (_, i) => place(i)))).toBe(false);
  const wide: QueueDeltaOp = { op: "remove", ids: Array.from({ length: QUEUE_DELTA_MAX_IDS }, (_, i) => `c${i}`) };
  expect(fitsQueueDeltaLimits([wide])).toBe(true);
  expect(fitsQueueDeltaLimits([wide, place(0)])).toBe(false);
});

test("a rank written on a card joins the wave that holds it, or goes to the end of the queue", () => {
  const rows = [{ id: "a", queue: 1 }, { id: "b", queue: 2 }, { id: "c", queue: 2 }, { id: "d", queue: 3 }];
  expect(rankMoveToDeltaOps(rows, "d", 2)).toEqual([{ op: "join", ids: ["d"], anchor: "b" }]);
  expect(rankMoveToDeltaOps(rows, "x", 3)).toEqual([{ op: "join", ids: ["x"], anchor: "d" }]);
  expect(rankMoveToDeltaOps(rows, "x", 9)).toEqual([{ op: "place", ids: ["x"], at: "end" }]);
  expect(rankMoveToDeltaOps(rows, "a", 7)).toEqual([{ op: "place", ids: ["a"], at: "end" }]);
});

test("a rank no wave holds goes before the first wave of a higher rank, and to the end only past every wave", () => {
  const gaps = [{ id: "b", queue: 2 }, { id: "c", queue: 3 }, { id: "e", queue: 5 }, { id: "f", queue: 5 }];
  expect(rankMoveToDeltaOps(gaps, "x", 1)).toEqual([{ op: "place", ids: ["x"], before: "b" }]);
  expect(rankMoveToDeltaOps(gaps, "x", 4)).toEqual([{ op: "place", ids: ["x"], before: "e" }]);
  expect(rankMoveToDeltaOps(gaps, "b", 4)).toEqual([{ op: "place", ids: ["b"], before: "e" }]);
  expect(rankMoveToDeltaOps(gaps, "x", 6)).toEqual([{ op: "place", ids: ["x"], at: "end" }]);
  expect(rankMoveToDeltaOps([], "x", 3)).toEqual([{ op: "place", ids: ["x"], at: "end" }]);
});

test("a rank that does not change a card says nothing, and null takes a queued card out", () => {
  const rows = [{ id: "a", queue: 1 }, { id: "b", queue: 2 }];
  expect(rankMoveToDeltaOps(rows, "b", 2)).toEqual([]);
  expect(rankMoveToDeltaOps(rows, "x", null)).toEqual([]);
  expect(rankMoveToDeltaOps(rows, "b", null)).toEqual([{ op: "remove", ids: ["b"] }]);
});
