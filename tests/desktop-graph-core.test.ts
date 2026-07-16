// EXPLORATION-graph-chat C23: pure DAG operations + shape validation
// (desktop/src/shared/graph). The graph is the source of truth (D1); these
// ops feed the context compilation, so determinism matters.

import { test, expect } from "bun:test";
import {
  ancestorsOf,
  childrenOf,
  graphId,
  linearize,
  mergePartition,
  parseGraphDoc,
  wouldCreateCycle,
  type GraphNode
} from "../desktop/src/shared/graph.ts";

let clock = 1000;
function n(id: string, parents: string[], type: GraphNode["type"] = "user"): GraphNode {
  return { id, type, parents, text: `text-${id}`, x: 0, y: 0, createdAt: ++clock };
}

/** trunk t1..t3, then branch a1..a10 and branch b1..b10 (the plan's example). */
function twoBranches(): { nodes: GraphNode[]; aHead: string; bHead: string } {
  const nodes: GraphNode[] = [n("t1", []), n("t2", ["t1"], "assistant"), n("t3", ["t2"])];
  let prevA = "t3";
  let prevB = "t3";
  for (let i = 1; i <= 10; i++) {
    nodes.push(n(`a${i}`, [prevA], i % 2 ? "assistant" : "user"));
    prevA = `a${i}`;
  }
  for (let i = 1; i <= 10; i++) {
    nodes.push(n(`b${i}`, [prevB], i % 2 ? "assistant" : "user"));
    prevB = `b${i}`;
  }
  return { nodes, aHead: prevA, bHead: prevB };
}

test("graphId is short and unique enough across a burst", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => graphId()));
  expect(ids.size).toBe(1000);
});

test("ancestorsOf includes the node itself and the full upward closure", () => {
  const { nodes } = twoBranches();
  const anc = ancestorsOf(nodes, "a3");
  expect([...anc].sort()).toEqual(["a1", "a2", "a3", "t1", "t2", "t3"]);
});

test("ancestorsOf ignores dangling parent ids instead of crashing", () => {
  const nodes = [n("x", ["ghost"])];
  expect([...ancestorsOf(nodes, "x")]).toEqual(["x"]);
});

test("wouldCreateCycle: self, descendant, and the legit case", () => {
  const { nodes } = twoBranches();
  expect(wouldCreateCycle(nodes, "t2", "t2")).toBe(true);
  // a5 is a descendant of t3: connecting it as a parent of t3 would cycle.
  expect(wouldCreateCycle(nodes, "t3", "a5")).toBe(true);
  // Crossing branch heads into a fresh node is what merge does: fine.
  expect(wouldCreateCycle(nodes, "a10", "b10")).toBe(false);
});

test("linearize orders parents before children, chronological ties, deterministic", () => {
  const { nodes } = twoBranches();
  const ids = ancestorsOf(nodes, "a3");
  const order = linearize(nodes, ids).map((x) => x.id);
  expect(order).toEqual(["t1", "t2", "t3", "a1", "a2", "a3"]);
  // Shuffling the input array must not change the output.
  const shuffled = [...nodes].reverse();
  expect(linearize(shuffled, ids).map((x) => x.id)).toEqual(order);
});

test("mergePartition: trunk once, exclusive deltas per branch (2x10 example)", () => {
  const { nodes, aHead, bHead } = twoBranches();
  const part = mergePartition(nodes, [aHead, bHead]);
  expect(part.trunk.map((x) => x.id)).toEqual(["t1", "t2", "t3"]);
  expect(part.branches).toHaveLength(2);
  expect(part.branches[0].head.id).toBe(aHead);
  expect(part.branches[0].nodes.map((x) => x.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `a${i + 1}`)
  );
  expect(part.branches[1].nodes.map((x) => x.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `b${i + 1}`)
  );
  // No node appears in two sections.
  const all = [...part.trunk, ...part.branches.flatMap((b) => b.nodes)].map((x) => x.id);
  expect(new Set(all).size).toBe(all.length);
});

test("mergePartition with unrelated roots has an empty trunk", () => {
  const nodes = [n("r1", []), n("r2", [])];
  const part = mergePartition(nodes, ["r1", "r2"]);
  expect(part.trunk).toHaveLength(0);
  expect(part.branches[0].nodes.map((x) => x.id)).toEqual(["r1"]);
});

test("childrenOf finds direct children only", () => {
  const { nodes } = twoBranches();
  expect(childrenOf(nodes, "t3").map((x) => x.id).sort()).toEqual(["a1", "b1"]);
  expect(childrenOf(nodes, "a10")).toHaveLength(0);
});

// ----- parseGraphDoc -----

test("parseGraphDoc round-trips a valid doc", () => {
  const { nodes } = twoBranches();
  const doc = { id: "g1", name: "test", nodes, createdAt: 1, updatedAt: 2 };
  const parsed = parseGraphDoc(doc);
  expect(parsed).not.toBeNull();
  expect(parsed!.nodes).toHaveLength(nodes.length);
  expect(parsed!.name).toBe("test");
});

test("parseGraphDoc drops dangling parents and rejects cyclic docs", () => {
  const dangling = parseGraphDoc({
    id: "g",
    name: "g",
    nodes: [{ id: "a", type: "user", parents: ["ghost", "a"], text: "", x: 0, y: 0, createdAt: 1 }]
  });
  expect(dangling!.nodes[0].parents).toEqual([]);

  const cyclic = parseGraphDoc({
    id: "g",
    name: "g",
    nodes: [
      { id: "a", type: "user", parents: ["b"], text: "", x: 0, y: 0, createdAt: 1 },
      { id: "b", type: "user", parents: ["a"], text: "", x: 0, y: 0, createdAt: 2 }
    ]
  });
  expect(cyclic).toBeNull();
});

test("parseGraphDoc rejects garbage and preserves assistant metadata", () => {
  expect(parseGraphDoc(null)).toBeNull();
  expect(parseGraphDoc({ name: "no id" })).toBeNull();
  const parsed = parseGraphDoc({
    id: "g",
    name: "g",
    nodes: [
      {
        id: "a",
        type: "assistant",
        parents: [],
        text: "hi",
        x: 1,
        y: 2,
        createdAt: 3,
        cli: "codex",
        model: "gpt-5",
        status: "ok",
        durationMs: 42
      },
      { id: "bad", type: "wat", parents: [], text: "", x: 0, y: 0, createdAt: 1 }
    ]
  });
  expect(parsed!.nodes).toHaveLength(1);
  expect(parsed!.nodes[0].cli).toBe("codex");
  expect(parsed!.nodes[0].model).toBe("gpt-5");
  expect(parsed!.nodes[0].status).toBe("ok");
});
