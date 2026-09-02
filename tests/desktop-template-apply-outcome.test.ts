// Card 96c98453: behavioural proof for the three sinks of the "a refused
// template must not read as a success" contract, kept in ONE pure module
// (desktop/src/shared/template-apply-outcome.ts) so the main-process sink
// (ipc.ts's template:apply handler: throw vs. return null), the agent-route
// sink (deck-control.ts's deck_apply_template: empty-batch mapping), and the
// renderer sink (store.ts's applyTemplate: show the toast or not) cannot
// drift apart.
//
// NAMED HOLE (not closeable with the tooling available today, stated rather
// than hidden): ipc.ts imports `electron`, which only exposes its named
// exports (ipcMain, dialog, ...) inside a real Electron process -- confirmed
// by a throwaway probe import under bun test, `SyntaxError: Export named
// 'ipcMain' not found in module '.../electron/index.js'`, unaffected by any
// tsconfig/alias flag. store.ts imports the `@shared/*` alias, which the
// root tsconfig.json `bun test` reads by default does not map (only
// desktop/tsconfig.node.json / tsconfig.web.json do) -- confirmed by the
// same probe technique, `Cannot find module '@shared/types'`. Neither file
// can be imported by `bun test`'s default resolution, before or after this
// card; no test in this repo imports either of them today. This suite
// therefore proves the DECISION FUNCTIONS below (real mutation-red proof of
// the throw/return-null and toast/no-toast logic itself, plus review
// correction C3 -- see templateInputsOrThrow's own doc comment -- moved the
// THROW itself inside the pure function specifically so ipc.ts's call site
// cannot silently ignore it the way a returned descriptor could). What this
// suite still CANNOT prove: that ipc.ts, deck-control.ts and store.ts
// actually CALL these functions and USE their result at their real call
// sites. A mutation that deletes the call entirely and hardcodes the old
// value instead (not "ignores the result of a call that's still there" --
// C3 closes that half for ipc.ts specifically, see below) would leave every
// test in this file GREEN. The only proof this repo has today that the
// three call sites are wired correctly is a human read of ipc.ts:1199-1213,
// deck-control.ts:782-798 and store.ts:750-763 (all three re-read during
// this same lot, the last two during the review-correction pass) plus
// `npm run typecheck:node` / `npm run typecheck:web` (both clean), which
// prove the TYPES line up but not that the call sites are reached with the
// intended arguments at runtime.
//
// NAMED RESIDUAL, accepted by the team-lead for a LATER lot rather than
// grown into this one (this lot already tripled in scope: discriminated
// result -> pure-module extraction -> this review-correction pass): the
// PRODUCER side -- desktop/src/main/index.ts's resolveTemplateInputs, which
// decides WHICH TemplateResolveResult.reason a given failure condition maps
// to (containment vs malformed vs refused) -- is pinned by NOTHING in this
// suite or anywhere else in the repo. Swapping 'refused' and 'malformed' at
// their return sites in index.ts (e.g. the shell-field-approval-declined
// branch returning `{ ok: false, reason: 'malformed' }` instead of
// `'refused'`) would resurrect the original bug in a new outfit -- a
// deliberate operator refusal would throw and read as an anomaly, or worse,
// a real anomaly would silently return null and show no toast at all --
// and neither `npm run typecheck:node`/`typecheck:web` nor this file would
// notice, because both only check that SOME valid `reason` literal is
// returned, never WHICH one for WHICH condition. index.ts is electron-coupled
// (same import problem named above) so it cannot be behaviourally tested
// today either. Closing this would mean extracting resolveTemplateInputs's
// condition -> reason mapping into its own pure module (~40 lines, same
// family as the extraction this lot already did) -- the reviewer proposed
// exactly that, the team-lead declined it FOR THIS LOT specifically because
// the lot had already grown three times, and carded it as its own residual
// lot instead of merging it in here.

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

// Card 96c98453, proof #1 requested by the team-lead: a mutation that
// reverts the pre-fix behaviour (a real anomaly resolves to a returned
// value instead of a thrown error, exactly ipc.ts's old
// `if (!inputs) return 0`) must go RED. This pins the CURRENT, correct
// mapping: 'containment' and 'malformed' both throw, only 'refused'
// resolves to a value (null).
test("proof #1: only 'refused' resolves to a value; every other non-ok reason throws", () => {
  const reasons: NotOk["reason"][] = ["containment", "malformed", "refused"];
  const outcomes = reasons.map((reason) => {
    try {
      return { threw: false, value: templateInputsOrThrow({ ok: false, reason }, "/x.json") };
    } catch {
      return { threw: true, value: undefined };
    }
  });
  expect(outcomes.map((o) => o.threw)).toEqual([true, true, false]);
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
  const reasons: NotOk["reason"][] = ["containment", "malformed", "refused"];
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
