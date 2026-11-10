import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");

const storeReads: string[] = [];
const throwingUseDeck = Object.assign(
  () => {
    storeReads.push("useDeck");
    throw new Error("the Deck store was read from the store-free inbox");
  },
  {
    getState: () => {
      storeReads.push("getState");
      throw new Error("the Deck store was read from the store-free inbox");
    },
    setState: () => {},
    subscribe: () => () => {}
  }
);
mockStore({ ...storeMockStubs, useDeck: throwingUseDeck });

const bridgeTouches: string[] = [];
(globalThis as unknown as { window: { api: unknown } }).window.api = new Proxy(
  {},
  {
    get: (_target, key) => {
      bridgeTouches.push(String(key));
      return () => Promise.resolve(true);
    }
  }
);

const { InboxCore, formatCloseStamp } = await import("../desktop/src/renderer/src/components/InboxCore.tsx");
const { inboxEntryKey } = await import("../desktop/src/shared/types.ts");

type Action = { kind: string; text?: string; answers?: Record<string, string[]> };
interface Calls {
  answers: { id: string; action: Action }[];
  replies: { id: number; sentAt: string; text: string }[];
  deletes: number[];
  acks: string[];
  seen: string[];
  drafts: Record<string, string>;
}

interface FakeApproval {
  id: string;
  kind: "permission" | "question";
  reply_route: "hook" | "channel" | "pty";
  status: string;
  title: string;
  question: string;
  options: string[];
  questions: unknown;
  mergeable: boolean;
  absorbed_permission: boolean;
  informational: boolean;
  created_at: string;
  origin: { tile_ref: string };
}

function approval(over: Partial<FakeApproval> = {}): FakeApproval {
  return {
    id: "apr-1",
    kind: "permission",
    reply_route: "channel",
    status: "pending",
    title: "",
    question: "rm -rf build",
    options: [],
    questions: null,
    mergeable: false,
    absorbed_permission: false,
    informational: false,
    created_at: "2026-10-09T12:00:00.000Z",
    origin: { tile_ref: "tile-a" },
    ...over
  };
}

const MESSAGE = { id: 7, from: "peer-x", text: "see the build", sentAt: "2026-10-09T11:00:00.000Z" };

let container: HTMLDivElement;
let root: Root;
let calls: Calls;
let outcome: "settled" | "failed" | "pending";
let release: () => void = () => {};

beforeEach(() => {
  calls = { answers: [], replies: [], deletes: [], acks: [], seen: [], drafts: {} };
  outcome = "settled";
  storeReads.length = 0;
  bridgeTouches.length = 0;
  reports.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  expect(storeReads, "the Deck store is never read").toEqual([]);
  expect(bridgeTouches, "window.api is never touched: every effect leaves through a capability").toEqual([]);
});

const UNSUPPORTED = { status: "unsupported", messages: {}, closedQuestions: [] } as const;
const reports: string[] = [];

const QUOTA_EVENT = { kind: "event", id: "quota:1700000000000", text: "quota text", at: "2026-10-09T12:30:00.000Z" } as const;

interface MountOptions {
  messages?: (typeof MESSAGE)[];
  events?: (typeof QUOTA_EVENT)[];
  eventNavigate?: boolean;
  approvals?: FakeApproval[];
  archive?: unknown;
  reclame?: boolean;
  courrierWrites?: boolean;
}

function Host(opts: MountOptions): React.JSX.Element {
  const [replyDrafts, setReplyDrafts] = React.useState<Record<string, string>>({});
  const [approvalDrafts, setApprovalDrafts] = React.useState<Record<string, unknown>>({});
  calls.drafts = replyDrafts;
  const settle = (): Promise<"settled" | "failed"> =>
    outcome === "pending"
      ? new Promise((resolve) => {
          release = () => resolve("settled");
        })
      : Promise.resolve(outcome);
  return React.createElement(InboxCore, {
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}|${Object.entries(params).map(([k, v]) => `${k}=${v}`).join("|")}` : key,
    report: (message: string) => reports.push(message),
    archive: opts.archive ?? UNSUPPORTED,
    messages: opts.messages ?? [],
    approvals: (opts.approvals ?? []) as never,
    readStates: {},
    reclame:
      opts.reclame === false
        ? null
        : {
            answer: (a: { id: string }, action: Action) => {
              calls.answers.push({ id: a.id, action });
              return settle();
            }
          },
    courrier: {
      markSeen: (e: { kind: string }) => calls.seen.push(e.kind),
      ack: (e: { kind: string }) => calls.acks.push(e.kind),
      ...(opts.courrierWrites
        ? {
            reply: (message: { id: number; sentAt: string }, text: string) => {
              calls.replies.push({ id: message.id, sentAt: message.sentAt, text });
              return settle();
            },
            deleteMessage: (id: number) => {
              calls.deletes.push(id);
              return settle();
            }
          }
        : {})
    },
    replyDrafts,
    onReplyDraft: (key: string, text: string) => setReplyDrafts((d) => ({ ...d, [key]: text })),
    approvalDrafts: approvalDrafts as never,
    onApprovalDraft: (id: string, d: unknown) => setApprovalDrafts((all) => ({ ...all, [id]: d })),
    resolveSender: () => ({ resolved: true, name: "worker" }),
    renderNavigate: () => React.createElement("span", { className: "nav-marker" }),
    events: opts.events,
    renderEventNavigate: opts.eventNavigate
      ? (event: { id: string }) => React.createElement("span", { className: "event-nav-marker" }, event.id)
      : undefined,
    seedApprovalId: null,
    onSeedConsumed: () => {},
    onClose: () => {}
  } as never);
}

async function mount(opts: MountOptions): Promise<void> {
  await act(async () => {
    root.render(React.createElement(Host, opts));
  });
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
}

function typeReply(text: string): void {
  const area = container.querySelector(".inbox-modal-reply") as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("a read-only Courrier offers neither reply nor delete, in the list or in the modal, and still acks", async () => {
  await mount({ messages: [MESSAGE] });
  expect(container.querySelector(".inbox-delete-btn"), "no delete in the list row").toBeNull();
  await click(container.querySelector(".inbox-ack-btn"));
  expect(calls.acks).toEqual(["message"]);
  await click(container.querySelector(".inbox-entry"));
  expect(calls.seen, "opening marks seen through the capability").toEqual(["message"]);
  const modal = container.querySelector(".inbox-modal")!;
  expect(modal.querySelector(".inbox-modal-reply"), "no reply field").toBeNull();
  expect(
    [...modal.querySelectorAll(".inbox-modal-actions button")].map((b) => b.textContent),
    "only ack and close remain"
  ).toEqual(["inbox.ack", "inbox.close"]);
});

test("a Courrier given reply and delete shows both, sends the trimmed draft, then clears it and closes", async () => {
  await mount({ messages: [MESSAGE], courrierWrites: true });
  await click(container.querySelector(".inbox-delete-btn"));
  expect(calls.deletes).toEqual([7]);
  await click(container.querySelector(".inbox-entry"));
  typeReply("  on it  ");
  await click(buttonLabelled("inbox.reply"));
  // Mutant: sendReply(open.message.from), which names the sender instead of the entry.
  expect(calls.replies).toEqual([{ id: MESSAGE.id, sentAt: MESSAGE.sentAt, text: "on it" }]);
  expect(container.querySelector(".inbox-modal"), "settled closes the entry").toBeNull();
  expect(Object.values(calls.drafts), "settled clears the draft").toEqual([""]);
});

test("a failed reply keeps the entry open with its draft", async () => {
  outcome = "failed";
  await mount({ messages: [MESSAGE], courrierWrites: true });
  await click(container.querySelector(".inbox-entry"));
  typeReply("on it");
  await click(buttonLabelled("inbox.reply"));
  expect(container.querySelector(".inbox-modal")).not.toBeNull();
  expect((container.querySelector(".inbox-modal-reply") as HTMLTextAreaElement).value).toBe("on it");
});

test("a hook question's structured answer reaches the Reclame callback as answers, never as text", async () => {
  const questions = [{ question: "Which?", header: "", options: [{ label: "Alpha", description: "" }, { label: "Beta", description: "" }], multi_select: false }];
  await mount({ approvals: [approval({ id: "hook-1", kind: "question", reply_route: "hook", questions })] });
  await click(container.querySelector(".inbox-entry"));
  expect(container.querySelector(".inbox-modal-reply"), "a hook row has no free reply").toBeNull();
  await click(container.querySelectorAll("button.aq-pick")[1]);
  expect(calls.answers).toEqual([{ id: "hook-1", action: { kind: "answers", answers: { "Which?": ["Beta"] } } }]);
  expect(container.querySelector(".inbox-modal"), "settled closes the entry").toBeNull();
});

test("channel chips route by kind: a permission's are verdicts, a question's relay their label as text", async () => {
  await mount({ approvals: [approval({ id: "perm" })] });
  await click(container.querySelector(".inbox-entry"));
  await click(buttonLabelled("inbox.permissionDeny"));
  await act(async () => {
    root.render(React.createElement(Host, { approvals: [approval({ id: "q", kind: "question", options: ["main", "dev"] })] }));
  });
  await click(container.querySelector(".inbox-entry"));
  await click(buttonLabelled("dev"));
  expect(calls.answers).toEqual([
    { id: "perm", action: { kind: "deny" } },
    { id: "q", action: { kind: "text", text: "dev" } }
  ]);
});

test("a Reclame decline goes through the callback, and a failed one keeps the entry open", async () => {
  outcome = "failed";
  await mount({ approvals: [approval({ id: "apr-9", kind: "question", options: [] })] });
  await click(container.querySelector(".inbox-entry"));
  await click(buttonLabelled("inbox.decline"));
  expect(calls.answers).toEqual([{ id: "apr-9", action: { kind: "deny" } }]);
  expect(container.querySelector(".inbox-modal")).not.toBeNull();
});

test("without the Reclame capability no verdict control is offered and the refusal is said", async () => {
  await mount({ approvals: [approval({ kind: "question", options: ["main"] })], reclame: false });
  await click(container.querySelector(".inbox-entry"));
  const modal = container.querySelector(".inbox-modal")!;
  expect(modal.querySelector(".inbox-modal-options")).toBeNull();
  expect(modal.querySelector(".inbox-modal-reply")).toBeNull();
  expect([...modal.querySelectorAll(".inbox-modal-actions button")].map((b) => b.textContent)).toEqual(["inbox.close"]);
  expect([...modal.querySelectorAll(".inbox-modal-note")].map((n) => n.textContent)).toContain("inbox.verdictRemoteBlocked");
});

test("a channel question's Ack reaches the Reclame callback as ack, not as a verdict", async () => {
  await mount({ approvals: [approval({ id: "ch", kind: "question", options: [] })] });
  await click(container.querySelector(".inbox-entry"));
  await click(buttonLabelled("inbox.ack"));
  expect(calls.answers).toEqual([{ id: "ch", action: { kind: "ack" } }]);
});

// Mutants: any one of the informational guards removed from the modal (decline, reply field, reply button, label, note).
test("an information is labelled as such and offers only Acknowledge and Close, with no reply field and no decline", async () => {
  await mount({ approvals: [approval({ id: "fyi", kind: "question", informational: true, question: "build is green" })] });
  await click(container.querySelector(".inbox-entry"));
  const modal = container.querySelector(".inbox-modal")!;

  expect(modal.querySelector(".inbox-modal-family")?.textContent).toBe("inbox.familyInformation");
  expect(modal.querySelector(".inbox-modal-reply"), "no reply field").toBeNull();
  expect(modal.querySelector(".inbox-modal-options"), "no option chip").toBeNull();
  expect([...modal.querySelectorAll(".inbox-modal-actions button")].map((b) => b.textContent)).toEqual([
    "inbox.ack",
    "inbox.close"
  ]);
  expect([...modal.querySelectorAll(".inbox-modal-note")].map((n) => n.textContent)).toEqual(["inbox.noteInformation"]);
  await click(buttonLabelled("inbox.ack"));
  expect(calls.answers).toEqual([{ id: "fyi", action: { kind: "ack" } }]);
});

// Mutant: an information sorted with the blocking questions (it is newer, so it would ride on top).
test("a blocking question stays above a newer information, which is listed with the rest", async () => {
  await mount({
    approvals: [
      approval({ id: "fyi", kind: "question", informational: true, question: "fyi text", created_at: "2026-10-09T13:00:00.000Z" }),
      approval({ id: "blocking", kind: "question", question: "blocking text", created_at: "2026-10-09T12:00:00.000Z" })
    ],
    messages: [MESSAGE]
  });

  const excerpts = [...container.querySelectorAll(".inbox-entry-excerpt")].map((e) => e.textContent);
  expect(excerpts).toEqual(["blocking text", "fyi text", "see the build"]);
});

// Mutants: `...events` dropped from the entries; the `renderEventNavigate` slot dropped from the modal.
test("a host-derived event is listed with the messages, offers the host's navigation and is acknowledged through the Courrier", async () => {
  await mount({ events: [QUOTA_EVENT], messages: [MESSAGE], eventNavigate: true });

  expect([...container.querySelectorAll(".inbox-entry-excerpt")].map((e) => e.textContent)).toEqual(["quota text", "see the build"]);
  await click(container.querySelector(".inbox-entry-event"));
  const modal = container.querySelector(".inbox-modal")!;
  expect(modal.querySelector(".event-nav-marker")?.textContent).toBe(QUOTA_EVENT.id);
  expect(modal.querySelector(".inbox-modal-reply"), "an event has no recipient").toBeNull();
  await click(buttonLabelled("inbox.ack"));
  expect(calls.acks).toEqual(["event"]);
});

test("an event without a host navigation shows no navigation slot", async () => {
  await mount({ events: [QUOTA_EVENT] });
  await click(container.querySelector(".inbox-entry-event"));
  expect(container.querySelector(".event-nav-marker")).toBeNull();
});

test("a hook request's Hand back reaches the Reclame callback as handback, not as a verdict", async () => {
  await mount({ approvals: [approval({ id: "hk", reply_route: "hook" })] });
  await click(container.querySelector(".inbox-entry"));
  await click(buttonLabelled("inbox.handback"));
  expect(calls.answers).toEqual([{ id: "hk", action: { kind: "handback" } }]);
});

test("two gestures while an answer is still in flight send it once", async () => {
  outcome = "pending";
  await mount({ approvals: [approval({ id: "slow", kind: "question", options: [] })] });
  await click(container.querySelector(".inbox-entry"));
  const decline = buttonLabelled("inbox.decline")!;
  await act(async () => {
    decline.click();
    decline.click();
  });
  expect(calls.answers, "the second gesture lands while the first is unsettled").toEqual([
    { id: "slow", action: { kind: "deny" } }
  ]);
  await act(async () => release());
});

test("a failed answer re-arms the lock: the same gesture sends again", async () => {
  outcome = "failed";
  await mount({ approvals: [approval({ id: "retry", kind: "question", options: [] })] });
  await click(container.querySelector(".inbox-entry"));
  await click(buttonLabelled("inbox.decline"));
  await click(buttonLabelled("inbox.decline"));
  expect(calls.answers).toEqual([
    { id: "retry", action: { kind: "deny" } },
    { id: "retry", action: { kind: "deny" } }
  ]);
});

test("an answer settling after another entry was opened leaves that other entry open", async () => {
  outcome = "pending";
  await mount({ approvals: [approval({ id: "A", kind: "question", options: [] })], messages: [MESSAGE] });
  await click(container.querySelector(".inbox-entry-approval"));
  await click(buttonLabelled("inbox.decline"));
  await click(container.querySelector(".inbox-entry-message"));
  await act(async () => release());
  expect(container.querySelector(".inbox-modal .inbox-modal-text")?.textContent, "B is still the open entry").toBe(
    "see the build"
  );
});

test("a delete settling after another entry was opened leaves that other entry open", async () => {
  outcome = "pending";
  await mount({ approvals: [approval({ id: "B", kind: "question", options: [] })], messages: [MESSAGE], courrierWrites: true });
  await click(container.querySelector(".inbox-entry-message"));
  await click(buttonLabelled("inbox.delete"));
  await click(container.querySelector(".inbox-entry-approval"));
  await act(async () => release());
  expect(calls.deletes).toEqual([7]);
  expect(container.querySelector(".inbox-modal .inbox-modal-text")?.textContent, "B is still the open entry").toBe(
    "rm -rf build"
  );
});

// --- Settled entries: closed, responded, previous run ------------------------

const CLOSED_AT = new Date(2026, 10, 3, 9, 5, 7).toISOString();
const MSG_KEY = inboxEntryKey({ kind: "message", message: MESSAGE });

const settled = (over: Record<string, unknown> = {}) => ({
  state: "closed",
  settledAt: CLOSED_AT,
  closedByPeerId: "worker-2",
  closedByAuthority: "author",
  closeReason: "done",
  ...over
});
const ready = (messages: Record<string, unknown>, closedQuestions: unknown[] = []) => ({
  status: "ready",
  messages,
  closedQuestions
});
const closedQuestion = (over: Record<string, unknown> = {}) =>
  approval({
    id: "cq",
    kind: "question",
    status: "closed",
    options: ["main", "dev"],
    answered_at: CLOSED_AT,
    closed_by_peer_id: "worker-2",
    closed_by_authority: "author",
    close_reason: "done",
    ...over
  } as Partial<FakeApproval>);
const modalButtons = (): (string | null)[] =>
  [...container.querySelectorAll(".inbox-modal-actions button")].map((b) => b.textContent);
const notes = (): string[] => [...container.querySelectorAll(".inbox-modal-note")].map((n) => n.textContent ?? "");

test("formatCloseStamp writes the local date and time with zeros, the same in every locale", () => {
  // Mutant: the month printed without +1, or toLocaleString.
  expect(formatCloseStamp(CLOSED_AT)).toEqual({ date: "03/11/2026", time: "09:05:07", valid: true });
  expect(formatCloseStamp("nope")).toEqual({ date: "nope", time: "--:--:--", valid: false });
});

test("a closed message shows who closed it, when and why, offers no reply, and keeps ack, close and delete", async () => {
  await mount({ messages: [MESSAGE], courrierWrites: true, archive: ready({ [MSG_KEY]: settled() }) });
  expect(container.querySelector(".inbox-entry-closed-badge"), "the list row carries the closed pastille").not.toBeNull();
  await click(container.querySelector(".inbox-entry"));
  const banner = container.querySelector(".inbox-closed-banner")!;
  expect(banner.textContent).toContain("inbox.closedBy|peer=worker-2|date=03/11/2026|time=09:05:07");
  expect(banner.querySelector(".inbox-closed-reason")?.textContent).toBe("done");
  // Mutant: the Reply button conditioned by courrier.reply alone.
  expect(container.querySelector(".inbox-modal-reply")).toBeNull();
  expect(buttonLabelled("inbox.reply")).toBeUndefined();
  expect(modalButtons()).toEqual(["inbox.ack", "inbox.close", "inbox.delete"]);
});

test("a closure reason is agent text: markup and links show literally, no element is created", async () => {
  const reason = "<b>x</b> https://exemple.invalid";
  await mount({
    messages: [MESSAGE],
    archive: ready({ [MSG_KEY]: settled({ closeReason: reason }) })
  });
  await click(container.querySelector(".inbox-entry"));
  const banner = container.querySelector(".inbox-closed-banner")!;
  // Mutant: the reason passed through renderText / linkedText.
  expect(banner.querySelector("b")).toBeNull();
  expect(banner.querySelector("a")).toBeNull();
  expect(banner.querySelector(".inbox-closed-reason")?.textContent).toBe(reason);
});

test("a closure by an instance-less authority names the translated authority, not an empty peer", async () => {
  await mount({
    messages: [MESSAGE],
    archive: ready({ [MSG_KEY]: settled({ closedByPeerId: null, closedByAuthority: "lead" }) })
  });
  await click(container.querySelector(".inbox-entry"));
  // Mutant: `peer ?? ''` instead of the authority variant.
  expect(container.querySelector(".inbox-closed-line")?.textContent).toContain(
    "inbox.closedByAuthority|authority=inbox.closedAuthority.lead|date=03/11/2026|time=09:05:07"
  );
});

test("an unreadable close time is shown as dashes and traced once, not on every render", async () => {
  const archive = ready({ [MSG_KEY]: settled({ settledAt: "garbage" }) });
  await mount({ messages: [MESSAGE], archive });
  await click(container.querySelector(".inbox-entry"));
  expect(container.querySelector(".inbox-closed-line")?.textContent).toContain("time=--:--:--");
  await mount({ messages: [MESSAGE], archive });
  expect(reports).toHaveLength(1);
});

test("a question an agent closed is a read-only consultation: closure banner, note, and Close alone", async () => {
  await mount({ approvals: [], archive: ready({}, [closedQuestion()]) });
  expect(container.querySelector(".inbox-entry-closed-question"), "listed as its own family").not.toBeNull();
  await click(container.querySelector(".inbox-entry"));
  const modal = container.querySelector(".inbox-modal")!;
  // Mutant: the closed question rendered as the approval family (decline, chips, reply, navigate come back).
  expect(modal.querySelector(".inbox-modal-options")).toBeNull();
  expect(modal.querySelector(".inbox-modal-reply")).toBeNull();
  expect(modal.querySelector(".nav-marker")).toBeNull();
  expect(modalButtons()).toEqual(["inbox.close"]);
  expect(notes()).toEqual(["inbox.noteClosed"]);
  expect(modal.querySelector(".inbox-closed-banner")?.textContent).toContain("peer=worker-2");
});

test("a question that closes under an open modal keeps the modal open on the banner and shows the unsent draft read-only", async () => {
  await mount({ approvals: [approval({ id: "cq", kind: "question", options: [] })] });
  await click(container.querySelector(".inbox-entry"));
  typeReply("half an answer");
  await act(async () => {
    root.render(React.createElement(Host, { approvals: [], archive: ready({}, [closedQuestion({ options: [] })]) }));
  });
  // Mutant: reactKey `cq:<id>` for the closed family (the modal would close).
  expect(container.querySelector(".inbox-modal")).not.toBeNull();
  expect(container.querySelector(".inbox-closed-banner")).not.toBeNull();
  expect(container.querySelector(".inbox-modal-reply"), "the field is gone").toBeNull();
  expect(container.querySelector(".inbox-modal-draft-orphan")?.textContent).toContain("half an answer");
  await click(buttonLabelled("inbox.close"));
  expect(Object.values(calls.drafts), "closing the modal drops the orphan draft").toEqual([""]);
});

test("a closed question's list marker is named closed, not acknowledged", async () => {
  await mount({ archive: ready({}, [closedQuestion()]) });
  // Mutant: the marker keeps the read-state title ('inbox.state.acked').
  expect(container.querySelector(".inbox-entry-dot")?.getAttribute("title")).toBe("inbox.stateClosed");
});

test("a draft left on a message whose entry settled or belongs to a previous run is shown read-only and dropped when the message is deleted", async () => {
  const rerender = async (archive: unknown): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(Host, { messages: [MESSAGE], courrierWrites: true, archive }));
    });
  };
  await mount({ messages: [MESSAGE], courrierWrites: true, archive: ready({ [MSG_KEY]: settled({ state: "open" }) }) });
  await click(container.querySelector(".inbox-entry"));
  typeReply("half an answer");
  await rerender(ready({}));
  expect(container.querySelector(".inbox-modal-draft-orphan")?.textContent, "a previous-run message keeps the draft readable").toContain("half an answer");
  await rerender(ready({ [MSG_KEY]: settled() }));
  expect(container.querySelector(".inbox-modal-draft-orphan")?.textContent).toContain("half an answer");
  await click(buttonLabelled("inbox.delete"));
  // Mutant: the orphan draft is not cleared when the entry is closed by a delete.
  expect(Object.values(calls.drafts)).toEqual([""]);
});

test("a question present as pending and as closed is listed once, as closed", async () => {
  await mount({
    approvals: [approval({ id: "cq", kind: "question", options: [] })],
    archive: ready({}, [closedQuestion()])
  });
  expect(container.querySelectorAll(".inbox-entry")).toHaveLength(1);
  expect(container.querySelector(".inbox-entry-closed-question")).not.toBeNull();
});

test("a responded message offers no reply and says why", async () => {
  await mount({ messages: [MESSAGE], courrierWrites: true, archive: ready({ [MSG_KEY]: settled({ state: "responded" }) }) });
  await click(container.querySelector(".inbox-entry"));
  expect(container.querySelector(".inbox-modal-reply")).toBeNull();
  expect(modalButtons()).toEqual(["inbox.ack", "inbox.close", "inbox.delete"]);
  expect(notes()).toEqual(["inbox.noteResponded"]);
  expect(container.querySelector(".inbox-closed-banner"), "responded is not a closure").toBeNull();
});

test("what a message offers follows the archive: open and an old broker reply, an unknown or previous-run one does not", async () => {
  await mount({ messages: [MESSAGE], courrierWrites: true, archive: ready({ [MSG_KEY]: settled({ state: "open" }) }) });
  await click(container.querySelector(".inbox-entry"));
  expect(container.querySelector(".inbox-modal-reply")).not.toBeNull();
  const rerender = async (archive: unknown): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(Host, { messages: [MESSAGE], courrierWrites: true, archive }));
    });
  };
  await rerender(ready({}));
  expect(container.querySelector(".inbox-modal-reply"), "absent from a ready snapshot: a previous run").toBeNull();
  expect(notes()).toEqual(["inbox.notePreviousRun"]);
  await rerender({ status: "pending", messages: {}, closedQuestions: [] });
  expect(container.querySelector(".inbox-modal-reply")).toBeNull();
  expect(notes()).toEqual(["inbox.noteStateUnknown"]);
  // Mutant: legacy-broker hides Reply.
  await rerender(UNSUPPORTED);
  expect(container.querySelector(".inbox-modal-reply"), "an old broker keeps the reply, the broker decides").not.toBeNull();
  expect(buttonLabelled("inbox.reply")).toBeDefined();
});
