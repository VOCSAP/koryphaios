// Card 5bffb7b9 -- companion guard to tests/desktop-inbox-sender.test.ts.
//
// That file's proof-2 describes (source scan) that InboxPanel.tsx routes
// through resolveApprovalSender(); it does NOT prove that senderOf() actually
// RENDERS what resolveApprovalSender() returns. Measured by the team-lead
// 2026-08-18 (mutation review): inserting `return res.raw || '?'` as the
// FIRST line inside senderOf()'s `if (e.kind === 'approval')` block turns the
// real JSX beneath it into dead code, and tests/desktop-inbox-sender.test.ts
// stays 12 pass / 0 fail -- a string-presence scan over the source text is
// vacated by dead code sitting right next to the string it's looking for.
//
// This file closes that gap by mounting the REAL, unmodified InboxPanel
// component (not a reimplementation) and reading the actual rendered DOM for
// all three shapes senderOf() can produce on an approval entry:
//   1. resolved (tile_ref matches a live session)      -> name only, no <code>
//   2. unresolved with a non-empty raw tile_ref         -> senderUnresolved text + <code>raw</code>
//   3. unresolved with an empty tile_ref                -> senderUnresolvedEmpty text, no <code>
//
// Scope note (card's point 1): the card cites inbox-sender.ts:52-53 as "where
// the contract lives" -- that is the DOC COMMENT stating the contract
// (resolveApprovalSender's docstring), not the render logic. inbox-sender.ts
// is deliberately a pure, react-free module (its own header comment): it
// returns a tagged union, nothing more. The rendering of that union into two
// visibly-different DOM shapes happens in InboxPanel.tsx's senderOf()
// (components/InboxPanel.tsx:130-148), which is what this file actually
// exercises. The card is stale on that one locator, not wrong about the gap.
//
// Resolution note for the `@shared/*` imports: InboxPanel.tsx has two REAL
// (non-type-only) imports from bare specifiers that bun cannot resolve when
// `bun test` runs from the repo root (no root tsconfig `paths` entry for
// `@shared`, same trap documented in tests/desktop-nav-badge-producer.test.ts
// and tests/desktop-tile-area.test.ts's TemplateComposer note) --
// `inboxEntryKey` from '@shared/types' and `COMPANION_MANIFEST` /
// `REMOTE_BLOCKED_CHANNELS` from '@shared/companion'. Both are intercepted
// with `mock.module` below, keyed by the bare specifier string itself (empirically
// confirmed bun's mock.module matches on the literal specifier as written in
// the importing file's `import` statement, not on a resolved filesystem path,
// so a specifier that would otherwise fail to resolve at all can still be
// mocked). `inboxEntryKey` is never actually CALLED by anything this file
// exercises: InboxPanel's `reactKey()` only calls it for `kind !== 'approval'`,
// and every InboxEntry fixture here is `kind: 'approval'` -- so the stub only
// needs to exist for the import to succeed, not to behave correctly.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Paired unregister, required by tests/desktop-happy-dom-teardown.test.ts's
// repo-wide scan (checks source text for both calls) and by the real
// contract behind it (register() replaces globalThis.fetch repo-wide for the
// rest of this `bun test` process; see that file's header for the measured
// blast radius).
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it

// Dynamic import: must run AFTER GlobalRegistrator.register() above, because
// react-dom inspects `window`/`document` at import time and a static import
// would be hoisted ahead of the register() call regardless of source order.
const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// ---------------------------------------------------------------------------
// Fake store: minimal FakeDeckState covering exactly what InboxPanel.tsx and
// i18n.ts's useT() read (both resolve '../store' / './store' to the SAME
// file, desktop/src/renderer/src/store.ts -- one mock.module call covers
// both call sites, per tests/desktop-tile-area.test.ts's established pattern).
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

// `errorText` is InboxPanel.tsx's other named import from '../store' (used
// only inside catch blocks of deleteEntry/sendReply/answerApproval, none of
// which this file's render-only tests exercise) -- must still exist as an
// export or the module fails to load.
mock.module("../desktop/src/renderer/src/store.ts", () => ({
  useDeck: fakeUseDeck,
  errorText: (e: unknown) => String(e)
}));

// '@shared/types': only `inboxEntryKey` is a real (value) import in
// InboxPanel.tsx; every other named import from this specifier there is
// `import type`, erased before bun ever tries to resolve it at runtime.
mock.module("@shared/types", () => ({
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

function renderPanel(a: FakeApproval, sessions: FakeSession[]): void {
  act(() => {
    fakeUseDeck.setState({ pendingApprovals: [a], sessions });
    root.render(React.createElement(InboxPanel));
  });
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
