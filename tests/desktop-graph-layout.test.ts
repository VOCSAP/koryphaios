// Grid + hierarchical layout helpers (desktop/src/shared/graph): snapping,
// free-spot scan, node kinds (timeline colors), outline order and the
// auto-arrange layout. Pure module, no electron import.

import { test, expect } from "bun:test";
import {
  findFreeSpot,
  graphNodeKind,
  GRAPH_GRID,
  GRAPH_NODE_H,
  GRAPH_NODE_MAX_W,
  GRAPH_NODE_MIN_W,
  GRAPH_NODE_W,
  GRAPH_PITCH_X,
  GRAPH_PITCH_Y,
  layoutGraph,
  outlineOrder,
  snapToGrid,
  type GraphNode
} from "../desktop/src/shared/graph.ts";

let clock = 1000;
function n(
  id: string,
  parents: string[],
  type: GraphNode["type"] = "user",
  x = 0,
  y = 0
): GraphNode {
  return { id, type, parents, text: `text-${id}`, x, y, createdAt: ++clock };
}

// ----- snapToGrid / findFreeSpot -----

test("snapToGrid rounds to the nearest grid step", () => {
  expect(snapToGrid(0)).toBe(0);
  expect(snapToGrid(9)).toBe(0);
  expect(snapToGrid(11)).toBe(GRAPH_GRID);
  expect(snapToGrid(-29)).toBe(-GRAPH_GRID);
});

test("findFreeSpot snaps and returns the spot unchanged when free", () => {
  const spot = findFreeSpot([], 33, 47);
  expect(spot).toEqual({ x: 40, y: 40 });
});

test("findFreeSpot slides right along the same row when occupied", () => {
  const nodes = [n("a", [], "user", 0, 0)];
  const spot = findFreeSpot(nodes, 0, 0);
  expect(spot.y).toBe(0); // same hierarchy level
  expect(spot.x).toBeGreaterThanOrEqual(GRAPH_NODE_W + GRAPH_GRID); // no overlap
  expect(spot.x % GRAPH_GRID).toBe(0);
});

test("findFreeSpot ignores listed ids (moving a node over itself)", () => {
  const nodes = [n("a", [], "user", 0, 0)];
  expect(findFreeSpot(nodes, 0, 0, ["a"])).toEqual({ x: 0, y: 0 });
});

test("findFreeSpot only cares about card-overlap distance", () => {
  const nodes = [n("a", [], "user", 0, 0)];
  const far = findFreeSpot(nodes, 0, GRAPH_NODE_H + GRAPH_GRID + 20, []);
  expect(far.x).toBe(0); // vertically clear of the card: no shift
});

// ----- findFreeSpot + resizable nodes (a0f2e983 review, bc72d2c CHANGES) -----
// The pre-fix test compared distance between ORIGINS against one fixed
// GRAPH_NODE_W, ignoring any node.w/node.h set by a resize. These must FAIL
// against that old formula (both a spot that used to read as "free" but
// isn't, and one that used to get needlessly pushed away).

test("findFreeSpot uses an existing node's REAL (resized) width, not the fixed default", () => {
  const wide = n("wide", [], "user", 0, 0);
  wide.w = GRAPH_NODE_MAX_W; // 640: far wider than the old fixed GRAPH_NODE_W=260
  // Exactly the old threshold (GRAPH_NODE_W + GRAPH_GRID = 280): the old,
  // fixed-width formula reads this as clear. It is not -- it lands well
  // inside the resized card's real 640-wide footprint.
  const spot = findFreeSpot([wide], GRAPH_NODE_W + GRAPH_GRID, 0);
  expect(spot.x).toBeGreaterThanOrEqual(GRAPH_NODE_MAX_W + GRAPH_GRID);
});

test("findFreeSpot does not over-push against a node narrowed below the default", () => {
  const narrow = n("narrow", [], "user", 0, 0);
  narrow.w = GRAPH_NODE_MIN_W; // 180: narrower than the old fixed GRAPH_NODE_W=260
  // Already clear of the REAL (narrower) right edge (0 + 180 + 20 = 200).
  // The old fixed-width formula would still see this as within its 280
  // threshold and needlessly shift it further right.
  const spot = findFreeSpot([narrow], GRAPH_NODE_MIN_W + GRAPH_GRID, 0);
  expect(spot.x).toBe(GRAPH_NODE_MIN_W + GRAPH_GRID);
});

test("findFreeSpot also accounts for the size of the node BEING placed, not just existing ones", () => {
  const existing = n("a", [], "user", 300, 0); // default-width card starting at x=300
  // A default-size (260-wide) probe at x=0 clears it: right edge at 260,
  // existing starts at 300, 40 >= the GRAPH_GRID gap.
  const defaultSize = findFreeSpot([existing], 0, 0);
  expect(defaultSize.x).toBe(0);
  // The SAME spot overlaps once the node being placed is itself wide enough
  // to reach into the existing card's footprint -- passing only the
  // existing node's real width (and ignoring the placed size) would miss
  // this half of the fix.
  const widePlaced = findFreeSpot([existing], 0, 0, [], { w: 400, h: GRAPH_NODE_H });
  expect(widePlaced.x).toBeGreaterThan(0);
});

// ----- graphNodeKind -----

test("graphNodeKind: prompt, answer, judge-as-merge, cross-as-merge, what-if", () => {
  const root = n("root", []);
  const a1 = n("a1", ["root"], "assistant");
  const a2 = n("a2", ["root"], "assistant"); // fan-out siblings stay answers
  const judge = n("j", ["a1", "a2"], "judge");
  const follow = n("f", ["a1"]); // single child of a1: plain continuation
  const whatif = n("w", ["root"]); // root now has 3 children -> branch
  const cross = n("x", ["f", "w"]); // user node crossing 2 parents
  const nodes = [root, a1, a2, judge, follow, whatif, cross];
  expect(graphNodeKind(nodes, root)).toBe("prompt");
  expect(graphNodeKind(nodes, a1)).toBe("answer");
  expect(graphNodeKind(nodes, a2)).toBe("answer");
  expect(graphNodeKind(nodes, judge)).toBe("merge");
  expect(graphNodeKind(nodes, follow)).toBe("prompt");
  expect(graphNodeKind(nodes, whatif)).toBe("whatif");
  expect(graphNodeKind(nodes, cross)).toBe("merge");
});

// ----- outlineOrder -----

test("outlineOrder walks depth-first with depths, children left-to-right", () => {
  const root = n("root", [], "user", 0, 0);
  const left = n("left", ["root"], "assistant", -GRAPH_PITCH_X, GRAPH_PITCH_Y);
  const right = n("right", ["root"], "assistant", GRAPH_PITCH_X, GRAPH_PITCH_Y);
  const deep = n("deep", ["left"], "user", -GRAPH_PITCH_X, 2 * GRAPH_PITCH_Y);
  // Shuffled input must not matter.
  const rows = outlineOrder([right, deep, root, left]);
  expect(rows.map((r) => r.node.id)).toEqual(["root", "left", "deep", "right"]);
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
});

test("outlineOrder lists a multi-parent node once and appends orphans", () => {
  const a = n("a", []);
  const b = n("b", []);
  const cross = n("cross", ["a", "b"]);
  const orphan = n("orphan", ["ghost"]); // dangling parent: treated as root
  const rows = outlineOrder([a, b, cross, orphan]);
  expect(rows.map((r) => r.node.id)).toEqual(["a", "cross", "b", "orphan"]);
  expect(rows.filter((r) => r.node.id === "cross")).toHaveLength(1);
});

// ----- layoutGraph -----

test("layoutGraph rows by depth, siblings on one line, all snapped", () => {
  const root = n("root", [], "user", 123, 456);
  const a1 = n("a1", ["root"], "assistant", 999, -50);
  const a2 = n("a2", ["root"], "assistant", -999, 17);
  const judge = n("j", ["a1", "a2"], "judge", 3, 3);
  const out = layoutGraph([root, a1, a2, judge]);
  const by = new Map(out.map((x) => [x.id, x]));
  expect(by.get("root")!.y).toBe(0);
  expect(by.get("a1")!.y).toBe(GRAPH_PITCH_Y);
  expect(by.get("a2")!.y).toBe(GRAPH_PITCH_Y);
  expect(by.get("j")!.y).toBe(2 * GRAPH_PITCH_Y);
  // Siblings spread horizontally, never stacked.
  expect(by.get("a1")!.x).not.toBe(by.get("a2")!.x);
  for (const node of out) {
    expect(Math.abs(node.x % GRAPH_GRID)).toBe(0);
    expect(Math.abs(node.y % GRAPH_GRID)).toBe(0);
  }
});

test("layoutGraph uses the LONGEST path for depth (judge below late branch)", () => {
  const root = n("root", []);
  const shallow = n("shallow", ["root"], "assistant");
  const mid = n("mid", ["root"], "assistant");
  const deep = n("deep", ["mid"], "user");
  const cross = n("x", ["shallow", "deep"]);
  const by = new Map(layoutGraph([root, shallow, mid, deep, cross]).map((x) => [x.id, x]));
  expect(by.get("x")!.y).toBe(3 * GRAPH_PITCH_Y);
});

test("layoutGraph keeps sibling order by parent barycenter (no edge crossing)", () => {
  const r1 = n("r1", [], "user", 0, 0);
  const r2 = n("r2", [], "user", 0, 0);
  const c1 = n("c1", ["r1"], "assistant");
  const c2 = n("c2", ["r2"], "assistant");
  const by = new Map(layoutGraph([r1, r2, c1, c2]).map((x) => [x.id, x]));
  // r1 left of r2 (creation order) => c1 must stay left of c2.
  expect(by.get("r1")!.x).toBeLessThan(by.get("r2")!.x);
  expect(by.get("c1")!.x).toBeLessThan(by.get("c2")!.x);
});

test("layoutGraph preserves every other node field", () => {
  const root = n("root", []);
  root.text = "hello";
  const out = layoutGraph([root]);
  expect(out[0]!.text).toBe("hello");
  expect(out[0]!.id).toBe("root");
  expect(out).not.toBe([root]); // new array, source untouched
  expect(root.x).toBe(0);
});
