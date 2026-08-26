// Card 1aa69066 (H2) review, blocker F3: desktop/src/main/detect/safe-strip.ts.

import { expect, test } from "bun:test";
import { createSafeStripper } from "../desktop/src/main/detect/safe-strip.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const ST_8BIT = String.fromCharCode(0x9c);

test("plain text passes through unchanged", () => {
  const s = createSafeStripper();
  expect(s.feed("hello world")).toBe("hello world");
});

// Card 1aa69066 review round 3, non-blocking T6: feed()'s fast path
// (`mode === 'idle' && no ESC in this chunk -> return chunk unchanged`)
// must NOT trigger for a no-ESC chunk that arrives WHILE a sequence from a
// PREVIOUS call is still unresolved -- the guard checks `mode`, not just
// "no ESC in this chunk", precisely so this case still goes through the
// real state machine instead of leaking the in-progress payload as plain
// text.
test("the no-ESC fast path does not fire mid-sequence: a plain-looking chunk arriving while an OSC is still open is still consumed as payload, not leaked", () => {
  const s = createSafeStripper();
  const chunk1 = s.feed(`${ESC}]0;`); // opens the OSC, mode is now 'osc'
  const chunk2 = s.feed(`plain looking text with no ESC at all${BEL}after`); // no ESC in THIS chunk
  expect(chunk1).toBe("");
  expect(chunk2).toBe("after"); // the "plain looking" part was OSC payload, discarded
});

test("a complete CSI sequence within one feed() call is stripped, surrounding text kept", () => {
  const s = createSafeStripper();
  expect(s.feed(`a${ESC}[31mb${ESC}[0mc`)).toBe("abc");
});

test("a complete OSC sequence within one feed() call is stripped, surrounding text kept", () => {
  const s = createSafeStripper();
  expect(s.feed(`a${ESC}]0;title${BEL}b`)).toBe("ab");
});

test("OSC terminated by ST (ESC \\\\) is also stripped", () => {
  const s = createSafeStripper();
  expect(s.feed(`a${ESC}]0;title${ST}b`)).toBe("ab");
});

// Card 1aa69066 review round 3, blocker T2: named gap closed. xterm in
// UTF-8 mode never emits this, but a raw/non-UTF-8 byte stream can, and it
// was the shortest path to the permanent-swallow bug this same round found.
test("OSC terminated by the 8-bit ST (single byte 0x9c) is also stripped", () => {
  const s = createSafeStripper();
  expect(s.feed(`a${ESC}]0;title${ST_8BIT}b`)).toBe("ab");
});

// The core property this module exists for: an UNTERMINATED escape sequence
// never leaks its raw bytes (including any glyph it carries) into the
// output of the chunk that contains its incomplete head.
test("an OSC head with NO terminator in this chunk emits NOTHING for it -- not the raw bytes", () => {
  const s = createSafeStripper();
  expect(s.feed(`before${ESC}]0;⣋ glyph-carrying-title-not-yet-terminated`)).toBe("before");
});

test("fragmented OSC: the glyph never appears in EITHER chunk's output, and text after the terminator resumes", () => {
  const s = createSafeStripper();
  const chunk1 = s.feed(`${ESC}]0;⣋ Claude`);
  const chunk2 = s.feed(` is thinking${BEL}after`);
  expect(chunk1).toBe("");
  expect(chunk2).toBe("after");
  expect(chunk1 + chunk2).not.toContain("⣋");
});

test("fragmented mid-terminator (ESC of ST in one chunk, backslash in the next)", () => {
  const s = createSafeStripper();
  const chunk1 = s.feed(`${ESC}]0;title${ESC}`);
  const chunk2 = s.feed(`\\after`);
  expect(chunk1).toBe("");
  expect(chunk2).toBe("after");
});

test("fragmented CSI sequence across chunks is also held back and never leaked", () => {
  const s = createSafeStripper();
  const chunk1 = s.feed(`a${ESC}[3`);
  const chunk2 = s.feed(`1mb`);
  expect(chunk1).toBe("a");
  expect(chunk2).toBe("b");
});

test("a lone ESC not followed by '[' or ']' is emitted as literal text (with the following char)", () => {
  const s = createSafeStripper();
  expect(s.feed(`a${ESC}Xb`)).toBe(`a${ESC}Xb`);
});

test("introducer split across chunks: ESC in one chunk, ']' in the next", () => {
  const s = createSafeStripper();
  const chunk1 = s.feed("before" + ESC);
  const chunk2 = s.feed(`]0;t${BEL}after`);
  expect(chunk1).toBe("before");
  expect(chunk2).toBe("after");
});

// Card 1aa69066 review round 3, blocker T2: a never-terminated OSC head
// used to make the OSC branch stay in 'osc' mode FOREVER (no length-cap
// escape hatch, unlike the CSI branch), swallowing the entire rest of the
// stream silently and permanently -- measured, review: `feed(ESC+']')`
// followed by anything at all returned `""` forever after. Fixed by
// aligning the OSC branch on the CSI branch's own abandon posture: past
// OSC_MAX_LEN, resume 'idle' and let subsequent bytes through as ordinary
// text (the same accepted fail-open-toward-not-losing-data tradeoff the
// CSI branch already makes), rather than requiring an actual terminator
// that adversarial/non-conforming input may never send.
test("a never-terminated OSC self-recovers once past the length cap, WITHOUT needing an actual terminator", () => {
  const s = createSafeStripper();
  s.feed(`${ESC}]0;`);
  for (let i = 0; i < 5; i++) s.feed("x".repeat(1000)); // crosses OSC_MAX_LEN (4096) partway through
  // Recovered: plain text fed AFTER the cap passes through normally, no
  // terminator was ever sent.
  expect(s.feed("plain text, no terminator anywhere")).toBe("plain text, no terminator anywhere");
});

test("a never-terminated OSC does not grow memory without bound (each call's cost stays proportional to that call's input)", () => {
  const s = createSafeStripper();
  s.feed(`${ESC}]0;`);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) s.feed("y".repeat(2000)); // 4M chars total across calls
  const ms = performance.now() - t0;
  // Generous ceiling: bounded per-call cost means this stays fast regardless
  // of how many prior calls happened -- an O(total-ever-fed) implementation
  // would be orders of magnitude slower here.
  expect(ms).toBeLessThan(500);
});

test("two instances never share state", () => {
  const a = createSafeStripper();
  const b = createSafeStripper();
  a.feed(`${ESC}]0;`); // a is now mid-OSC
  expect(b.feed("plain")).toBe("plain"); // b is unaffected
});
