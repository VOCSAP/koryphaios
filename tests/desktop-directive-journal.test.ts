// A source scan proves which symbols a call site reads but not their
// composition: with nothing matched and at least one ambiguous id, a prior
// wording listed only the ambiguous ones and silently dropped the
// plainly-absent ones -- a real loss, since runDirectiveWave is
// mark-then-execute and this line is the operator's only report.
// Three probes (absent only, ambiguous only, both together) cover this; only
// the third would have caught the composition defect.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dispatchedTargetsTail,
  unreachedTargets,
  unreachedTargetsText
} from "../desktop/src/main/directive-journal.ts";

test("absent ids only: every requested id is named", () => {
  const text = unreachedTargetsText(["host-absent", "gone-peer"], []);
  expect(text).toBe("no live target: host-absent, gone-peer");
});

test("ambiguous ids only: named as ambiguous, never as absent", () => {
  const text = unreachedTargetsText(["dup-peer"], ["dup-peer"]);
  expect(text).toBe("refused: 1 ambiguous (matched more than one live tile): dup-peer");
  // The wording must not claim the target does not exist -- it exists twice.
  expect(text).not.toContain("no live target");
});

test("BOTH categories at once: neither is dropped (the regression this file exists for)", () => {
  // `ambiguous` is a SUBSET of `missing` (directive.ts's contract), so a
  // realistic input carries the ambiguous id in BOTH arrays.
  const text = unreachedTargetsText(["dup-peer", "host-absent"], ["dup-peer"]);
  expect(text).toContain("host-absent");
  expect(text).toContain("dup-peer");
  expect(text).toBe(
    "no live target: host-absent; refused: 1 ambiguous (matched more than one live tile): dup-peer"
  );
});

test("an ambiguous id is never counted twice (subset, not a competing bucket)", () => {
  const text = unreachedTargetsText(["dup-peer"], ["dup-peer"]);
  expect(text.match(/dup-peer/g)?.length).toBe(1);
});

test("nothing unreached yields an empty string, so the caller can skip journaling", () => {
  expect(unreachedTargetsText([], [])).toBe("");
});

// Presence scan: the pure function above proves the WORDING; this proves the
// real call site uses it rather than re-composing its own. Weak by nature
// (it cannot prove the arguments are the right ones), which is exactly why
// the probes above exist alongside it.
test("executeDirective journals through unreachedTargetsText at BOTH of its call sites (real file)", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"),
    "utf-8"
  );
  // Symbol + module, not the whole import statement: the specifier list grew a
  // sibling (unreachedTargets, card bf76d37f) and will grow again.
  expect(src).toMatch(/import \{[^}]*\bunreachedTargetsText\b[^}]*\} from '\.\/directive-journal'/);
  const calls = src.match(/unreachedTargetsText\(missing, ambiguous\)/g) ?? [];
  // One per branch: the no-match early return, and the partial-miss tail.
  expect(calls.length).toBe(2);
});

// ---------------------------------------------------------------------------
// Card bf76d37f: the same split, as DATA, so the buckets travel back to the
// caller instead of being journaled and then thrown away.
// ---------------------------------------------------------------------------

test("unreachedTargets: absent and ambiguous are distinct reasons, never conflated", () => {
  expect(unreachedTargets(["dup-peer", "host-absent"], ["dup-peer"])).toEqual([
    { peerId: "host-absent", reason: "no-live-target" },
    { peerId: "dup-peer", reason: "ambiguous" }
  ]);
});

test("unreachedTargets: an ambiguous id appears ONCE, as ambiguous only (subset contract)", () => {
  const out = unreachedTargets(["dup-peer"], ["dup-peer"]);
  expect(out).toEqual([{ peerId: "dup-peer", reason: "ambiguous" }]);
  expect(out.filter((u) => u.peerId === "dup-peer")).toHaveLength(1);
});

test("unreachedTargets: nothing unreached yields an empty list", () => {
  expect(unreachedTargets([], [])).toEqual([]);
});

// The point of sharing `plainMissing`: the prose and the data cannot drift.
// This probe is what would go red if one of the two grew its own subtraction.
test("unreachedTargets and unreachedTargetsText name the SAME ids for the SAME reasons", () => {
  const cases: [string[], string[]][] = [
    [["host-absent", "gone-peer"], []],
    [["dup-peer"], ["dup-peer"]],
    [["dup-peer", "host-absent"], ["dup-peer"]],
    // Out of the subset contract on purpose: an ambiguous id NOT in `missing`
    // is still reported by the text, so the structured list must not shrink
    // where the text does not.
    [["host-absent"], ["stray-dup"]]
  ];
  for (const [missing, ambiguous] of cases) {
    const text = unreachedTargetsText(missing, ambiguous);
    const data = unreachedTargets(missing, ambiguous);
    expect(new Set(data.map((u) => u.peerId))).toEqual(new Set([...missing, ...ambiguous]));
    for (const u of data) {
      expect(text).toContain(u.peerId);
      // The reason must match the SECTION of the text the id sits in.
      const absentPart = text.split("; ").find((p) => p.startsWith("no live target: ")) ?? "";
      const inAbsent = absentPart.includes(u.peerId);
      expect(inAbsent).toBe(u.reason === "no-live-target");
    }
  }
});

test("dispatchedTargetsTail: counts only, singular/plural, and an explicit zero", () => {
  expect(dispatchedTargetsTail(0, 0)).toBe("no target reached");
  expect(dispatchedTargetsTail(1, 0)).toBe("1 target");
  expect(dispatchedTargetsTail(2, 0)).toBe("2 targets");
  expect(dispatchedTargetsTail(2, 1)).toBe("2 targets, 1 unreached");
  expect(dispatchedTargetsTail(0, 3)).toBe("no target reached, 3 unreached");
});

// executeDirective's own module imports electron and cannot be imported under
// bun test, so its return value is the one thing here that only a source scan
// can cover -- weak by nature, since it cannot prove the values are actually
// right.
// The behavior it feeds is instead probed directly, against a live call,
// elsewhere.
test("SOURCE SCAN (weak): executeDirective returns the resolver's buckets on every path", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"),
    "utf-8"
  );
  expect(src).toMatch(/import \{[^}]*\bunreachedTargets\b[^}]*\} from '\.\/directive-journal'/);
  expect(src).toContain("const executeDirective = async (item: RoadmapItem): Promise<DirectiveDispatch> =>");
  // One per resolved path: the no-match early return and the final return.
  // The third path (invalid command) resolves nothing and returns null.
  expect((src.match(/unreached: unreachedTargets\(missing, ambiguous\)/g) ?? []).length).toBe(2);
  // The matched tiles are PROJECTED from the resolver's own output, never
  // re-derived from a second liveness pass over service.list().
  expect(src).toContain("injected: matched.map((t) => ({ tileId: t.id, peerId: t.peerId }))");
});
