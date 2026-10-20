import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness";
import type {
  ApprovalPresentation,
  ApprovalWindowApi,
  ApprovalWindowReadMetricsIntent,
  ApprovalWindowSnapshot,
  ApprovalWindowVerdictIntent
} from "../desktop/src/shared/approval-window.ts";

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");
const { ApprovalReader } = await import("../desktop/src/renderer/src/approval/ApprovalReader");

const geometry = { viewport: 400, content: 1000, top: 0 };
const GEOMETRY_PROPS = ["clientHeight", "scrollHeight", "scrollTop"] as const;
const saved = GEOMETRY_PROPS.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
const valueOf = { clientHeight: () => geometry.viewport, scrollHeight: () => geometry.content, scrollTop: () => geometry.top };
for (const name of GEOMETRY_PROPS) {
  const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name);
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("approval-scroll") ? valueOf[name]() : (native?.get?.call(this) ?? 0);
    },
    set(this: HTMLElement, value: number) {
      native?.set?.call(this, value);
    }
  });
}

afterAll(async () => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  await GlobalRegistrator.unregister();
});

const PRESENTATION: ApprovalPresentation = {
  lang: "fr",
  text: { regionLabel: "Texte intégral", unreached: "Fin non atteinte", reached: "Fin atteinte", readFailed: "Lecture refusée", verdictFailed: "Réponse refusée" }
};

function snapshotOf(generation: number, detail = "01| npm run dev", fingerprint = `fp-${generation}`): ApprovalWindowSnapshot {
  return {
    generation,
    fingerprint,
    document: { message: "Lancer cette commande ?", detail, approve: "Approuver", refuse: "Refuser", close: "Fermer" },
    presentation: PRESENTATION
  };
}

interface Calls {
  reads: ApprovalWindowReadMetricsIntent[];
  verdicts: ApprovalWindowVerdictIntent[];
  order: string[];
  reports: string[];
  closes: number;
}

function fakeApi(calls: Calls, state: () => Promise<ApprovalWindowSnapshot>, read: () => Promise<void> = () => Promise.resolve()): ApprovalWindowApi {
  return {
    getState: state,
    read: (intent) => {
      calls.reads.push(intent);
      calls.order.push("read");
      return read();
    },
    verdict: (intent) => {
      calls.verdicts.push(intent);
      calls.order.push(`verdict:${intent.verdict}`);
      return Promise.resolve();
    },
    reportError: (message) => {
      calls.reports.push(message);
    }
  };
}

let root: Root;
let host: HTMLElement;
let calls: Calls;

beforeEach(() => {
  geometry.viewport = 400;
  geometry.content = 1000;
  geometry.top = 0;
  calls = { reads: [], verdicts: [], order: [], reports: [], closes: 0 };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function mount(api: ApprovalWindowApi): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ApprovalReader, { api, closeWindow: () => { calls.closes += 1; } }));
  });
  await flush();
}

const scroller = (): HTMLElement => host.querySelector<HTMLElement>(".approval-scroll")!;
const buttons = (): HTMLButtonElement[] => Array.from(host.querySelectorAll<HTMLButtonElement>(".approval-foot button"));
const refuseButton = (): HTMLButtonElement => buttons()[0]!;
const approveButton = (): HTMLButtonElement => buttons()[1]!;
const status = (): string => host.querySelector(".approval-status")!.textContent ?? "";

async function scrollTo(top: number): Promise<void> {
  geometry.top = top;
  await act(async () => {
    scroller().dispatchEvent(new Event("scroll"));
  });
  await flush();
}

const identity = { generation: 1, fingerprint: "fp-1" };

test("keeps Approve locked and sends no read while the end of the text is out of view", async () => {
  await mount(fakeApi(calls, async () => snapshotOf(1)));

  expect(approveButton().disabled, "Approve must stay locked before the bottom is reached").toBe(true);
  expect(calls.reads).toEqual([]);
  expect(status()).toBe("Fin non atteinte");
});

test("unlocks Approve only once main accepted the read sent with the exact identity and metrics", async () => {
  let accept!: () => void;
  await mount(fakeApi(calls, async () => snapshotOf(1), () => new Promise<void>((resolve) => { accept = resolve; })));
  await scrollTo(600);

  expect(calls.reads).toEqual([{ ...identity, metrics: { viewportHeight: 400, scrollHeight: 1000, scrollTop: 600 } }]);
  expect(approveButton().disabled, "no optimistic unlock before main accepts the read").toBe(true);
  await act(async () => accept());
  await flush();
  expect(approveButton().disabled).toBe(false);
  expect(status()).toBe("Fin atteinte");
});

test("unlocks a fully visible document on its first measurement, without any scroll", async () => {
  geometry.content = 400;
  await mount(fakeApi(calls, async () => snapshotOf(1)));

  expect(calls.reads).toHaveLength(1);
  expect(approveButton().disabled).toBe(false);
});

test("keeps Approve locked and reports when main rejects the read", async () => {
  geometry.content = 400;
  await mount(fakeApi(calls, async () => snapshotOf(1), () => Promise.reject(new Error("rejected"))));

  expect(approveButton().disabled).toBe(true);
  expect(status()).toBe("Lecture refusée");
  expect(calls.reports.some((message) => message.startsWith("read rejected"))).toBe(true);
});

test("re-measures at click and sends no verdict when the text grew since the unlock", async () => {
  geometry.content = 400;
  await mount(fakeApi(calls, async () => snapshotOf(1)));
  expect(approveButton().disabled).toBe(false);

  geometry.content = 2000;
  await act(async () => approveButton().click());
  await flush();

  expect(calls.verdicts, "a click on a stale measurement must not approve").toEqual([]);
  expect(approveButton().disabled).toBe(true);
});

test("approves with a read carrying the click-time metrics, then the verdict, in that order", async () => {
  await mount(fakeApi(calls, async () => snapshotOf(1)));
  await scrollTo(600);
  geometry.content = 1004;
  geometry.top = 604;
  await act(async () => approveButton().click());
  await flush();

  expect(calls.reads.at(-1)).toEqual({ ...identity, metrics: { viewportHeight: 400, scrollHeight: 1004, scrollTop: 604 } });
  expect(calls.order.slice(-2)).toEqual(["read", "verdict:approve"]);
  expect(calls.verdicts).toEqual([{ ...identity, verdict: "approve" }]);
});

test("refuses on Escape and never approves on Enter while locked", async () => {
  await mount(fakeApi(calls, async () => snapshotOf(1)));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(calls.verdicts).toEqual([]);

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flush();
  expect(calls.verdicts).toEqual([{ ...identity, verdict: "refuse" }]);
});

test("sends no verdict on Enter or a click while the read of a fully visible document is pending", async () => {
  geometry.content = 400;
  let reads = 0;
  const firstPendingThenAccepted = (): Promise<void> => (++reads === 1 ? new Promise<void>(() => {}) : Promise.resolve());
  await mount(fakeApi(calls, async () => snapshotOf(1), firstPendingThenAccepted));
  expect(calls.reads).toHaveLength(1);

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    approveButton().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    approveButton().click();
  });
  await flush();

  expect(calls.verdicts, "approval must wait for main to accept the read").toEqual([]);
});

test("puts the initial focus on Refuse", async () => {
  await mount(fakeApi(calls, async () => snapshotOf(1)));

  expect(document.activeElement, "Enter on the initial focus must refuse, never approve").toBe(refuseButton());
});

test("starts a new generation locked even when the previous one was unlocked for the same document", async () => {
  geometry.content = 400;
  await mount(fakeApi(calls, async () => snapshotOf(1)));
  expect(approveButton().disabled).toBe(false);

  let accept!: () => void;
  await mount(fakeApi(calls, async () => snapshotOf(2, undefined, "fp-1"), () => new Promise<void>((resolve) => { accept = resolve; })));

  expect(calls.reads.at(-1)).toMatchObject({ generation: 2, fingerprint: "fp-1" });
  expect(approveButton().disabled, "generation 2 must not inherit the unlock of generation 1").toBe(true);
  await act(async () => accept());
  await flush();
  expect(approveButton().disabled).toBe(false);
});

test("renders the detail as inert text, markup included", async () => {
  const detail = '01| <img src=x onerror="alert(1)"> & <b>bold</b>';
  await mount(fakeApi(calls, async () => snapshotOf(1, detail)));

  expect(host.querySelectorAll("img, b")).toHaveLength(0);
  expect(host.querySelector(".approval-text")!.textContent).toBe(detail);
});

test("rounds a fractional scrollTop up and never reads on non-finite metrics", async () => {
  await mount(fakeApi(calls, async () => snapshotOf(1)));
  geometry.viewport = Number.NaN;
  await scrollTo(600);
  expect(calls.reads, "a NaN viewport must never be sent as a read").toEqual([]);

  geometry.viewport = 400;
  await scrollTo(599.4);
  expect(calls.reads).toEqual([{ ...identity, metrics: { viewportHeight: 400, scrollHeight: 1000, scrollTop: 600 } }]);
  expect(approveButton().disabled).toBe(false);
});

test("closes the window, which refuses, when the state cannot be loaded", async () => {
  await mount(fakeApi(calls, () => Promise.reject(new Error("sender is not current"))));

  expect(calls.closes).toBe(1);
  expect(host.querySelector(".approval-foot")).toBeNull();
  expect(calls.reports.some((message) => message.includes("sender is not current"))).toBe(true);
});
