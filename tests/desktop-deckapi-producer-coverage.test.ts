// Domain-wide guard against the "declared consumer, no producer" shape --
// the general case of the sandbox:changed bug this repo already paid for
// once (CLAUDE.md: "A comment or class that ASSERTS a guarantee must be
// wired to it... DeckApi.onX declared, multiplexed and subscribed compiles
// and tests green with NO producer"). Mutation review on the ask_operator
// lot (M8) reproduced it live: replacing `broadcast('approvals:pending',
// list)` in index.ts with `void 0` left 67 tests green, because no file
// under tests/ contains the string 'approvals:pending'. spec_fb1c615c.
//
// Scope: every `onX` PROPERTY of the `const api: DeckApi = { ... }` object
// literal in desktop/src/preload/index.ts must resolve to a channel string,
// and that channel must have a real emitter -- a literal `broadcast('chan',
// ...)` or `mainWindow?.webContents.send('chan', ...)` call, or a call to a
// named single-line wrapper function that itself forwards to one of those
// two verbs (the real `toRenderer` in index.ts) -- somewhere in
// desktop/src/main/*.ts.
//
// The consumer side is anchored to the SET OF PROPERTIES on `api`, not to
// the `subscribe`/`multiplex` VERBS an earlier version of this file matched
// on (mutation review, second pass): a property wired some OTHER way --
// e.g. `onGhostFeed: (l) => ipcRenderer.on('ghost:feed', l)`, bypassing both
// helpers -- still enters the domain, because every `on\w+` key is walked
// regardless of how its value is shaped. A channel a property's value
// contains no literal for at all (and doesn't call a locally-declared
// `multiplex(...)`-bound wrapper either) is counted as UNPARSED and fails
// the guard loudly, the same fail-closed contract the producer side already
// had. This is what makes "a new onX added tomorrow is automatically in
// scope" a true claim rather than one that only holds for onX methods wired
// through the two verbs this file happened to recognize first (the earlier
// wording overclaimed exactly this, per mutation review).
//
// Both sides are DISCOVERED by scanning the actual files, not read from a
// fixed channel list (CLAUDE.md's gating-coverage rule, growth half).
//
// WHAT THIS DOES NOT COVER, stated rather than assumed (D7/D8 from review):
//  - A producer call that exists only in UNREACHABLE code (a dead branch,
//    an unused function, code after an early return) is textually
//    indistinguishable from a live one to this scanner -- static text
//    presence is treated as evidence of wiring, not runtime reachability.
//    No test claims to catch this; it is a real, named limit.
//  - The OTHER gap in the same chain -- DeckApi declares an `onX` method
//    that preload's own `api` object never implements at all -- is a
//    DIFFERENT bug and is not re-covered here. It doesn't need to be: `const
//    api: DeckApi = { ... }` in preload/index.ts is a plain object literal
//    assigned to an interface-typed binding, so TypeScript's structural
//    check already fails that assignment to compile if a required `onX`
//    property is missing (verified by reading preload/index.ts:73 and
//    ordinary TS excess/missing-property assignability rules; also gated by
//    `npm run typecheck` in desktop/, since `src/preload/**/*.ts` is in
//    tsconfig.node.json's `include`). Re-implementing that check here in
//    text form would be strictly weaker than the compiler, for no benefit.
//  - A producer call written as `broadcast(SOME_CONST, x)` (a named
//    constant instead of a string literal) is not resolved to a channel
//    name -- it is counted as an UNPARSED call site instead, and the guard
//    fails loudly on any nonzero unparsed count rather than silently
//    treating it as "produced" or silently dropping it from the count. This
//    is a deliberate fail-closed choice, proven by a fixture below.
//  - A channel mentioned only inside a `//` or `/* */` comment (never real
//    code) does not satisfy the guard -- both scans strip comments before
//    matching, proven by a fixture below (this repo has a known precedent
//    of exactly this fail-open shape in an i18n orphan-key scanner).
//
// NOTED, NOT FIXED (mutation review, second pass -- recorded rather than
// corrected on purpose): the consumer scan reads ONLY
// desktop/src/preload/index.ts, and the producer scan reads
// desktop/src/main/*.ts NON-recursively (no subdirectory walk). The
// producer side fails CLOSED if an emitter moved into a subdirectory (it
// would stop being found, and the guard would correctly start reporting
// every channel that emitter used to cover as missing). The CONSUMER side
// is the asymmetric risk: if preload/index.ts were ever split into multiple
// files, this scan would silently shrink to whatever fraction still lives
// in index.ts, and the `>= 20` sanity floor below only catches the walk
// collapsing to near-zero, not losing half the properties to a sibling file
// it never reads. Fixing this would mean discovering preload source files
// the same way the producer side discovers desktop/src/main/*.ts (a
// directory walk instead of one hardcoded path) -- left as a known gap
// because preload is a single file today and no such split is planned; if
// one happens, this comment is the trigger to revisit.

import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";

const REPO_ROOT = join(import.meta.dir, "..");
const PRELOAD_TS = join(REPO_ROOT, "desktop", "src", "preload", "index.ts");
const MAIN_DIR = join(REPO_ROOT, "desktop", "src", "main");

// Quote- and backtick-aware // and /* */ stripper (same shape as the one in
// tests/desktop-approval-parity.test.ts and tests/desktop-tsconfig-flags.test.ts's
// JSONC variant -- kept local rather than shared, since sharing test-only
// utilities across test files is not this repo's established pattern and
// each copy stays trivially auditable on its own).
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Extracts the `{ ... }` body following a header regex, quote-aware.
 * Delegates to tests/_braced-body.ts (card 9e450573 Lot B dedup): `start` is
 * one past the opening `{` (same convention the shared helper's `openIdx`
 * expects, offset by one), so the call passes `start - 1`.
 */
function extractObjectBody(src: string, headerRe: RegExp): string {
  const m = src.match(headerRe);
  if (!m) throw new Error(`extractObjectBody: header not found: ${headerRe}`);
  const start = m.index! + m[0].length;
  return extractBracedBody(src, start - 1, true);
}

/** Splits an object-literal body into top-level `key: value` properties (nesting- and quote-aware). */
function splitTopLevelProps(body: string): Array<{ key: string; value: string }> {
  const segments: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let segStart = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      segments.push(body.slice(segStart, i));
      segStart = i + 1;
    }
  }
  segments.push(body.slice(segStart));

  const props: Array<{ key: string; value: string }> = [];
  for (const seg of segments) {
    let d = 0;
    let inS: string | null = null;
    let colonIdx = -1;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i]!;
      if (inS) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === inS) inS = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inS = c;
        continue;
      }
      if (c === "(" || c === "{" || c === "[") d++;
      else if (c === ")" || c === "}" || c === "]") d--;
      else if (c === ":" && d === 0) {
        colonIdx = i;
        break;
      }
    }
    if (colonIdx === -1) continue;
    const key = seg.slice(0, colonIdx).trim();
    const value = seg.slice(colonIdx + 1).trim();
    if (key) props.push({ key, value });
  }
  return props;
}

/**
 * Every `onX` property of `const api: DeckApi = { ... }`, resolved to a
 * channel string regardless of HOW it's wired: a literal quoted string
 * anywhere in the property's own value (covers `subscribe('chan', cb)`,
 * `ipcRenderer.on('chan', cb)`, or any future shape with an inline
 * literal), or -- for the `multiplex` indirection, whose literal lives in a
 * separate `const NAME = multiplex<T>('chan')` binding rather than in the
 * property's own value -- a call to a name bound that way elsewhere in the
 * same file. A property that resolves neither way is UNPARSED.
 */
function extractConsumerChannels(preloadSrc: string): { channels: string[]; unparsedCount: number } {
  const src = stripComments(preloadSrc);
  const apiBody = extractObjectBody(src, /const\s+api\s*:\s*DeckApi\s*=\s*\{/);
  const onProps = splitTopLevelProps(apiBody).filter((p) => /^on[A-Z]\w*$/.test(p.key));

  const channels: string[] = [];
  let unparsedCount = 0;
  for (const { value } of onProps) {
    const direct = value.match(/'([^']+)'/);
    if (direct) {
      channels.push(direct[1]!);
      continue;
    }
    const callMatch = value.match(/\b(\w+)\(/);
    let resolved = false;
    if (callMatch) {
      const bindingRe = new RegExp(`const\\s+${callMatch[1]}\\s*=\\s*multiplex(?:<[^>]*>)?\\(\\s*'([^']+)'`);
      const bm = src.match(bindingRe);
      if (bm) {
        channels.push(bm[1]!);
        resolved = true;
      }
    }
    if (!resolved) unparsedCount++;
  }
  return { channels, unparsedCount };
}

// The one structural infrastructure exemption: api-registry.ts's `broadcast()`
// fans out to every registered sink, and index.ts registers the window
// itself as a sink with `addEventSink((channel, payload) =>
// mainWindow?.webContents.send(channel, payload))`. That line is the
// MECHANISM broadcast() uses to reach the window, not evidence of any one
// channel -- the real evidence is each literal `broadcast('X', ...)` call
// site, which this scan finds independently. Matched and blanked out by its
// exact structural shape (not by channel name), so it cannot silently
// swallow an unrelated future gap shaped like it.
const ADD_EVENT_SINK_RE =
  /addEventSink\(\s*\(\s*channel\s*,\s*payload\s*\)\s*=>\s*mainWindow\?\.webContents\.send\(\s*channel\s*,\s*payload\s*\)\s*\)/;

/**
 * Every `broadcast('chan', ...)` / `mainWindow?.webContents.send('chan', ...)`
 * literal call site across the given files, plus calls to any named
 * single-line wrapper function that structurally forwards its own string
 * parameter to either verb (resolves index.ts's `toRenderer`).
 */
function extractProducerChannels(filesByName: Record<string, string>): {
  channels: Set<string>;
  unparsedByFile: Record<string, number>;
} {
  const channels = new Set<string>();
  const unparsedByFile: Record<string, number> = {};

  for (const [name, rawSrc] of Object.entries(filesByName)) {
    let src = stripComments(rawSrc);
    src = src.replace(ADD_EVENT_SINK_RE, "");

    const wrapperDefRe =
      /const\s+(\w+)\s*=\s*\(\s*(\w+)\s*:\s*string[^)]*\)[^=]*=>[\s\S]*?(?:\.webContents\.send|broadcast)\(\s*\2\b/g;
    const wrapperNames = new Set<string>();
    for (const m of src.matchAll(wrapperDefRe)) wrapperNames.add(m[1]!);
    const wrapperDefCount = [...src.matchAll(wrapperDefRe)].length;

    // `(?<!this\.)` excludes session-service.ts's unrelated private zero-arg
    // `broadcast(): void` method (same name, no relation to api-registry.ts's
    // `broadcast`, always called as `this.broadcast()`). `(?<!function )`
    // excludes `broadcast`'s own exported declaration. `(?!\))` requires at
    // least one char inside the parens, which additionally excludes any
    // zero-arg call/declaration shaped like `broadcast()` on principle (a
    // real emission always carries a channel argument).
    const rawRe = /(?<!this\.)(?<!function )(?:\bbroadcast\((?!\))|\.webContents\.send\()/g;
    const rawMatches = [...src.matchAll(rawRe)];

    const literalRe = /(?<!this\.)(?<!function )(?:\bbroadcast\(|\.webContents\.send\()\s*'([^']+)'/g;
    let parsedCount = 0;
    for (const m of src.matchAll(literalRe)) {
      channels.add(m[1]!);
      parsedCount++;
    }

    for (const wname of wrapperNames) {
      const callRe = new RegExp(`\\b${wname}\\(\\s*'([^']+)'`, "g");
      for (const m of src.matchAll(callRe)) channels.add(m[1]!);
    }

    const unparsed = rawMatches.length - parsedCount - wrapperDefCount;
    if (unparsed > 0) unparsedByFile[name] = unparsed;
  }

  return { channels, unparsedByFile };
}

function diffMissingProducers(consumerChannels: string[], producerChannels: Set<string>): string[] {
  return consumerChannels
    .filter((ch) => !producerChannels.has(ch))
    .map((ch) => `no producer found for channel "${ch}"`);
}

// ----- real-repo check -----------------------------------------------------

function readMainFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(MAIN_DIR)) {
    if (f.endsWith(".ts")) out[f] = readFileSync(join(MAIN_DIR, f), "utf-8");
  }
  return out;
}

test("every DeckApi event channel wired in preload/index.ts has a real producer in desktop/src/main today", () => {
  const consumer = extractConsumerChannels(readFileSync(PRELOAD_TS, "utf-8"));
  expect(consumer.unparsedCount).toBe(0);

  const producer = extractProducerChannels(readMainFiles());
  expect(producer.unparsedByFile).toEqual({});

  expect(diffMissingProducers(consumer.channels, producer.channels)).toEqual([]);
});

test("sanity floor: the real scan finds a non-trivial number of channels both sides (catches the walk collapsing to 0)", () => {
  const consumer = extractConsumerChannels(readFileSync(PRELOAD_TS, "utf-8"));
  const producer = extractProducerChannels(readMainFiles());
  expect(consumer.channels.length).toBeGreaterThanOrEqual(20);
  expect(producer.channels.size).toBeGreaterThanOrEqual(20);
});

// ----- fixture-backed positive/negative controls ----------------------------

/** Wraps a fixture's `onX: ...` property text in the header shape extractConsumerChannels requires. */
function wrapApi(props: string): string {
  return `const api: DeckApi = {\n  ${props}\n}`;
}

test("fixture positive control: a subscribed channel with a matching literal broadcast() is not flagged", () => {
  const preload = wrapApi(`onFoo: (cb) => subscribe('foo:bar', cb)`);
  const main = { "index.ts": `broadcast('foo:bar', payload)` };
  const consumer = extractConsumerChannels(preload);
  const producer = extractProducerChannels(main);
  expect(diffMissingProducers(consumer.channels, producer.channels)).toEqual([]);
});

test("fixture: a subscribed channel with NO producer anywhere is caught (the sandbox:changed shape)", () => {
  const preload = wrapApi(`onGhost: (cb) => subscribe('ghost:channel', cb)`);
  const main = { "index.ts": `broadcast('unrelated:channel', payload)` };
  const consumer = extractConsumerChannels(preload);
  const producer = extractProducerChannels(main);
  expect(diffMissingProducers(consumer.channels, producer.channels)).toEqual([
    'no producer found for channel "ghost:channel"',
  ]);
});

test("fixture: a channel mentioned ONLY inside a comment is not treated as produced (D7.1)", () => {
  const preload = wrapApi(`onGhost: (cb) => subscribe('ghost:channel', cb)`);
  const main = {
    "index.ts": `// TODO: someday call broadcast('ghost:channel', payload) here\n/* not yet: broadcast('ghost:channel', x) */`,
  };
  const consumer = extractConsumerChannels(preload);
  const producer = extractProducerChannels(main);
  expect(diffMissingProducers(consumer.channels, producer.channels)).toEqual([
    'no producer found for channel "ghost:channel"',
  ]);
});

test("fixture: a producer call with a named constant instead of a literal is UNPARSED, not silently accepted (D7.2)", () => {
  const main = { "index.ts": `const CH = 'foo:bar'\nbroadcast(CH, payload)` };
  const producer = extractProducerChannels(main);
  expect(producer.unparsedByFile).toEqual({ "index.ts": 1 });
  expect(producer.channels.has("foo:bar")).toBe(false);
});

test("fixture: a multi-line wrapper function (arrow body on the next line) still resolves its call sites", () => {
  const preload = wrapApi(`onMenuSettings: (cb) => subscribe('menu:settings', cb)`);
  const main = {
    "index.ts":
      `const toRenderer = (channel: string, payload?: unknown): void =>\n` +
      `    mainWindow?.webContents.send(channel, payload)\n` +
      `toRenderer('menu:settings')`,
  };
  const consumer = extractConsumerChannels(preload);
  const producer = extractProducerChannels(main);
  expect(diffMissingProducers(consumer.channels, producer.channels)).toEqual([]);
});

test("fixture: the same channel produced from two different files is a plain union, not a double-flag or a crash", () => {
  const preload = wrapApi(`onWorkspaceCurrent: (cb) => subscribe('workspace:current', cb)`);
  const main = {
    "index.ts": `broadcast('workspace:current', a)`,
    "ipc.ts": `broadcast('workspace:current', b)`,
  };
  const consumer = extractConsumerChannels(preload);
  const producer = extractProducerChannels(main);
  expect(diffMissingProducers(consumer.channels, producer.channels)).toEqual([]);
  expect(producer.unparsedByFile).toEqual({});
});

test("fixture: session-service.ts's unrelated private zero-arg broadcast() method is neither a producer nor a false gap", () => {
  const main = {
    "session-service.ts": `class X {\n  private broadcast(): void {\n    this.emit('changed')\n  }\n  update() {\n    this.broadcast()\n  }\n}`,
  };
  const producer = extractProducerChannels(main);
  expect(producer.channels.size).toBe(0);
  expect(producer.unparsedByFile).toEqual({});
});

test("fixture: the addEventSink infrastructure line is excluded structurally, not treated as an unparsed gap or a channel", () => {
  const main = {
    "index.ts": `addEventSink((channel, payload) => mainWindow?.webContents.send(channel, payload))`,
  };
  const producer = extractProducerChannels(main);
  expect(producer.channels.size).toBe(0);
  expect(producer.unparsedByFile).toEqual({});
});

// ----- Garde B (mutation review, second pass): an onX property wired some
// way OTHER than subscribe()/multiplex() must still enter the domain, and a
// truly unresolvable one must fail loudly rather than being silently
// skipped because it didn't match a recognized verb. -----

test("Garde B: an onX property wired directly via ipcRenderer.on(...) (not subscribe/multiplex) still enters the domain and is caught missing a producer", () => {
  // Reproduces the exact injected mutation from mutation review: onGhostFeed
  // bypasses both recognized helpers entirely.
  const preload = wrapApi(`onGhostFeed: (l) => ipcRenderer.on('ghost:feed', l)`);
  const main = { "index.ts": `broadcast('unrelated:channel', payload)` };
  const consumer = extractConsumerChannels(preload);
  expect(consumer.channels).toContain("ghost:feed");
  expect(consumer.unparsedCount).toBe(0);
  const producer = extractProducerChannels(main);
  expect(diffMissingProducers(consumer.channels, producer.channels)).toEqual([
    'no producer found for channel "ghost:feed"',
  ]);
});

test("Garde B: an onX property with NO literal anywhere and no resolvable multiplex binding is UNPARSED, not silently dropped from the domain", () => {
  const preload = wrapApi(`onSomethingElse: (cb) => registerViaSomeOtherMechanism(cb)`);
  const consumer = extractConsumerChannels(preload);
  expect(consumer.unparsedCount).toBe(1);
  expect(consumer.channels).toEqual([]);
});

test("Garde B: the multiplex indirection (literal lives in a separate const binding, not in the property's own value) still resolves", () => {
  const preload =
    `const onPtyDataMux = multiplex<PtyDataEvent>('pty:data')\n` + wrapApi(`onPtyData: (cb) => onPtyDataMux(cb)`);
  const consumer = extractConsumerChannels(preload);
  expect(consumer.channels).toEqual(["pty:data"]);
  expect(consumer.unparsedCount).toBe(0);
});
