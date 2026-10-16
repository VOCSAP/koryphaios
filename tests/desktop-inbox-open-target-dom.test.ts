// Mounts the real InboxPanel with the store's one-shot inbox seed and reads
// which question modal the DOM shows.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// GlobalRegistrator.register() replaces globalThis.fetch repo-wide for the rest
// of this bun test process; the paired unregister is required by the repo-wide
// teardown scan.
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";

// Dynamic import: react-dom inspects `window`/`document` at import time, so it
// must load after register().
const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeApproval {
  id: string;
  origin: { tile_ref: string };
  question: string;
  created_at: string;
  kind: "question";
  reply_route: "channel";
  mergeable: boolean;
  options: string[];
}

interface FakeDeckState {
  inboxMessages: unknown[];
  pendingApprovals: FakeApproval[];
  sessions: unknown[];
  inboxAckState: Record<string, string>;
  inboxReplyDrafts: Record<string, string>;
  approvalDrafts: Record<string, unknown>;
  graphDrafts: unknown[];
  dict: Record<string, string>;
  remote: boolean;
  inboxSeed: string | null;
  clearInboxSeed: () => void;
  openInbox: () => void;
  openGraphDraft: () => void;
  markInboxSeen: () => void;
  ackInboxEntry: () => void;
  setInboxReplyDraft: () => void;
  setApprovalDraft: () => void;
  clearPendingApproval: () => void;
  showToast: () => void;
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function initialFakeState(): FakeDeckState {
  return {
    inboxMessages: [],
    pendingApprovals: [],
    sessions: [],
    inboxAckState: {},
    inboxReplyDrafts: {},
    approvalDrafts: {},
    graphDrafts: [],
    dict: {},
    remote: false,
    inboxSeed: null,
    clearInboxSeed: () => fakeUseDeck.setState({ inboxSeed: null }),
    openInbox: () => {},
    openGraphDraft: () => {},
    markInboxSeen: () => {},
    ackInboxEntry: () => {},
    setInboxReplyDraft: () => {},
    setApprovalDraft: () => {},
    clearPendingApproval: () => {},
    showToast: () => {}
  };
}

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// Re-export the real module: mock.module freezes a specifier's export list for
// the whole bun process on first materialization.
import * as realSharedTypes from "../desktop/src/shared/types.ts";

mock.module("@shared/types", () => ({
  ...realSharedTypes,
  inboxEntryKey: () => {
    throw new Error("inboxEntryKey stub called -- fixture must stay kind:'approval' only");
  }
}));

const { InboxPanel } = await import("../desktop/src/renderer/src/components/InboxPanel.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function question(id: string, created_at: string, text: string): FakeApproval {
  return {
    id,
    origin: { tile_ref: "" },
    question: text,
    created_at,
    kind: "question",
    reply_route: "channel",
    mergeable: false,
    options: []
  };
}

const OLDEST = question("apr-old", "2026-10-16T10:00:00.000Z", "oldest question");
const NEWEST = question("apr-new", "2026-10-16T11:00:00.000Z", "newest question");

function mount(seed: string | null): void {
  act(() => {
    fakeUseDeck.setState({ pendingApprovals: [NEWEST, OLDEST], inboxSeed: seed });
    root.render(React.createElement(InboxPanel));
  });
}

const modalText = (): string | null => container.querySelector(".inbox-modal-text")?.textContent ?? null;

test("a seeded panel opens the modal of the seeded question, not the first listed one", () => {
  mount("apr-old");
  expect(modalText(), "the seed names the OLDEST question, listed last").toBe("oldest question");
  expect(fakeUseDeck.getState().inboxSeed, "the seed is one-shot").toBeNull();
});

test("the seed does not reorder the Courrier: newest first", () => {
  mount("apr-old");
  const listed = [...container.querySelectorAll(".inbox-entry-excerpt")].map((n) => n.textContent);
  expect(listed).toEqual(["newest question", "oldest question"]);
});

test("a seed arriving while the panel is already open still opens its question", () => {
  mount(null);
  expect(modalText()).toBeNull();
  act(() => {
    fakeUseDeck.setState({ inboxSeed: "apr-new" });
  });
  expect(modalText()).toBe("newest question");
});

test("a seed naming a question already settled opens the panel without a modal", () => {
  mount("apr-answered");
  expect(modalText()).toBeNull();
  expect(container.querySelectorAll(".inbox-entry")).toHaveLength(2);
  expect(fakeUseDeck.getState().inboxSeed).toBeNull();
});

test("without a seed, no modal opens", () => {
  mount(null);
  expect(modalText()).toBeNull();
});
