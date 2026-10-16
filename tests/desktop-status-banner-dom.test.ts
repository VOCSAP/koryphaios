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
import type { OperatorTrustStatusEvent, RoadmapSyncStatus } from "../desktop/src/shared/types.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  dict: Record<string, string>;
  brokerStatus: {
    up: boolean;
    since: number;
    lastError: string | null;
    manualStop?: { stopped_at: string | null } | null;
  } | null;
  operatorTrustStatus: OperatorTrustStatusEvent;
  offlineBannerDismissed: number | null;
  dismissOfflineBanner(): void;
  roadmapSync: { status: RoadmapSyncStatus; conflicts: unknown[] };
  setView(view: string): void;
  mobile: boolean;
  openRoadmapConflictsFilter(): void;
  operatorTrustRetrying: boolean;
  openOperatorTrustDialog(open: boolean): void;
  retryOperatorTrust(): Promise<unknown>;
}

function initialFakeState(): FakeDeckState {
  return {
    // Untranslated keys resolve to the key itself (i18n.ts's `translate`), so
    // the assertions below match on the literal key strings.
    dict: {},
    brokerStatus: { up: true, since: 0, lastError: null },
    operatorTrustStatus: { state: "compatible" },
    offlineBannerDismissed: null,
    dismissOfflineBanner: () => {},
    roadmapSync: { status: { mode: "local" }, conflicts: [] },
    setView: () => {},
    mobile: false,
    openRoadmapConflictsFilter: () => {},
    operatorTrustRetrying: false,
    openOperatorTrustDialog: () => {},
    retryOperatorTrust: async () => null,
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

test.each([
  ["unconfigured", "banner.operatorUnconfigured"],
  ["not-trusted", "banner.operatorNotTrusted"],
  ["incompatible", "banner.operatorIncompatible"],
  ["identity-unreadable", "banner.operatorIdentityUnreadable"],
  ["invalid", "banner.operatorInvalid"],
  ["unreachable", "banner.operatorUnreachable"],
] as const)("operator trust state %s renders its dedicated banner", (state, textKey) => {
  fakeUseDeck.setState({ operatorTrustStatus: { state } });
  mountBanner();
  expect(container.textContent).toContain(textKey);
});

function bannerButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".status-banner-action")].find(
    (b) => b.textContent === label
  );
  expect(button, `the operator trust banner must carry a "${label}" action`).toBeDefined();
  return button!;
}

test.each(["unconfigured", "not-trusted", "incompatible", "identity-unreadable", "invalid", "unreachable"] as const)(
  "operator trust state %s offers Details and Retry, and nothing else",
  (state) => {
    fakeUseDeck.setState({ operatorTrustStatus: { state, fingerprint: "b".repeat(64) } });
    mountBanner();
    const labels = [...container.querySelectorAll(".status-banner > *")].map((el) =>
      el.tagName === "BUTTON" ? `button:${el.textContent}` : el.className
    );
    expect(labels).toEqual(["status-banner-text", "button:banner.operatorDetails", "button:banner.retry"]);
  }
);

test("the fingerprint lives in the dialog, never in the truncated banner line", () => {
  const fingerprint = "b".repeat(64);
  fakeUseDeck.setState({ operatorTrustStatus: { state: "not-trusted", fingerprint } });
  mountBanner();
  expect(container.textContent).not.toContain(fingerprint);
});

test("Details opens the operator trust dialog", () => {
  const calls: unknown[] = [];
  fakeUseDeck.setState({
    operatorTrustStatus: { state: "not-trusted" },
    openOperatorTrustDialog: (open) => calls.push(open),
  });
  mountBanner();
  act(() => bannerButton("banner.operatorDetails").click());
  expect(calls).toEqual([true]);
});

test("Retry runs the store re-check, and is disabled with its own label while one is in flight", () => {
  let retries = 0;
  fakeUseDeck.setState({
    operatorTrustStatus: { state: "unreachable" },
    retryOperatorTrust: async () => {
      retries++;
      return null;
    },
  });
  mountBanner();
  act(() => bannerButton("banner.retry").click());
  expect(retries).toBe(1);

  act(() => fakeUseDeck.setState({ operatorTrustRetrying: true }));
  const busy = bannerButton("operatorTrust.retrying");
  expect(busy.disabled).toBe(true);
});

test("an unconfigured trust policy uses the neutral information tone", () => {
  fakeUseDeck.setState({ operatorTrustStatus: { state: "unconfigured" } });
  mountBanner();
  expect(container.querySelector(".status-banner")?.className).toContain("status-banner-info");
});

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

// ----- manual broker stop -----

type StartResult = { ok: true } | { ok: false; error: string };

function stubApi(startBroker: () => Promise<StartResult>): string[] {
  const calls: string[] = [];
  (window as unknown as { api: unknown }).api = {
    startBroker: () => {
      calls.push("startBroker");
      return startBroker();
    },
    retryBroker: async () => {
      calls.push("retryBroker");
    },
    reportError: (scope: string, message: string) => calls.push(`reportError:${scope}:${message}`),
  };
  return calls;
}

function stoppedStatus(over: { up?: boolean } = {}): FakeDeckState["brokerStatus"] {
  return { up: over.up ?? false, since: 5, lastError: "ECONNREFUSED", manualStop: { stopped_at: "2026-10-16T19:00:00.000Z" } };
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

function startControl(): HTMLButtonElement {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons, "the stopped banner is ONE control, sentence and label together").toHaveLength(1);
  return buttons[0]!;
}

test("a manual stop shows its own banner as one Start control, with no Dismiss, over the outage it causes", () => {
  stubApi(async () => ({ ok: true }));
  fakeUseDeck.setState({ brokerStatus: stoppedStatus() });
  mountBanner();
  expect(container.textContent).not.toContain("banner.brokerDown");
  const control = startControl();
  expect(control.type).toBe("button");
  expect(control.textContent).toContain("banner.brokerStopped");
  expect(control.textContent).toContain("banner.brokerStart");
  expect(container.textContent).not.toContain("banner.dismiss");
});

test("clicking the sentence itself starts the broker", async () => {
  const calls = stubApi(async () => ({ ok: true }));
  fakeUseDeck.setState({ brokerStatus: stoppedStatus() });
  mountBanner();
  const sentence = container.querySelector<HTMLElement>(".status-banner-text");
  expect(sentence?.textContent).toContain("banner.brokerStopped");
  await act(async () => {
    sentence!.click();
  });
  expect(calls).toEqual(["startBroker"]);
});

test("the Start control calls broker:start, never the Retry poll, and is disabled while it runs", async () => {
  let release!: (r: StartResult) => void;
  const calls = stubApi(() => new Promise<StartResult>((resolve) => { release = resolve; }));
  fakeUseDeck.setState({ brokerStatus: stoppedStatus() });
  mountBanner();
  act(() => {
    startControl().click();
  });
  expect(calls).toEqual(["startBroker"]);
  expect(startControl().disabled).toBe(true);
  expect(startControl().textContent).toContain("banner.brokerStarting");
  act(() => {
    startControl().click();
  });
  expect(calls, "a disabled control must not start twice").toEqual(["startBroker"]);
  await act(async () => {
    release({ ok: true });
  });
  expect(startControl().disabled).toBe(false);
  expect(startControl().textContent).toContain("banner.brokerStart");
});

test("a failed Start stays visible, on the stopped banner and on the outage banner that follows it", async () => {
  stubApi(async () => ({ ok: false, error: "no broker.ts to start" }));
  fakeUseDeck.setState({ brokerStatus: stoppedStatus() });
  mountBanner();
  await act(async () => {
    startControl().click();
  });
  expect(container.textContent).toContain("no broker.ts to start");

  act(() => {
    fakeUseDeck.setState({ brokerStatus: { up: false, since: 5, lastError: "ECONNREFUSED", manualStop: null } });
  });
  expect(container.textContent).toContain("banner.brokerDown");
  expect(container.textContent, "the marker is gone, the start error must survive the switch").toContain(
    "no broker.ts to start"
  );
});

test("a Start that throws is reported and shown", async () => {
  const calls = stubApi(async () => {
    throw new Error("remote-blocked");
  });
  fakeUseDeck.setState({ brokerStatus: stoppedStatus() });
  mountBanner();
  await act(async () => {
    startControl().click();
  });
  expect(calls.some((c) => c.startsWith("reportError:banner:") && c.includes("remote-blocked"))).toBe(true);
  expect(container.textContent).toContain("remote-blocked");
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
