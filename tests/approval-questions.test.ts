import { describe, expect, test } from "bun:test";
import {
  APPROVAL_FREE_TEXT_MAX,
  APPROVAL_OPTIONS_MAX,
  APPROVAL_QUESTIONS_MAX,
  validateApprovalAnswers,
  validateApprovalDraft,
} from "../shared/approval.ts";
import { settledOutcome } from "../shared/approval-outcome.ts";
import type { ApprovalQuestion } from "../shared/types.ts";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
// Built at run time so no invisible character is ever typed into this file.
const INVISIBLE = [0x9b, 0x85, 0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff].map((c) => String.fromCharCode(c));
const EMOJI = String.fromCodePoint(0x1f600);
const loneSurrogateAtEnd = (s: string): boolean => {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
};

const base = { kind: "question", title: "Questions", question: "Answer these", merge: "never" };
const fruit = {
  question: "Pick fruits?",
  header: "Fruit",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multi_select: true,
};
const colour = {
  question: "Which colour?",
  header: "Colour",
  options: [{ label: "Red", description: "warm" }, { label: "Blue" }],
  multi_select: false,
};

function questionsOf(raw: unknown): ApprovalQuestion[] {
  const r = validateApprovalDraft({ ...base, questions: raw });
  if (!r.ok) throw new Error(`fixture refused: ${r.error}`);
  if (!r.value.questions) throw new Error("fixture lost its questions");
  return r.value.questions;
}

describe("questions on /approval/add", () => {
  test("well-formed questions are normalised: description defaults to '', multi_select to false", () => {
    const qs = questionsOf([fruit, { ...colour, multi_select: undefined }]);
    expect(qs).toEqual([
      {
        question: "Pick fruits?",
        header: "Fruit",
        options: [
          { label: "Apple", description: "" },
          { label: "Banana", description: "" },
          { label: "Cherry", description: "" },
        ],
        multi_select: true,
      },
      {
        question: "Which colour?",
        header: "Colour",
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "" },
        ],
        multi_select: false,
      },
    ]);
  });

  test("absent or null questions leave an ordinary draft", () => {
    for (const questions of [undefined, null]) {
      const r = validateApprovalDraft({ ...base, questions });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.questions).toBeNull();
    }
  });

  test("control bytes never survive into a question, a header or a label", () => {
    const qs = questionsOf([
      { question: `Q${ESC}[31m?${BEL}`, header: `H${ESC}`, options: [{ label: `L${BEL}1`, description: `d${ESC}` }] },
    ]);
    expect(JSON.stringify(qs)).not.toContain(ESC);
    expect(JSON.stringify(qs)).not.toContain(BEL);
    expect(qs[0]!.options[0]!.label).toBe("L1");
  });

  const refused: Array<[string, unknown, string]> = [
    ["not an array", { question: "q" }, "array"],
    ["an empty array", [], "at least one"],
    ["too many questions", Array.from({ length: APPROVAL_QUESTIONS_MAX + 1 }, (_, i) => ({ ...colour, question: `q${i}` })), "at most"],
    ["a question that is not an object", ["Which colour?"], "object"],
    ["an empty question text", [{ ...colour, question: "  " }], "question text"],
    ["two questions with the same text", [colour, { ...colour, header: "other" }], "twice"],
    ["no options", [{ ...colour, options: [] }], "option"],
    ["too many options", [{ ...colour, options: Array.from({ length: APPROVAL_OPTIONS_MAX + 1 }, (_, i) => ({ label: `o${i}` })) }], "at most"],
    ["an option that is not an object", [{ ...colour, options: ["Red", "Blue"] }], "object"],
    ["a non-string label", [{ ...colour, options: [{ label: 42 }, { label: "Blue" }] }], "label"],
    ["a NaN label", [{ ...colour, options: [{ label: Number.NaN }, { label: "Blue" }] }], "label"],
    ["an empty label", [{ ...colour, options: [{ label: " " }, { label: "Blue" }] }], "label"],
    ["the same label twice", [{ ...colour, options: [{ label: "Red" }, { label: "Red" }] }], "twice"],
    ["a non-boolean multi_select", [{ ...colour, multi_select: "true" }], "multi_select"],
    ["a non-string header", [{ ...colour, header: 7 }], "header"],
    ["a non-string description", [{ ...colour, options: [{ label: "Red", description: 7 }, { label: "Blue" }] }], "description"],
  ];
  for (const [label, questions, message] of refused) {
    test(`refused: ${label}`, () => {
      const r = validateApprovalDraft({ ...base, questions });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(message);
    });
  }

  test("bidi overrides, zero-width marks and C1 controls never survive into the questions", () => {
    const dirty = (s: string) => INVISIBLE.join("") + s + INVISIBLE.join("");
    const qs = questionsOf([
      {
        question: dirty("Which?"),
        header: dirty("H"),
        options: [{ label: dirty("Red"), description: dirty("warm") }, { label: "Blue" }],
      },
    ]);
    expect(qs[0]).toEqual({
      question: "Which?",
      header: "H",
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "" },
      ],
      multi_select: false,
    });
  });

  test("every control, format and separator character goes, letters and emoji stay", () => {
    const gone = [0x2060, 0x2028, 0x2029, 0x061c, 0x00ad, 0xe0041].map((c) => String.fromCodePoint(c)).join("");
    const kept = ["e", String.fromCodePoint(0x301), String.fromCodePoint(0x4e2d), EMOJI].join("");
    const qs = questionsOf([{ question: `Q${gone}?`, options: [{ label: `A${gone}${kept}` }, { label: "B" }] }]);
    expect(qs[0]!.question).toBe("Q?");
    expect(qs[0]!.options[0]!.label).toBe(`A${kept}`);
    const r = validateApprovalAnswers(qs, { "Q?": [`free${gone}${kept}`] });
    expect(r.ok && r.value.answers["Q?"]).toEqual([`free${kept}`]);
  });

  test("a question text is cut on a code point, never inside one", () => {
    const qs = questionsOf([{ question: "a".repeat(3999) + EMOJI + "tail", options: [{ label: "x" }] }]);
    expect(Array.from(qs[0]!.question)).toHaveLength(4000);
    expect(loneSurrogateAtEnd(qs[0]!.question)).toBe(false);
    expect(qs[0]!.question.endsWith(EMOJI)).toBe(true);
  });

  test("questions are a guarded request: merge 'tile' is refused", () => {
    for (const merge of [undefined, "tile"]) {
      const r = validateApprovalDraft({ ...base, merge, questions: [colour] });
      expect(r.ok, String(merge)).toBe(false);
      if (!r.ok) expect(r.error).toContain("merge never");
    }
    expect(validateApprovalDraft({ ...base, merge: "never", questions: [colour] }).ok).toBe(true);
  });

  test("questions belong to a question, never to a permission or a plan", () => {
    for (const kind of ["permission", "plan"]) {
      const r = validateApprovalDraft({ ...base, kind, questions: [colour] });
      expect(r.ok).toBe(false);
    }
  });
});

describe("answers on /approval/claim", () => {
  const qs = questionsOf([fruit, colour]);

  test("labels come back in DISPLAY order, free text last, with a readable summary", () => {
    const r = validateApprovalAnswers(qs, { "Pick fruits?": ["Cherry", "my own", "Apple"], "Which colour?": ["Blue"] });
    expect(r).toEqual({
      ok: true,
      value: {
        answers: { "Pick fruits?": ["Apple", "Cherry", "my own"], "Which colour?": ["Blue"] },
        summary: "Pick fruits?: Apple, Cherry, my own\nWhich colour?: Blue",
      },
    });
  });

  test("a single-select question takes one label or one free text (Other)", () => {
    const other = validateApprovalAnswers(qs, { "Pick fruits?": ["Apple"], "Which colour?": ["Green, please"] });
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.value.answers["Which colour?"]).toEqual(["Green, please"]);
    const two = validateApprovalAnswers(qs, { "Pick fruits?": ["Apple"], "Which colour?": ["Red", "Blue"] });
    expect(two.ok).toBe(false);
  });

  test("free text equal to a label is that label", () => {
    const r = validateApprovalAnswers(qs, { "Pick fruits?": ["Banana", " Apple "], "Which colour?": ["Red"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.answers["Pick fruits?"]).toEqual(["Apple", "Banana"]);
  });

  test("free text reaching the model is flattened, stripped of control bytes and bounded", () => {
    const r = validateApprovalAnswers(qs, {
      "Pick fruits?": [`line1\nline2${ESC}[2J${BEL}` + "x".repeat(APPROVAL_FREE_TEXT_MAX * 2)],
      "Which colour?": ["Red"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.value.answers["Pick fruits?"]![0]!;
    expect(text.startsWith("line1 line2")).toBe(true);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\n");
    expect(text.length).toBe(APPROVAL_FREE_TEXT_MAX);

    const spaced = validateApprovalAnswers(qs, { "Pick fruits?": ["Apple"], "Which colour?": ["a \t\n   b"] });
    expect(spaced.ok && spaced.value.answers["Which colour?"]).toEqual(["a b"]);
  });

  test("questions named like Object.prototype members are answered as plain keys", () => {
    const proto = questionsOf(
      ["__proto__", "constructor", "toString"].map((question) => ({ question, options: [{ label: "A" }, { label: "B" }] }))
    );
    // JSON.parse, as on the wire, gives "__proto__" an own property.
    const r = validateApprovalAnswers(proto, JSON.parse('{"__proto__":["A"],"constructor":["B"],"toString":["A"]}'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(JSON.stringify(r.value.answers))).toEqual(
      JSON.parse('{"__proto__":["A"],"constructor":["B"],"toString":["A"]}')
    );
    expect(Object.keys(r.value.answers)).toEqual(["__proto__", "constructor", "toString"]);

    const omitted = validateApprovalAnswers(proto, JSON.parse('{"__proto__":["A"],"toString":["A"]}'));
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.error).toContain("unanswered");
  });

  test("invisible characters are stripped from free text and do not hide a label", () => {
    const hidden = INVISIBLE.join("");
    const r = validateApprovalAnswers(qs, { "Pick fruits?": [`App${hidden}le`], "Which colour?": [`go${hidden} on`] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.answers).toEqual({ "Pick fruits?": ["Apple"], "Which colour?": ["go on"] });
  });

  test("free text and the summary are cut on a code point, never inside one", () => {
    const r = validateApprovalAnswers(qs, { "Pick fruits?": [EMOJI.repeat(APPROVAL_FREE_TEXT_MAX + 5)], "Which colour?": ["Red"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const free = r.value.answers["Pick fruits?"]![0]!;
    expect(Array.from(free)).toHaveLength(APPROVAL_FREE_TEXT_MAX);
    expect(loneSurrogateAtEnd(free)).toBe(false);

    const long = questionsOf([{ question: "a".repeat(3999) + EMOJI, options: [{ label: "x" }] }]);
    const s = validateApprovalAnswers(long, { [long[0]!.question]: ["x"] });
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(Array.from(s.value.summary)).toHaveLength(4000);
      expect(loneSurrogateAtEnd(s.value.summary)).toBe(false);
    }
  });

  test("a multi-line question stays on one summary line", () => {
    const multi = questionsOf([{ question: "line1\nline2", options: [{ label: "x" }] }]);
    const r = validateApprovalAnswers(multi, { "line1\nline2": ["x"] });
    expect(r.ok && r.value.summary).toBe("line1 line2: x");
  });

  const refused: Array<[string, unknown, string]> = [
    ["not an object", ["Apple"], "object"],
    ["null", null, "object"],
    ["a key outside the questions", { "Pick fruits?": ["Apple"], "Which colour?": ["Red"], "Rogue?": ["x"] }, "not one of the questions"],
    ["a missing question", { "Pick fruits?": ["Apple"] }, "unanswered"],
    ["a string instead of an array", { "Pick fruits?": "Apple", "Which colour?": ["Red"] }, "array"],
    ["an empty array", { "Pick fruits?": [], "Which colour?": ["Red"] }, "at least one"],
    ["a NaN element", { "Pick fruits?": [Number.NaN], "Which colour?": ["Red"] }, "string"],
    ["two free texts", { "Pick fruits?": ["mine", "yours"], "Which colour?": ["Red"] }, "free text"],
    ["the same label twice", { "Pick fruits?": ["Apple", "Apple"], "Which colour?": ["Red"] }, "twice"],
    ["an empty free text", { "Pick fruits?": ["Apple"], "Which colour?": [`  ${BEL} `] }, "empty"],
  ];
  for (const [label, raw, message] of refused) {
    test(`refused: ${label}`, () => {
      const r = validateApprovalAnswers(qs, raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(message);
    });
  }
});

test("an answers verdict reads back as its summary for every human or agent reader", () => {
  expect(settledOutcome({ status: "answered", answer_kind: "answers", answer_text: "Q?: A" })).toEqual({
    kind: "text",
    text: "Q?: A",
  });
});
