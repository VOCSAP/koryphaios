// Card a688748b. Unit-tests tests/_store-mock.ts in isolation: pure logic
// only, no DOM, no broker, no mock.module registration reaching a complete
// state (that would globally register a stub store.ts for the rest of this
// bun test process -- harmless for the throw path below, since the check
// runs BEFORE mock.module is ever called, but avoided on the success path
// too so this file never has an opinion on what other test files see).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  countStoreMockSpecifiers,
  findDirectStoreMocks,
  listTestsDirFiles,
  missingStoreKeys,
  mockStore,
  storeMockStubs
} from "./_store-mock";
import { TESTS_DIR } from "../scripts/pure-module-partition.ts";
import { join } from "node:path";

// The real value-export names of store.ts as of this writing (errorText,
// inboxPendingCount, inboxBadgeCount, inboxAwaitsAction, useDeck). Not
// re-derived here on purpose: this file asserts the GUARD's behaviour
// against a fixed set it controls, so a change to store.ts's real surface
// shows up as this test needing an update, distinct from the guard mis-firing.
const KNOWN_REAL_KEYS = ["errorText", "inboxAwaitsAction", "inboxBadgeCount", "inboxPendingCount", "useDeck"].sort();

test("missingStoreKeys: empty when every real store.ts export is present", () => {
  const complete = Object.fromEntries(KNOWN_REAL_KEYS.map((key) => [key, () => {}]));
  expect(missingStoreKeys(complete, KNOWN_REAL_KEYS)).toEqual([]);
});

test("missingStoreKeys: reports exactly the keys absent from a partial mock", () => {
  expect(missingStoreKeys({ useDeck: () => {} }, KNOWN_REAL_KEYS)).toEqual(
    KNOWN_REAL_KEYS.filter((key) => key !== "useDeck")
  );
});

test("missingStoreKeys: an extra, unknown key alongside every real one is not reported (harmless)", () => {
  const complete = Object.fromEntries(KNOWN_REAL_KEYS.map((key) => [key, () => {}]));
  expect(missingStoreKeys({ ...complete, staleLeftoverKey: 1 }, KNOWN_REAL_KEYS)).toEqual([]);
});

test("mockStore: throws naming every missing export, without registering the incomplete mock", () => {
  // Deliberately incomplete: only `useDeck`, like the pre-guard shape every
  // one of the 5 adopted test files used to write by hand. Cast bypasses
  // the compile-time contract on purpose, to prove the RUNTIME check --
  // the one `bun test` actually runs -- catches it independently of tsc.
  expect(() =>
    mockStore({ useDeck: () => {} } as unknown as Parameters<typeof mockStore>[0])
  ).toThrow(/incomplete store\.ts mock, missing export\(s\): errorText, inboxAwaitsAction, inboxBadgeCount, inboxPendingCount/);
});

test("storeMockStubs: covers every pure helper store.ts exports besides useDeck", () => {
  expect(Object.keys(storeMockStubs).sort()).toEqual(
    KNOWN_REAL_KEYS.filter((key) => key !== "useDeck")
  );
});

// ---------------------------------------------------------------------------
// findDirectStoreMocks: closes the residual declared above ("only guards a
// call site that adopts mockStore"). Synthetic sources via the injectable
// `readSource` param -- no real files written, no real mock.module reached.

test("findDirectStoreMocks: flags a direct mock.module(store.ts, ...) call, any quote style", () => {
  const sources: Record<string, string> = {
    "double.test.ts": 'mock.module("../desktop/src/renderer/src/store.ts", () => ({}));',
    "single.test.ts": "mock.module('../desktop/src/renderer/src/store.ts', () => ({}));",
    "template.test.ts": "mock.module(`../desktop/src/renderer/src/store.ts`, () => ({}));"
  };
  const files = Object.keys(sources);
  expect(findDirectStoreMocks(files, (f) => sources[f]!).sort()).toEqual([...files].sort());
});

test("findDirectStoreMocks: does not flag a mock.module call aimed at a different specifier", () => {
  const sources: Record<string, string> = {
    "other.test.ts": 'mock.module("@shared/reorder", () => ({ moveBeside: (ids: string[]) => ids }));'
  };
  expect(findDirectStoreMocks(Object.keys(sources), (f) => sources[f]!)).toEqual([]);
});

test("findDirectStoreMocks: exempts its own canonical file by name", () => {
  const sources: Record<string, string> = {
    "_store-mock.ts": 'mock.module("../desktop/src/renderer/src/store.ts", () => (overrides));'
  };
  expect(findDirectStoreMocks(Object.keys(sources), (f) => sources[f]!)).toEqual([]);
});

test("findDirectStoreMocks: KNOWN BLIND SPOT, documented not assumed -- a variable specifier is invisible to this scan", () => {
  const sources: Record<string, string> = {
    "indirect.test.ts":
      'const spec = "../desktop/src/renderer/src/store.ts";\nmock.module(spec, () => ({}));'
  };
  // This MUST stay empty: it is the coverage gap findDirectStoreMocks's own
  // header comment names. A regex/AST upgrade that started catching this
  // form would need this expectation flipped to `.toEqual(["indirect.test.ts"])`
  // as evidence the gap actually closed, not silently left behind.
  expect(findDirectStoreMocks(Object.keys(sources), (f) => sources[f]!)).toEqual([]);
});

test("findDirectStoreMocks: canonicalizes paths instead of comparing text -- a nested caller and an extension-less specifier both resolve", () => {
  const sources: Record<string, string> = {
    "nested/deep.test.ts": 'mock.module("../../desktop/src/renderer/src/store.ts", () => ({}));',
    "no-ext.test.ts": 'mock.module("../desktop/src/renderer/src/store", () => ({}));'
  };
  expect(findDirectStoreMocks(Object.keys(sources), (f) => sources[f]!).sort()).toEqual(
    ["nested/deep.test.ts", "no-ext.test.ts"].sort()
  );
});

test("listTestsDirFiles: matches an independent readdirSync scan, not a narrowed copy of it", () => {
  // Reviewer-measured (card a688748b, mutation M5): a floor check
  // (`length > 100`) against the SAME function it is meant to guard stayed
  // green when that function's own implementation was truncated to 101 of
  // 218 -- a floor only catches an absurd value, not a plausible-looking
  // narrowing. Recomputing the scan INDEPENDENTLY here and requiring EXACT
  // equality (not just a floor) makes a narrowed production implementation
  // mismatch immediately, whatever the narrowed count happens to be.
  const independent = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".ts"));
  expect(independent.length).toBeGreaterThan(180); // sanity: still a real, non-trivial domain
  expect(listTestsDirFiles().sort()).toEqual(independent.sort());
});

test("findDirectStoreMocks: no file in the real tests/ directory mocks store.ts outside _store-mock.ts", () => {
  // This file itself is excluded from THIS assertion: its synthetic
  // fixtures a few tests up embed the literal text
  // `mock.module("../desktop/src/renderer/src/store.ts", ...)` as PLAIN
  // STRING DATA (never executed, never a real call), and the scan reads
  // source TEXT -- it cannot tell that apart from a real violation in this
  // one file. That gap is not left open: the pinned-count self-check right
  // below is a fail-closed check on exactly this file.
  const SELF = "store-mock-guard.test.ts";
  expect(findDirectStoreMocks().filter((file) => file !== SELF)).toEqual([]);
});

test("this file's own real source: exactly the store.ts-aimed specifiers its synthetic fixtures account for (fail-closed self-check)", () => {
  // Stronger than exempting this file by NAME (which would stay blind to a
  // real mock.module(store.ts, ...) call added directly to this file
  // later): pins the COUNT of literal specifiers in this file's own on-disk
  // text that resolve to store.ts, as if all written flat in tests/ (this
  // file's real location) -- measured, not hand-derived, since resolution
  // depends on which fixture strings happen to be text-adjacent to
  // `mock.module(` and how each one's relative path resolves from THIS
  // file's real position (not from whatever synthetic key a test above
  // attaches it to). Adding a real, executable mock.module(store.ts, ...)
  // call to this file -- or a new fixture literal that happens to resolve
  // to store.ts from here -- moves this number, and this test is what makes
  // that a visible signal instead of a silent pass-through.
  const SELF = "store-mock-guard.test.ts";
  const source = readFileSync(join(TESTS_DIR, SELF), "utf-8");
  expect(countStoreMockSpecifiers(source, SELF)).toBe(6);
});
