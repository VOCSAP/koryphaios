import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";
import { capVisibly } from "../shared/text.ts";
import { APPROVAL_QUESTION_MAX } from "../shared/approval.ts";
import * as realSharedTypes from "../desktop/src/shared/types.ts";

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

const { ApprovalRequestBody, ApprovalNavigate } = await import(
  "../desktop/src/renderer/src/components/ApprovalRequestBody.tsx"
);
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

const PERMISSION = "The agent wants to use Bash.\nInput: {\"command\":\"ls\"}\nWorking directory: C:/work";

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
  render(React.createElement(ApprovalRequestBody, {
    approval: { kind: "permission", question: PERMISSION },
    className: "inbox-modal-text"
  }));
  expect(shape()).toEqual([
    "command:approval-command-head=The agent wants to use Bash.|approval-command-rest=Input: {\"command\":\"ls\"}\nWorking directory: C:/work",
    "signal:approval-signal-legend"
  ]);
  expect(container.firstElementChild!.classList.contains("inbox-modal-text"), "the host box class is kept").toBe(true);
});

test("a single-line permission renders no rest block, and the legend is still there", () => {
  render(React.createElement(ApprovalRequestBody, {
    approval: { kind: "permission", question: "rm -rf build" },
    className: "tile-approval-text"
  }));
  expect(shape()).toEqual([
    "command:approval-command-head=rm -rf build",
    "signal:approval-signal-legend"
  ]);
});

test("the danger badge appears only with a danger prop, before the legend, naming the matched pattern", () => {
  render(React.createElement(ApprovalRequestBody, {
    approval: { kind: "permission", question: "rm -rf /" },
    danger: "rm -rf",
    className: "inbox-modal-text"
  }));
  expect(shape()[1]).toBe("signal:approval-danger-badge|approval-signal-legend");
  const badge = container.querySelector(".approval-danger-badge")!;
  expect(badge.querySelector("code")!.textContent).toBe("rm -rf");
  expect(badge.querySelector("svg"), "the badge carries a glyph, not an emoji").not.toBeNull();
});

test("a null danger renders no badge", () => {
  render(React.createElement(ApprovalRequestBody, {
    approval: { kind: "permission", question: "ls" },
    danger: null,
    className: "inbox-modal-text"
  }));
  expect(container.querySelector(".approval-danger-badge")).toBeNull();
  expect(container.querySelector(".approval-signal-legend")).not.toBeNull();
});

test("a question is plain text: no command block, no signal row", () => {
  render(React.createElement(ApprovalRequestBody, {
    approval: { kind: "question", question: "Which branch?\nmain or dev" },
    className: "inbox-modal-text"
  }));
  expect(shape()).toEqual(["plain:inbox-modal-text=Which branch?\nmain or dev"]);
});

test("markup in the agent's text renders as literal text: no element injected, no handler run", () => {
  const g = globalThis as Record<string, unknown>;
  delete g.__approvalPwned;
  const head = `<img src=x onerror="globalThis.__approvalPwned=1">`;
  const rest = `<b onmouseover="globalThis.__approvalPwned=2">bold</b>`;
  const danger = `<svg onload="globalThis.__approvalPwned=3"></svg>`;
  render(React.createElement(ApprovalRequestBody, {
    approval: { kind: "permission", question: `${head}\n${rest}` },
    danger,
    className: "inbox-modal-text"
  }));
  expect(container.querySelector(".approval-command-head")!.textContent).toBe(head);
  expect(container.querySelector(".approval-command-rest")!.textContent).toBe(rest);
  expect(container.querySelector(".approval-danger-badge code")!.textContent).toBe(danger);
  expect(container.querySelectorAll("img, b").length, "no element built from the agent's markup").toBe(0);
  expect(container.querySelectorAll(".approval-danger-badge svg").length, "only the badge glyph is an svg").toBe(1);
  expect(g.__approvalPwned).toBeUndefined();
});

const LONG = capVisibly(`The agent wants to use Bash.\nInput: {"command":"${"x".repeat(5000)}"}`, APPROVAL_QUESTION_MAX);
const MARKER = /… \[truncated from \d+ characters\]$/;

test("a producer-cut question keeps its visible truncation marker", () => {
  expect(LONG, "fixture is really cut by the producer's cutter").toMatch(MARKER);
  render(React.createElement(ApprovalRequestBody, {
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
  expect(modal.querySelector(".inbox-modal-text.approval-command .approval-command-head")!.textContent).toBe(
    "The agent wants to use Bash."
  );
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

test("the tile panel renders its hook permission through the shared body", () => {
  fakeUseDeck.setState({ pendingApprovals: [approval()] });
  render(React.createElement(TileApprovalPanel, { tileId: "tile-a" }));
  const body = container.querySelector(".tile-approval-body")!;
  expect(body.querySelector(".tile-approval-text.approval-command .approval-command-head")!.textContent).toBe(
    "The agent wants to use Bash."
  );
  expect(body.querySelector(".approval-signal .approval-signal-legend")).not.toBeNull();
  expect(body.querySelector(".inbox-goto-btn"), "the tile already is the destination").toBeNull();
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
