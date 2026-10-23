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

const { InboxCore } = await import("../desktop/src/renderer/src/components/InboxCore.tsx");

type Action = { kind: string; text?: string; answers?: Record<string, string[]> };
interface Calls {
  answers: { id: string; action: Action }[];
  replies: { to: string; text: string }[];
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

interface MountOptions {
  messages?: (typeof MESSAGE)[];
  approvals?: FakeApproval[];
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
    t: (key: string) => key,
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
            reply: (to: string, text: string) => {
              calls.replies.push({ to, text });
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
  expect(calls.replies).toEqual([{ to: "peer-x", text: "on it" }]);
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
