// Settings > Broker on a COMPANION client. 'peersConfig:get' is on the
// remote-block floor (see desktop-companion.test.ts), so the shim rejects it
// with 'remote-blocked': a panel that still issued the call would light its
// error state and raise an error toast on a paired phone -- an alarm about a
// file that is simply none of that device's business.
//
// Two layers, because neither alone is the guarantee: the pure state machine
// pins the ORDER of the four states, and the mounted panel proves the read is
// never issued in the first place.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import {
  brokerPanelState,
  shouldReadPeersConfig,
  type BrokerPanelState,
} from "../desktop/src/shared/broker-panel.ts";
import type { PeersConfigSummary } from "../desktop/src/shared/types.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

function summary(overrides: Partial<PeersConfigSummary> = {}): PeersConfigSummary {
  return {
    mode: "remote",
    brokerUrl: "http://host:7899",
    hasToken: true,
    offlineReplica: false,
    serveReplicas: false,
    forcedByEnv: { brokerUrl: false, offlineReplica: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The pure state machine
// ---------------------------------------------------------------------------

test("companion mode outranks EVERY other input: no error state, no stale summary, no loading", () => {
  // The exhaustive cross-product, not a sample: the point of the guarantee is
  // that no combination of `peers`/`error` can produce anything but host-only
  // once the client is remote. A summary left in the store by a previous
  // desktop run of the same renderer would otherwise be rendered as fact.
  for (const peers of [null, summary(), summary({ offlineReplica: true })]) {
    for (const error of [false, true]) {
      expect(brokerPanelState({ companion: true, peers, error })).toBe("host-only");
    }
  }
});

test("on the host the three original states keep their order: error, then loading, then ready", () => {
  const cases: [PeersConfigSummary | null, boolean, BrokerPanelState][] = [
    [null, true, "error"],
    // An error with a summary still shows the error: the summary is the stale
    // result of a PREVIOUS read, and the panel must not pretend it succeeded.
    [summary(), true, "error"],
    [null, false, "loading"],
    [summary(), false, "ready"],
  ];
  for (const [peers, error, expected] of cases) {
    expect(brokerPanelState({ companion: false, peers, error })).toBe(expected);
  }
});

test("shouldReadPeersConfig is DERIVED from the state machine, not a second copy of the test", () => {
  expect(shouldReadPeersConfig(true)).toBe(false);
  expect(shouldReadPeersConfig(false)).toBe(true);
  // The guarantee the derivation buys: the read is refused for exactly the
  // states that cannot display its result. A future state added for a
  // companion would flip both together, never one of the two.
  for (const companion of [true, false]) {
    const hostOnly = brokerPanelState({ companion, peers: null, error: false }) === "host-only";
    expect(shouldReadPeersConfig(companion)).toBe(!hostOnly);
  }
});

// ---------------------------------------------------------------------------
// 2. The mounted panel
// ---------------------------------------------------------------------------

interface FakeDeckState {
  dict: Record<string, string>;
  remote: boolean;
  peersConfig: PeersConfigSummary | null;
  peersConfigError: boolean;
  refreshPeersConfig(): Promise<void>;
  setOfflineReplica(value: boolean): Promise<void>;
}

// Every call the panel could make to the blocked channel goes through the
// store's refreshPeersConfig, so counting its invocations is counting
// 'peersConfig:get' calls.
let refreshCalls = 0;

function initialFakeState(): FakeDeckState {
  return {
    // Untranslated keys resolve to the key itself (i18n.ts's `translate`), so
    // the assertions below match on the literal key strings.
    dict: {},
    remote: false,
    peersConfig: null,
    peersConfigError: false,
    refreshPeersConfig: async () => {
      refreshCalls++;
    },
    setOfflineReplica: async () => {},
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// BrokerSettings.tsx's only VALUE import through the `@shared/*` tsconfig-only
// alias (not resolved by bun test from the repo root) is broker-panel.
// Re-exporting the REAL module, already imported above by a relative path, so
// the mounted component runs the same decision code the pure tests exercise.
mock.module("@shared/broker-panel", () => ({ brokerPanelState, shouldReadPeersConfig }));

const { BrokerSettings } = await import(
  "../desktop/src/renderer/src/components/BrokerSettings"
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  refreshCalls = 0;
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

function mountPanel(): void {
  act(() => {
    root.render(React.createElement(BrokerSettings));
  });
}

test("companion mode: the host-only message is rendered and peersConfig:get is NEVER invoked", () => {
  fakeUseDeck.setState({ remote: true });
  mountPanel();
  expect(container.textContent).toContain("settings.brokerHostOnly");
  expect(container.textContent).toContain("settings.brokerHostOnlyHelp");
  // The whole point: not "the error was handled", but "the call never left".
  expect(refreshCalls).toBe(0);
});

test("companion mode: neither the error state nor the checkbox can be reached", () => {
  // A companion carrying BOTH a stale summary and the error flag -- the two
  // inputs that drive the other three states -- still gets host-only, so a
  // refused read cannot reach the error branch by construction.
  fakeUseDeck.setState({ remote: true, peersConfig: summary(), peersConfigError: true });
  mountPanel();
  expect(container.textContent).toContain("settings.brokerHostOnly");
  expect(container.textContent).not.toContain("settings.brokerUnavailable");
  expect(container.textContent).not.toContain("settings.offlineReplica");
  expect(container.querySelector("input[type=checkbox]")).toBeNull();
  expect(refreshCalls).toBe(0);
});

test("host mode: the panel reads the file on mount and renders the summary", () => {
  mountPanel();
  expect(refreshCalls).toBe(1);
  // Still null in the fake store: the loading line, never a blank panel.
  expect(container.textContent).toContain("settings.brokerLoading");
  act(() => {
    fakeUseDeck.setState({ peersConfig: summary({ mode: "replica", offlineReplica: true }) });
  });
  expect(container.textContent).toContain("settings.brokerModeReplica");
  expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
  // Read-only capability line: what this machine's broker SERVES to others.
  expect(container.textContent).toContain("settings.brokerServeReplicas");
  expect(container.textContent).toContain("settings.brokerServeReplicasNo");
  act(() => {
    fakeUseDeck.setState({ peersConfig: summary({ serveReplicas: true }) });
  });
  expect(container.textContent).toContain("settings.brokerServeReplicasYes");
});

test("host mode: a failed read shows the retry, and the retry re-issues the call", () => {
  fakeUseDeck.setState({ peersConfigError: true });
  mountPanel();
  expect(refreshCalls).toBe(1);
  expect(container.textContent).toContain("settings.brokerUnavailable");
  const retry = container.querySelector("button");
  expect(retry).not.toBeNull();
  act(() => {
    retry!.dispatchEvent(new Event("click", { bubbles: true }));
  });
  expect(refreshCalls).toBe(2);
});
