// Mounts the real TileApprovalPanel (the answer panel a tile shows while its
// Claude Code module waits on a verdict) over a fake store, and reads which
// row it serves, what it offers and which IPC it calls.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";
import { hookAwaitedTiles } from "../desktop/src/main/hook-attention.ts";
import { hookRowsForTile } from "../desktop/src/shared/hook-await.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface Q {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multi_select: boolean;
}
interface Row {
  id: string;
  kind: "permission" | "question";
  reply_route: "hook" | "channel" | "pty";
  status: string;
  title: string;
  question: string;
  options: string[];
  questions: Q[] | null;
  created_at: string;
  origin: { tile_ref: string };
}

interface FakeState {
  pendingApprovals: Row[];
  remote: boolean;
  dict: Record<string, string>;
  approvalDrafts: Record<string, unknown>;
  setApprovalDraft: (id: string, d: unknown) => void;
  clearPendingApproval: (id: string) => void;
  showToast: () => void;
}

const fakeUseDeck = create<FakeState>((set) => ({
  pendingApprovals: [],
  remote: false,
  dict: { "tile.approvalMore": "+{n}" },
  approvalDrafts: {},
  setApprovalDraft: (id, d) =>
    set((s) => {
      const next = { ...s.approvalDrafts };
      if (d) next[id] = d;
      else delete next[id];
      return { approvalDrafts: next };
    }),
  clearPendingApproval: (id) => set((s) => ({ pendingApprovals: s.pendingApprovals.filter((a) => a.id !== id) })),
  showToast: () => {}
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { TileApprovalPanel } = await import("../desktop/src/renderer/src/components/TileApprovalPanel.tsx");
const { VERDICT_BLOCKED_REMOTELY } = await import("../desktop/src/renderer/src/components/verdict-remote.ts");

let calls: [string, ...unknown[]][];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls = [];
  const record =
    (name: string) =>
    (...args: unknown[]): Promise<boolean> => {
      calls.push([name, ...args]);
      return Promise.resolve(true);
    };
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {
    approvalAllow: record("approvalAllow"),
    approvalDecline: record("approvalDecline"),
    approvalHandback: record("approvalHandback"),
    approvalAnswers: record("approvalAnswers")
  };
  fakeUseDeck.setState({ pendingApprovals: [], remote: false, approvalDrafts: {} });
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

function row(over: Partial<Row>): Row {
  return {
    id: "r1",
    kind: "permission",
    reply_route: "hook",
    status: "pending",
    title: "Bash: rm -rf build",
    question: "rm -rf build",
    options: ["Allow", "Deny"],
    questions: null,
    created_at: "2026-10-07T08:00:00.000Z",
    origin: { tile_ref: "t1" },
    ...over
  };
}

function mount(rows: Row[], remote = false): void {
  act(() => {
    fakeUseDeck.setState({ pendingApprovals: rows, remote });
    root.render(React.createElement(TileApprovalPanel, { tileId: "t1" }));
  });
}

function push(rows: Row[]): void {
  act(() => {
    fakeUseDeck.setState({ pendingApprovals: rows });
  });
}

const panel = (): HTMLElement | null => container.querySelector(".tile-approval");
const actions = (): string[] =>
  [...container.querySelectorAll(".tile-approval-actions > button")].map((b) => b.textContent ?? "");
const button = (label: string): HTMLButtonElement =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

test("form A: a hook permission offers hand back, Deny and Allow, with the command to judge", () => {
  mount([row({})]);
  expect(panel(), "the panel opens by itself for a new row").not.toBeNull();
  expect(actions()).toEqual(["inbox.handback", "inbox.permissionDeny", "inbox.permissionAllow"]);
  expect(container.querySelector(".tile-approval-text")?.textContent).toBe("rm -rf build");
  expect(container.querySelector(".tile-approval-title")?.textContent).toBe("Bash: rm -rf build");
});

for (const [label, method] of [
  ["inbox.permissionAllow", "approvalAllow"],
  ["inbox.permissionDeny", "approvalDecline"],
  ["inbox.handback", "approvalHandback"]
] as const) {
  test(`form A: ${label} claims through ${method}, the Courrier's own call, and settles the row`, async () => {
    mount([row({})]);
    await click(button(label));
    expect(calls).toEqual([[method, "r1"]]);
    expect(panel(), "a settled row leaves the tile").toBeNull();
  });
}

test("form B/C: a hook question renders the question form and sends structured answers", async () => {
  const questions: Q[] = [
    { question: "Channel?", header: "", multi_select: false, options: [{ label: "Stable", description: "" }, { label: "Beta", description: "" }] },
    { question: "Platforms?", header: "", multi_select: true, options: [{ label: "Win", description: "" }, { label: "Mac", description: "" }] }
  ];
  mount([row({ id: "q1", kind: "question", title: "Release", question: "two questions", options: [], questions })]);
  expect(container.querySelectorAll("fieldset.aq")).toHaveLength(2);
  expect(container.querySelector(".tile-approval-text"), "each fieldset carries its question").toBeNull();
  expect(actions()).not.toContain("inbox.permissionAllow");
  const pick = (fs: number, label: string): HTMLInputElement =>
    [...container.querySelectorAll("fieldset.aq")[fs]!.querySelectorAll("label.aq-opt")]
      .find((l) => l.querySelector(".aq-label")?.textContent === label)!
      .querySelector("input") as HTMLInputElement;
  await click(pick(0, "Beta"));
  await click(pick(1, "Mac"));
  await click(pick(1, "Win"));
  await click(button("inbox.sendAnswers"));
  expect(calls).toEqual([["approvalAnswers", "q1", { "Channel?": ["Beta"], "Platforms?": ["Win", "Mac"] }]]);
});

test("two rows on one tile: the oldest is served and the others are counted", () => {
  mount([
    row({ id: "newest", title: "third", created_at: "2026-10-07T08:00:03.000Z" }),
    row({ id: "oldest", title: "first", created_at: "2026-10-07T08:00:01.000Z" }),
    row({ id: "middle", title: "second", created_at: "2026-10-07T08:00:02.000Z" })
  ]);
  expect(container.querySelector(".tile-approval-title")?.textContent).toBe("first");
  expect(container.querySelector(".tile-approval-more")?.textContent).toBe("+2");
  push([row({ id: "only", title: "alone" })]);
  expect(container.querySelector(".tile-approval-more"), "a single row counts nothing").toBeNull();
});

test("only a pending hook row declared for THIS tile opens the panel", () => {
  mount([
    row({ id: "a", reply_route: "channel" }),
    row({ id: "b", origin: { tile_ref: "t2" } }),
    row({ id: "c", origin: { tile_ref: "" } }),
    row({ id: "d", status: "answered" })
  ]);
  expect(panel()).toBeNull();
  push([row({ id: "e", status: "expired_notif" })]);
  expect(panel(), "an expired notification still waits on the operator").not.toBeNull();
});

test("on a remote companion whose verdict channels are blocked, the tile offers no verdict", () => {
  expect(VERDICT_BLOCKED_REMOTELY, "precondition: the companion floor blocks the verdict channels").toBe(true);
  mount([row({})], true);
  expect(panel()).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

test("folding holds for that row only: a newer row opens the panel again", async () => {
  mount([row({ id: "r1" })]);
  await click(container.querySelector(".tile-approval-fold")!);
  expect(panel()?.classList.contains("is-folded")).toBe(true);
  expect(container.querySelector(".tile-approval-actions"), "folded: the controls leave the tab order").toBeNull();
  push([row({ id: "r1" })]);
  expect(panel()?.classList.contains("is-folded"), "the same row stays folded across a poll").toBe(true);
  push([row({ id: "r2", created_at: "2026-10-07T08:05:00.000Z" })]);
  expect(panel()?.classList.contains("is-folded"), "a new row opens by itself").toBe(false);
});

test("the tile's rows and the attention flag come from one predicate", () => {
  const rows = [
    row({ id: "1" }),
    row({ id: "2", origin: { tile_ref: "t2" }, status: "expired_notif" }),
    row({ id: "3", origin: { tile_ref: "t3" }, reply_route: "channel" }),
    row({ id: "4", origin: { tile_ref: "t4" }, status: "answered" }),
    row({ id: "5", origin: { tile_ref: "" } })
  ];
  const flagged = hookAwaitedTiles(rows as never);
  const served = new Set(["t1", "t2", "t3", "t4", ""].filter((tile) => hookRowsForTile(rows, tile).length > 0));
  expect([...flagged].sort()).toEqual([...served].sort());
  expect([...flagged].sort()).toEqual(["t1", "t2"]);
});
