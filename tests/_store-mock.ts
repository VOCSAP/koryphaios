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
import { dirname, join, resolve } from "node:path";
import { listTestFiles, TESTS_DIR } from "../scripts/pure-module-partition.ts";

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

// ---------------------------------------------------------------------------
// Closing the residual `mockStore` itself declared above ("only guards a
// call site that adopts it"): that phrasing is exactly the coverage failure
// this repo's conventions single out -- sensitivity proven, coverage never
// measured. `findDirectStoreMocks` below turns the domain into the whole
// tests/ directory (via listTestFiles(), the same real on-disk inventory
// scripts/pure-module-partition.ts and its own guard use -- not a copy of
// that scan, an import of it), so a 6th file that hand-writes
// `mock.module(".../store.ts", ...)` enters the swept set for free, without
// anyone adding its name anywhere.

const CANONICAL_STORE_MOCK_FILE = "_store-mock.ts";

const REAL_STORE_ABS_PATH = resolve(TESTS_DIR, "../desktop/src/renderer/src/store.ts");

/**
 * Extracts every `mock.module(<specifier>, ...)` call's specifier argument
 * from `source`, but ONLY when it is a plain string/template literal with
 * no interpolation.
 *
 * COVERAGE, stated in code rather than left to be found the day it bites:
 * a specifier built in a variable (`const s = "..."; mock.module(s, ...)`)
 * or reached through a path alias instead of a relative path is INVISIBLE
 * to this regex by construction -- an AST walk or a real Bun.plugin-level
 * intercept of `mock.module` itself would be needed to see those, and
 * neither exists here. `scripts/pure-module-partition.ts`'s own
 * CONTAMINATION_MARKERS scan (which this file's OWN presence in `tests/`
 * legitimately trips, since it contains the literal text `mock.module(`)
 * makes the identical trade-off for the same reason. Degradation check: a
 * regex NARROWED to double-quotes only would silently drop every
 * single-quoted or template-literal specifier into the same blind spot --
 * covered below by testing all three forms, not just the one the current 6
 * adopters happen to use.
 */
function extractMockModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const m of source.matchAll(/mock\.module\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const specifier = m[1] ?? m[2] ?? m[3];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * True if `specifier`, resolved as an import written inside `fromFile` (a
 * bare filename directly under tests/ -- confirmed the only layout tests/
 * has today: every *.test.ts lives flat, none nested), points at the real
 * store.ts. Resolution is done with node:path, not string comparison, so a
 * different relative depth (a specifier written from a hypothetical nested
 * subdirectory) or a differently-spelled-but-equivalent path both resolve
 * correctly -- CLAUDE.md's "comparing two paths, canonicalize both" applies
 * here as much as it does to a live filesystem path. Extension-optional:
 * Bun accepts a specifier without ".ts", so the comparison retries with it
 * appended rather than treating that form as a non-match.
 */
function resolvesToStore(specifier: string, fromFile: string): boolean {
  const fromDir = dirname(resolve(TESTS_DIR, fromFile));
  const candidate = resolve(fromDir, specifier);
  return candidate === REAL_STORE_ABS_PATH || `${candidate}.ts` === REAL_STORE_ABS_PATH;
}

/**
 * Bare filenames (under tests/) that call `mock.module` against store.ts
 * DIRECTLY, bypassing `mockStore`'s completeness check entirely. Domain is
 * `listTestFiles()` -- the real inventory on disk -- not an enumerated
 * list, so a brand new file enters the swept set the moment it exists.
 * `_store-mock.ts` itself is exempt by name: it is the one file whose
 * `mock.module(store.ts, ...)` call (inside `mockStore` above) IS the
 * canonical, checked one -- everything else finding its way here is a
 * second, unchecked path to the same specifier.
 */
export function findDirectStoreMocks(
  files: string[] = listTestFiles(),
  readSource: (file: string) => string = (f) => readFileSync(resolve(TESTS_DIR, f), "utf-8")
): string[] {
  return files.filter((file) => {
    if (file === CANONICAL_STORE_MOCK_FILE) return false;
    const source = readSource(file);
    return extractMockModuleSpecifiers(source).some((specifier) => resolvesToStore(specifier, file));
  });
}
