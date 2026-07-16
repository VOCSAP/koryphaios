// EXPLORATION-graph-chat C23: per-project persistence
// (desktop/src/main/graph-store). Dir passed as a parameter (no electron),
// project bucket derived from the deck project_key.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteGraph,
  graphsFile,
  loadGraphs,
  saveGraphs,
  upsertGraph
} from "../desktop/src/main/graph-store.ts";
import type { GraphDoc } from "../desktop/src/shared/graph.ts";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-graph-store-"));
  tmpDirs.push(d);
  return d;
}

function doc(id: string, name = "g", updatedAt = 1): GraphDoc {
  return { id, name, nodes: [], createdAt: 1, updatedAt };
}

const KEY = "github.com/vocsap/koryphaios";

test("graphsFile is stable per key and filesystem-safe", () => {
  const f1 = graphsFile("/state", KEY);
  const f2 = graphsFile("/state", KEY);
  expect(f1).toBe(f2);
  expect(f1).toMatch(/graphs-[0-9a-f]{16}\.json$/);
  expect(graphsFile("/state", "local:abc")).not.toBe(f1);
});

test("save/load round-trip, newest first", () => {
  const dir = tmp();
  saveGraphs(dir, KEY, [doc("a", "old", 10), doc("b", "new", 20)]);
  const loaded = loadGraphs(dir, KEY);
  expect(loaded.map((d) => d.id)).toEqual(["b", "a"]);
});

test("upsertGraph replaces by id and stamps updatedAt", () => {
  const dir = tmp();
  upsertGraph(dir, KEY, doc("a", "v1"));
  const stamped = upsertGraph(dir, KEY, doc("a", "v2"));
  expect(stamped.updatedAt).toBeGreaterThan(1);
  const loaded = loadGraphs(dir, KEY);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].name).toBe("v2");
});

test("deleteGraph removes only the matching doc", () => {
  const dir = tmp();
  saveGraphs(dir, KEY, [doc("a"), doc("b")]);
  expect(deleteGraph(dir, KEY, "a")).toBe(true);
  expect(deleteGraph(dir, KEY, "ghost")).toBe(false);
  expect(loadGraphs(dir, KEY).map((d) => d.id)).toEqual(["b"]);
});

test("missing file, corrupt JSON, and corrupt entries degrade to empty/filtered", () => {
  const dir = tmp();
  expect(loadGraphs(dir, KEY)).toEqual([]);
  mkdirSync(join(dir, "graphs"), { recursive: true });
  writeFileSync(graphsFile(dir, KEY), "not json{{{", "utf-8");
  expect(loadGraphs(dir, KEY)).toEqual([]);
  writeFileSync(graphsFile(dir, KEY), JSON.stringify([doc("ok"), { junk: true }]), "utf-8");
  expect(loadGraphs(dir, KEY).map((d) => d.id)).toEqual(["ok"]);
});

test("projects do not leak into each other", () => {
  const dir = tmp();
  saveGraphs(dir, "key-one", [doc("a")]);
  saveGraphs(dir, "key-two", [doc("b")]);
  expect(loadGraphs(dir, "key-one").map((d) => d.id)).toEqual(["a"]);
  expect(loadGraphs(dir, "key-two").map((d) => d.id)).toEqual(["b"]);
  // Two buckets = two files.
  expect(readFileSync(graphsFile(dir, "key-one"), "utf-8")).toContain('"a"');
});
