// Every `onX` property of the DeckApi object literal in preload/index.ts must
// resolve to a channel with a real emitter (a literal broadcast or
// webContents.send, or a named wrapper forwarding to one) in
// desktop/src/main/*.ts. Both sides are discovered by scanning the files, not
// from a fixed channel list; the consumer side is anchored to the properties
// of `api`, not to the subscribe verbs, and an unresolvable channel value is
// UNPARSED and fails loudly rather than being dropped.
// Not covered: a producer call in unreachable code reads as wired; a channel
// named by a constant is UNPARSED; an onX declared on DeckApi but never
// implemented is TypeScript's job. The producer scan is non-recursive and the
// consumer scan reads only preload/index.ts: splitting either across files
// silently shrinks the coverage.

import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";

const REPO_ROOT = join(import.meta.dir, "..");
const PRELOAD_TS = join(REPO_ROOT, "desktop", "src", "preload", "index.ts");
const MAIN_DIR = join(REPO_ROOT, "desktop", "src", "main");

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
