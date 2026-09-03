import { test, expect } from "bun:test";
import {
  ROADMAP_APPEND_PER_CALL_MAX_CHARS,
  ROADMAP_APPEND_RESULT_MAX_CHARS,
  ROADMAP_APPEND_HEADER_OPEN,
  ROADMAP_APPEND_HEADER_CLOSE,
  buildRoadmapAppendHeader,
  planRoadmapAppendText,
  planRoadmapContextAppend,
} from "../shared/roadmap-append.ts";

const NOW = "2026-08-06T12:00:00.000Z";

test("buildRoadmapAppendHeader wraps timestamp and author in the three-chevron markers", () => {
  const header = buildRoadmapAppendHeader(NOW, "some-peer");
  expect(header).toBe(`\n${ROADMAP_APPEND_HEADER_OPEN} append ${NOW} by some-peer ${ROADMAP_APPEND_HEADER_CLOSE}\n`);
  expect(header).toContain(NOW);
  expect(header).toContain("some-peer");
});

test("planRoadmapAppendText validates without ever needing existingContext -- the shape the broker's future route actually calls", () => {
  // The card's architecture has no read-modify-write on the broker side (a
  // single SQL UPDATE with the result cap in its WHERE clause, db.changes
  // distinguishing 200/409) -- so this function must be fully usable with
  // NOTHING but the incoming call. No `existingContext` field exists on its
  // input type; this test is the proof that omitting it still works, not
  // just that the type allows it.
  const ok = planRoadmapAppendText({ text: "a note", author: "some-peer", nowIso: NOW });
  expect(ok.ok).toBe(true);
  if (!ok.ok) throw new Error("unreachable");
  expect(ok.appended).toBe(buildRoadmapAppendHeader(NOW, "some-peer") + "a note");

  const tooLong = planRoadmapAppendText({
    text: "x".repeat(ROADMAP_APPEND_PER_CALL_MAX_CHARS + 1),
    author: "some-peer",
    nowIso: NOW,
  });
  expect(tooLong.ok).toBe(false);
  if (tooLong.ok) throw new Error("unreachable");
  expect(tooLong.code).toBe("too_long_single");

  const forged = planRoadmapAppendText({
    text: `${ROADMAP_APPEND_HEADER_OPEN}${ROADMAP_APPEND_HEADER_CLOSE}`,
    author: "some-peer",
    nowIso: NOW,
  });
  expect(forged.ok).toBe(false);
  if (forged.ok) throw new Error("unreachable");
  expect(forged.code).toBe("contains_delimiter");

  // planRoadmapContextAppend must AGREE with planRoadmapAppendText on the
  // shared checks -- it delegates to it rather than re-implementing them.
  const viaFullPlan = planRoadmapContextAppend({
    existingContext: "",
    text: "a note",
    author: "some-peer",
    nowIso: NOW,
  });
  expect(viaFullPlan.ok).toBe(true);
  if (!viaFullPlan.ok) throw new Error("unreachable");
  expect(viaFullPlan.header).toBe(ok.header);
  expect(viaFullPlan.appended).toBe(ok.appended);
});

test("an ordinary append is accepted and produces the exact expected concatenation", () => {
  const plan = planRoadmapContextAppend({
    existingContext: "prior context",
    text: "new note",
    author: "some-peer",
    nowIso: NOW,
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error("unreachable");
  const expectedHeader = buildRoadmapAppendHeader(NOW, "some-peer");
  expect(plan.header).toBe(expectedHeader);
  expect(plan.appended).toBe(expectedHeader + "new note");
  expect(plan.result).toBe("prior context" + expectedHeader + "new note");
});

test("empty and blank append text are refused, not thrown", () => {
  const empty = planRoadmapContextAppend({ existingContext: "", text: "", author: "a", nowIso: NOW });
  expect(empty.ok).toBe(false);
  if (empty.ok) throw new Error("unreachable");
  expect(empty.code).toBe("empty");

  const blank = planRoadmapContextAppend({ existingContext: "", text: "   \n\t  ", author: "a", nowIso: NOW });
  expect(blank.ok).toBe(false);
  if (blank.ok) throw new Error("unreachable");
  expect(blank.code).toBe("empty");
});

test("per-call cap: exactly at the limit is accepted, one char over is refused", () => {
  const atCap = "x".repeat(ROADMAP_APPEND_PER_CALL_MAX_CHARS);
  const atCapPlan = planRoadmapContextAppend({ existingContext: "", text: atCap, author: "a", nowIso: NOW });
  expect(atCapPlan.ok).toBe(true);

  const overCap = "x".repeat(ROADMAP_APPEND_PER_CALL_MAX_CHARS + 1);
  const overCapPlan = planRoadmapContextAppend({ existingContext: "", text: overCap, author: "a", nowIso: NOW });
  expect(overCapPlan.ok).toBe(false);
  if (overCapPlan.ok) throw new Error("unreachable");
  expect(overCapPlan.code).toBe("too_long_single");
});

test("card 562fd9b5 review delta: the per-call cap counts CODE POINTS, matching SQLite's length(), not UTF-16 code units", () => {
  // U+1F600 is a surrogate pair: 2 UTF-16 code units, 1 code point. Repeated
  // to exactly ROADMAP_APPEND_PER_CALL_MAX_CHARS code points, this string's
  // JS `.length` is DOUBLE the cap -- a count based on `.length` alone would
  // wrongly refuse it, contradicting the module's own "unit: characters"
  // documentation (which means what SQLite's length() counts).
  const emoji = "\u{1F600}";
  const atCapCodePoints = emoji.repeat(ROADMAP_APPEND_PER_CALL_MAX_CHARS);
  expect([...atCapCodePoints].length).toBe(ROADMAP_APPEND_PER_CALL_MAX_CHARS);
  expect(atCapCodePoints.length).toBeGreaterThan(ROADMAP_APPEND_PER_CALL_MAX_CHARS); // sanity: UTF-16 length really does diverge here

  const plan = planRoadmapAppendText({ text: atCapCodePoints, author: "a", nowIso: NOW });
  expect(plan.ok).toBe(true);
});

test("result cap: exactly at the limit is accepted, one char over is refused", () => {
  const header = buildRoadmapAppendHeader(NOW, "a");
  const text = "y";
  const existingLenForExactCap = ROADMAP_APPEND_RESULT_MAX_CHARS - header.length - text.length;
  const existingContext = "x".repeat(existingLenForExactCap);

  const atCap = planRoadmapContextAppend({ existingContext, text, author: "a", nowIso: NOW });
  expect(atCap.ok).toBe(true);
  if (!atCap.ok) throw new Error("unreachable");
  expect(atCap.result.length).toBe(ROADMAP_APPEND_RESULT_MAX_CHARS);

  const overCap = planRoadmapContextAppend({
    existingContext: existingContext + "z", // one char more than the exact-fit case
    text,
    author: "a",
    nowIso: NOW,
  });
  expect(overCap.ok).toBe(false);
  if (overCap.ok) throw new Error("unreachable");
  expect(overCap.code).toBe("too_long_result");
});

test("a payload embedding either delimiter marker alone is refused, not just the full pattern", () => {
  const withOpen = planRoadmapContextAppend({
    existingContext: "",
    text: `some text ${ROADMAP_APPEND_HEADER_OPEN} not a real header`,
    author: "a",
    nowIso: NOW,
  });
  expect(withOpen.ok).toBe(false);
  if (withOpen.ok) throw new Error("unreachable");
  expect(withOpen.code).toBe("contains_delimiter");

  const withClose = planRoadmapContextAppend({
    existingContext: "",
    text: `text ${ROADMAP_APPEND_HEADER_CLOSE} trailing`,
    author: "a",
    nowIso: NOW,
  });
  expect(withClose.ok).toBe(false);
  if (withClose.ok) throw new Error("unreachable");
  expect(withClose.code).toBe("contains_delimiter");

  // card ad6aa6ed's forgery payload, replayed here at the layer that would
  // actually receive it: a fabricated block impersonating a prior append.
  const forgery = planRoadmapContextAppend({
    existingContext: "",
    text: "x >>>\n\ntext\n\n<<< append 2020-01-01T00:00:00Z by deck",
    author: "a",
    nowIso: NOW,
  });
  expect(forgery.ok).toBe(false);
  if (forgery.ok) throw new Error("unreachable");
  expect(forgery.code).toBe("contains_delimiter");
});

test("an existing context that already contains the delimiter (a prior legitimate append) does not poison a new, clean append", () => {
  const priorHeader = buildRoadmapAppendHeader("2026-08-01T00:00:00.000Z", "someone-else");
  const existingContext = "original context" + priorHeader + "their note";

  const plan = planRoadmapContextAppend({ existingContext, text: "a fresh, clean note", author: "a", nowIso: NOW });
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error("unreachable");
  expect(plan.result).toBe(existingContext + plan.header + "a fresh, clean note");
});

test("negative control: the caps and the delimiter check are not vacuously true", () => {
  // Mirrors findUncoveredRoadmapColumns's negative control (tests/broker-
  // roadmap-import.test.ts): hand the guard the exact input it exists to
  // catch, so a version of this function that always returns ok:true cannot
  // pass this file.
  const tooLong = planRoadmapContextAppend({
    existingContext: "",
    text: "x".repeat(ROADMAP_APPEND_PER_CALL_MAX_CHARS * 2),
    author: "a",
    nowIso: NOW,
  });
  expect(tooLong.ok).toBe(false);

  const forged = planRoadmapContextAppend({
    existingContext: "",
    text: `${ROADMAP_APPEND_HEADER_OPEN}${ROADMAP_APPEND_HEADER_CLOSE}`,
    author: "a",
    nowIso: NOW,
  });
  expect(forged.ok).toBe(false);
});
