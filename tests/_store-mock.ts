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
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { TESTS_DIR } from "../scripts/pure-module-partition.ts";

// Read as text, never imported: store.ts imports '@shared/types' via a
// tsconfig-only path alias that Bun does not resolve when bun test runs from
// the repo root, so a real import throws before this module can read it.
const STORE_SOURCE_PATH = join(import.meta.dir, "../desktop/src/renderer/src/store.ts");

/**
 * Scans store.ts's own source for its current value-export names rather than
 * hardcoding them, so a mock written against a stale surface fails loudly
 * instead of silently missing an export.
 * Every exported line must match a recognized form (function, const with a
 * single declarator, export type, export const enum) or this throws; export
 * type is excluded since it carries no runtime key.
 * hasTopLevelComma rejects a multi-declarator const line instead of silently
 * keeping only the first name.
 */
function hasTopLevelComma(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth <= 0) return true;
  }
  return false;
}

function readRealStoreKeys(): string[] {
  const source = readFileSync(STORE_SOURCE_PATH, "utf-8");
  const keys = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    if (!/^export\b/.test(line)) continue;
    if (/^export\s+type\b/.test(line)) continue;
    // `export const enum NAME { ... }`: recognized and deliberately
    // excluded from required keys -- store.ts has none today (confirmed:
    // `grep -n "^export" store.ts` lists exactly 6 lines, none a const
    // enum). If one appears, this is the line to revisit; until then it is
    // a stated exclusion, not a silent one.
    if (/^export\s+const\s+enum\s+\w+/.test(line)) continue;
    const fnMatch = /^export\s+(?:async\s+)?function\s+(\w+)/.exec(line);
    if (fnMatch) {
      keys.add(fnMatch[1]!);
      continue;
    }
    // `(?!enum\b)`: without it this would ALSO match a const-enum line and
    // capture the literal word "enum" as a bogus key name -- reviewer-measured
    // false positive (card a688748b, mutation M6d). The dedicated branch
    // above already routes const-enum lines away from here; this lookahead
    // is the second half of the same fix, kept as the direct guard against
    // the exact regex that produced the false positive.
    const constMatch = /^export\s+const\s+(?!enum\b)(\w+)/.exec(line);
    if (constMatch) {
      // Reject multi-declarator lines instead of silently keeping only the
      // first name (mutation N1, see this function's own docstring above).
      if (hasTopLevelComma(line.slice(constMatch.index + constMatch[0].length))) {
        throw new Error(
          `readRealStoreKeys(): multi-declarator "export const" line not supported, cannot safely enumerate every declared name: ${JSON.stringify(line)}`
        );
      }
      keys.add(constMatch[1]!);
      continue;
    }
    throw new Error(
      `readRealStoreKeys(): unrecognized top-level export form in store.ts, cannot tell whether it is a required mock key: ${JSON.stringify(line)}`
    );
  }
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
  // Literal specifier, written out here rather than through a shared
  // constant: `findDirectStoreMocks`'s `extractMockModuleSpecifiers` only
  // recognizes a literal string/template argument (see its own docstring
  // below), so this ONE call -- the canonical, checked mock.module(store.ts)
  // -- must itself use a literal or it is invisible to that scan, which
  // would make the exemption further down dead code on the real call path.
  // Reviewer-measured (card a688748b): with the previous variable
  // indirection, CANONICAL_IN_DOMAIN was false and that exemption never ran.
  mock.module("../desktop/src/renderer/src/store.ts", () => overrides);
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
  inboxAwaitsAction: (): boolean => false,
  roadmapConflictCount: (): number => 0
};

// ---------------------------------------------------------------------------
// Closing the residual `mockStore` itself declared above ("only guards a
// call site that adopts it"): that phrasing is exactly the coverage failure
// this repo's conventions single out -- sensitivity proven, coverage never
// measured. `findDirectStoreMocks` below turns the domain into every `.ts`
// file directly under tests/, not just the ones bun actually RUNS as a
// suite, so a 6th file that hand-writes `mock.module(".../store.ts", ...)`
// enters the swept set for free, without anyone adding its name anywhere.

/**
 * Lists every .ts/.tsx/.mts/.cts file under tests/, recursively, as a path
 * relative to tests/ -- distinct from pure-module-partition's listTestFiles(),
 * which scopes to top-level *.test.ts files bun actually runs as a suite.
 */
export function listTestsDirFiles(): string[] {
  return readdirSync(TESTS_DIR, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.[cm]?tsx?$/.test(e.name))
    .map((e) => join(relative(TESTS_DIR, e.parentPath), e.name));
}

const CANONICAL_STORE_MOCK_FILE = "_store-mock.ts";

const REAL_STORE_ABS_PATH = resolve(TESTS_DIR, "../desktop/src/renderer/src/store.ts");

/**
 * Extracts mock.module() specifier arguments that are plain string/template
 * literals; a specifier built from a variable or a path alias is invisible to
 * this regex by construction, matching the same tradeoff
 * pure-module-partition's CONTAMINATION_MARKERS scan makes.
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
 * `listTestsDirFiles()` -- every real `.ts` file on disk, not only the ones
 * bun collects as a suite -- not an enumerated list, so a brand new file
 * (test OR helper) enters the swept set the moment it exists.
 * `_store-mock.ts` itself is exempt by name: it is the one file whose
 * `mock.module(store.ts, ...)` call (inside `mockStore` above, written with
 * a literal specifier for exactly this reason) IS the canonical, checked
 * one -- everything else finding its way here is a second, unchecked path
 * to the same specifier.
 */
export function findDirectStoreMocks(
  files: string[] = listTestsDirFiles(),
  readSource: (file: string) => string = (f) => readFileSync(resolve(TESTS_DIR, f), "utf-8")
): string[] {
  return files.filter((file) => {
    if (file === CANONICAL_STORE_MOCK_FILE) return false;
    const source = readSource(file);
    return extractMockModuleSpecifiers(source).some((specifier) => resolvesToStore(specifier, file));
  });
}

/**
 * Exported so a file that legitimately embeds mock.module(store.ts, ...) as
 * fixture text can pin the expected count instead of exempting itself by
 * filename, which would stay blind to a real violation added later.
 */
export function countStoreMockSpecifiers(source: string, fromFile: string): number {
  return extractMockModuleSpecifiers(source).filter((specifier) => resolvesToStore(specifier, fromFile)).length;
}
