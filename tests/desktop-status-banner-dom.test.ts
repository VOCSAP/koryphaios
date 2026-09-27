// Card 7974fb83, reviewer-flagged residual: replicaOfflineTextKey (pure,
// unit-tested in desktop-status-banner.test.ts) has exactly one consumer,
// StatusBanner.tsx, and nothing guarded that the component actually CALLS it
// instead of a hardcoded generic key -- which is precisely the bug this card
// fixes, one layer up. Mounts the REAL component with a mocked store, the
// same two-layer pattern as desktop-broker-panel.test.ts: the pure function
// proves the mapping, this file proves the wiring.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import { bannerKind, replicaOfflineTextKey } from "../desktop/src/shared/status-banner.ts";
import type { RoadmapSyncStatus } from "../desktop/src/shared/types.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  dict: Record<string, string>;
  brokerStatus: { up: boolean; since: number; lastError: string | null } | null;
  offlineBannerDismissed: number | null;
  dismissOfflineBanner(): void;
  roadmapSync: { status: RoadmapSyncStatus; conflicts: unknown[] };
  setView(view: string): void;
  mobile: boolean;
  openRoadmapConflictsFilter(): void;
}

function initialFakeState(): FakeDeckState {
  return {
    // Untranslated keys resolve to the key itself (i18n.ts's `translate`), so
    // the assertions below match on the literal key strings.
    dict: {},
    brokerStatus: { up: true, since: 0, lastError: null },
    offlineBannerDismissed: null,
    dismissOfflineBanner: () => {},
    roadmapSync: { status: { mode: "local" }, conflicts: [] },
    setView: () => {},
    mobile: false,
    openRoadmapConflictsFilter: () => {},
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

mockStore({
  useDeck: fakeUseDeck,
  ...storeMockStubs,
  roadmapConflictCount: (s: FakeDeckState): number => s.roadmapSync.conflicts.length,
});

// StatusBanner.tsx's only VALUE import through the `@shared/*` tsconfig-only
// alias (not resolved by bun test from the repo root) is status-banner.
// Re-exporting the REAL module, already imported above by a relative path, so
// the mounted component runs the same decision code the pure tests exercise.
mock.module("@shared/status-banner", () => ({ bannerKind, replicaOfflineTextKey }));

const { StatusBanner } = await import("../desktop/src/renderer/src/components/StatusBanner");

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

function mountBanner(): void {
  act(() => {
    root.render(React.createElement(StatusBanner));
  });
}

function replicaOffline(overrides: Partial<RoadmapSyncStatus> = {}): RoadmapSyncStatus {
  return { mode: "replica", online: false, pending_push: 3, last_error: null, ...overrides };
}

test("a transport failure (no reason, or 'transport') renders the original wording", () => {
  fakeUseDeck.setState({ roadmapSync: { status: replicaOffline({ offline_reason: "transport" }), conflicts: [] } });
  mountBanner();
  expect(container.textContent).toContain("banner.replicaOffline");
  expect(container.textContent).not.toContain("banner.replicaStale");
  expect(container.textContent).not.toContain("banner.replicaRefused");
});

test("offline_reason 'stale_upstream' renders its OWN wording, not the generic one", () => {
  fakeUseDeck.setState({
    roadmapSync: { status: replicaOffline({ offline_reason: "stale_upstream" }), conflicts: [] },
  });
  mountBanner();
  expect(container.textContent).toContain("banner.replicaStale");
  expect(container.textContent).not.toContain("banner.replicaOffline");
});

test("offline_reason 'refused' renders its OWN wording, not the generic one", () => {
  fakeUseDeck.setState({ roadmapSync: { status: replicaOffline({ offline_reason: "refused" }), conflicts: [] } });
  mountBanner();
  expect(container.textContent).toContain("banner.replicaRefused");
  expect(container.textContent).not.toContain("banner.replicaOffline");
});

test("an absent offline_reason (an older broker) falls back to the generic wording", () => {
  fakeUseDeck.setState({ roadmapSync: { status: replicaOffline(), conflicts: [] } });
  mountBanner();
  expect(container.textContent).toContain("banner.replicaOffline");
});

test("the remote error detail is rendered regardless of which of the three causes fired -- the operator's actual discriminant for a grouped 'refused'", () => {
  fakeUseDeck.setState({
    roadmapSync: {
      status: replicaOffline({
        offline_reason: "refused",
        last_error: "replication routes require serve_replicas to be enabled on this broker",
      }),
      conflicts: [],
    },
  });
  mountBanner();
  expect(container.textContent).toContain(
    "replication routes require serve_replicas to be enabled on this broker"
  );
});

function clickConflictsButton(): void {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "banner.openRoadmap"
  );
  expect(button, "the conflicts banner must carry its open-the-roadmap button").toBeDefined();
  act(() => {
    button!.click();
  });
}

test("desktop: the conflicts banner button opens the roadmap FILTERED on the conflicts, not the bare view", () => {
  const calls: string[] = [];
  fakeUseDeck.setState({
    roadmapSync: { status: { mode: "replica", online: true }, conflicts: [{}] },
    setView: (v) => calls.push(`setView:${v}`),
    openRoadmapConflictsFilter: () => calls.push("openRoadmapConflictsFilter"),
  });
  mountBanner();
  clickConflictsButton();
  expect(calls).toEqual(["openRoadmapConflictsFilter"]);
});

test("mobile: the conflicts banner button only switches view, RoadmapList has no filter row to show a narrowing", () => {
  const calls: string[] = [];
  fakeUseDeck.setState({
    mobile: true,
    roadmapSync: { status: { mode: "replica", online: true }, conflicts: [{}] },
    setView: (v) => calls.push(`setView:${v}`),
    openRoadmapConflictsFilter: () => calls.push("openRoadmapConflictsFilter"),
  });
  mountBanner();
  clickConflictsButton();
  expect(calls).toEqual(["setView:roadmap"]);
});
