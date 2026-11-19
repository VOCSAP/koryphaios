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
import { onDeckError } from "../desktop/src/main/log.ts";
import { extractParenBody } from "./_braced-body.ts";

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

test("save/load round-trip, newest first", async () => {
  const dir = tmp();
  await saveGraphs(dir, KEY, [doc("a", "old", 10), doc("b", "new", 20)]);
  const loaded = await loadGraphs(dir, KEY);
  expect(loaded.map((d) => d.id)).toEqual(["b", "a"]);
});

test("upsertGraph replaces by id and stamps updatedAt", async () => {
  const dir = tmp();
  await upsertGraph(dir, KEY, doc("a", "v1"));
  const stamped = await upsertGraph(dir, KEY, doc("a", "v2"));
  expect(stamped.updatedAt).toBeGreaterThan(1);
  const loaded = await loadGraphs(dir, KEY);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].name).toBe("v2");
});

test("deleteGraph removes only the matching doc", async () => {
  const dir = tmp();
  await saveGraphs(dir, KEY, [doc("a"), doc("b")]);
  expect(await deleteGraph(dir, KEY, "a")).toBe(true);
  expect(await deleteGraph(dir, KEY, "ghost")).toBe(false);
  expect((await loadGraphs(dir, KEY)).map((d) => d.id)).toEqual(["b"]);
});

test("missing file, corrupt JSON, and corrupt entries degrade to empty/filtered", async () => {
  const dir = tmp();
  expect(await loadGraphs(dir, KEY)).toEqual([]);
  mkdirSync(join(dir, "graphs"), { recursive: true });
  writeFileSync(graphsFile(dir, KEY), "not json{{{", "utf-8");
  expect(await loadGraphs(dir, KEY)).toEqual([]);
  writeFileSync(graphsFile(dir, KEY), JSON.stringify([doc("ok"), { junk: true }]), "utf-8");
  expect((await loadGraphs(dir, KEY)).map((d) => d.id)).toEqual(["ok"]);
});

test("projects do not leak into each other", async () => {
  const dir = tmp();
  await saveGraphs(dir, "key-one", [doc("a")]);
  await saveGraphs(dir, "key-two", [doc("b")]);
  expect((await loadGraphs(dir, "key-one")).map((d) => d.id)).toEqual(["a"]);
  expect((await loadGraphs(dir, "key-two")).map((d) => d.id)).toEqual(["b"]);
  // Two buckets = two files.
  expect(readFileSync(graphsFile(dir, "key-one"), "utf-8")).toContain('"a"');
});

// ----- encryption at rest (PLAN K8) -----
// A fake SecretCipher (reversed base64) stands in for Electron safeStorage,
// like the scope-secrets tests: the store only needs the injected surface.

import { migrateGraphsAtRest } from "../desktop/src/main/graph-store.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";

function fakeCipher(available = true): SecretCipher {
  const encrypt = (plain: string) => Buffer.from([...Buffer.from(plain, "utf-8")].reverse());
  const decrypt = (buf: Buffer) => Buffer.from([...buf].reverse()).toString("utf-8");
  return {
    isAvailable: () => available,
    encrypt,
    decrypt,
    isAvailableAsync: async () => available,
    encryptAsync: async (plain) => encrypt(plain),
    decryptAsync: async (buf) => decrypt(buf),
  };
}

test("saveGraphs with a cipher writes an envelope, never the clear content", async () => {
  const dir = tmp();
  const cipher = fakeCipher();
  await saveGraphs(dir, KEY, [doc("a", "secret plan")], cipher);
  const onDisk = readFileSync(graphsFile(dir, KEY), "utf-8");
  expect(onDisk).not.toContain("secret plan");
  const parsed = JSON.parse(onDisk) as { cipher: string; payload: string };
  expect(parsed.cipher).toBe("safeStorage");
  expect(typeof parsed.payload).toBe("string");
  // Round-trip through the same cipher.
  const loaded = await loadGraphs(dir, KEY, cipher);
  expect(loaded.map((d) => d.name)).toEqual(["secret plan"]);
});

test("upsert/delete keep the file encrypted end-to-end", async () => {
  const dir = tmp();
  const cipher = fakeCipher();
  await upsertGraph(dir, KEY, doc("a", "one"), cipher);
  await upsertGraph(dir, KEY, doc("b", "two"), cipher);
  expect(readFileSync(graphsFile(dir, KEY), "utf-8")).not.toContain("one");
  expect(await deleteGraph(dir, KEY, "a", cipher)).toBe(true);
  expect((await loadGraphs(dir, KEY, cipher)).map((d) => d.id)).toEqual(["b"]);
});

test("a legacy clear file still loads and migrateGraphsAtRest re-encrypts it", async () => {
  const dir = tmp();
  const cipher = fakeCipher();
  // Pre-K8 layout: clear JSON array on disk.
  mkdirSync(join(dir, "graphs"), { recursive: true });
  writeFileSync(graphsFile(dir, KEY), JSON.stringify([doc("a", "legacy")]), "utf-8");

  expect((await loadGraphs(dir, KEY, cipher)).map((d) => d.name)).toEqual(["legacy"]);
  expect(await migrateGraphsAtRest(dir, KEY, cipher)).toBe(true);
  expect(readFileSync(graphsFile(dir, KEY), "utf-8")).not.toContain("legacy");
  expect((await loadGraphs(dir, KEY, cipher)).map((d) => d.name)).toEqual(["legacy"]);
  // Second call: already encrypted -> no-op.
  expect(await migrateGraphsAtRest(dir, KEY, cipher)).toBe(false);
});

test("an encrypted file without a usable cipher yields [] (never a crash)", async () => {
  const dir = tmp();
  const cipher = fakeCipher();
  await saveGraphs(dir, KEY, [doc("a")], cipher);
  expect(await loadGraphs(dir, KEY)).toEqual([]);
  expect(await loadGraphs(dir, KEY, fakeCipher(false))).toEqual([]);
  // Broken decryption (OS key changed): swallowed, empty list.
  const broken: SecretCipher = {
    ...cipher,
    decryptAsync: async () => {
      throw new Error("key mismatch");
    },
  };
  expect(await loadGraphs(dir, KEY, broken)).toEqual([]);
});

test("no keychain -> clear-text fallback keeps the feature working", async () => {
  const dir = tmp();
  const off = fakeCipher(false);
  await saveGraphs(dir, KEY, [doc("a", "plain")], off);
  // Written clear (array shape), readable with or without a cipher.
  expect(JSON.parse(readFileSync(graphsFile(dir, KEY), "utf-8"))).toBeArray();
  expect((await loadGraphs(dir, KEY, off)).map((d) => d.name)).toEqual(["plain"]);
  expect(await migrateGraphsAtRest(dir, KEY, off)).toBe(false);
});

test("the store goes through the async cipher only", async () => {
  const dir = tmp();
  const removed = (): never => {
    throw new Error("the sync cipher must not be used");
  };
  const asyncOnly: SecretCipher = { ...fakeCipher(), isAvailable: removed, encrypt: removed, decrypt: removed };
  await upsertGraph(dir, KEY, doc("a", "one"), asyncOnly);
  expect((await loadGraphs(dir, KEY, asyncOnly)).map((d) => d.name)).toEqual(["one"]);
  expect(await migrateGraphsAtRest(dir, KEY, asyncOnly)).toBe(false);
});

test("concurrent saves of one project lose no update", async () => {
  const dir = tmp();
  const cipher = fakeCipher();
  await Promise.all(["a", "b", "c", "d", "e"].map((id) => upsertGraph(dir, KEY, doc(id, id), cipher)));
  expect((await loadGraphs(dir, KEY, cipher)).map((d) => d.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
  await Promise.all([deleteGraph(dir, KEY, "a", cipher), upsertGraph(dir, KEY, doc("f", "f"), cipher)]);
  expect((await loadGraphs(dir, KEY, cipher)).map((d) => d.id).sort()).toEqual(["b", "c", "d", "e", "f"]);
});

test("a failed at-rest migration is traced and leaves the clear file readable", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "graphs"), { recursive: true });
  writeFileSync(graphsFile(dir, KEY), JSON.stringify([doc("a", "legacy")]), "utf-8");
  const failing: SecretCipher = {
    ...fakeCipher(),
    encryptAsync: async () => {
      throw new Error("encrypt failed");
    },
  };
  const texts: string[] = [];
  onDeckError((_scope, text) => texts.push(text));
  try {
    expect(await migrateGraphsAtRest(dir, KEY, failing)).toBe(false);
  } finally {
    onDeckError(() => {});
  }
  expect(texts).toEqual(["could not migrate the graphs at rest: Error"]);
  expect((await loadGraphs(dir, KEY)).map((d) => d.name)).toEqual(["legacy"]);
});

test("a failing save rejects, and does not block the next one", async () => {
  const dir = tmp();
  const failing: SecretCipher = {
    ...fakeCipher(),
    encryptAsync: async () => {
      throw new Error("encrypt failed");
    },
  };
  await expect(upsertGraph(dir, KEY, doc("a", "one"), failing)).rejects.toThrow("encrypt failed");
  await upsertGraph(dir, KEY, doc("b", "two"), fakeCipher());
  expect((await loadGraphs(dir, KEY, fakeCipher())).map((d) => d.id)).toEqual(["b"]);
});

test("opening a graph draft traces a failed broker flip instead of swallowing it", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts"), "utf8").replace(/\r\n/g, "\n");
  const anchor = "regHandle('graphDraft:open'";
  const at = source.indexOf(anchor);
  expect(at, "ipc.ts must register graphDraft:open").toBeGreaterThanOrEqual(0);
  const handler = extractParenBody(source, at + "regHandle".length, true);
  const flipAt = handler.indexOf("await markGraphDraftOpened(");
  expect(flipAt, "the handler flips the draft on the broker").toBeGreaterThanOrEqual(0);
  const afterFlip = handler.slice(flipAt);
  const catchBody = afterFlip.slice(afterFlip.indexOf("catch"));
  expect(catchBody.slice(0, catchBody.indexOf("journal.add")), "the failure is reported").toContain(
    "reportError('graph', 'could not mark the graph draft opened'"
  );
});

test("every ipc.ts call into the store or the provider decryption is awaited or returned", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts"), "utf8").replace(/\r\n/g, "\n");
  const calls = [...source.matchAll(/\b(loadGraphs|upsertGraph|deleteGraph|migrateGraphsAtRest|decryptProviders|applySealedProviderPatch)\(/g)];
  expect(calls.length, "the handlers call the store").toBeGreaterThanOrEqual(12);
  for (const m of calls) {
    const before = source.slice(0, m.index!).trimEnd();
    expect(before.endsWith("await") || before.endsWith("return"), `${m[1]}( at offset ${m.index} is neither awaited nor returned`).toBe(true);
  }
});
