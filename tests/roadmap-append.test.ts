import { test, expect } from "bun:test";
import {
  ROADMAP_APPEND_HEADER_OPEN,
  ROADMAP_APPEND_HEADER_CLOSE,
  ROADMAP_APPEND_BODY_TARGET,
  buildRoadmapAppendHeader,
  getLivingRoadmapContextUnits,
  getRoadmapContextEditorProjection,
  getResultingRoadmapContextLiveLength,
  getRoadmapContextLiveLength,
  getUniqueRoadmapAppendTimestamp,
  parseRoadmapContext,
  planRoadmapAppendText,
  planRoadmapContextAppend,
  reconcileRoadmapContextForSave,
  resolveSupersededRoadmapContextTargets,
  validateRoadmapSupersedeTargets,
} from "../shared/roadmap-append.ts";

const NOW = "2026-08-06T12:00:00.000Z";

test("buildRoadmapAppendHeader wraps timestamp and author in the three-chevron markers", () => {
  const header = buildRoadmapAppendHeader(NOW, "some-peer");
  expect(header).toBe(`\n${ROADMAP_APPEND_HEADER_OPEN} append ${NOW} by some-peer ${ROADMAP_APPEND_HEADER_CLOSE}\n`);
  expect(header).toContain(NOW);
  expect(header).toContain("some-peer");
});

test("planRoadmapAppendText validates text without an existing context", () => {
  const ok = planRoadmapAppendText({ text: "a note", author: "some-peer", nowIso: NOW });
  expect(ok.ok).toBe(true);
  if (!ok.ok) throw new Error("unreachable");
  expect(ok.appended).toBe(buildRoadmapAppendHeader(NOW, "some-peer") + "a note");

  const forged = planRoadmapAppendText({
    text: `${ROADMAP_APPEND_HEADER_OPEN}${ROADMAP_APPEND_HEADER_CLOSE}`,
    author: "some-peer",
    nowIso: NOW,
  });
  expect(forged.ok).toBe(false);
  if (forged.ok) throw new Error("unreachable");
  expect(forged.code).toBe("contains_delimiter");

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

test("negative control: the delimiter check is not vacuously true", () => {
  const forged = planRoadmapContextAppend({
    existingContext: "",
    text: `${ROADMAP_APPEND_HEADER_OPEN}${ROADMAP_APPEND_HEADER_CLOSE}`,
    author: "a",
    nowIso: NOW,
  });
  expect(forged.ok).toBe(false);
});

const APPEND_A = "2026-09-22T12:00:00.000Z";
const APPEND_B = "2026-09-22T12:01:00.000Z";
const APPEND_C = "2026-09-22T12:02:00.000Z";

function codePointLength(text: string): number {
  return [...text].length;
}

test("the broker timestamp helper increments until the append target is absent", () => {
  const first = buildRoadmapAppendHeader(APPEND_A, "a") + "first";
  const secondAt = "2026-09-22T12:00:00.001Z";
  const second = buildRoadmapAppendHeader(secondAt, "b") + "second";

  expect(getUniqueRoadmapAppendTimestamp(first, APPEND_A)).toBe(secondAt);
  expect(getUniqueRoadmapAppendTimestamp(first + second, APPEND_A)).toBe("2026-09-22T12:00:00.002Z");
});

function plannedAppend(
  existingContext: string,
  nowIso: string,
  author: string,
  text: string,
  supersedes: readonly string[] = [],
): string {
  const plan = planRoadmapContextAppend({ existingContext, nowIso, author, text, supersedes });
  if (!plan.ok) throw new Error(plan.message);
  return plan.appended;
}

test("a context without an append header is one live body unit", () => {
  const context = "origin \u{1F600}";
  const units = parseRoadmapContext(context);

  expect(units).toHaveLength(1);
  expect(units[0]).toMatchObject({ kind: "body", target: ROADMAP_APPEND_BODY_TARGET, raw: context });
  expect(getRoadmapContextLiveLength(context)).toBe(codePointLength(context));
});

test("three ordinary appends keep every unit live and preserve the existing header form", () => {
  const context =
    "origin" +
    buildRoadmapAppendHeader(APPEND_A, "a") +
    "first" +
    buildRoadmapAppendHeader(APPEND_B, "b") +
    "second" +
    buildRoadmapAppendHeader(APPEND_C, "c") +
    "third";

  const units = parseRoadmapContext(context);
  const live = getLivingRoadmapContextUnits(context);

  expect(units).toHaveLength(4);
  expect(live).toEqual(units);
  expect(getRoadmapContextLiveLength(context)).toBe(codePointLength(context));
  expect(live.map((unit) => unit.raw).join("")).toBe(context);
});

test("superseding an append removes its whole raw unit including its header from the live length", () => {
  const obsolete = buildRoadmapAppendHeader(APPEND_A, "a") + "obsolete";
  const existingContext = "origin" + obsolete;
  const replacement = plannedAppend(existingContext, APPEND_B, "b", "replacement", [APPEND_A]);
  const context = existingContext + replacement;

  const [body, victim] = parseRoadmapContext(context);
  const live = getLivingRoadmapContextUnits(context);

  expect(victim).toMatchObject({ kind: "append", target: APPEND_A, raw: obsolete });
  expect(live.map((unit) => unit.raw).join("")).toBe(body!.raw + replacement);
  expect(getRoadmapContextLiveLength(context)).toBe(codePointLength(context) - codePointLength(obsolete));
});

test("an append can supersede the original body", () => {
  const replacement = plannedAppend("origin", APPEND_A, "a", "replacement", [ROADMAP_APPEND_BODY_TARGET]);
  const context = "origin" + replacement;

  const [body] = parseRoadmapContext(context);
  const live = getLivingRoadmapContextUnits(context);

  expect(body).toMatchObject({ kind: "body", raw: "origin" });
  expect(live.map((unit) => unit.raw).join("")).toBe(replacement);
  expect(getRoadmapContextLiveLength(context)).toBe(codePointLength(replacement));
});

test("one append can supersede multiple units in canonical target order", () => {
  const first = buildRoadmapAppendHeader(APPEND_A, "a") + "first";
  const second = buildRoadmapAppendHeader(APPEND_B, "b") + "second";
  const existingContext = "origin" + first + second;
  const replacement = plannedAppend(existingContext, APPEND_C, "c", "replacement", [APPEND_B, APPEND_A, ROADMAP_APPEND_BODY_TARGET]);
  const context = existingContext + replacement;

  expect(replacement).toContain(`supersedes ${ROADMAP_APPEND_BODY_TARGET}, ${APPEND_A}, ${APPEND_B}`);
  expect([...resolveSupersededRoadmapContextTargets(parseRoadmapContext(context))]).toEqual([
    ROADMAP_APPEND_BODY_TARGET,
    APPEND_A,
    APPEND_B,
  ]);
  expect(getLivingRoadmapContextUnits(context).map((unit) => unit.raw).join("")).toBe(replacement);
});

test("a superseded append keeps its own supersession effective in a chain", () => {
  const victim = buildRoadmapAppendHeader(APPEND_A, "a") + "victim";
  const beforeRefutation = "origin" + victim;
  const refutation = plannedAppend(beforeRefutation, APPEND_B, "b", "refutation", [APPEND_A]);
  const beforeCorrection = beforeRefutation + refutation;
  const correction = plannedAppend(beforeCorrection, APPEND_C, "c", "correction", [APPEND_B]);
  const context = beforeCorrection + correction;

  expect([...resolveSupersededRoadmapContextTargets(parseRoadmapContext(context))]).toEqual([APPEND_A, APPEND_B]);
  expect(getLivingRoadmapContextUnits(context).map((unit) => unit.raw).join("")).toBe("origin" + correction);
});

test("supersession targets reject missing and ambiguous units with distinct named failures", () => {
  const missing = validateRoadmapSupersedeTargets("origin", [APPEND_A]);
  expect(missing).toMatchObject({ ok: false, code: "supersede_target_missing" });
  if (missing.ok) throw new Error("unreachable");
  expect(missing.message).toContain(APPEND_A);

  const duplicateTarget = buildRoadmapAppendHeader(APPEND_A, "a") + "first" + buildRoadmapAppendHeader(APPEND_A, "b") + "second";
  const ambiguous = validateRoadmapSupersedeTargets(duplicateTarget, [APPEND_A]);
  expect(ambiguous).toMatchObject({ ok: false, code: "supersede_target_ambiguous" });
  if (ambiguous.ok) throw new Error("unreachable");
  expect(ambiguous.message).toContain(APPEND_A);
});

test("supersession targets reject duplicates and do not confuse an author named supersedes with the clause", () => {
  const context = buildRoadmapAppendHeader(APPEND_A, "supersedes") + "first";
  const duplicate = validateRoadmapSupersedeTargets(context, [APPEND_A, APPEND_A]);

  expect(duplicate).toMatchObject({ ok: false, code: "supersede_target_duplicate" });
  if (duplicate.ok) throw new Error("unreachable");
  expect(duplicate.message).toContain(APPEND_A);
  expect(parseRoadmapContext(context)[1]).toMatchObject({ author: "supersedes", supersedes: [] });
});

test("getLivingRoadmapContextUnits' concatenated raw units and getRoadmapContextLiveLength agree on codepoint count", () => {
  const obsolete = buildRoadmapAppendHeader(APPEND_A, "a") + "obsolete";
  const existingContext = "origin" + obsolete;
  const replacement = plannedAppend(existingContext, APPEND_B, "b", "replacement", [ROADMAP_APPEND_BODY_TARGET, APPEND_A]);
  const context = existingContext + replacement;
  const folded = getLivingRoadmapContextUnits(context).map((unit) => unit.raw).join("");

  expect(codePointLength(folded)).toBe(getRoadmapContextLiveLength(context));
});

test("a hypothetical append that supersedes more than it adds decreases the resulting live length", () => {
  const obsolete = buildRoadmapAppendHeader(APPEND_A, "a") + "x".repeat(300);
  const existingContext = "origin" + obsolete;
  const replacement = plannedAppend(existingContext, APPEND_B, "b", "replacement", [APPEND_A]);
  const resultingLiveLength = getResultingRoadmapContextLiveLength(existingContext, replacement);

  expect(resultingLiveLength).toBe(getRoadmapContextLiveLength(existingContext + replacement));
  expect(resultingLiveLength).toBeLessThan(getRoadmapContextLiveLength(existingContext));
});

test("only the atomic append plan can emit a validated supersession header", () => {
  const existingContext = "origin" + buildRoadmapAppendHeader(APPEND_A, "a") + "x".repeat(300);
  const missing = planRoadmapContextAppend({
    existingContext,
    text: "replacement",
    author: "b",
    nowIso: APPEND_B,
    supersedes: [APPEND_C],
  });
  expect(missing).toMatchObject({ ok: false, code: "supersede_target_missing" });

  const valid = planRoadmapContextAppend({
    existingContext,
    text: "replacement",
    author: "b",
    nowIso: APPEND_B,
    supersedes: [APPEND_A],
  });
  expect(valid).toMatchObject({ ok: true });
  if (!valid.ok) throw new Error("unreachable");
  expect(valid.header).toContain(`supersedes ${APPEND_A}`);
  expect(valid.resultLiveLength).toBeLessThan(getRoadmapContextLiveLength(existingContext));

  const buildWithUnvalidatedTargets = buildRoadmapAppendHeader as unknown as (
    nowIso: string,
    author: string,
    targets: readonly string[],
  ) => string;
  expect(() => buildWithUnvalidatedTargets(APPEND_B, "b", [APPEND_C])).toThrow("supersession targets require");
});

test("editor reconciliation keeps a superseded append at its timestamp-identified structural position", () => {
  const obsolete = buildRoadmapAppendHeader(APPEND_A, "a") + "obsolete";
  const live = plannedAppend("origin" + obsolete, APPEND_B, "b", "current", [APPEND_A]);
  const original = "origin" + obsolete + live;
  const editedLive = "origin" + live.replace("current", "edited current");

  expect(getRoadmapContextEditorProjection(original)).toEqual({ mode: "living", context: "origin" + live });
  expect(reconcileRoadmapContextForSave(original, editedLive)).toEqual({
    ok: true,
    context: "origin" + obsolete + live.replace("current", "edited current")
  });
});

test("editor reconciliation leaves an unedited expired context byte-for-byte unchanged", () => {
  const obsolete = buildRoadmapAppendHeader(APPEND_A, "a") + "obsolete";
  const live = plannedAppend("origin" + obsolete, APPEND_B, "b", "current", [APPEND_A]);
  const original = "origin" + obsolete + live;
  const projection = getRoadmapContextEditorProjection(original);

  expect(reconcileRoadmapContextForSave(original, projection.context)).toEqual({ ok: true, context: original });
});

test("editor reconciliation refuses text before a superseded body instead of folding it into expired content", () => {
  const live = plannedAppend("origin", APPEND_A, "a", "replacement", [ROADMAP_APPEND_BODY_TARGET]);
  const result = reconcileRoadmapContextForSave("origin" + live, "operator note" + live);

  expect(result).toMatchObject({ ok: false, code: "expired_body_prefix" });
});

test("an ambiguous timestamp falls back to the raw editor context", () => {
  const first = buildRoadmapAppendHeader(APPEND_A, "a") + "first";
  const second = buildRoadmapAppendHeader(APPEND_A, "b") + "second";
  const original = "origin" + first + second;

  expect(getRoadmapContextEditorProjection(original)).toEqual({ mode: "raw", context: original });
  expect(reconcileRoadmapContextForSave(original, original)).toEqual({ ok: true, context: original });
});

function reconciliationWithEditedLiveHeader(transform: (live: string) => string) {
  const obsolete = buildRoadmapAppendHeader(APPEND_A, "a") + "obsolete";
  const live = plannedAppend("origin" + obsolete, APPEND_B, "b", "current", [APPEND_A]);
  return reconcileRoadmapContextForSave("origin" + obsolete + live, "origin" + transform(live));
}

test("editor reconciliation refuses a live append that removes a supersedes target", () => {
  const result = reconciliationWithEditedLiveHeader((live) => live.replace(` supersedes ${APPEND_A}`, ""));

  expect(result).toMatchObject({ ok: false, code: "living_header_changed" });
});

test("editor reconciliation refuses a live append that adds a supersedes target", () => {
  const result = reconciliationWithEditedLiveHeader((live) => live.replace(` supersedes ${APPEND_A}`, ` supersedes ${APPEND_A}, ${APPEND_C}`));

  expect(result).toMatchObject({ ok: false, code: "living_header_changed" });
});

test("editor reconciliation refuses a live append whose author changes", () => {
  const result = reconciliationWithEditedLiveHeader((live) => live.replace("by b", "by changed-author"));

  expect(result).toMatchObject({ ok: false, code: "living_header_changed" });
});

test("editor reconciliation refuses a live append whose supersedes target changes at the same length", () => {
  const result = reconciliationWithEditedLiveHeader((live) =>
    live.replace(`supersedes ${APPEND_A}`, `supersedes ${APPEND_C}`)
  );

  expect(result).toMatchObject({ ok: false, code: "living_header_changed" });
});

test("editor reconciliation refuses a change to a later supersedes target", () => {
  const obsolete = buildRoadmapAppendHeader(APPEND_A, "a") + "obsolete";
  const live = plannedAppend(
    "origin" + obsolete,
    APPEND_B,
    "b",
    "current",
    [ROADMAP_APPEND_BODY_TARGET, APPEND_A]
  );
  const original = "origin" + obsolete + live;
  const edited = live.replace(
    `supersedes ${ROADMAP_APPEND_BODY_TARGET}, ${APPEND_A}`,
    `supersedes ${ROADMAP_APPEND_BODY_TARGET}, ${APPEND_C}`
  );

  expect(reconcileRoadmapContextForSave(original, edited)).toMatchObject({
    ok: false,
    code: "living_header_changed"
  });
});
