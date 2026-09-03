// ipc.ts (electron import) and store.ts (@shared/* alias) can't be imported
// under bun test's default resolution, so this suite proves only the pure
// decision functions (throw/return-null, toast/no-toast), not that ipc.ts,
// deck-control.ts and store.ts actually call them and use the result at their
// real call sites.
// The producer side (index.ts's resolveTemplateInputs, which maps a failure
// condition to a reason) is pinned by nothing here or elsewhere: swapping
// 'refused' and 'malformed' at their return sites would resurrect the original
// bug undetected by either typecheck or this file.

import { test, expect } from "bun:test";
import {
  templateInputsOrThrow,
  templateInputsOrEmpty,
  shouldShowTemplateAppliedToast
} from "../desktop/src/shared/template-apply-outcome";
import type { TemplateResolveResult } from "../desktop/src/shared/template";

type NotOk = Extract<TemplateResolveResult, { ok: false }>;

// ----- templateInputsOrThrow (main-process sink) -----

test("ok:true resolves to its own inputs, untouched", () => {
  const inputs = [{ name: "a" }, { name: "b" }];
  expect(templateInputsOrThrow({ ok: true, inputs }, "/t.json")).toBe(inputs);
});

test("refused: resolves to null, never throws -- the operator's own choice is not an error", () => {
  expect(templateInputsOrThrow({ ok: false, reason: "refused" }, "/t/local.json")).toBeNull();
});

test("containment: throws, with a message distinct from malformed's", () => {
  expect(() => templateInputsOrThrow({ ok: false, reason: "containment" }, "/etc/passwd.json")).toThrow(
    /outside the allowed template directories/
  );
  expect(() => templateInputsOrThrow({ ok: false, reason: "containment" }, "/etc/passwd.json")).toThrow(
    /\/etc\/passwd\.json/
  );
});

test("malformed: throws, with a message distinct from containment's", () => {
  expect(() => templateInputsOrThrow({ ok: false, reason: "malformed" }, "/t/broken.json")).toThrow(
    /missing or invalid/
  );
  try {
    templateInputsOrThrow({ ok: false, reason: "malformed" }, "/t/broken.json");
    throw new Error("expected a throw");
  } catch (e) {
    expect(String(e)).not.toContain("outside the allowed template directories");
  }
});

// Card 64f8f629: unlike 'refused' (the operator's own click, who already
// knows why), an unattended caller never got a chance to decide anything --
// a quiet null here would read as a silent refusal instead of the blocked
// approval it actually is.
test("unattended: throws, with a message distinct from refused's silent null", () => {
  expect(() => templateInputsOrThrow({ ok: false, reason: "unattended" }, "/t/local.json")).toThrow(
    /operator at the desktop app/
  );
});

// Card 96c98453, proof #1 requested by the team-lead: a mutation that
// reverts the pre-fix behaviour (a real anomaly resolves to a returned
// value instead of a thrown error, exactly ipc.ts's old
// `if (!inputs) return 0`) must go RED. This pins the CURRENT, correct
// mapping: 'containment' and 'malformed' both throw, only 'refused'
// resolves to a value (null).
test("proof #1: only 'refused' resolves to a value; every other non-ok reason throws", () => {
  const reasons: NotOk["reason"][] = ["containment", "malformed", "refused", "unattended"];
  const outcomes = reasons.map((reason) => {
    try {
      return { threw: false, value: templateInputsOrThrow({ ok: false, reason }, "/x.json") };
    } catch {
      return { threw: true, value: undefined };
    }
  });
  expect(outcomes.map((o) => o.threw)).toEqual([true, true, false, true]);
});

// The switch's `default: { const _exhaustive: never = result.reason; ... }`
// is a compile-time guard (a 4th reason literal added to the union without a
// case fails `npm run typecheck:node`/`typecheck:web`, not this test) --
// this run-time case only documents the fallback shape for a value that
// bypasses the type system (e.g. `as any`), it does not exercise the
// exhaustiveness check itself.
test("an unrecognised reason value (bypassing the type system) throws rather than silently resolving", () => {
  const bogus = { ok: false, reason: "something-new" } as unknown as NotOk;
  expect(() => templateInputsOrThrow(bogus, "/x.json")).toThrow();
});

// ----- templateInputsOrEmpty (agent-route sink) -----

test("ok:true resolves to its own inputs, untouched", () => {
  const inputs = [{ name: "a" }, { name: "b" }];
  expect(templateInputsOrEmpty({ ok: true, inputs })).toBe(inputs);
});

// Review correction C2, card 96c98453: deck-control.ts's route never throws
// for ANY non-ok reason, unlike ipc.ts's sink above -- proven for all three
// reasons, not just the one deck-control.ts's own tests happened to cover
// before this correction.
test("every non-ok reason resolves to an empty array, never throws", () => {
  const reasons: NotOk["reason"][] = ["containment", "malformed", "refused", "unattended"];
  for (const reason of reasons) {
    expect(templateInputsOrEmpty({ ok: false, reason })).toEqual([]);
  }
});

test("an unrecognised reason value (bypassing the type system) still resolves to an empty array", () => {
  const bogus = { ok: false, reason: "something-new" } as unknown as NotOk;
  expect(templateInputsOrEmpty(bogus)).toEqual([]);
});

// ----- shouldShowTemplateAppliedToast (renderer sink) -----

// Card 96c98453, proof #2 requested by the team-lead: the refused branch
// (represented here by the null count templateInputsOrThrow's 'refused'
// case produces) must NOT show the success toast, distinguished
// behaviourally from the success case (a real count, including the 0-session
// edge case) which MUST show it.
test("proof #2: null (refused) does not show the success toast", () => {
  expect(shouldShowTemplateAppliedToast(null)).toBe(false);
});

test("proof #2: a real count (including zero sessions) shows the success toast", () => {
  expect(shouldShowTemplateAppliedToast(0)).toBe(true);
  expect(shouldShowTemplateAppliedToast(3)).toBe(true);
});

// Review correction C4, card 96c98453: `typeof count === 'number'` rather
// than `count !== null`, so `undefined` (unreachable today, but what a
// resolved-and-dropped companion/phone key would arrive as -- see the
// function's own doc comment) does NOT show the toast either. The old
// `!== null` form would have shown it -- `undefined !== null` is true.
test("proof C4: undefined does not show the success toast (the JSON-key-dropped case)", () => {
  expect(shouldShowTemplateAppliedToast(undefined as unknown as number | null)).toBe(false);
});

// A mutation that reverts store.ts's fix (any count, including null, shows
// the toast) is exactly `shouldShowTemplateAppliedToast` always returning
// true -- pinned by the null and undefined cases above already going false.
test("proof #1 mirror for the renderer sink: only a real number shows the toast", () => {
  const counts: (number | null | undefined)[] = [null, undefined, 0, 1, 42];
  const shown = counts.map((c) => shouldShowTemplateAppliedToast(c as number | null));
  expect(shown).toEqual([false, false, true, true, true]);
});
