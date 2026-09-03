// Covers inboxEntryKey (the sole producer of the ack key) and its persistence
// (loadAckState/appendSeenKey/appendAckedKey).
// Four properties held here: acked never regresses to seen; two entries sharing
// a broker id but a different sentAt across a database recreate produce
// distinct keys; a blocking approval entry is excluded from AckableInboxEntry
// at compile time, verified by spawning tsc against a generated probe; and
// inboxEntryKey throws on an unrecognized shape while a missing or corrupt
// ack-state file degrades to empty state rather than crashing.

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  loadAckState,
  appendSeenKey,
  appendAckedKey,
  inboxAckFile,
  INBOX_ACK_CAP,
} from "../desktop/src/main/inbox-store.ts";
import { inboxEntryKey } from "../desktop/src/shared/types.ts";
import type { AckableInboxEntry } from "../desktop/src/shared/types.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "cp-inbox-ack-"));
}

function msgEntry(id: number, sentAt: string): AckableInboxEntry {
  return { kind: "message", message: { id, from: "coder-1", text: "t", sentAt } };
}

function evtEntry(id: string, at: string): AckableInboxEntry {
  return { kind: "event", id, text: "t", at };
}

// ----- property 1: acked never regresses to seen ------------------------

test("natural order: seen then acked -> acked", () => {
  const d = dir();
  appendSeenKey(d, "msg:2020-01-01T00:00:00.000Z:1");
  appendAckedKey(d, "msg:2020-01-01T00:00:00.000Z:1");
  expect(loadAckState(d)).toEqual({ "msg:2020-01-01T00:00:00.000Z:1": "acked" });
});

test("reversed order: acked then seen -> STAYS acked (must not regress)", () => {
  const d = dir();
  const key = "msg:2020-01-01T00:00:00.000Z:1";
  appendAckedKey(d, key);
  appendSeenKey(d, key);
  expect(loadAckState(d)).toEqual({ [key]: "acked" });
});

test("loadAckState resolves a non-disjoint file (key in both seen and acked) as acked, never seen", () => {
  // The two production functions keep `seen`/`acked` disjoint on disk (see
  // the next test), so this directly constructs the file to exercise
  // loadAckState's OWN override order in isolation -- the disjoint-on-disk
  // invariant is defense in depth, this is the other layer, and neither
  // alone is reachable from the other's regression.
  const d = dir();
  const key = "msg:2020-01-01T00:00:00.000Z:1";
  writeFileSync(inboxAckFile(d), JSON.stringify({ seen: [key], acked: [key] }), "utf-8");
  expect(loadAckState(d)).toEqual({ [key]: "acked" });
});

test("appendSeenKey on an already-acked key is a true no-op (file untouched)", () => {
  const d = dir();
  const key = "msg:2020-01-01T00:00:00.000Z:1";
  appendAckedKey(d, key);
  const before = readFileSync(inboxAckFile(d), "utf-8");
  appendSeenKey(d, key);
  const after = readFileSync(inboxAckFile(d), "utf-8");
  expect(after).toBe(before);
});

test("appendAckedKey removes the key from `seen` on disk (sets stay disjoint)", () => {
  const d = dir();
  const key = "msg:2020-01-01T00:00:00.000Z:1";
  appendSeenKey(d, key);
  appendAckedKey(d, key);
  const raw = JSON.parse(readFileSync(inboxAckFile(d), "utf-8"));
  expect(raw.seen).toEqual([]);
  expect(raw.acked).toEqual([key]);
});

// ----- property 2: key survives a broker DB recreate ---------------------

test("inboxEntryKey: same broker id, different sentAt -> distinct keys", () => {
  const a = inboxEntryKey(msgEntry(1, "2020-01-01T00:00:00.000Z"));
  const b = inboxEntryKey(msgEntry(1, "2021-06-15T00:00:00.000Z"));
  expect(a).not.toBe(b);
});

test("inboxEntryKey: exact wire format 'msg:<sentAt>:<id>' and 'evt:<at>:<id>'", () => {
  expect(inboxEntryKey(msgEntry(42, "2020-01-01T00:00:00.000Z"))).toBe(
    "msg:2020-01-01T00:00:00.000Z:42"
  );
  expect(inboxEntryKey(evtEntry("quota-warn", "2020-01-01T00:00:00.000Z"))).toBe(
    "evt:2020-01-01T00:00:00.000Z:quota-warn"
  );
});

test("a stale ack for an old sentAt does not mask a replayed id with a new sentAt (end-to-end through ack state)", () => {
  const d = dir();
  const old = msgEntry(1, "2020-01-01T00:00:00.000Z");
  appendAckedKey(d, inboxEntryKey(old));
  // Broker DB wiped/reinstalled: id 1 reused by a genuinely new message.
  const replayed = msgEntry(1, "2024-03-01T00:00:00.000Z");
  const state = loadAckState(d);
  expect(state[inboxEntryKey(replayed)]).toBeUndefined();
});

// ----- property 4: throw on unrecognized shape, no crash on bad disk state --

test("inboxEntryKey throws on an unrecognized entry shape", () => {
  // Cast past the compiler deliberately: this simulates a hand-built IPC
  // payload arriving at runtime with no type system of its own (the exact
  // scenario inboxEntryKey's own guard comment calls out), not a call site
  // this repo's TS would ever let through un-cast.
  expect(() => inboxEntryKey({ kind: "bogus" } as unknown as AckableInboxEntry)).toThrow(
    "inboxEntryKey: unrecognized entry shape"
  );
});

test("inboxEntryKey throws on a message entry with a non-numeric id", () => {
  expect(() =>
    inboxEntryKey({ kind: "message", message: { id: "1" } } as unknown as AckableInboxEntry)
  ).toThrow("inboxEntryKey: unrecognized entry shape");
});

test("missing inbox-ack.json loads as empty state, then recovers on append", () => {
  const d = dir();
  expect(loadAckState(d)).toEqual({});
  appendSeenKey(d, "evt:2020-01-01T00:00:00.000Z:e1");
  expect(loadAckState(d)).toEqual({ "evt:2020-01-01T00:00:00.000Z:e1": "seen" });
});

test("corrupt inbox-ack.json (invalid JSON) loads as empty state, not a crash", () => {
  const d = dir();
  writeFileSync(inboxAckFile(d), "{not json", "utf-8");
  expect(loadAckState(d)).toEqual({});
  // And the store keeps working afterwards -- corruption doesn't wedge it.
  appendAckedKey(d, "evt:2020-01-01T00:00:00.000Z:e1");
  expect(loadAckState(d)).toEqual({ "evt:2020-01-01T00:00:00.000Z:e1": "acked" });
});

test("wrong-shaped inbox-ack.json (seen/acked not arrays of strings) degrades to empty, not a crash", () => {
  const d = dir();
  writeFileSync(inboxAckFile(d), JSON.stringify({ seen: 1, acked: "x" }), "utf-8");
  expect(loadAckState(d)).toEqual({});
});

test("inbox-ack.json with a mixed-type array filters out non-string entries", () => {
  const d = dir();
  writeFileSync(
    inboxAckFile(d),
    JSON.stringify({ seen: ["ok-key", 42, null], acked: [] }),
    "utf-8"
  );
  expect(loadAckState(d)).toEqual({ "ok-key": "seen" });
});

// ----- cap enforcement (mirrors the history-cap test in desktop-inbox-store) --

test("seen keys are capped, oldest dropped first", () => {
  const d = dir();
  appendSeenKey(d, "a", 2);
  appendSeenKey(d, "b", 2);
  appendSeenKey(d, "c", 2);
  const raw = JSON.parse(readFileSync(inboxAckFile(d), "utf-8"));
  expect(raw.seen).toEqual(["b", "c"]);
});

test("acked keys are capped, oldest dropped first", () => {
  const d = dir();
  appendAckedKey(d, "a", 2);
  appendAckedKey(d, "b", 2);
  appendAckedKey(d, "c", 2);
  const raw = JSON.parse(readFileSync(inboxAckFile(d), "utf-8"));
  expect(raw.acked).toEqual(["b", "c"]);
});

test("INBOX_ACK_CAP default is a sane positive integer (guards a future edit dropping the default silently)", () => {
  expect(INBOX_ACK_CAP).toBeGreaterThan(0);
});

test("a failed persist invokes onPersistError instead of swallowing (mirrors PLAN O6 on the history journal)", () => {
  const d = dir();
  const blocked = join(d, "not-a-dir");
  writeFileSync(blocked, "occupied");
  const errors: unknown[] = [];
  appendSeenKey(join(blocked, "state"), "k1", undefined, (e) => errors.push(e));
  expect(errors.length).toBe(1);
});

// ----- property 3: approval-kind entries cannot be acked (compile-time) --
//
// AckableInboxEntry = Extract<InboxEntry, { kind: 'message' | 'event' }>
// (shared/types.ts) is a TYPE-LEVEL exclusion: there is no runtime branch to
// exercise, so the only honest proof is that passing a 'kind: approval'
// value to inboxEntryKey fails to COMPILE. Spawns the project's own tsc
// against a small generated probe file that imports the real
// inboxEntryKey/AckableInboxEntry from shared/types.ts (no duplication of
// the contract under test). A positive control (a genuinely valid
// AckableInboxEntry) must compile clean in the same harness, proving the
// probe discriminates rather than being unconditionally red.

const REPO_ROOT = join(import.meta.dir, "..");
const TYPES_TS = join(REPO_ROOT, "desktop", "src", "shared", "types.ts");
const TSC_BIN = join(REPO_ROOT, "desktop", "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
// Measured (mutation review): without `desktop/node_modules` installed (a
// CI matrix step that runs this file before `npm install` in desktop/, see
// TESTING.md "Cross-platform tests"), Bun.spawnSync on a missing TSC_BIN
// throws "Executable not found in $PATH" and BOTH compile-discipline tests
// below fail -- for a reason with nothing to do with what they prove. An
// unrelated red is worse than an absent test: it gets ignored, and then the
// real red gets ignored with it. Skip explicitly, by name, rather than let
// that happen silently.
const TSC_AVAILABLE = existsSync(TSC_BIN);
const tscTest = TSC_AVAILABLE ? test : test.skip;
if (!TSC_AVAILABLE) {
  console.warn(
    `[desktop-inbox-ack.test.ts] tsc binary not found at ${TSC_BIN} -- skipping the two ` +
      `compile-discipline tests (run \`npm install\` in desktop/ to enable them)`
  );
}

function tscProbe(body: string): { exitCode: number | null; output: string } {
  const d = dir();
  const rel = relative(d, TYPES_TS).replace(/\\/g, "/").replace(/\.ts$/, "");
  const specifier = rel.startsWith(".") ? rel : `./${rel}`;
  writeFileSync(
    join(d, "probe.ts"),
    `import { inboxEntryKey } from "${specifier}";\n` +
      `import type { InboxEntry, AckableInboxEntry } from "${specifier}";\n\n${body}\n`,
    "utf-8"
  );
  writeFileSync(
    join(d, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: ["probe.ts"],
    }),
    "utf-8"
  );
  const proc = Bun.spawnSync([TSC_BIN, "--noEmit", "-p", "tsconfig.json"], { cwd: d });
  const output = (proc.stdout.toString("utf-8") + proc.stderr.toString("utf-8")).trim();
  return { exitCode: proc.exitCode, output };
}

tscTest("compile-discipline: a valid message-kind AckableInboxEntry compiles clean (positive control)", () => {
  const { exitCode, output } = tscProbe(
    `const good: AckableInboxEntry = { kind: "message", message: { id: 1, from: "x", text: "y", sentAt: "2020-01-01T00:00:00.000Z" } };\n` +
      `inboxEntryKey(good);\n`
  );
  expect(output).toBe("");
  expect(exitCode).toBe(0);
}, 20_000);

tscTest("compile-discipline: an approval-kind entry passed to inboxEntryKey does NOT compile (TS2345)", () => {
  const { exitCode, output } = tscProbe(
    `const bad: InboxEntry = { kind: "approval", approval: {} as any };\n` + `inboxEntryKey(bad);\n`
  );
  expect(exitCode).not.toBe(0);
  expect(output).toContain("TS2345");
  expect(output).toContain("AckableInboxEntry");
}, 20_000);
