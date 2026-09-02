import { test, expect, describe } from "bun:test";
import { verdictAnswerKindFor } from "../desktop/src/renderer/src/components/approval-verdict.ts";
import { buildKeystrokes } from "../desktop/src/main/approval-service.ts";
import type { Approval } from "../shared/types.ts";

// Card c7df3781: InboxPanel routed EVERY approval chip click through
// approvalReply (answer_kind: 'text'), which types the option's LABEL plus
// Enter into the pty. The CLI's Ink chooser at a 'permission' prompt does
// not accept free text, so the agent stayed stuck. These probes pin BOTH
// branches of the fix -- discrimination on `kind`, never on the label --
// with the negative control the bug hid behind: a 'question' chip (where
// the label really is the answer) must still send its label as text.

function approval(patch: Partial<Approval>): Approval {
  return {
    id: "a",
    operator_id: "op",
    origin: {
      host: "h",
      os_user_hash: "u",
      project_key: "p",
      group_id: "",
      from_peer: "",
      session_ref: "tile-1",
    },
    kind: "permission",
    title: "t",
    question: "q",
    options: [],
    status: "answered",
    answered_via: "deck",
    answer_kind: null,
    answer_text: null,
    created_at: "",
    notif_expires_at: "",
    answered_at: "",
    delivered_at: null,
    ...patch,
  } as Approval;
}

describe("verdictAnswerKindFor (chip -> answerKind routing)", () => {
  test("'permission' option[0] is a verdict: allow", () => {
    expect(verdictAnswerKindFor("permission", 0)).toBe("allow");
  });

  test("'permission' option[1] is a verdict: deny", () => {
    expect(verdictAnswerKindFor("permission", 1)).toBe("deny");
  });

  test("'question' options stay free text regardless of index", () => {
    expect(verdictAnswerKindFor("question", 0)).toBe("text");
    expect(verdictAnswerKindFor("question", 1)).toBe("text");
  });
});

// Only optionIndex===1 resolves to the destructive 'deny' verdict; every other
// index (a future third option, -1, NaN) degrades to the benign 'text' retype
// rather than silently becoming 'deny'.
describe("verdictAnswerKindFor -- degenerate/unknown 'permission' indices degrade to 'text', never silently to 'deny'", () => {
  test("a third option (index 2, e.g. a future 'always allow') is not silently 'deny'", () => {
    expect(verdictAnswerKindFor("permission", 2)).toBe("text");
  });

  test("a stray out-of-range index (-1) is not silently 'deny'", () => {
    expect(verdictAnswerKindFor("permission", -1)).toBe("text");
  });

  test("NaN is not silently 'deny' -- NaN===0 and NaN===1 are both false, so a naive equality chain must be checked, not assumed", () => {
    expect(verdictAnswerKindFor("permission", NaN)).toBe("text");
  });
});

// Mutation review, MAJOR-2: the rule "discriminate on kind, never on the
// label" is otherwise asserted only in comments. TypeScript compiles a BARE
// optional parameter (`label?: string`) into a counted parameter, so
// Function.length still catches it -- this is what makes the pin decisive
// rather than decorative. Documented blind spot: a parameter with a DEFAULT
// value (`label = ''`) or a REST parameter would NOT increment Function.length
// and would silently defeat this pin -- it is real but not total.
describe("verdictAnswerKindFor -- arity is pinned so a label-based branch cannot be smuggled back in via an added parameter", () => {
  test("Function.length is exactly 2", () => {
    expect(verdictAnswerKindFor.length).toBe(2);
  });
});

// 'plan' is a valid ApprovalKind with no current producer; it resolves to
// 'text' as an explicit decision, not by falling into the same branch that
// handles 'question'.
describe("verdictAnswerKindFor -- 'plan' is an explicit decision, not a fallthrough", () => {
  test("'plan' resolves to 'text' regardless of index, including the indices that would mean allow/deny for 'permission'", () => {
    expect(verdictAnswerKindFor("plan", 0)).toBe("text");
    expect(verdictAnswerKindFor("plan", 1)).toBe("text");
    expect(verdictAnswerKindFor("plan", 99)).toBe("text");
  });
});

describe("routing -> keystrokes, end to end (the bug's actual symptom)", () => {
  test("a click on option[0] of a 'permission' approval ends as a bare Enter", () => {
    const answerKind = verdictAnswerKindFor("permission", 0);
    expect(answerKind).toBe("allow");
    const out = buildKeystrokes(approval({ kind: "permission", answer_kind: answerKind }));
    expect(out).toBe("\r");
  });

  test("negative control: a 'question' chip still types its label, not a bare Enter", () => {
    const answerKind = verdictAnswerKindFor("question", 0);
    expect(answerKind).toBe("text");
    const out = buildKeystrokes(
      approval({ kind: "question", answer_kind: answerKind, answer_text: "Allow" })
    );
    expect(out).toBe("Allow\r");
  });
});
