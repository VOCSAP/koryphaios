// Shared factory for `mock.module(".../store.ts", ...)` fixtures (card
// a688748b). Two test files mocked the SAME specifier with DIFFERENT export
// surfaces: the first to load fixed the surface for the whole `bun test`
// process (Bun's module registry is process-global, not per-file), and the
// second -- needing a key the first omitted -- died mid-import with
// `SyntaxError: Export named 'errorText' not found in module store.ts`,
// AFTER its GlobalRegistrator.register() ran and BEFORE its afterAll(unregister)
// could, orphaning happy-dom globals (globalThis.fetch in particular) for
// every test file alphabetically after it in the same process. A guard that
// enumerates "these five files must carry `errorText`" would only ever see
// the files that broke it once; this one derives the required surface from
// store.ts ITSELF, so it also catches export #6 nobody has mocked yet.
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STORE_SPECIFIER = "../desktop/src/renderer/src/store.ts";

// Read as TEXT, never imported/executed: an actual `import` of store.ts
// from a file living outside `desktop/` hits the SAME gap already
// documented in tests/desktop-templates-composer-draft-reset.test.ts --
// `@shared/*` is a tsconfig-only path alias (desktop/tsconfig.web.json)
// that Bun does not resolve when `bun test` runs from the repo root, and
// store.ts's own `import { inboxEntryKey } from '@shared/types'` (a VALUE
// import, not `import type`) throws before this module could ever read
// `Object.keys()` off the real thing. Measured directly: `bun test
// tests/desktop-tile-area.test.ts` with a real `import * as RealStore from
// ".../store.ts"` here failed with "Cannot find module '@shared/types'
// from '.../store.ts'" before a single test ran.
const STORE_SOURCE_PATH = join(import.meta.dir, "../desktop/src/renderer/src/store.ts");

/**
 * Value-export names store.ts has TODAY, scanned off its own source rather
 * than hardcoded -- a future export added there shows up here for free, and
 * a mock written against yesterday's surface starts failing loudly instead
 * of silently shipping a hole. Scoped to ONE canonical, stable-shaped file
 * (never to the arbitrary test files that MOCK it, which is the fragile
 * scan this project's conventions warn against): matches top-level `export
 * function NAME` / `export const NAME`. `export type` lines are excluded on
 * purpose -- erased at runtime, never a key a `mock.module` factory needs.
 */
function readRealStoreKeys(): string[] {
  const source = readFileSync(STORE_SOURCE_PATH, "utf-8");
  const keys = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) keys.add(m[1]);
  for (const m of source.matchAll(/^export\s+const\s+(\w+)/gm)) keys.add(m[1]);
  return [...keys].sort();
}

const REAL_STORE_KEYS = readRealStoreKeys();

/**
 * Pure comparison, kept separate from `mockStore` so it is directly
 * testable without touching Bun's module registry: which of the real
 * store.ts value exports are absent from `provided`. Empty result means the
 * mock is complete.
 */
export function missingStoreKeys(
  provided: Record<string, unknown>,
  realKeys: readonly string[] = REAL_STORE_KEYS
): string[] {
  return realKeys.filter((key) => !(key in provided));
}

// Compile-time contract only: `typeof import(...)` is a type-only
// construct, fully erased by Bun before this file ever runs, so it does
// NOT execute store.ts (which would hit the resolution gap above). Not
// relied on for enforcement -- nothing in this repo currently type-checks
// tests/ -- but documents the intended shape and would flag a missing key
// wherever a type-checker IS pointed at this file.
type RealStoreModule = typeof import("../desktop/src/renderer/src/store.ts");

/**
 * Registers the store.ts mock, refusing to install an incomplete one. The
 * throw below is what actually enforces completeness under plain
 * `bun test`, which does not type-check.
 *
 * Coverage residual: this only guards a call site that adopts `mockStore`.
 * A test file that keeps calling `mock.module(".../store.ts", ...)`
 * directly bypasses it entirely -- known gap, not silently assumed closed.
 */
export function mockStore(overrides: RealStoreModule): void {
  const missing = missingStoreKeys(overrides);
  if (missing.length > 0) {
    throw new Error(
      `mockStore(): incomplete store.ts mock, missing export(s): ${missing.join(", ")}. ` +
        `Every mock of store.ts must provide its current value exports: ${REAL_STORE_KEYS.join(", ")}.`
    );
  }
  mock.module(STORE_SPECIFIER, () => overrides);
}

/**
 * Harmless stand-ins for the 4 pure helpers store.ts exports alongside
 * `useDeck`. None of the components mounted by the test files that adopt
 * `mockStore` today call them -- these only exist to satisfy completeness.
 * NOT the real implementation (unreachable from here, see the resolution
 * gap above): a test that actually exercises error-text stripping or badge
 * counting must stub those keys itself instead of spreading this in.
 */
export const storeMockStubs = {
  errorText: (e: unknown): string => String(e),
  inboxPendingCount: (): number => 0,
  inboxBadgeCount: (): number => 0,
  inboxAwaitsAction: (): boolean => false
};
