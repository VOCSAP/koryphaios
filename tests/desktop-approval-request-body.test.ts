import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";
import { capVisibly } from "../shared/text.ts";
import { APPROVAL_QUESTION_MAX } from "../shared/approval.ts";
import * as realSharedTypes from "../desktop/src/shared/types.ts";
import { buildSpawnApprovalPayload } from "../desktop/src/main/serve-approval-dialog.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

type FakeSession = { id: string; name: string };
interface FakeApproval {
  id: string;
  kind: "permission" | "question";
  reply_route: "hook" | "channel" | "pty";
  status: string;
  title: string;
  question: string;
  options: string[];
  questions: null;
  text_flags?: string[];
  danger_view?: realSharedTypes.DangerView;
  mergeable: boolean;
  absorbed_permission: boolean;
  created_at: string;
  origin: { tile_ref: string };
}
interface FakeDeckState {
  sessions: FakeSession[];
  pendingApprovals: FakeApproval[];
  inboxMessages: unknown[];
  inboxAckState: Record<string, string>;
  inboxArchive: { status: string; messages: Record<string, unknown>; closedQuestions: unknown[] };
  inboxReplyDrafts: Record<string, string>;
  approvalDrafts: Record<string, unknown>;
  graphDrafts: unknown[];
  dict: Record<string, string>;
  remote: boolean;
  focusTile: (id: string) => void;
  openInbox: (open: boolean) => void;
  openGraphDraft: () => void;
  markInboxSeen: () => void;
  ackInboxEntry: () => void;
  setInboxReplyDraft: () => void;
  setApprovalDraft: () => void;
  clearPendingApproval: () => void;
  showToast: () => void;
}

let focused: string[] = [];
let inboxCalls: boolean[] = [];

function initialFakeState(): FakeDeckState {
  return {
    sessions: [],
    pendingApprovals: [],
    inboxMessages: [],
    inboxAckState: {},
    inboxArchive: { status: "unsupported", messages: {}, closedQuestions: [] },
    inboxReplyDrafts: {},
    approvalDrafts: {},
    graphDrafts: [],
    dict: {},
    remote: false,
    focusTile: (id) => {
      focused.push(id);
    },
    openInbox: (open) => {
      inboxCalls.push(open);
    },
    openGraphDraft: () => {},
    markInboxSeen: () => {},
    ackInboxEntry: () => {},
    setInboxReplyDraft: () => {},
    setApprovalDraft: () => {},
    clearPendingApproval: () => {},
    showToast: () => {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });
mock.module("@shared/types", () => ({ ...realSharedTypes }));

const { ApprovalRequestBody } = await import("../desktop/src/renderer/src/components/ApprovalRequestBody.tsx");
const { ApprovalNavigate } = await import("../desktop/src/renderer/src/components/ApprovalNavigate.tsx");
const { linkedText } = await import("../desktop/src/renderer/src/components/LinkedText.tsx");
const { translate } = await import("../desktop/src/renderer/src/i18n.ts");

const keyT = (key: string, params?: Record<string, string | number>): string => translate({}, key, params);

function body(props: { approval: { kind: string; question: string; text_flags?: string[] }; className: string }): unknown {
  return React.createElement(ApprovalRequestBody, { t: keyT, renderText: linkedText, ...props } as never);
}
const { InboxPanel } = await import("../desktop/src/renderer/src/components/InboxPanel.tsx");
const { TileApprovalPanel } = await import("../desktop/src/renderer/src/components/TileApprovalPanel.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  focused = [];
  inboxCalls = [];
  fakeUseDeck.setState(initialFakeState(), true);
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

function render(el: unknown): void {
  act(() => {
    root.render(el as Parameters<Root["render"]>[0]);
  });
}

function shape(): string[] {
  return [...container.children].map((el) => {
    if (el.classList.contains("approval-command")) {
      return `command:${[...el.children].map((c) => `${c.className}=${c.textContent}`).join("|")}`;
    }
    if (el.classList.contains("approval-signal")) {
      return `signal:${[...el.children].map((c) => c.className).join("|")}`;
    }
    return `plain:${el.className}=${el.textContent}`;
  });
}

const PERMISSION = "Bash: ls\nInput: {\"command\":\"ls\"}\nWorking directory: C:/work";

function approval(over: Partial<FakeApproval> = {}): FakeApproval {
  return {
    id: "apr-1",
    kind: "permission",
    reply_route: "hook",
    status: "pending",
    title: "ls",
    question: PERMISSION,
    options: ["Allow", "Deny"],
    questions: null,
    mergeable: false,
    absorbed_permission: false,
    created_at: "2026-10-09T12:00:00.000Z",
    origin: { tile_ref: "tile-a" },
    ...over
  };
}

test("a permission leads with its first line, then the rest, then the legend alone when nothing is flagged", () => {
  render(body({
    approval: { kind: "permission", question: PERMISSION },
    className: "inbox-modal-text"
  }));
  expect(shape()).toEqual([
    "command:approval-command-head=Bash: ls|approval-command-rest=Input: {\"command\":\"ls\"}\nWorking directory: C:/work",
    "signal:approval-signal-legend"
  ]);
  expect(container.firstElementChild!.classList.contains("inbox-modal-text"), "the host box class is kept").toBe(true);
});

test("a single-line permission renders no rest block, and the legend is still there", () => {
  render(body({
    approval: { kind: "permission", question: "rm -rf build" },
    className: "tile-approval-text"
  }));
  expect(shape()).toEqual([
    "command:approval-command-head=rm -rf build",
    "signal:approval-signal-legend"
  ]);
});

const EN = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "desktop", "locales", "en.json"), "utf8")) as Record<string, string>;
const enT = (key: string, params?: Record<string, string | number>): string => translate(EN, key, params);
type View = realSharedTypes.DangerView;
type Entry = realSharedTypes.DangerViewEntry;
const KORY_RM: Entry = { id: "kory/rm-recursive", source: "kory", message: "rm -r deletes a tree.", messageFrom: "deck", known: true, confirmed: true };

function viewBody(dangerView: View | undefined, question = "Bash: rm -rf /"): unknown {
  return React.createElement(ApprovalRequestBody, {
    t: enT,
    renderText: linkedText,
    approval: { kind: "permission", question },
    dangerView,
    className: "inbox-modal-text"
  } as never);
}
const notes = (): string[] => [...container.querySelectorAll(".approval-danger-row")].map((row) =>
  [...row.children].map((c) => c.textContent).join(" | "));

test("a danger row appears per entry of the Deck's view, before the legend, naming the rule with a glyph", () => {
  render(viewBody({ reevaluation: "done", entries: [KORY_RM] }));
  expect(shape()[1]).toBe("signal:approval-danger-row|approval-signal-legend");
  const badge = container.querySelector(".approval-danger-badge")!;
  expect(badge.querySelector("code")!.textContent).toBe("kory/rm-recursive");
  expect(badge.querySelector("svg"), "the badge carries a glyph, not an emoji").not.toBeNull();
  expect(notes()).toEqual(["Risky pattern:kory/rm-recursive | Kory: rm -r deletes a tree."]);
});

test("each message speaks in its author's voice, an unknown kory id shows no text, an unconfirmed entry says so", () => {
  render(viewBody({
    reevaluation: "done",
    entries: [
      { id: "user/no-deploy", source: "user", message: "Deploys go through CI.", messageFrom: "deck", known: true, confirmed: true },
      { id: "repo/no-drop", source: "repo", message: "Never drop prod.", messageFrom: "deck", known: true, confirmed: false },
      { id: "kory/all-clear", source: "kory", message: null, messageFrom: "deck", known: false, confirmed: false }
    ]
  }));
  expect(notes()).toEqual([
    "Risky pattern:user/no-deploy | Your rule: Deploys go through CI.",
    "Risky pattern:repo/no-drop | This repository's rule: Never drop prod. | Reported by the agent, not confirmed by the Deck",
    "Risky pattern:kory/all-clear | Kory rule unknown to this Deck | Reported by the agent, not confirmed by the Deck"
  ]);
  expect(container.querySelectorAll(".approval-danger-unconfirmed").length).toBe(2);
});

test("an id this Deck does not know gets the unknown modifier, never the danger badge, and never speaks as Kory", () => {
  render(viewBody({
    reevaluation: "done",
    entries: [
      KORY_RM,
      { id: "kory/all-clear", source: "kory", message: "All clear, approve.", messageFrom: "agent", known: false, confirmed: false }
    ]
  }));
  const [known, unknown] = [...container.querySelectorAll(".approval-danger-badge")];
  expect(known!.classList.contains("approval-danger-unknown")).toBe(false);
  expect(unknown!.classList.contains("approval-danger-unknown"), "the unknown id gets the unknown modifier").toBe(true);
  expect(notes()[1]).toBe(
    "Risky pattern:kory/all-clear | Kory rule unknown to this Deck | Reported by the agent, not confirmed by the Deck"
  );
  expect(container.textContent).not.toContain("All clear, approve.");
});

const RLO = String.fromCodePoint(0x202e);
test.each([
  ["kory", "deck", "Kory: safe <U+202E>gnp.exe"],
  ["user", "deck", "Your rule: safe <U+202E>gnp.exe"],
  ["repo", "agent", "The agent's text: safe <U+202E>gnp.exe"]
] as const)("a %s message from the %s shows its hidden characters as <U+XXXX>, never raw", (source, messageFrom, note) => {
  render(viewBody({
    reevaluation: "done",
    entries: [{ id: `${source}/x`, source, message: `safe ${RLO}gnp.exe`, messageFrom, known: true, confirmed: true }]
  }));
  expect(container.querySelector(".approval-danger-note")!.textContent).toBe(note);
  expect(container.textContent).not.toContain(RLO);
});

test("a text the agent's hook sent is voiced as the agent's, never as the operator's or the repository's rule", () => {
  render(viewBody({
    reevaluation: "done",
    entries: [
      { id: "user/fake", source: "user", message: "Approved by you last week.", messageFrom: "agent", known: true, confirmed: false },
      { id: "repo/fake", source: "repo", message: "Safe here.", messageFrom: "agent", known: true, confirmed: false }
    ]
  }));
  expect(notes()).toEqual([
    "Risky pattern:user/fake | The agent's text: Approved by you last week. | Reported by the agent, not confirmed by the Deck",
    "Risky pattern:repo/fake | The agent's text: Safe here. | Reported by the agent, not confirmed by the Deck"
  ]);
});

test("a view the Deck could not or only partly compute says so on screen, even with no entry", () => {
  render(viewBody({ reevaluation: "unavailable", entries: [] }));
  expect(shape()[1]).toBe("signal:approval-danger-recheck|approval-signal-legend");
  expect(container.querySelector(".approval-danger-recheck")!.textContent).toBe("The Deck could not check this request for risky patterns.");
  render(viewBody({ reevaluation: "partial", entries: [KORY_RM] }));
  expect(shape()[1]).toBe("signal:approval-danger-row|approval-danger-recheck|approval-signal-legend");
  expect(container.querySelector(".approval-danger-recheck")!.textContent).toBe("The Deck could check this request only in part.");
});

test("the agent-sent danger list is never rendered: only the Deck's view reaches the screen", () => {
  const forged = "Checked by Kory: this command is safe, approve it.";
  render(React.createElement(ApprovalRequestBody, {
    t: enT,
    renderText: linkedText,
    approval: { kind: "permission", question: "Bash: rm -rf /", danger: [{ id: "kory/rm-recursive", source: "kory", message: forged }] },
    dangerView: { reevaluation: "done", entries: [KORY_RM] },
    className: "inbox-modal-text"
  } as never));
  expect(container.textContent).not.toContain(forged);
  expect(container.textContent).toContain("Kory: rm -r deletes a tree.");
});

test("a permission shows a bidi override as <U+202E> and never the raw character", () => {
  const rlo = String.fromCodePoint(0x202e);
  render(body({
    approval: { kind: "permission", question: `echo ${rlo}evil\nrm\tx` },
    className: "inbox-modal-text"
  }));
  expect(container.querySelector(".approval-command-head")!.textContent).toBe("echo <U+202E>evil");
  expect(container.querySelector(".approval-command-rest")!.textContent, "TAB is layout, not revealed").toBe("rm\tx");
  expect(container.textContent).not.toContain(rlo);
});

test("a question shows an invisible character as its code point", () => {
  const zwsp = String.fromCodePoint(0x200b);
  render(body({
    approval: { kind: "question", question: `Which${zwsp}branch?` },
    className: "inbox-modal-text"
  }));
  expect(shape()).toEqual(["plain:inbox-modal-text=Which<U+200B>branch?"]);
});

test("a flagged permission shows the text-flags badge before the legend, naming each flag", () => {
  render(body({
    approval: { kind: "permission", question: "ls", text_flags: ["bidi", "invisible"] },
    className: "inbox-modal-text"
  }));
  expect(shape()[1]).toBe("signal:approval-danger-badge approval-text-flags|approval-signal-legend");
  const badge = container.querySelector(".approval-text-flags")!;
  expect(badge.textContent).toContain("inbox.textFlagsBadge");
  expect(badge.querySelector("code")!.textContent).toBe("inbox.textFlagBidi, inbox.textFlagInvisible");
  expect(badge.querySelector("svg"), "the badge carries a glyph, not an emoji").not.toBeNull();
});

test("a flagged question shows the text-flags badge under its text", () => {
  render(body({
    approval: { kind: "question", question: "Which branch?", text_flags: ["control"] },
    className: "inbox-modal-text"
  }));
  expect(shape()).toEqual(["plain:inbox-modal-text=Which branch?", "signal:approval-danger-badge approval-text-flags"]);
});

test("empty or absent text_flags render no text-flags badge", () => {
  for (const approvalProps of [
    { kind: "permission", question: "ls", text_flags: [] },
    { kind: "permission", question: "ls" },
    { kind: "question", question: "Which branch?", text_flags: [] },
    { kind: "question", question: "Which branch?" }
  ]) {
    render(body({ approval: approvalProps, className: "inbox-modal-text" }));
    expect(container.querySelector(".approval-text-flags"), JSON.stringify(approvalProps)).toBeNull();
  }
});

test("no danger view, or an empty one fully checked, renders no badge and no note, only the legend", () => {
  for (const view of [undefined, { reevaluation: "done" as const, entries: [] }]) {
    render(viewBody(view, "ls"));
    expect(shape()[1], JSON.stringify(view)).toBe("signal:approval-signal-legend");
  }
});

test("a question is plain text: no command block, no signal row", () => {
  render(body({
    approval: { kind: "question", question: "Which branch?\nmain or dev" },
    className: "inbox-modal-text"
  }));
  expect(shape()).toEqual(["plain:inbox-modal-text=Which branch?\nmain or dev"]);
});

test("a spawn payload stays visible in the Courrier approval body", () => {
  const rlo = String.fromCharCode(0x202e);
  const payload = buildSpawnApprovalPayload([{
    name: `worker\n${rlo}漢`, agent: "", embedded: "", model: "", effort: "", cli: "claude", worktree_branch: "", prompt_preview: "", args: "--label   value"
  }], "team-lead-deadbeef", false);
  render(body({
    approval: { kind: "permission", question: payload.question },
    className: "inbox-modal-text"
  }));

  expect(payload.title).toBe('Agent "team-lead-deadbeef" wants to spawn 1 agent session');
  expect(container.querySelector(".approval-command-head")!.textContent).toStartWith("01| ");
  expect(container.querySelector(".approval-command-rest")!.textContent).toContain("args:·--label");
  expect(container.textContent).not.toContain("--label   ");
  expect(container.textContent).not.toContain(`worker\n`);
  expect(container.textContent).not.toContain(rlo);
  expect(container.textContent).not.toContain("漢");
});

test("a question's URL is a link inside the host box", () => {
  render(body({
    approval: { kind: "question", question: "Is https://example.com/x right?" },
    className: "inbox-modal-text"
  }));
  expect(shape()).toEqual(["plain:inbox-modal-text=Is https://example.com/x right?"]);
  expect([...container.querySelectorAll(".inbox-modal-text > .text-link")].map((b) => b.textContent)).toEqual([
    "https://example.com/x"
  ]);
});

test("a question is shown through the host's renderText: a host without links gets plain text", () => {
  const seen: string[] = [];
  render(React.createElement(ApprovalRequestBody, {
    t: keyT,
    approval: { kind: "question", question: "Is https://example.com/x right?" },
    className: "inbox-modal-text",
    renderText: (text: string) => {
      seen.push(text);
      return text;
    }
  } as never));
  expect(seen).toEqual(["Is https://example.com/x right?"]);
  expect(container.querySelectorAll(".text-link").length, "no Deck link wired behind the host's back").toBe(0);
  expect(shape()).toEqual(["plain:inbox-modal-text=Is https://example.com/x right?"]);
});

test("a permission command stays plain text on every line: the operator judges it as written", () => {
  render(body({
    approval: { kind: "permission", question: "Run curl https://example.com/a\nthen https://example.com/b" },
    className: "inbox-modal-text"
  }));
  expect(container.querySelector(".approval-command-head")!.textContent).toBe("Run curl https://example.com/a");
  expect(container.querySelector(".approval-command-rest")!.textContent).toBe("then https://example.com/b");
  expect(container.querySelectorAll(".text-link").length).toBe(0);
});

test("the Courrier modal links a message's URL while the list excerpt stays plain text", () => {
  fakeUseDeck.setState({
    inboxMessages: [{ id: 1, from: "peer-x", text: "see https://example.com/x", sentAt: "2026-10-09T12:00:00.000Z" }]
  });
  render(React.createElement(InboxPanel));
  expect(container.querySelectorAll(".text-link").length, "the list row is itself a control").toBe(0);
  act(() => {
    (container.querySelector(".inbox-entry") as HTMLElement).click();
  });
  expect([...container.querySelectorAll(".inbox-modal .inbox-modal-text .text-link")].map((b) => b.textContent)).toEqual([
    "https://example.com/x"
  ]);
});

test("markup in the agent's text renders as literal text: no element injected, no handler run", () => {
  const g = globalThis as Record<string, unknown>;
  delete g.__approvalPwned;
  const head = `<img src=x onerror="globalThis.__approvalPwned=1">`;
  const rest = `<b onmouseover="globalThis.__approvalPwned=2">bold</b>`;
  const danger = `<svg onload="globalThis.__approvalPwned=3"></svg>`;
  render(viewBody(
    { reevaluation: "done", entries: [{ id: "user/x", source: "user", message: danger, messageFrom: "deck", known: true, confirmed: false }] },
    `${head}\n${rest}`
  ));
  expect(container.querySelector(".approval-command-head")!.textContent).toBe(head);
  expect(container.querySelector(".approval-command-rest")!.textContent).toBe(rest);
  expect(container.querySelector(".approval-danger-note")!.textContent).toBe(`Your rule: ${danger}`);
  expect(container.querySelectorAll("img, b").length, "no element built from the agent's markup").toBe(0);
  expect(container.querySelectorAll(".approval-danger-badge svg").length, "only the badge glyph is an svg").toBe(1);
  expect(g.__approvalPwned).toBeUndefined();
});

const LONG_HEAD = capVisibly(`Bash: ${"x".repeat(5000)}`, 160);
const LONG = capVisibly(`${LONG_HEAD}\nInput: {"command":"${"x".repeat(5000)}"}`, APPROVAL_QUESTION_MAX);
const MARKER = /… \[truncated from \d+ characters\]$/;

test("a producer-cut question keeps its visible truncation marker", () => {
  expect(LONG, "fixture is really cut by the producer's cutter").toMatch(MARKER);
  render(body({
    approval: { kind: "permission", question: LONG },
    className: "inbox-modal-text"
  }));
  const rest = container.querySelector(".approval-command-rest")!.textContent!;
  expect(rest).toMatch(MARKER);
  expect(`${container.querySelector(".approval-command-head")!.textContent}\n${rest}`).toBe(LONG);
});

function gotoButton(): HTMLButtonElement {
  return container.querySelector(".inbox-goto-btn") as HTMLButtonElement;
}

test("Navigate is disabled with its visible reason when the tile_ref matches no live tile", () => {
  fakeUseDeck.setState({ sessions: [{ id: "tile-a", name: "worker" }] });
  let navigated = 0;
  render(React.createElement(ApprovalNavigate, {
    approval: { origin: { tile_ref: "tile-gone" } },
    onNavigated: () => navigated++
  }));
  expect(gotoButton().disabled).toBe(true);
  expect(container.querySelector(".inbox-goto-reason")!.textContent).toBe("inbox.navigateUnavailable");
  act(() => {
    gotoButton().click();
  });
  expect(focused).toEqual([]);
  expect(navigated).toBe(0);
});

test("Navigate is disabled for an empty tile_ref", () => {
  render(React.createElement(ApprovalNavigate, {
    approval: { origin: { tile_ref: "" } },
    onNavigated: () => {}
  }));
  expect(gotoButton().disabled).toBe(true);
});

test("a tile_ref that only prefixes a live tile id is not followed", () => {
  fakeUseDeck.setState({ sessions: [{ id: "tile-abc", name: "worker" }] });
  render(React.createElement(ApprovalNavigate, {
    approval: { origin: { tile_ref: "tile-a" } },
    onNavigated: () => {}
  }));
  expect(gotoButton().disabled).toBe(true);
});

test("the Courrier modal renders a permission through the shared body and Navigate jumps to its tile", () => {
  fakeUseDeck.setState({
    sessions: [{ id: "tile-a", name: "worker" }, { id: "tile-b", name: "other" }],
    pendingApprovals: [approval({ question: LONG })]
  });
  render(React.createElement(InboxPanel));
  expect(container.querySelector(".inbox-entry-excerpt")!.textContent, "the list excerpt keeps the marker").toMatch(MARKER);
  act(() => {
    (container.querySelector(".inbox-entry") as HTMLElement).click();
  });
  const modal = container.querySelector(".inbox-modal")!;
  expect(modal.querySelector(".inbox-modal-text.approval-command .approval-command-head")!.textContent).toBe(LONG_HEAD);
  expect(modal.querySelector(".approval-signal .approval-signal-legend")).not.toBeNull();
  const go = modal.querySelector(".inbox-goto-btn") as HTMLButtonElement;
  expect(go.disabled).toBe(false);
  act(() => {
    go.click();
  });
  expect(focused).toEqual(["tile-a"]);
  expect(inboxCalls, "the Courrier closes so the tile is visible").toEqual([false]);
  expect(container.querySelector(".inbox-modal"), "the modal closes too").toBeNull();
});

test("the Courrier modal disables Navigate when the requesting tile is not open", () => {
  fakeUseDeck.setState({
    sessions: [{ id: "tile-b", name: "other" }],
    pendingApprovals: [approval({ origin: { tile_ref: "tile-gone" } })]
  });
  render(React.createElement(InboxPanel));
  act(() => {
    (container.querySelector(".inbox-entry") as HTMLElement).click();
  });
  expect((container.querySelector(".inbox-modal .inbox-goto-btn") as HTMLButtonElement).disabled).toBe(true);
  expect(container.querySelector(".inbox-modal .inbox-goto-reason")).not.toBeNull();
});

test("every rejected Courrier or Reclame call is traced to the journal right before its toast", async () => {
  const log: string[] = [];
  const g = globalThis as unknown as { window: { api?: unknown } };
  g.window.api = {
    inboxDelete: () => Promise.reject(new Error("delete-boom")),
    inboxReply: () => Promise.reject(new Error("reply-boom")),
    approvalDecline: () => Promise.reject(new Error("decline-boom")),
    approvalHandback: () => Promise.reject(new Error("handback-boom")),
    reportError: (scope: string, message: string) => log.push(`report:${scope}:${message}`)
  };
  const message = { id: 3, from: "peer-x", text: "hi", sentAt: "2026-10-09T12:00:00.000Z" };
  const press = async (el: Element | undefined | null): Promise<void> => {
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const entry = (excerpt: string): Element | undefined =>
    [...container.querySelectorAll(".inbox-entry")].find((e) => e.querySelector(".inbox-entry-excerpt")?.textContent === excerpt);
  const labelled = (label: string): Element | undefined =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  const closeModal = async (): Promise<void> => press(container.querySelector(".modal-backdrop"));
  try {
    fakeUseDeck.setState({
      inboxMessages: [message],
      inboxReplyDrafts: { [realSharedTypes.inboxEntryKey({ kind: "message", message })]: "on it" },
      pendingApprovals: [
        approval({ id: "apr-d", kind: "question", reply_route: "channel", options: [], question: "decline me" }),
        approval({ id: "apr-h", kind: "permission", reply_route: "hook", question: "hand me back" })
      ],
      showToast: ((key: string) => log.push(`toast:${key.split(":")[0]}`)) as never
    });
    await act(async () => {
      root.render(React.createElement(InboxPanel) as Parameters<Root["render"]>[0]);
    });
    await press(container.querySelector(".inbox-delete-btn"));
    await press(entry("hi"));
    await press(labelled("inbox.reply"));
    await closeModal();
    await press(entry("decline me"));
    await press(labelled("inbox.decline"));
    await closeModal();
    await press(entry("hand me back"));
    await press(labelled("inbox.handback"));
    expect(log.map((line) => line.replace("Error: ", ""))).toEqual([
      "report:inbox:delete of message 3 failed: delete-boom",
      "toast:inbox.delete",
      "report:inbox:reply to message 3 failed: reply-boom",
      "toast:inbox.reply",
      "report:inbox:answer 'deny' on apr-d failed: decline-boom",
      "toast:inbox.reply",
      "report:inbox:hook answer 'handback' on apr-h failed: handback-boom",
      "toast:inbox.reply"
    ]);
  } finally {
    delete g.window.api;
  }
});

test("the tile panel renders its hook permission through the shared body", () => {
  fakeUseDeck.setState({ pendingApprovals: [approval()] });
  render(React.createElement(TileApprovalPanel, { tileId: "tile-a" }));
  const body = container.querySelector(".tile-approval-body")!;
  expect(body.querySelector(".tile-approval-text.approval-command .approval-command-head")!.textContent).toBe("Bash: ls");
  expect(body.querySelector(".approval-signal .approval-signal-legend")).not.toBeNull();
  expect(body.querySelector(".inbox-goto-btn"), "the tile already is the destination").toBeNull();
});

test("the Courrier modal and the tile panel both show the row's danger view", () => {
  const danger_view: View = { reevaluation: "unavailable", entries: [KORY_RM] };
  fakeUseDeck.setState({ sessions: [{ id: "tile-a", name: "worker" }], pendingApprovals: [approval({ danger_view })] });
  render(React.createElement(InboxPanel));
  act(() => {
    (container.querySelector(".inbox-entry") as HTMLElement).click();
  });
  const modal = container.querySelector(".inbox-modal")!;
  expect(modal.querySelector(".approval-danger-row code")?.textContent, "Courrier").toBe("kory/rm-recursive");
  expect(modal.querySelector(".approval-danger-recheck"), "Courrier").not.toBeNull();
  render(React.createElement(TileApprovalPanel, { tileId: "tile-a" }));
  const tile = container.querySelector(".tile-approval-body")!;
  expect(tile.querySelector(".approval-danger-row code")?.textContent, "tile panel").toBe("kory/rm-recursive");
  expect(tile.querySelector(".approval-danger-recheck"), "tile panel").not.toBeNull();
});

test("the tile panel reveals a bidi override in its title and badges the flagged row", () => {
  const rlo = String.fromCodePoint(0x202e);
  fakeUseDeck.setState({
    pendingApprovals: [approval({ title: `ls ${rlo}`, question: `ls ${rlo}`, text_flags: ["bidi"] })]
  });
  render(React.createElement(TileApprovalPanel, { tileId: "tile-a" }));
  expect(container.querySelector(".tile-approval-title")!.textContent).toBe("ls <U+202E>");
  expect(container.querySelector(".tile-approval-body .approval-text-flags")).not.toBeNull();
  expect(container.textContent).not.toContain(rlo);
});

// Process isolation preserves alias resolution and avoids irreversible renderer mocks.
test("a system-notification click, through the real store, shows the agents view on exactly that tile", () => {
  const dir = mkdtempSync(join(tmpdir(), "focus-tile-"));
  try {
    const storePath = resolve(import.meta.dir, "../desktop/src/renderer/src/store.ts").replaceAll("\\", "/");
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      [
        "let onFocus: ((id: string) => void) | undefined;",
        "let rejections = 0;",
        "process.on('unhandledRejection', () => { rejections++; });",
        "const boot: Record<string, () => Promise<unknown>> = {",
        "  listSessions: async () => [], getConfig: async () => ({}),",
        "  getI18n: async () => ({ dict: {}, available: [] }),",
        "  listWorkspaces: async () => [], listTemplates: async () => []",
        "};",
        "const api = new Proxy({}, { get: (_t, key) => {",
        "  if (typeof key !== 'string') return undefined;",
        "  if (key in boot) return boot[key];",
        "  if (key.startsWith('on')) return (cb: (id: string) => void) => { if (key === 'onFocusSession') onFocus = cb; return () => {}; };",
        "  return () => Promise.resolve(undefined);",
        "} });",
        "(globalThis as Record<string, unknown>).window = { api };",
        `const { useDeck } = await import(${JSON.stringify(storePath)});`,
        "await useDeck.getState().init().catch(() => { rejections++; });",
        "useDeck.setState({ view: 'home', selectedId: 'tile-other' });",
        "onFocus?.('tile-a');",
        "const s = useDeck.getState();",
        "console.error(`unrelated init rejections: ${rejections}`);",
        "console.log(JSON.stringify({ subscribed: typeof onFocus === 'function', view: s.view, selectedId: s.selectedId }));",
        "process.exit(0);"
      ].join("\n")
    );
    const tsconfig = resolve(import.meta.dir, "../desktop/tsconfig.web.json");
    const r = Bun.spawnSync([process.execPath, `--tsconfig-override=${tsconfig}`, "run", probe]);
    const out = r.stdout.toString().trim();
    expect(r.exitCode, `probe failed: ${r.stderr.toString()}`).toBe(0);
    expect(JSON.parse(out.split("\n").at(-1)!), "init subscribes onFocusSession and its callback focuses the tile").toEqual({
      subscribed: true,
      view: "agents",
      selectedId: "tile-a"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
