import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");
const { BubbleApp, AVATAR_BUBBLE_ARM_MS } = await import("../desktop/src/renderer/src/avatar-bubble/BubbleApp.tsx");

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
  deckLabel: string;
  id: number;
  fromPeerId: string;
  text: string;
  sentAt: string;
  closed: boolean;
  answered: boolean;
  closedAt: string | null;
  closedBy: string | null;
  reason: string | null;
  cut: boolean;
}

function message(over: Partial<Message> = {}): Message {
  const id = over.id ?? 41;
  return {
    key: JSON.stringify([IDENTITY.deckRunId, IDENTITY.broker_url, id]),
    identity: IDENTITY,
    deckLabel: "koryphaios",
    id,
    fromPeerId: "peer-9",
    text: "L2 review approved",
    sentAt: "2026-11-17T09:00:00.000Z",
    closed: false,
    answered: false,
    closedAt: null,
    closedBy: null,
    reason: null,
    cut: false,
    ...over
  };
}

function state(reclame: Card[], courrier: Message[] = [], generation = 7) {
  return {
    generation,
    theme: "dark",
    lang: "en",
    dict: {},
    anchor: "right",
    model: { reclame, courrier, closed: [], truncated: { approvals: 0, messages: 0, closed: 0 }, nextChangeAt: null }
  };
}

interface Calls {
  acts: unknown[];
  focus: unknown[];
  reports: string[];
}

let calls: Calls;
let current: ReturnType<typeof state>;
let actResult: () => Promise<{ outcome: string; reason?: string }>;
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
    close: () => Promise.resolve(),
    reportError: (message: string) => {
      calls.reports.push(message);
    }
  };
}

beforeEach(() => {
  calls = { acts: [], focus: [], reports: [] };
  actResult = () => Promise.resolve({ outcome: "won" });
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

test("an empty Reclame says nothing is waiting", async () => {
  await mount(state([]));
  expect(container.querySelector(".avb-empty")?.textContent).toBe("avatarBubble.emptyReclame");
});
