import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createOscParser, type OscSnapshot } from "../desktop/src/main/detect/osc.ts";
import { stripAnsi as attentionStripAnsi } from "../desktop/src/main/attention.ts";
import { stripAnsi as quotaStripAnsi } from "../desktop/src/main/quota.ts";
import { stripAnsi as startupAckStripAnsi } from "../desktop/src/main/startup-ack.ts";
import { stripAnsi as thinkingStripAnsi } from "../desktop/src/main/thinking.ts";
import { createXtermScreen } from "../desktop/src/main/xterm-screen.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

function osc(ps: string, body: string, terminator: string = BEL): string {
  return `${ESC}]${ps};${body}${terminator}`;
}

// ----- 1. Behavioural tests of createOscParser() --------------------------

test("title (OSC 0) and progress (OSC 9;4) are the LAST seen, no history", () => {
  const p = createOscParser();
  p.feed(osc("0", "first title"));
  const snap = p.feed(osc("0", "second title") + osc("9", "4;42"));
  expect(snap.title).toBe("second title");
  expect(snap.progress).toBe("42");
});

test("OSC 2 also sets title, same as OSC 0", () => {
  const p = createOscParser();
  const snap = p.feed(osc("2", "window title via OSC 2"));
  expect(snap.title).toBe("window title via OSC 2");
});

test("titleSeq increments on OSC 2 exactly like OSC 0, not just OSC 0", () => {
  const p = createOscParser();
  const snap = p.feed(osc("2", "window title via OSC 2"));
  expect(snap.titleSeq).toBe(1);
});

test("titleSeq does NOT increment on OSC 9;4 (progress) or OSC 777 (notify) -- only title (0/2) counts", () => {
  const progress = createOscParser();
  expect(progress.feed(osc("9", "4;42")).titleSeq).toBe(0);

  const notify = createOscParser();
  expect(notify.feed(osc("777", "notify;Claude Code;Claude needs your permission")).titleSeq).toBe(0);
});

test("OSC 777 exposes the notify body", () => {
  const p = createOscParser();
  const snap = p.feed(osc("777", "notify;Claude Code;Claude needs your permission"));
  expect(snap.notify).toEqual({ body: "Claude needs your permission" });
});

test("a semicolon inside the notify body survives verbatim (only the first two fields are structural)", () => {
  const p = createOscParser();
  const snap = p.feed(osc("777", "notify;Claude Code;body; with; semicolons"));
  expect(snap.notify?.body).toBe("body; with; semicolons");
});

test("two back-to-back OSC sequences in the same chunk are both captured, not just the first", () => {
  const p = createOscParser();
  const snap = p.feed(osc("0", "busy title") + osc("9", "4;7"));
  expect(snap.title).toBe("busy title");
  expect(snap.progress).toBe("7");
});

test("ST (ESC \\\\) terminator works exactly like BEL", () => {
  const p = createOscParser();
  const snap = p.feed(osc("0", "st-terminated", ST));
  expect(snap.title).toBe("st-terminated");
});

test("plain text around an OSC sequence is not itself parsed as payload", () => {
  const p = createOscParser();
  const snap = p.feed(`before ${osc("0", "t")} after`);
  expect(snap.title).toBe("t");
});

test("nothing seen yet -> all three fields null", () => {
  const p = createOscParser();
  expect(p.feed("plain text, no escapes at all")).toEqual({
    title: null,
    progress: null,
    notify: null,
    titleSeq: 0
  } satisfies OscSnapshot);
});

// ----- 2. Fragmentation across feed() calls, at multiple offsets ----------

test("fragmented at the introducer: ESC in one chunk, ']' in the next", () => {
  const p = createOscParser();
  const whole = osc("0", "split-at-introducer");
  p.feed(whole.slice(0, 1)); // just ESC
  const snap = p.feed(whole.slice(1));
  expect(snap.title).toBe("split-at-introducer");
});

test("fragmented mid-payload, at several offsets", () => {
  const whole = osc("777", "notify;Claude Code;fragmented body text");
  for (let cut = 1; cut < whole.length - 1; cut++) {
    const p = createOscParser();
    p.feed(whole.slice(0, cut));
    const snap = p.feed(whole.slice(cut));
    expect(snap.notify?.body).toBe("fragmented body text");
  }
});

test("fragmented mid-terminator: ESC of the ST in one chunk, backslash in the next", () => {
  const whole = osc("0", "split-mid-terminator", ST);
  const escIndex = whole.length - 2; // ST is the last two bytes: ESC, '\'
  const p = createOscParser();
  p.feed(whole.slice(0, escIndex + 1)); // ends exactly on the ESC of ST
  const snap = p.feed(whole.slice(escIndex + 1)); // just the '\'
  expect(snap.title).toBe("split-mid-terminator");
});

test("a byte-at-a-time feed reconstructs the same payload as one whole feed()", () => {
  const whole = osc("777", "notify;Claude Code;byte at a time");
  const p = createOscParser();
  let snap: OscSnapshot = { title: null, progress: null, notify: null, titleSeq: 0 };
  for (const ch of whole) snap = p.feed(ch);
  expect(snap.notify?.body).toBe("byte at a time");
});

test("an ESC inside an in-progress OSC payload that is NOT followed by a backslash is literal payload content, not a false terminator", () => {
  const p = createOscParser();
  // ESC not followed by '\' mid-payload, then the real terminator.
  const snap = p.feed(`${ESC}]0;a${ESC}Xb${BEL}`);
  expect(snap.title).toBe(`a${ESC}Xb`);
});

// ----- 3. Length cap: a never-terminated sequence does not grow unbound ---

test("a never-terminated OSC sequence stops accumulating past the cap and does not apply a payload once terminated", () => {
  const p = createOscParser();
  // Well past OSC_MAX_LEN (4096), never terminated in this feed() call.
  p.feed(`${ESC}]0;${"x".repeat(20_000)}`);
  // Now terminate it -- the capped sequence must be dropped, not applied.
  const snap = p.feed(BEL);
  expect(snap.title).toBeNull();
});

test("after a capped sequence is finally terminated, the NEXT real OSC sequence is parsed normally (not swallowed)", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;${"x".repeat(20_000)}`); // never terminated here -- abandons to 'idle' as soon as the cap is exceeded
  p.feed(BEL); // arrives in 'idle' now -- a no-op, nothing left to terminate
  const snap = p.feed(osc("0", "after the cap"));
  expect(snap.title).toBe("after the cap");
});

test("feeding a capped sequence's overflow across MANY small chunks still bounds memory (no throw, no growth-dependent slowdown)", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;`);
  for (let i = 0; i < 50; i++) p.feed("x".repeat(1000)); // 50,000 chars total, well over the cap
  const snap = p.feed(BEL);
  expect(snap.title).toBeNull();
});

// The cap can also be exceeded from the 'in-osc-esc-seen' state: a held-back
// ESC that turns out not to be a real ST is appended via appendAndCheckCap,
// which can itself push buf past OSC_MAX_LEN on the very next feed()'s first
// character.
test("cap overflow triggered from 'in-osc-esc-seen' (a pending held-back ESC pushes buf past the cap) abandons to idle -- the next well-formed OSC sequence is parsed normally, not merged with the abandoned one's bytes", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;${"x".repeat(4094)}${ESC}`); // buf = "0;" + 4094 x's = exactly 4096 (at, not over, the cap); trailing ESC held pending
  const snap = p.feed(`A${osc("0", "after")}`); // 'A' triggers the pending-ESC append, overflowing buf by one
  expect(snap.title).toBe("after");
});

test("a well-formed OSC nested after an oversized payload is applied", () => {
  const p = createOscParser();
  const snap = p.feed(`${ESC}]0;${"y".repeat(9000)}${osc("0", "EVIL")}`);
  expect(snap.title).toBe("EVIL");
});

test("a never-terminated, over-cap OSC head does NOT swallow the next well-formed OSC sequence that follows with no terminator sent for the abandoned one", () => {
  const p = createOscParser();
  p.feed(`${ESC}]0;${"x".repeat(20_000)}`); // never terminated, well past OSC_MAX_LEN
  // No BEL/ST sent for the abandoned head -- straight into a brand-new,
  // complete, well-formed OSC sequence in the very next feed() call.
  const snap = p.feed(osc("0", "real title"));
  expect(snap.title).toBe("real title");
});

test("the 8-bit ST (0x9C single byte) terminates an OSC sequence in osc.ts exactly like BEL", () => {
  const p = createOscParser();
  const snap = p.feed(osc("0", "st8-terminated", String.fromCharCode(0x9c)));
  expect(snap.title).toBe("st8-terminated");
});

// ----- 5. No shared state between two concurrent sessions -----------------

test("two parser instances fed interleaved, fragmented chunks never leak state into each other", () => {
  const a = createOscParser();
  const b = createOscParser();

  const wholeA = osc("0", "session A title");
  const wholeB = osc("777", "notify;Claude Code;session B notify");

  const cutA = 8;
  const cutB = 12;

  // Interleave: A's first half, B's first half, A's second half, B's second half.
  a.feed(wholeA.slice(0, cutA));
  b.feed(wholeB.slice(0, cutB));
  const snapA = a.feed(wholeA.slice(cutA));
  const snapB = b.feed(wholeB.slice(cutB));

  expect(snapA.title).toBe("session A title");
  expect(snapA.notify).toBeNull();
  expect(snapB.notify?.body).toBe("session B notify");
  expect(snapB.title).toBeNull();
});

test("two instances constructed from the SAME factory function do not share the module (mint-fresh-object sanity check)", () => {
  const a = createOscParser();
  const b = createOscParser();
  a.feed(osc("0", "only in A"));
  const snapB = b.feed("no osc here at all");
  expect(snapB.title).toBeNull();
});

const REPO_ROOT = join(import.meta.dir, "..");
const SESSION_SERVICE_PATH = join(REPO_ROOT, "desktop/src/main/session-service.ts");

function extractOscSnapshotBody(src: string): string {
  const pattern = /oscSnapshot\(id: string\): OscSnapshot \| null \{/;
  const m = pattern.exec(src);
  if (!m) throw new Error("oscSnapshot(id) not found in session-service.ts -- has it been renamed?");
  const braceStart = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart + 1, i);
    }
  }
  throw new Error("oscSnapshot(id) found but its brace block never closed");
}

test("SessionService.oscSnapshot(id): returns null for an unknown session, and feeding an empty chunk reads without mutating", () => {
  const body = extractOscSnapshotBody(readFileSync(SESSION_SERVICE_PATH, "utf-8"));
  // eslint-disable-next-line no-new-func -- extracted from the real source text, not user input
  const fn = new Function("id", body) as (this: unknown, id: string) => OscSnapshot | null;

  expect(fn.call({ oscParsers: new Map() }, "unknown-session")).toBeNull();

  const parser = createOscParser();
  parser.feed(`${ESC}]0;a real title${BEL}`);
  const self = { oscParsers: new Map([["s1", parser]]) };
  expect(fn.call(self, "s1")).toEqual({
    title: "a real title",
    progress: null,
    notify: null,
    titleSeq: 1
  });
  expect(fn.call(self, "s1")).toEqual({
    title: "a real title",
    progress: null,
    notify: null,
    titleSeq: 1
  });
});

const PTY_DATA_HANDLER_ANCHOR = "this.pty.on('data', (e: { id: string; data: string }) => {";

function extractPtyDataHandlerBody(src: string): string {
  const start = src.indexOf(PTY_DATA_HANDLER_ANCHOR);
  if (start === -1) {
    throw new Error(
      `PTY_DATA_HANDLER_ANCHOR not found in session-service.ts -- the pty.on('data', ...) ` +
        `handler was renamed or reshaped; update the anchor in tests/desktop-osc.test.ts`
    );
  }
  const braceStart = start + PTY_DATA_HANDLER_ANCHOR.length - 1; // the "{" itself
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error("PTY_DATA_HANDLER_ANCHOR found but its brace block never closed");
}

function discoverFeedFields(handlerBody: string): string[] {
  const fields = new Set<string>();
  let m: RegExpExecArray | null;

  const direct = /this\.(\w+)\??\.feed\(\s*e\.id\b/g;
  while ((m = direct.exec(handlerBody))) fields.add(m[1]!);

  const localToField = new Map<string, string>();
  const assign = /(?:const|let)\s+(\w+)\s*=\s*this\.(\w+)\b/g;
  while ((m = assign.exec(handlerBody))) localToField.set(m[1]!, m[2]!);
  const destructure = /(?:const|let)\s*\{\s*([^}]+?)\s*\}\s*=\s*this\b/g;
  while ((m = destructure.exec(handlerBody))) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().split(/\s*:\s*/)[0]?.trim();
      if (name) localToField.set(name, name);
    }
  }

  const viaLocal = /(\w+)\??\.feed\(\s*e\.id\b/g;
  while ((m = viaLocal.exec(handlerBody))) {
    const field = localToField.get(m[1]!);
    if (field) fields.add(field);
  }

  return [...fields].sort();
}

function resolveFieldToFile(sessionServiceSrc: string, field: string): string {
  const ctorRe = new RegExp(`private ${field}(?:\\s*:\\s*\\w+)?\\s*=\\s*new\\s+(\\w+)\\(`);
  const ctorMatch = ctorRe.exec(sessionServiceSrc);
  if (!ctorMatch) {
    throw new Error(`no "private ${field} = new <Class>(...)" found in session-service.ts`);
  }
  const className = ctorMatch[1]!;
  const importRe = new RegExp(`import\\s*\\{[^}]*\\b${className}\\b[^}]*\\}\\s*from\\s*['"](\\.[^'"]+)['"]`);
  const importMatch = importRe.exec(sessionServiceSrc);
  if (!importMatch) {
    throw new Error(`no import statement found for class ${className} (field ${field})`);
  }
  const relFromMain = importMatch[1]!.replace(/^\.\//, "");
  return `desktop/src/main/${relFromMain}.ts`;
}

const OSC_PROBE_MARKER = "OSC_COVERAGE_PROBE_MARKER";
function oscProbeChunk(): string {
  return `before${ESC}]0;${OSC_PROBE_MARKER}${BEL}after`;
}

interface DetectorAdapter {
  strip(chunk: string): string | Promise<string>;
}

const DETECTOR_ADAPTERS: Record<string, DetectorAdapter> = {
  "desktop/src/main/attention.ts": { strip: attentionStripAnsi },
  "desktop/src/main/quota.ts": { strip: quotaStripAnsi },
  "desktop/src/main/startup-ack.ts": { strip: startupAckStripAnsi },
  "desktop/src/main/xterm-screen.ts": {
    strip: async (chunk) => {
      const screen = createXtermScreen({ cols: 120, rows: 40, reportError: () => undefined });
      screen.feed(chunk);
      await screen.drain();
      const read = screen.read();
      screen.dispose();
      if (read.status !== "ready") throw new Error(`xterm screen unavailable: ${read.reason}`);
      return read.snapshot.lines.join("\n");
    }
  }
};

interface DetectorExemption {
  reason: string;
}

const EXEMPT_DETECTORS: Record<string, DetectorExemption> = {
  "desktop/src/main/thinking.ts": {
    reason: "BUSY_RE does not match live signals, so its input cannot affect attention state."
  }
};

async function auditDetectors(
  paths: string[],
  exemptions: Record<string, DetectorExemption>,
  adapters: Record<string, DetectorAdapter> = DETECTOR_ADAPTERS
): Promise<string[]> {
  const violations: string[] = [];
  const chunk = oscProbeChunk();
  for (const path of paths) {
    if (Object.hasOwn(exemptions, path)) continue;
    const adapter = adapters[path];
    if (!adapter) {
      violations.push(
        `${path}: no behavioural adapter registered in DETECTOR_ADAPTERS -- a newly discovered ` +
          `live PTY-data consumer fails CLOSED until one is added, it is never silently skipped`
      );
      continue;
    }
    const out = await adapter.strip(chunk);
    if (out.includes(OSC_PROBE_MARKER)) {
      violations.push(`${path}: the OSC payload survived its real strip mechanism (behavioural probe)`);
      continue;
    }
    // Require ordinary text so a marker-only check cannot accept a swallowed chunk.
    if (!(out.includes("before") && out.includes("after"))) {
      violations.push(`${path}: ordinary text around the OSC sequence did not survive its real strip mechanism (behavioural probe)`);
    }
  }
  return violations;
}

test("every discovered live PTY detector strips OSC or has an explicit exemption", async () => {
  const sessionServiceSrc = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const handlerBody = extractPtyDataHandlerBody(sessionServiceSrc);
  const fields = discoverFeedFields(handlerBody);

  expect(fields).toEqual(["attentionDetector", "quotaDetector", "screenGuard", "startupAckDetector", "thinkingDetector"]);

  const paths = fields.map((field) => resolveFieldToFile(sessionServiceSrc, field));
  const violations = await auditDetectors(paths, EXEMPT_DETECTORS);
  expect(violations).toEqual([]);
});

test("EXEMPT_DETECTORS only names a field that is actually discovered and whose REAL stripAnsi genuinely lets the OSC probe through (a stale exemption is silent, not caught elsewhere)", () => {
  const sessionServiceSrc = readFileSync(SESSION_SERVICE_PATH, "utf-8");
  const handlerBody = extractPtyDataHandlerBody(sessionServiceSrc);
  const fields = discoverFeedFields(handlerBody);
  const discoveredPaths = new Set(fields.map((f) => resolveFieldToFile(sessionServiceSrc, f)));

  for (const [path, entry] of Object.entries(EXEMPT_DETECTORS)) {
    expect(discoveredPaths.has(path), `EXEMPT_DETECTORS names ${path}, which discovery did not find wired to live PTY data`).toBe(true);
    expect(entry.reason.trim().length, `EXEMPT_DETECTORS["${path}"] reason is too short`).toBeGreaterThan(20);
  }
  expect(
    thinkingStripAnsi(oscProbeChunk()).includes(OSC_PROBE_MARKER),
    'EXEMPT_DETECTORS["desktop/src/main/thinking.ts"] is unnecessary: its stripAnsi now removes OSC'
  ).toBe(true);
});

test("auditDetectors: a synthetic file whose strip does NOT remove the OSC probe is reported unless exempted", async () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  // eslint-disable-next-line no-control-regex -- CSI-only, genuinely does not touch OSC
  const csiOnly = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const adapters = { [fakePath]: { strip: csiOnly } };
  expect(await auditDetectors([fakePath], {}, adapters)).toEqual([
    `${fakePath}: the OSC payload survived its real strip mechanism (behavioural probe)`
  ]);
  expect(await auditDetectors([fakePath], { [fakePath]: { reason: "synthetic fixture" } }, adapters)).toEqual([]);
});

test("auditDetectors: a strip that swallows the WHOLE chunk (return '') drops the marker too, but also drops the surrounding ordinary text -- must still be reported", async () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  const swallowAll: DetectorAdapter["strip"] = () => "";
  expect(await auditDetectors([fakePath], {}, { [fakePath]: { strip: swallowAll } })).toEqual([
    `${fakePath}: ordinary text around the OSC sequence did not survive its real strip mechanism (behavioural probe)`
  ]);
});

test("auditDetectors: no text trick (comment, unrelated regex, string literal) can pass a CSI-only strip -- only real OSC removal does", async () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  const csiOnlyWithDecoys = (s: string) =>
    s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const adapters = { [fakePath]: { strip: csiOnlyWithDecoys } };
  expect(await auditDetectors([fakePath], {}, adapters)).toEqual([
    `${fakePath}: the OSC payload survived its real strip mechanism (behavioural probe)`
  ]);
});

test("auditDetectors: a genuinely OSC-aware strip (regex, \\x1b factored out of the alternation -- the shape attention.ts/quota.ts/startup-ack.ts actually ship) is not reported", async () => {
  const fakePath = "desktop/src/main/fake-detector.ts";
  // eslint-disable-next-line no-control-regex
  const realShape = (s: string) =>
    s.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\))/g, "");
  expect(await auditDetectors(["desktop/src/main/fake-detector.ts"], {}, { [fakePath]: { strip: realShape } })).toEqual([]);
});

test("auditDetectors: the real xterm-screen.ts adapter removes the OSC probe", async () => {
  expect(await auditDetectors(["desktop/src/main/xterm-screen.ts"], {})).toEqual([]);
});

test("auditDetectors: a discovered path with no registered adapter is reported by name, not silently skipped", async () => {
  const newPath = "desktop/src/main/a-brand-new-detector.ts";
  expect(await auditDetectors([newPath], {})).toEqual([
    `${newPath}: no behavioural adapter registered in DETECTOR_ADAPTERS -- a newly discovered live PTY-data consumer fails CLOSED until one is added, it is never silently skipped`
  ]);
  expect(await auditDetectors([newPath], { [newPath]: { reason: "not a real detector, test fixture" } })).toEqual([]);
});

test("discoverFeedFields discovers a transformed payload argument", () => {
  const handlerBody = "this.fakeDetector.feed(e.id, String(e.data))\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: optional chaining (?.feed) is discovered", () => {
  const handlerBody = "this.fakeDetector?.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: a field aliased through an intermediate local variable is discovered", () => {
  const handlerBody = "const p = this.fakeDetector\np.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: a field pulled off `this` via destructuring is discovered", () => {
  const handlerBody = "const { fakeDetector } = this\nfakeDetector.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual(["fakeDetector"]);
});

test("discoverFeedFields: an unresolved local variable (not derived from `this`) is never mistaken for a field", () => {
  const handlerBody = "const p = makeSomething()\np.feed(e.id, e.data)\n";
  expect(discoverFeedFields(handlerBody)).toEqual([]);
});
