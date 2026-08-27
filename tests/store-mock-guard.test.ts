// Card a688748b. Unit-tests tests/_store-mock.ts in isolation: pure logic
// only, no DOM, no broker, no mock.module registration reaching a complete
// state (that would globally register a stub store.ts for the rest of this
// bun test process -- harmless for the throw path below, since the check
// runs BEFORE mock.module is ever called, but avoided on the success path
// too so this file never has an opinion on what other test files see).
import { expect, test } from "bun:test";
import { missingStoreKeys, mockStore, storeMockStubs } from "./_store-mock";

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
