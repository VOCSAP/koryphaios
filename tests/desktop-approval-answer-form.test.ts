// Mounts the real ApprovalAnswerForm with a controlled draft held by a small
// host, and reads what each of the three shapes sends: a permission served by
// the module (Allow / Deny), one single-choice question (answers on one click),
// and several questions (drafted, then sent as one structured answer).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import type { QuestionDraft } from "../desktop/src/renderer/src/components/approval-answers";
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// Only the keys whose interpolation is asserted carry a template; every other
// key renders as itself.
const fakeUseDeck = create(() => ({
  dict: {
    "inbox.questionsProgress": "{done}/{total}",
    "inbox.questionOtherCount": "{n}/{max}"
  } as Record<string, string>
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { ApprovalAnswerForm } = await import("../desktop/src/renderer/src/components/ApprovalAnswerForm.tsx");
const { formQuestions, keepDrafts } = await import("../desktop/src/renderer/src/components/approval-answers.ts");

interface Q {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multi_select: boolean;
}
interface FormApproval {
  id: string;
  kind: "permission" | "question";
  questions?: Q[];
}

function q(question: string, labels: string[], multi_select = false): Q {
  return { question, header: "", options: labels.map((label) => ({ label, description: "" })), multi_select };
}

interface Calls {
  allow: number;
  deny: number;
  handback: number;
  answers: Record<string, string[]>[];
}

let container: HTMLDivElement;
let root: Root;
let calls: Calls;

beforeEach(() => {
  calls = { allow: 0, deny: 0, handback: 0, answers: [] };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function Host(props: { approval: FormApproval }): React.JSX.Element {
  const [draft, setDraft] = React.useState<QuestionDraft[] | undefined>(undefined);
  return React.createElement(ApprovalAnswerForm, {
    approval: props.approval as never,
    disabled: false,
    draft,
    onDraft: setDraft,
    onAllow: () => calls.allow++,
    onDeny: () => calls.deny++,
    onAnswers: (a: Record<string, string[]>) => calls.answers.push(a),
    onHandback: () => calls.handback++,
    actionsClassName: "acts"
  });
}

function mount(approval: FormApproval): void {
  act(() => {
    root.render(React.createElement(Host, { approval }));
  });
}

function actionLabels(): string[] {
  return [...container.querySelectorAll(".acts > button")].map((b) => b.textContent ?? "");
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled ${label}; have ${actionLabels().join(", ")}`);
  return found as HTMLButtonElement;
}

function click(el: Element): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

function fieldset(i: number): HTMLFieldSetElement {
  return container.querySelectorAll("fieldset.aq")[i] as HTMLFieldSetElement;
}

function choice(fs: Element, label: string): HTMLInputElement {
  const opt = [...fs.querySelectorAll("label.aq-opt")].find(
    (l) => l.querySelector(".aq-label")?.textContent === label
  );
  if (!opt) throw new Error(`no option ${label}`);
  return opt.querySelector("input") as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("form A: a permission answers Allow or Deny once each and never renders its questions", () => {
  mount({ id: "p1", kind: "permission", questions: [q("ignored?", ["X"])] });
  expect(container.querySelectorAll("fieldset.aq"), "a permission carries no question form").toHaveLength(0);
  expect(actionLabels()).toEqual(["inbox.handback", "inbox.permissionDeny", "inbox.permissionAllow"]);
  click(button("inbox.permissionAllow"));
  click(button("inbox.permissionDeny"));
  click(button("inbox.handback"));
  expect(calls).toEqual({ allow: 1, deny: 1, handback: 1, answers: [] });
  expect(container.querySelector(".inbox-modal-note")?.textContent).toBe("inbox.allowOnceNote");
});

test("form B: one single-choice question answers its clicked option at once, in display order", () => {
  mount({ id: "b1", kind: "question", questions: [q("Which?", ["Alpha", "Beta", "Gamma"])] });
  const picks = [...container.querySelectorAll("button.aq-pick .aq-label")].map((s) => s.textContent);
  expect(picks, "options render in producer order").toEqual(["Alpha", "Beta", "Gamma"]);
  expect(actionLabels(), "one click answers: no Deny, no Send answers").toEqual(["inbox.handback", "inbox.sendOther"]);
  click(container.querySelectorAll("button.aq-pick")[1]!);
  expect(calls.answers).toEqual([{ "Which?": ["Beta"] }]);
});

test("form B: the free Other text is sent trimmed, and only once it holds something", () => {
  mount({ id: "b2", kind: "question", questions: [q("Which?", ["Alpha"])] });
  const send = button("inbox.sendOther");
  expect(send.disabled, "empty Other").toBe(true);
  const other = container.querySelector("input.aq-other-input") as HTMLInputElement;
  type(other, "   ");
  expect(button("inbox.sendOther").disabled, "blank Other is still no answer").toBe(true);
  type(other, "  my own  ");
  expect(container.querySelector(".aq-count")?.textContent).toBe("10/1000");
  click(button("inbox.sendOther"));
  expect(calls.answers).toEqual([{ "Which?": ["my own"] }]);
});

test("form C: several questions are sent once, labels in display order whatever the click order, Other last", () => {
  mount({
    id: "c1",
    kind: "question",
    questions: [q("Pick one", ["One", "Two", "Three"]), q("Pick many", ["Red", "Green", "Blue"], true)]
  });
  expect(container.querySelectorAll("fieldset.aq")).toHaveLength(2);
  expect(container.querySelectorAll("button.aq-pick"), "several questions never answer on one click").toHaveLength(0);
  expect(container.querySelector(".aq-progress")?.textContent).toBe("0/2");
  expect(
    container.querySelector(".acts .aq-progress"),
    "the progress sits above the footer: in it, the row overflows the 560px modal"
  ).toBeNull();
  expect(button("inbox.sendAnswers").disabled).toBe(true);

  click(choice(fieldset(0), "Three"));
  click(choice(fieldset(0), "Two"));
  click(choice(fieldset(1), "Blue"));
  click(choice(fieldset(1), "Red"));
  click(choice(fieldset(1), "inbox.questionOther"));
  type(fieldset(1).querySelector("input.aq-other-input") as HTMLInputElement, " teal ");

  expect(container.querySelector(".aq-progress")?.textContent).toBe("2/2");
  click(button("inbox.sendAnswers"));
  expect(calls.answers).toEqual([{ "Pick one": ["Two"], "Pick many": ["Red", "Blue", "teal"] }]);
});

test("form C: Other checked but left empty keeps the answer incomplete and the send blocked", () => {
  mount({ id: "c2", kind: "question", questions: [q("First", ["A", "B"]), q("Second", ["C", "D"], true)] });
  click(choice(fieldset(0), "inbox.questionOther"));
  click(choice(fieldset(1), "C"));
  click(choice(fieldset(1), "inbox.questionOther"));
  type(fieldset(1).querySelector("input.aq-other-input") as HTMLInputElement, "  ");

  expect(container.querySelector(".aq-progress")?.textContent, "a picked option does not complete a blank Other").toBe("0/2");
  expect([...container.querySelectorAll(".aq-mode.is-missing")]).toHaveLength(2);
  const send = button("inbox.sendAnswers");
  expect(send.disabled).toBe(true);
  click(send);
  expect(calls.answers).toEqual([]);

  type(fieldset(0).querySelector("input.aq-other-input") as HTMLInputElement, "free");
  click(choice(fieldset(1), "inbox.questionOther"));
  expect(container.querySelector(".aq-progress")?.textContent).toBe("2/2");
  click(button("inbox.sendAnswers"));
  expect(calls.answers).toEqual([{ First: ["free"], Second: ["C"] }]);
});

function otherOnlyBlocked(text: string, pick?: string): { progress: string | null; sendDisabled: boolean } {
  mount({ id: `o-${text.length}-${pick ?? ""}`, kind: "question", questions: [q("First", ["A", "B"]), q("Many", ["C", "D"], true)] });
  click(choice(fieldset(0), "A"));
  if (pick) click(choice(fieldset(1), pick));
  click(choice(fieldset(1), "inbox.questionOther"));
  type(fieldset(1).querySelector("input.aq-other-input") as HTMLInputElement, text);
  const send = button("inbox.sendAnswers");
  click(send);
  return { progress: container.querySelector(".aq-progress")?.textContent ?? null, sendDisabled: send.disabled };
}

test("an Other made only of zero-width spaces is no answer: the broker drops them", () => {
  const zwsp = String.fromCodePoint(0x200b);
  expect(otherOnlyBlocked(zwsp + zwsp + zwsp)).toEqual({ progress: "1/2", sendDisabled: true });
  expect(calls.answers).toEqual([]);
});

test("an Other made only of control characters is no answer: the broker drops them", () => {
  const bel = String.fromCharCode(7);
  expect(otherOnlyBlocked(bel + bel)).toEqual({ progress: "1/2", sendDisabled: true });
  expect(calls.answers).toEqual([]);
});

test("an Other repeating a checked label is no answer: the broker refuses a label chosen twice", () => {
  expect(otherOnlyBlocked(" C ", "C")).toEqual({ progress: "1/2", sendDisabled: true });
  expect(calls.answers).toEqual([]);
});

test("an Other carrying invisible characters around real text is sent as the broker keeps it", () => {
  mount({ id: "o-clean", kind: "question", questions: [q("Many", ["C", "D"], true)] });
  click(choice(fieldset(0), "inbox.questionOther"));
  const zwsp = String.fromCodePoint(0x200b);
  type(fieldset(0).querySelector("input.aq-other-input") as HTMLInputElement, `${zwsp} sea\tgreen ${zwsp}`);
  click(button("inbox.sendAnswers"));
  expect(calls.answers).toEqual([{ Many: ["sea green"] }]);
});

test("each question is captioned by its fieldset's legend", () => {
  mount({ id: "lg", kind: "question", questions: [q("Pick one", ["One"]), q("Pick many", ["Red"], true)] });
  const captions = [...container.querySelectorAll("fieldset.aq")].map(
    (fs) => fs.firstElementChild?.tagName + ":" + fs.firstElementChild?.querySelector(".aq-q")?.textContent
  );
  expect(captions).toEqual(["LEGEND:Pick one", "LEGEND:Pick many"]);
});

test("a draft leaves with its row: the pushed list no longer naming it drops it", () => {
  const draft = [{ picked: [1], other: false, otherText: "" }];
  const drafts = { kept: draft, gone: draft };
  expect(keepDrafts(drafts, [{ id: "kept" }, { id: "fresh" }])).toEqual({ kept: draft });
  expect(keepDrafts(drafts, [])).toEqual({});
  expect(keepDrafts(drafts, [{ id: "kept" }, { id: "gone" }]), "nothing settled: the same object, no re-render").toBe(drafts);
});

test("formQuestions names the requests whose form shows the questions, so the host shows their text once", () => {
  const qs = [q("Which?", ["A"])];
  expect(formQuestions({ kind: "question", questions: qs })).toBe(qs);
  expect(formQuestions({ kind: "permission", questions: qs }), "a permission never renders its questions").toBeNull();
  expect(formQuestions({ kind: "question", questions: [] }), "no question: the host keeps the request text").toBeNull();
  expect(formQuestions({ kind: "question", questions: null })).toBeNull();
  expect(formQuestions({ kind: "question" })).toBeNull();
});

test("a question or option named __proto__ stays an own answer key and pollutes no prototype", () => {
  mount({
    id: "x1",
    kind: "question",
    questions: [q("__proto__", ["__proto__", "constructor"], true), q("constructor", ["polluted"])]
  });
  click(choice(fieldset(0), "constructor"));
  click(choice(fieldset(0), "__proto__"));
  click(choice(fieldset(1), "polluted"));
  click(button("inbox.sendAnswers"));
  const sent = calls.answers[0]!;
  expect(Object.getPrototypeOf(sent), "the answer object keeps Object.prototype").toBe(Object.prototype);
  expect(Object.keys(sent)).toEqual(["__proto__", "constructor"]);
  expect(Object.hasOwn(sent, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(sent, "__proto__")!.value).toEqual(["__proto__", "constructor"]);
  expect(sent.constructor as unknown).toEqual(["polluted"]);
  expect(Object.keys(Object.prototype), "nothing leaked onto Object.prototype").toEqual([]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();

  act(() => {
    root.unmount();
  });
  root = createRoot(container);
  mount({ id: "x2", kind: "question", questions: [q("__proto__", ["__proto__"])] });
  click(container.querySelector("button.aq-pick")!);
  const oneClick = calls.answers[1]!;
  expect(Object.getPrototypeOf(oneClick), "the one-click answer keeps Object.prototype").toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(oneClick, "__proto__")!.value).toEqual(["__proto__"]);
});
