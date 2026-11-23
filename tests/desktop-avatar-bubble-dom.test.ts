import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Root } from "../desktop/tests-support/react-test-harness";

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");
const { BubbleApp, AVATAR_BUBBLE_ARM_MS } = await import("../desktop/src/renderer/src/avatar-bubble/BubbleApp.tsx");
const { bubbleCourrier } = await import("../desktop/src/renderer/src/avatar-bubble/courrier.ts");
const { GLYPH_ACTIONS } = await import("../desktop/src/renderer/src/components/icons.tsx");

const IDENTITY = { deckRunId: "run-1", broker_url: "http://127.0.0.1:7899" };

interface Card {
  key: string;
  identity: typeof IDENTITY;
  deckLabel: string;
  approvalId: string;
  kind: "permission" | "question";
  blocking: boolean;
  title: string;
  question: string;
  options: { value: string; label: string }[];
  questions: unknown;
  fromPeerId: string;
  tileName: string | null;
  createdAt: string;
  cut: boolean;
  gestures: string[];
  openInDeck: boolean;
  settledElsewhere: boolean;
}

function card(over: Partial<Card> = {}): Card {
  const approvalId = over.approvalId ?? "aaaaaaaa-0000-4000-8000-000000000001";
  return {
    key: JSON.stringify([IDENTITY.deckRunId, IDENTITY.broker_url, approvalId]),
    identity: IDENTITY,
    deckLabel: "koryphaios",
    approvalId,
    kind: "permission",
    blocking: true,
    title: "Bash",
    question: "git push origin experimental",
    options: [],
    questions: null,
    fromPeerId: "peer-11",
    tileName: "lead",
    createdAt: "2026-11-17T10:00:00.000Z",
    cut: false,
    gestures: ["allow", "deny"],
    openInDeck: false,
    settledElsewhere: false,
    ...over
  };
}

interface Message {
  key: string;
  identity: typeof IDENTITY;
  scopeGeneration: number;
  deckLabel: string;
  id: number;
  fromPeerId: string;
  text: string;
  sentAt: string;
  read: "seen" | "acked" | null;
  closed: boolean;
  answered: boolean;
  closedAt: string | null;
  closedBy: string | null;
  reason: string | null;
  cut: boolean;
}

function message(over: Partial<Message> = {}): Message {
  const id = over.id ?? 41;
  const identity = over.identity ?? IDENTITY;
  const scopeGeneration = over.scopeGeneration ?? 3;
  const sentAt = over.sentAt ?? "2026-11-17T09:00:00.000Z";
  return {
    key: JSON.stringify([identity.deckRunId, identity.broker_url, scopeGeneration, id, sentAt]),
    identity,
    scopeGeneration,
    deckLabel: "koryphaios",
    id,
    fromPeerId: "peer-9",
    text: "L2 review approved",
    sentAt,
    read: null,
    closed: false,
    answered: false,
    closedAt: null,
    closedBy: null,
    reason: null,
    cut: false,
    ...over
  };
}

function state(reclame: Card[], courrier: Message[] = [], generation = 7, courrierPending = 0) {
  return {
    generation,
    theme: "dark",
    lang: "en",
    dict: {},
    anchor: "right",
    expanded: false,
    model: { reclame, courrier, courrierPending, closed: [], truncated: { approvals: 0, messages: 0, closed: 0 }, nextChangeAt: null }
  };
}

interface Calls {
  acts: unknown[];
  focus: unknown[];
  resizes: unknown[];
  reads: { gesture: string; intent: Record<string, unknown> }[];
  reports: string[];
}

let calls: Calls;
let current: ReturnType<typeof state>;
let actResult: () => Promise<{ outcome: string; reason?: string }>;
let readResult: () => Promise<string>;
let resizeResult: () => Promise<void>;
let push: (next: unknown) => void = () => {};
let container: HTMLDivElement;
let root: Root;

function fakeApi() {
  return {
    getState: () => Promise.resolve(current),
    onState: (cb: (s: unknown) => void) => {
      push = cb;
      return () => {
        push = () => {};
      };
    },
    act: (intent: unknown) => {
      calls.acts.push(intent);
      return actResult();
    },
    focusDeck: (intent: unknown) => {
      calls.focus.push(intent);
      return Promise.resolve();
    },
    setExpanded: (intent: unknown) => {
      calls.resizes.push(intent);
      return resizeResult();
    },
    markSeen: (intent: Record<string, unknown>) => {
      calls.reads.push({ gesture: "markSeen", intent });
      return readResult();
    },
    ack: (intent: Record<string, unknown>) => {
      calls.reads.push({ gesture: "ack", intent });
      return readResult();
    },
    close: () => Promise.resolve(),
    reportError: (message: string) => {
      calls.reports.push(message);
    }
  };
}

beforeEach(() => {
  calls = { acts: [], focus: [], resizes: [], reads: [], reports: [] };
  resizeResult = () => Promise.resolve();
  actResult = () => Promise.resolve({ outcome: "won" });
  readResult = () => Promise.resolve("seen");
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

// Timers fire only when the test says so: the arming delay is a step, never a wait.
let timers: { callback: () => void; ms: number }[] = [];
const clock = {
  setTimeout: (callback: () => void, ms: number) => {
    const timer = { callback, ms };
    timers.push(timer);
    return timer;
  },
  clearTimeout: (handle: unknown) => {
    timers = timers.filter((t) => t !== handle);
  }
};

async function arm(): Promise<void> {
  const due = timers;
  timers = [];
  await act(async () => {
    for (const t of due) t.callback();
  });
}

async function mount(s: ReturnType<typeof state>, armed = true): Promise<void> {
  current = s;
  timers = [];
  await act(async () => {
    root.render(React.createElement(BubbleApp, { api: fakeApi(), clock } as never));
  });
  if (armed) await arm();
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const buttons = (): (string | null)[] => [...container.querySelectorAll(".avb-card-actions button")].map((b) => b.textContent);
const buttonLabelled = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

// Mutant: the Allow button drawn without `may('allow')`, so a cut card offers to approve unseen text.
test("a cut card offers Deny and Open in the Deck, never Allow nor a reply", async () => {
  await mount(state([card({ cut: true, openInDeck: true, gestures: ["deny"] })]));
  expect(buttons()).toEqual(["inbox.permissionDeny", "avatarBubble.openInDeck"]);
  expect(container.querySelector(".avb-reply")).toBeNull();
  expect(container.querySelector(".avb-card-line.is-cut")?.textContent).toBe("avatarBubble.cutNote");
});

// Mutant: Open in the Deck wired to act, or the intent built without the state's generation.
test("Open in the Deck focuses the card's Deck with the state's generation", async () => {
  await mount(state([card({ cut: true, openInDeck: true, gestures: ["deny"] })], [], 12));
  await click(buttonLabelled("avatarBubble.openInDeck"));
  expect(calls.focus).toEqual([{ generation: 12, deckRunId: IDENTITY.deckRunId, broker_url: IDENTITY.broker_url }]);
  expect(calls.acts).toEqual([]);
});

// Mutant: the approval id or the identity taken from another card than the one shown.
test("Allow sends the shown card's approval to its own Deck", async () => {
  await mount(state([card()], [], 3));
  await click(buttonLabelled("inbox.permissionAllow"));
  expect(calls.acts).toEqual([
    {
      generation: 3,
      deckRunId: IDENTITY.deckRunId,
      broker_url: IDENTITY.broker_url,
      action: { approval_id: "aaaaaaaa-0000-4000-8000-000000000001", action: "allow" }
    }
  ]);
});

// Mutant: the title or the question rendered through innerHTML.
test("relayed title and question are rendered as text, never as markup", async () => {
  await mount(state([card({ kind: "question", title: '<img src="x">', question: "<b>bold</b>", gestures: ["deny"] })]));
  expect(container.querySelector(".avb-card img, .avb-card b")).toBeNull();
  expect(container.querySelector(".inbox-modal-subject")?.textContent).toBe('<img src="x">');
  expect(container.querySelector(".avb-card-text")?.textContent).toBe("<b>bold</b>");
});

const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const REPL = String.fromCodePoint(0xfffd);

// Mutant: answers keyed by the displayed question or valued by the displayed label.
test("a structured answer carries the raw question key and option value, not the displayed text", async () => {
  const questions = [
    {
      key: `Which${RLO}branch?`,
      question: `Which${REPL}branch?`,
      header: "",
      options: [
        { value: "main", label: "main", description: "" },
        { value: `dev${ZWSP}`, label: `dev${REPL}`, description: "" }
      ],
      multiSelect: false
    }
  ];
  await mount(state([card({ kind: "question", questions, gestures: ["deny", "answers"] })]));
  expect(container.querySelector(".avb-reply"), "no text gesture, no free text").toBeNull();
  await click(buttonLabelled(`dev${REPL}`));
  await click(buttonLabelled("avatarBubble.sendAnswers"));
  expect((calls.acts[0] as { action: unknown }).action).toEqual({
    approval_id: "aaaaaaaa-0000-4000-8000-000000000001",
    action: "answers",
    answers: { [`Which${RLO}branch?`]: [`dev${ZWSP}`] }
  });
});

// Mutant: the action row drawn whatever settledElsewhere says.
test("a card settled elsewhere says so and offers no gesture", async () => {
  await mount(state([card({ settledElsewhere: true, gestures: [] })]));
  expect(container.querySelector(".avb-card-actions")).toBeNull();
  expect(container.querySelector(".avb-card-line.is-settled")?.textContent).toBe("avatarBubble.settledElsewhere");
});

// Mutant: the next button moving to index - 1, or the position printed from 0.
test("the pager walks the single queue and keeps its card when the queue shifts", async () => {
  const a = card({ approvalId: "aaaaaaaa-0000-4000-8000-00000000000a", title: "A" });
  const b = card({ approvalId: "aaaaaaaa-0000-4000-8000-00000000000b", title: "B", deckLabel: "kleos" });
  await mount(state([a, b]));
  expect(container.querySelector(".avb-pager-count")?.textContent).toBe("avatarBubble.position");
  await click(container.querySelector('button[title="avatarBubble.next"]'));
  expect(container.querySelector(".inbox-modal-subject")?.textContent).toBe("B");
  expect(container.querySelector(".avb-card-deck")?.textContent).toBe("kleos");
  const c = card({ approvalId: "aaaaaaaa-0000-4000-8000-00000000000c", title: "C" });
  await act(async () => push(state([c, a, b])));
  expect(container.querySelector(".inbox-modal-subject")?.textContent, "B stays open").toBe("B");
});

// Mutant: an outcome that leaves the card in place shown as nothing, or a rejected act left unreported.
test("a refused answer is said on the card, and a rejected one is reported", async () => {
  actResult = () => Promise.resolve({ outcome: "refused" });
  await mount(state([card()]));
  await click(buttonLabelled("inbox.permissionAllow"));
  expect(container.querySelector(".avb-card-notice")?.textContent).toBe("avatarBubble.refused");
  actResult = () => Promise.reject(new Error("stale generation"));
  await click(buttonLabelled("inbox.permissionAllow"));
  expect(container.querySelector(".avb-card-notice")?.textContent).toBe("avatarBubble.failed");
  expect(calls.reports.join("\n")).toContain("stale generation");
});

// Mutants: a reply capability given to the Courrier, or a closed message mapped as open.
test("the Courrier is read-only and shows a closed message as closed", async () => {
  await mount(state([], [message(), message({ id: 40, closed: true, closedAt: "2026-11-17T09:30:00.000Z", closedBy: "lead" })]));
  await click(container.querySelectorAll('[role="tab"]')[1]);
  expect(container.querySelector(".inbox-panel")?.className).toBe("inbox-panel is-embedded");
  expect(container.querySelectorAll(".inbox-entry-closed-badge").length).toBe(1);
  await click(container.querySelector(".inbox-entry"));
  expect(container.querySelector(".inbox-modal-reply")).toBeNull();
  expect(buttonLabelled("inbox.reply")).toBeUndefined();
  expect(container.querySelector(".avb-foot")?.textContent).toBe("avatarBubble.readOnly");
});

// Mutant: the arming delay removed (armed from the first frame), so a double-click approves the next card unread.
test("the card that replaces a won one ignores a click until its arming delay has passed", async () => {
  const a = card({ approvalId: "aaaaaaaa-0000-4000-8000-00000000000a", title: "A" });
  const b = card({ approvalId: "aaaaaaaa-0000-4000-8000-00000000000b", title: "B" });
  await mount(state([a, b]), false);
  await click(container.querySelector(".avb-card-actions .primary"));
  expect(calls.acts, "the first card is not armed either").toEqual([]);
  await arm();
  await click(container.querySelector(".avb-card-actions .primary"));
  expect(calls.acts.length).toBe(1);
  await act(async () => push(state([b])));
  expect(timers.map((t) => t.ms), "the new card arms after the named delay").toEqual([AVATAR_BUBBLE_ARM_MS]);
  await click(container.querySelector(".avb-card-actions .primary"));
  expect(calls.acts.length, "the second click of the double-click lands on B and is dropped").toBe(1);
  await arm();
  await click(container.querySelector(".avb-card-actions .primary"));
  expect((calls.acts[1] as { action: { approval_id: string } }).action.approval_id).toBe(b.approvalId);
});

// Mutants: the chip sending its label instead of its value, or the description left in a tooltip.
test("an option chip shows its label and sends its raw value, and a pick shows its description", async () => {
  await mount(
    state([
      card({ kind: "question", options: [{ value: `ship${ZWSP}`, label: `ship${REPL}` }], gestures: ["deny", "text"] }),
      card({
        approvalId: "aaaaaaaa-0000-4000-8000-00000000000d",
        kind: "question",
        gestures: ["deny", "answers"],
        questions: [{ key: "k", question: "Which?", header: "", multiSelect: false, options: [{ value: "a", label: "Alpha", description: "the safe one" }] }]
      })
    ])
  );
  await click(buttonLabelled(`ship${REPL}`));
  expect((calls.acts[0] as { action: unknown }).action).toEqual({
    approval_id: "aaaaaaaa-0000-4000-8000-000000000001",
    action: "text",
    text: `ship${ZWSP}`
  });
  await click(container.querySelector('button[title="avatarBubble.next"]'));
  await arm();
  expect(container.querySelector(".avb-pick .aq-desc")?.textContent).toBe("the safe one");
});

// Mutant: the closure banner falling back to a "?" authority when the relay carries none.
test("a closed message whose closer is unknown says when it closed, with no placeholder authority", async () => {
  await mount(state([], [message({ closed: true, closedAt: "2026-11-17T09:30:00.000Z" })]));
  await click(container.querySelectorAll('[role="tab"]')[1]);
  await click(container.querySelector(".inbox-entry"));
  expect(container.querySelector(".inbox-closed-line")?.textContent).toBe("inbox.closedAt");
});

const OTHER_DECK = { deckRunId: "run-2", broker_url: "http://127.0.0.1:7900" };

function entryFrom(label: string): HTMLElement {
  const entry = [...container.querySelectorAll(".inbox-entry")].find((e) => e.querySelector(".inbox-entry-from")?.textContent === label);
  if (!entry) throw new Error(`no entry from ${label}`);
  return entry as HTMLElement;
}

async function openCourrier(): Promise<void> {
  await click(container.querySelectorAll('[role="tab"]')[1]);
}

test("two Decks holding the same message id and send time keep their own read state and closure", async () => {
  const a = message({ deckLabel: "alpha", closed: true, closedAt: "2026-11-17T09:30:00.000Z" });
  const b = message({ identity: OTHER_DECK, deckLabel: "beta" });
  await mount(state([], [a, b]));
  await openCourrier();
  expect(container.querySelectorAll(".inbox-entry").length).toBe(2);
  expect(entryFrom("alpha · peer-9").querySelector(".inbox-entry-closed-badge"), "A is closed").not.toBeNull();
  expect(entryFrom("beta · peer-9").querySelector(".inbox-entry-closed-badge"), "B stays open").toBeNull();
  await click(entryFrom("alpha · peer-9").querySelector(".inbox-ack-btn"));
  expect(calls.reads).toEqual([
    { gesture: "ack", intent: { generation: 7, deckRunId: "run-1", broker_url: IDENTITY.broker_url, scopeGeneration: 3, id: 41, sentAt: a.sentAt } }
  ]);
  await act(async () => push(state([], [{ ...a, read: "acked" }, b])));
  expect(entryFrom("alpha · peer-9").className).toContain("is-acked");
  expect(entryFrom("beta · peer-9").className, "acknowledging A leaves B unread").toContain("is-unread");
});

test("a message read before the bubble closed is still read when it reopens", async () => {
  const seen = state([], [message({ read: "seen" })]);
  await mount(seen);
  await openCourrier();
  await click(container.querySelector(".inbox-entry"));
  expect(calls.reads.map((r) => r.gesture), "opening asks main to mark it seen").toEqual(["markSeen"]);
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await mount(seen);
  await openCourrier();
  expect(container.querySelector(".inbox-entry")?.className).toContain("is-seen");
});

test("a read gesture main refuses is reported, not swallowed", async () => {
  readResult = () => Promise.reject(new Error("stale_generation"));
  await mount(state([], [message()]));
  await openCourrier();
  await click(container.querySelector(".inbox-ack-btn"));
  expect(calls.reports.join("\n")).toContain("stale_generation");
  expect(container.querySelector(".inbox-entry")?.className, "no local state stands in for main").toContain("is-unread");
});

test("two Decks closing the same approval id each open their own closed question", async () => {
  const approvalId = "aaaaaaaa-0000-4000-8000-0000000000cc";
  const closed = (identity: typeof IDENTITY, deckLabel: string, title: string, fromPeerId: string, tileName: string) => ({
    key: JSON.stringify([identity.deckRunId, identity.broker_url, approvalId]),
    identity,
    deckLabel,
    approvalId,
    title,
    closedAt: "2026-11-17T09:30:00.000Z",
    closedBy: null,
    reason: null,
    fromPeerId,
    tileName
  });
  const s = state([]);
  s.model.closed = [
    closed(IDENTITY, "alpha", "close A", "peer-a", "Team A"),
    closed(OTHER_DECK, "beta", "close B", "peer-b", "Team B")
  ] as never;
  await mount(s);
  await openCourrier();
  const rows = [...container.querySelectorAll(".inbox-entry")];
  expect(rows.map((r) => r.querySelector(".inbox-entry-excerpt")?.textContent)).toEqual(["close A", "close B"]);
  expect(rows.map((r) => r.querySelector(".inbox-entry-from")?.textContent)).toEqual(["alpha · Team A", "beta · Team B"]);
  await click(rows[1]);
  const modal = container.querySelector(".inbox-modal")?.textContent ?? "";
  expect(modal).toContain("close B");
  expect(modal, "B's row does not open A's question").not.toContain("close A");
});

test("a closed question names the authority that closed it, and only says when it closed if the relay carries none", async () => {
  const closed = (approvalId: string, title: string, closedBy: string | null) => ({
    key: JSON.stringify([IDENTITY.deckRunId, IDENTITY.broker_url, approvalId]),
    identity: IDENTITY,
    deckLabel: "alpha",
    approvalId,
    title,
    closedAt: "2026-11-17T09:30:00.000Z",
    closedBy,
    reason: null
  });
  const cases: [string | null, string][] = [
    ["author", "closed by label-author"],
    ["lead", "closed by label-lead"],
    ["supervisor", "closed by label-supervisor"],
    [null, "inbox.closedAt"]
  ];
  const s = state([]);
  s.dict = {
    "inbox.closedByAuthority": "closed by {authority}",
    "inbox.closedAuthority.author": "label-author",
    "inbox.closedAuthority.lead": "label-lead",
    "inbox.closedAuthority.supervisor": "label-supervisor"
  };
  s.model.closed = cases.map(([closedBy], i) => closed(`q-${i}`, `question ${i}`, closedBy)) as never;
  await mount(s);
  await openCourrier();
  expect([...container.querySelectorAll(".inbox-entry-from")].map((n) => n.textContent)).toEqual(
    cases.map(() => "inbox.senderUnresolvedEmpty")
  );
  for (const [i, [, line]] of cases.entries()) {
    await click([...container.querySelectorAll(".inbox-entry")][i]);
    expect(container.querySelector(".inbox-closed-line")?.textContent, `question ${i}`).toBe(line);
    await click(container.querySelector('.inbox-modal button[title="inbox.close"]'));
  }
});

test("a copy of a listed message gets no key and is reported once", () => {
  const traces: string[] = [];
  const c = bubbleCourrier(state([], [message()]).model as never, (m) => traces.push(m));
  const listed = c.messages[0]!;
  expect(c.entryKey({ kind: "message", message: listed })).toBe(message().key);
  const copy = { ...listed };
  expect(c.entryKey({ kind: "message", message: copy })).toBeNull();
  expect(c.entryKey({ kind: "message", message: copy })).toBeNull();
  expect(traces).toEqual(["bubble Courrier left out message 41: not one the bubble listed"]);
});

test("a copy of a listed closed question gets no key and is reported once", () => {
  const traces: string[] = [];
  const s = state([]);
  const key = JSON.stringify([IDENTITY.deckRunId, IDENTITY.broker_url, "q-1"]);
  s.model.closed = [{ key, identity: IDENTITY, deckLabel: "alpha", approvalId: "q-1", title: "t", closedAt: "2026-11-17T09:30:00.000Z", closedBy: null, reason: null }] as never;
  const c = bubbleCourrier(s.model as never, (m) => traces.push(m));
  const listed = c.archive.closedQuestions[0]!;
  expect(c.approvalKey(listed)).toBe(key);
  const copy = { ...listed };
  expect(c.approvalKey(copy)).toBeNull();
  expect(c.approvalKey(copy)).toBeNull();
  expect(traces).toEqual(["bubble Courrier left out question q-1: not one the bubble listed"]);
});

const courrierBadge = (): string | null => container.querySelectorAll('[role="tab"]')[1]?.querySelector(".avb-tab-count")?.textContent ?? null;

test("the Courrier badge shows the count main sends, not one counted from the listed messages", async () => {
  await mount(state([], [message(), message({ id: 40 })], 7, 5));
  expect(courrierBadge()).toBe("5");
  await act(async () => push(state([], [message(), message({ id: 40 })], 7, 0)));
  expect(courrierBadge()).toBeNull();
});

test("an answered message is not listed even when main still relays it, and the other Deck's twin stays", async () => {
  await mount(state([], [message({ deckLabel: "alpha", answered: true }), message({ identity: OTHER_DECK, deckLabel: "beta" })]));
  await openCourrier();
  expect([...container.querySelectorAll(".inbox-entry-from")].map((n) => n.textContent)).toEqual(["beta · peer-9"]);
});

test("an empty Reclame says nothing is waiting", async () => {
  await mount(state([]));
  expect(container.querySelector(".avb-empty")?.textContent).toBe("avatarBubble.emptyReclame");
});

async function glyphMarkup(glyph: unknown): Promise<string> {
  const host = document.createElement("div");
  const scratch = createRoot(host);
  await act(async () => {
    scratch.render(glyph as never);
  });
  const markup = host.innerHTML;
  await act(async () => {
    scratch.unmount();
  });
  return markup;
}

const headerButtons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(".avb-head .icon-btn")];
const sizeButton = (): HTMLButtonElement => headerButtons().at(-2)!;
const root_ = (): HTMLElement => container.querySelector(".avb") as HTMLElement;
const expandedState = (over: Partial<ReturnType<typeof state>> = {}) => ({ ...state([card()]), expanded: true, ...over });

test("the size button sits just before the close button and is named by its title and aria-label", async () => {
  await mount(state([card()]));
  expect(headerButtons().map((b) => b.getAttribute("aria-label"))).toEqual(["avatarBubble.expand", "avatarBubble.close"]);
  expect(sizeButton().title).toBe("avatarBubble.expand");
  expect(sizeButton().querySelector("svg")).not.toBeNull();
});

test("a normal bubble offers to enlarge with the tile's expand glyph, an expanded one to shrink with its restore glyph", async () => {
  const expandGlyph = await glyphMarkup(GLYPH_ACTIONS.expand);
  const restoreGlyph = await glyphMarkup(GLYPH_ACTIONS.restore);
  expect(expandGlyph).not.toBe(restoreGlyph);
  await mount(state([card()]));
  expect(sizeButton().innerHTML).toBe(expandGlyph);
  await act(async () => push(expandedState()));
  expect(sizeButton().getAttribute("aria-label")).toBe("avatarBubble.collapse");
  expect(sizeButton().title).toBe("avatarBubble.collapse");
  expect(sizeButton().innerHTML).toBe(restoreGlyph);
  await act(async () => push(state([card()])));
  expect(sizeButton().getAttribute("aria-label")).toBe("avatarBubble.expand");
  expect(sizeButton().innerHTML).toBe(expandGlyph);
});

test("the bubble root carries data-expanded from the state, loading root included", async () => {
  current = state([card()]);
  await act(async () => {
    root.render(React.createElement(BubbleApp, { api: { ...fakeApi(), getState: () => new Promise(() => {}) }, clock } as never));
  });
  expect(root_().getAttribute("data-expanded"), "before the first state").toBe("false");
  await act(async () => push(state([card()])));
  expect(root_().getAttribute("data-expanded")).toBe("false");
  await act(async () => push(expandedState()));
  expect(root_().getAttribute("data-expanded")).toBe("true");
});

test("the button asks for the opposite of the current size, with the state's generation", async () => {
  await mount({ ...state([card()], [], 12) });
  await click(sizeButton());
  expect(calls.resizes).toEqual([{ generation: 12, expanded: true }]);
  await act(async () => push(expandedState({ generation: 12 })));
  await click(sizeButton());
  expect(calls.resizes).toEqual([
    { generation: 12, expanded: true },
    { generation: 12, expanded: false }
  ]);
});

test("a click while the resize is pending sends nothing, and the button works again once it settles", async () => {
  let settle: () => void = () => {};
  resizeResult = () => new Promise<void>((resolve) => (settle = resolve));
  await mount(state([card()]));
  await click(sizeButton());
  await click(sizeButton());
  expect(calls.resizes).toHaveLength(1);
  await act(async () => settle());
  await click(sizeButton());
  expect(calls.resizes).toHaveLength(2);
});

const refuse = (): void => {
  resizeResult = () => Promise.reject(new Error("window gone"));
};
const resizeNotices = (): Element[] => [...container.querySelectorAll(".avb-resize-notice")];
const expectResizeNotice = (): void => {
  const notices = resizeNotices();
  expect(notices).toHaveLength(1);
  expect(notices[0]!.textContent).toBe("avatarBubble.resizeFailed");
  expect(notices[0]!.getAttribute("role")).toBe("alert");
  expect(notices[0]!.parentElement?.className, "under the header, outside any tab panel").toBe("avb-frame");
};

test("a refused resize is traced, tells the operator, keeps the old glyph, and leaves the button usable", async () => {
  refuse();
  await mount(state([card()]));
  const before = sizeButton().innerHTML;
  await click(sizeButton());
  expect(calls.reports).toEqual(["bubble resize was refused: window gone"]);
  expectResizeNotice();
  expect(container.querySelector(".avb-card-notice"), "the card notice is for the answer, not for the size").toBeNull();
  expect(sizeButton().innerHTML).toBe(before);
  expect(root_().getAttribute("data-expanded")).toBe("false");
  await click(sizeButton());
  expect(calls.resizes).toHaveLength(2);
});

test("a refused resize from the Courrier tab is shown there too", async () => {
  refuse();
  await mount(state([card()], [message()], 7, 1));
  await openCourrier();
  await click(sizeButton());
  expectResizeNotice();
  expect(container.querySelector(".avb-card"), "Courrier is on screen").toBeNull();
});

test("a refused resize is shown when Reclame holds no card", async () => {
  refuse();
  await mount(state([]));
  expect(container.querySelector(".avb-card")).toBeNull();
  await click(sizeButton());
  expectResizeNotice();
});

test("a second refusal replaces the notice, and the next try clears it while the call is pending", async () => {
  refuse();
  await mount(state([card()]));
  await click(sizeButton());
  await click(sizeButton());
  expect(calls.resizes).toHaveLength(2);
  expectResizeNotice();
  let settle: () => void = () => {};
  resizeResult = () => new Promise<void>((resolve) => (settle = resolve));
  await click(sizeButton());
  expect(resizeNotices(), "cleared as soon as the next try starts").toHaveLength(0);
  await act(async () => settle());
  expect(resizeNotices()).toHaveLength(0);
});

// Each state is read on its own mount: happy-dom keeps an element's computed style across an attribute change.
async function questionCapUnderRealStyles(expanded: boolean): Promise<string> {
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(new URL("../desktop/src/renderer/src/styles.css", import.meta.url), "utf8");
  document.head.appendChild(sheet);
  try {
    const longQuestion = card({ kind: "question", question: "Which root?\n".repeat(40), gestures: ["deny"] });
    await mount({ ...state([longQuestion]), expanded });
    return getComputedStyle(container.querySelector(".avb-card-text") as Element).maxHeight;
  } finally {
    sheet.remove();
  }
}

test("the question text keeps its 180 px cap in a normal bubble", async () => {
  expect(await questionCapUnderRealStyles(false)).toBe("180px");
});

test("the question text loses its cap in an expanded bubble, so the card is the one scroll area", async () => {
  expect(await questionCapUnderRealStyles(true)).toBe("none");
});

test("the size button is also there on the Courrier tab", async () => {
  await mount(expandedState());
  await openCourrier();
  expect(sizeButton().getAttribute("aria-label")).toBe("avatarBubble.collapse");
  await click(sizeButton());
  expect(calls.resizes).toEqual([{ generation: 7, expanded: false }]);
});
