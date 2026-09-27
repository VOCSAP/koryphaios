// Mounts the real InboxPanel component and reads the rendered DOM for the three
// shapes senderOf() can produce on an approval entry: resolved (name only),
// unresolved with a tile_ref (text + <code>), unresolved with an empty tile_ref
// (text only).
// '@shared/*' imports are intercepted with mock.module, keyed by the bare
// specifier exactly as written in the importing file -- bun matches on that
// literal string, not on a resolved filesystem path.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const originalTimeZone = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

GlobalRegistrator.register();

// GlobalRegistrator.register() replaces globalThis.fetch repo-wide for the rest
// of this bun test process; the paired unregister is required by the repo-wide
// teardown scan.
afterAll(async () => {
  setSystemTime();
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, jest, mock, setSystemTime, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";

// Dynamic import: must run AFTER GlobalRegistrator.register() above, because
// react-dom inspects `window`/`document` at import time and a static import
// would be hoisted ahead of the register() call regardless of source order.
const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// FakeDeckState covers exactly what InboxPanel.tsx and i18n's useT() read; both
// resolve '../store' and './store' to the same file, so one mock.module call
// covers both call sites.
type FakeSession = { id: string; name: string };
interface FakeApprovalOrigin {
  tile_ref: string;
}
interface FakeApproval {
  id: string;
  origin: FakeApprovalOrigin;
  question: string;
  created_at: string;
}
type FakeInboxEntry = { kind: "approval"; approval: FakeApproval };

interface FakeDeckState {
  inboxMessages: unknown[];
  pendingApprovals: FakeApproval[];
  sessions: FakeSession[];
  inboxAckState: Record<string, string>;
  inboxReplyDrafts: Record<string, string>;
  graphDrafts: unknown[];
  dict: Record<string, string>;
  remote: boolean;
  openInbox: () => void;
  openGraphDraft: () => void;
  markInboxSeen: () => void;
  ackInboxEntry: () => void;
  setInboxReplyDraft: () => void;
  clearPendingApproval: () => void;
  showToast: () => void;
}

function initialFakeState(): FakeDeckState {
  return {
    inboxMessages: [],
    pendingApprovals: [],
    sessions: [],
    inboxAckState: {},
    inboxReplyDrafts: {},
    graphDrafts: [],
    dict: {},
    remote: false,
    openInbox: () => {},
    openGraphDraft: () => {},
    markInboxSeen: () => {},
    ackInboxEntry: () => {},
    setInboxReplyDraft: () => {},
    clearPendingApproval: () => {},
    showToast: () => {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  fakeUseDeck.setState(initialFakeState(), true);
}

// errorText is InboxPanel's other named import from '../store', unused by these
// render-only tests but must still exist as an export or the module fails to
// load.
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// mock.module freezes the exported-names list of a specifier for the whole
// bun process on first materialization, not per importing file: a factory
// exposing fewer names than the real module poisons every later file that
// imports another value export of the same specifier. Re-export the real
// module and only override the one symbol this fixture needs to control.
import * as realSharedTypes from "../desktop/src/shared/types.ts";

mock.module("@shared/types", () => ({
  ...realSharedTypes,
  inboxEntryKey: () => {
    throw new Error("inboxEntryKey stub called -- fixture must stay kind:'approval' only");
  }
}));

// '@shared/companion': InboxPanel.tsx computes VERDICT_BLOCKED_REMOTELY at
// module-eval time from these two, so the stub shape only needs to satisfy
// that one expression (`REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalReply.channel)`
// and its two siblings) -- an empty Set means "nothing blocked remotely",
// which is irrelevant here since `remote` stays false in every fixture.
mock.module("@shared/companion", () => ({
  COMPANION_MANIFEST: {
    approvalReply: { channel: "deck-only" },
    approvalDecline: { channel: "deck-only" },
    approvalAllow: { channel: "deck-only" }
  },
  REMOTE_BLOCKED_CHANNELS: new Set<string>()
}));

// Imported AFTER all three mock.module calls above, so InboxPanel.tsx's own
// imports (`../store`, `@shared/types`, `@shared/companion`) bind to the
// mocks rather than attempting real resolution.
const { InboxPanel } = await import("../desktop/src/renderer/src/components/InboxPanel.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-01-02T12:00:00.000Z"));
  resetFakeStore();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.useRealTimers();
  setSystemTime();
});

function approval(overrides: Partial<FakeApproval> = {}): FakeApproval {
  return {
    id: "apr-1",
    origin: { tile_ref: "" },
    question: "may I proceed?",
    created_at: "2020-01-01T00:00:00.000Z",
    ...overrides
  };
}

function renderApprovals(approvals: FakeApproval[], sessions: FakeSession[]): void {
  act(() => {
    fakeUseDeck.setState({ pendingApprovals: approvals, sessions });
    root.render(React.createElement(InboxPanel));
  });
}

function renderPanel(a: FakeApproval, sessions: FakeSession[]): void {
  renderApprovals([a], sessions);
}

function senderSpan(): HTMLElement | null {
  return container.querySelector(".inbox-entry-from");
}

test("resolved sender: tile_ref matches a live session -> name only, no <code>, no unresolved text", () => {
  renderPanel(
    approval({ origin: { tile_ref: "tile-abc" } }),
    [{ id: "tile-abc", name: "backend worker" }]
  );
  const span = senderSpan();
  expect(span).not.toBeNull();
  expect(span!.textContent).toBe("backend worker");
  expect(span!.querySelector("code")).toBeNull();
  expect(span!.textContent).not.toContain("inbox.senderUnresolved");
});

test("unresolved sender with a non-empty raw tile_ref -> senderUnresolved text AND the raw value inside a real <code> element", () => {
  renderPanel(approval({ origin: { tile_ref: "tile-gone" } }), []);
  const span = senderSpan();
  expect(span).not.toBeNull();
  // Empty dict -> t(key) falls back to the literal key (translate() in i18n.ts).
  expect(span!.textContent).toContain("inbox.senderUnresolved");
  const code = span!.querySelector("code");
  expect(code).not.toBeNull();
  expect(code!.textContent).toBe("tile-gone");
  // Not just "present somewhere in the text" -- specifically INSIDE <code>,
  // which is the "visibly differently" half of the contract this whole card
  // is about (roadmap 5bffb7b9's description).
  expect(span!.innerHTML).toContain("<code>tile-gone</code>");
});

test("unresolved sender with an EMPTY tile_ref -> senderUnresolvedEmpty text, no <code> at all", () => {
  renderPanel(approval({ origin: { tile_ref: "" } }), []);
  const span = senderSpan();
  expect(span).not.toBeNull();
  expect(span!.textContent).toBe("inbox.senderUnresolvedEmpty");
  expect(span!.querySelector("code")).toBeNull();
});

test("timestamps use local calendar days and refresh after local midnight", async () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Los_Angeles");
  // setSystemTime() alone does not survive advanceTimersToNextTimer() on bun
  // 1.3.13: it patches Date but not the fake-timer engine's own anchor, so
  // the clock snaps back to real time the moment a timer is advanced.
  // Re-anchoring via useFakeTimers({ now }) keeps both in sync.
  jest.useFakeTimers({ now: new Date("2026-01-03T07:59:59.000Z") });
  const currentLocalDayAt = "2026-01-02T12:00:00.000Z";
  const priorLocalDayAt = "2026-01-02T06:00:00.000Z";
  // Local midnight for the fixture's America/Los_Angeles TZ (fixed above),
  // one second after the frozen system time.
  const expectedLocalMidnight = Date.parse("2026-01-03T08:00:00.000Z");
  renderApprovals(
    [
      approval({ id: "apr-current-local-day", created_at: currentLocalDayAt }),
      approval({ id: "apr-prior-local-day", created_at: priorLocalDayAt })
    ],
    []
  );

  const timestamps = (): (string | null)[] =>
    [...container.querySelectorAll(".inbox-entry-time")].map((node) => node.textContent);
  expect(timestamps()).toEqual([
    new Date(currentLocalDayAt).toLocaleTimeString(),
    new Date(priorLocalDayAt).toLocaleString()
  ]);

  await act(async () => {
    jest.advanceTimersToNextTimer();
  });

  expect(Date.now()).toBe(expectedLocalMidnight);
  expect(timestamps()).toEqual([
    new Date(currentLocalDayAt).toLocaleString(),
    new Date(priorLocalDayAt).toLocaleString()
  ]);
  expect(jest.getTimerCount()).toBe(1);

  // A foreign timer (React's scheduler, happy-dom) can appear during the
  // component's lifetime under gate-scale load, so the count right before
  // unmount -- not a pre-mount baseline -- is what the delta must match.
  const beforeUnmount = jest.getTimerCount();
  act(() => {
    root.unmount();
  });
  expect(beforeUnmount - jest.getTimerCount()).toBe(1);

  expect(() => {
    jest.advanceTimersToNextTimer();
  }).not.toThrow();
  expect(timestamps()).toEqual([]);
});
