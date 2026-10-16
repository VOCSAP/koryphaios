import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";
import type { OperatorTrustStatusEvent } from "../desktop/src/shared/types.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

type Outcome = "compatible" | "unchanged" | "changed" | null;

interface FakeDeckState {
  dict: Record<string, string>;
  operatorTrustStatus: OperatorTrustStatusEvent;
  operatorTrustRetrying: boolean;
  openOperatorTrustDialog(open: boolean): void;
  retryOperatorTrust(): Promise<Outcome>;
  copyOperatorFingerprint(value: string): Promise<void>;
}

const opens: boolean[] = [];
const copies: string[] = [];

function initialFakeState(): FakeDeckState {
  return {
    dict: {},
    operatorTrustStatus: { state: "not-trusted", fingerprint: "a".repeat(64) },
    operatorTrustRetrying: false,
    openOperatorTrustDialog: (open) => {
      opens.push(open);
    },
    retryOperatorTrust: async () => null,
    copyOperatorFingerprint: async (value) => {
      copies.push(value);
    },
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { OperatorTrustDialog } = await import("../desktop/src/renderer/src/components/OperatorTrustDialog");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fakeUseDeck.setState(initialFakeState(), true);
  opens.length = 0;
  copies.length = 0;
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

function mount(): void {
  act(() => {
    root.render(React.createElement(OperatorTrustDialog));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label
  );
  expect(found, `the dialog must carry a "${label}" button`).toBeDefined();
  return found!;
}

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

test.each([
  ["unconfigured", "banner.operatorUnconfigured", "operatorTrust.help.unconfigured"],
  ["not-trusted", "banner.operatorNotTrusted", "operatorTrust.help.notTrusted"],
  ["incompatible", "banner.operatorIncompatible", "operatorTrust.help.incompatible"],
  ["identity-unreadable", "banner.operatorIdentityUnreadable", "operatorTrust.help.identityUnreadable"],
  ["invalid", "banner.operatorInvalid", "operatorTrust.help.invalid"],
  ["unreachable", "banner.operatorUnreachable", "operatorTrust.help.unreachable"],
] as const)("state %s shows its own sentence and its own remedy", (state, textKey, helpKey) => {
  fakeUseDeck.setState({ operatorTrustStatus: { state } });
  mount();
  expect(container.querySelector(".operator-trust-state")?.textContent).toContain(textKey);
  expect(container.querySelector(".operator-trust-help")?.textContent).toBe(helpKey);
  expect(container.textContent).toContain("operatorTrust.newSessionsOnly");
});

test("the dialog body is, in order: head, state, help, fingerprint, note, actions", () => {
  mount();
  const shape = [...container.querySelectorAll(".operator-trust-modal > *")].map((el) => el.className);
  expect(shape).toEqual([
    "modal-head",
    "operator-trust-state operator-trust-state-not-trusted",
    "operator-trust-help",
    "operator-trust-fingerprint",
    "operator-trust-note",
    "modal-actions",
  ]);
});

test("without a fingerprint there is no empty row and no copy button", () => {
  fakeUseDeck.setState({ operatorTrustStatus: { state: "identity-unreadable" } });
  mount();
  expect(container.querySelector(".operator-trust-fingerprint")).toBeNull();
  expect(container.querySelector('[aria-label="operatorTrust.copyFingerprint"]')).toBeNull();
});

test("copy hands the full fingerprint to the store action", async () => {
  mount();
  await act(async () => {
    button("operatorTrust.copyFingerprint").click();
  });
  expect(copies).toEqual(["a".repeat(64)]);
});

test("a retry the broker still refuses says unchanged; a different refusal does not", async () => {
  fakeUseDeck.setState({ retryOperatorTrust: async () => "unchanged" });
  mount();
  await act(async () => {
    button("banner.retry").click();
  });
  expect(container.querySelector(".operator-trust-unchanged")?.textContent).toBe("operatorTrust.unchanged");

  act(() => fakeUseDeck.setState({ retryOperatorTrust: async () => "changed" }));
  await act(async () => {
    button("banner.retry").click();
  });
  expect(container.querySelector(".operator-trust-unchanged")).toBeNull();
});

test("Retry is disabled with its own label while a check is in flight", () => {
  fakeUseDeck.setState({ operatorTrustRetrying: true });
  mount();
  expect(button("operatorTrust.retrying").disabled).toBe(true);
});

test("a state that no longer needs explaining closes the dialog", () => {
  fakeUseDeck.setState({ operatorTrustStatus: { state: "compatible" } });
  mount();
  expect(container.querySelector(".operator-trust-modal")).toBeNull();
  expect(opens).toEqual([false]);
});

test("keyboard: modal semantics, focus on mount, Tab kept inside, Escape closes", () => {
  mount();
  const modal = container.querySelector(".operator-trust-modal")!;
  expect(modal.getAttribute("role")).toBe("dialog");
  expect(modal.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement, "the close cross takes the focus on mount").toBe(button("common.close"));
  expect(modal.contains(document.activeElement)).toBe(true);

  const controls = [...modal.querySelectorAll<HTMLButtonElement>("button")];
  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  act(() => last.focus());
  expect(key({ key: "Tab" }).defaultPrevented, "Tab on the last control wraps").toBe(true);
  expect(document.activeElement).toBe(first);
  expect(key({ key: "Tab", shiftKey: true }).defaultPrevented, "Shift+Tab on the first control wraps").toBe(true);
  expect(document.activeElement).toBe(last);

  expect(opens).toEqual([]);
  key({ key: "Escape" });
  expect(opens).toEqual([false]);
});

test("Escape typed in a text field outside the dialog is left to that field", () => {
  const field = document.createElement("input");
  document.body.appendChild(field);
  try {
    mount();
    act(() => field.focus());
    key({ key: "Escape" });
    expect(opens).toEqual([]);
  } finally {
    field.remove();
  }
});

function runProbe(lines: string[]): unknown {
  const dir = mkdtempSync(join(tmpdir(), "operator-trust-probe-"));
  try {
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, lines.join("\n"));
    const tsconfig = resolve(import.meta.dir, "../desktop/tsconfig.web.json");
    const r = Bun.spawnSync([process.execPath, `--tsconfig-override=${tsconfig}`, "run", probe]);
    expect(r.exitCode, `probe failed: ${r.stderr.toString()}`).toBe(0);
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const storePath = resolve(import.meta.dir, "../desktop/src/renderer/src/store.ts").replaceAll("\\", "/");

test("the real store classifies a retry: compatible, unchanged, changed, failure, and a second click in flight", () => {
  const out = runProbe([
    "let answer: () => Promise<unknown> = async () => ({ state: 'compatible' });",
    "const api = new Proxy({}, { get: (_t, key) => {",
    "  if (key === 'retryOperatorTrust') return () => answer();",
    "  if (typeof key === 'string' && key.startsWith('on')) return () => () => {};",
    "  return () => Promise.resolve(undefined);",
    "} });",
    "(globalThis as Record<string, unknown>).window = { api };",
    `const { useDeck } = await import(${JSON.stringify(storePath)});`,
    "const run = async (before: string, next: () => Promise<unknown>) => {",
    "  useDeck.setState({ operatorTrustStatus: { state: before }, toast: null });",
    "  answer = next;",
    "  const outcome = await useDeck.getState().retryOperatorTrust();",
    "  const s = useDeck.getState();",
    "  return { outcome, state: s.operatorTrustStatus.state, toast: s.toast, retrying: s.operatorTrustRetrying };",
    "};",
    "const out: Record<string, unknown> = {};",
    "out.compatible = await run('not-trusted', async () => ({ state: 'compatible' }));",
    "out.unchanged = await run('unreachable', async () => ({ state: 'unreachable' }));",
    "out.changed = await run('unreachable', async () => ({ state: 'not-trusted', fingerprint: 'f' }));",
    "out.failed = await run('invalid', async () => { throw new Error('no handler'); });",
    "let release: () => void = () => {};",
    "answer = () => new Promise((r) => { release = () => r({ state: 'compatible' }); });",
    "useDeck.setState({ operatorTrustStatus: { state: 'invalid' } });",
    "const first = useDeck.getState().retryOperatorTrust();",
    "out.second = await useDeck.getState().retryOperatorTrust();",
    "release();",
    "out.first = await first;",
    "console.log(JSON.stringify(out));",
    "process.exit(0);",
  ]) as Record<string, { outcome: Outcome; state: string; toast: string | null; retrying: boolean }> & {
    second: Outcome;
    first: Outcome;
  };
  expect(out.compatible, "a trusted verdict is the only success").toEqual({
    outcome: "compatible",
    state: "compatible",
    toast: "toast.operatorTrusted",
    retrying: false,
  });
  expect(out.unchanged, "the same refusal as before the click is never a success").toEqual({
    outcome: "unchanged",
    state: "unreachable",
    toast: "toast.operatorTrustUnchanged",
    retrying: false,
  });
  expect(out.changed, "a different refusal updates the state without a toast").toEqual({
    outcome: "changed",
    state: "not-trusted",
    toast: null,
    retrying: false,
  });
  expect(out.failed!.outcome, "a failed IPC call yields no verdict").toBeNull();
  expect(out.failed!.state, "a failed IPC call keeps the state shown").toBe("invalid");
  expect(out.failed!.retrying, "a failed IPC call releases the busy flag").toBe(false);
  expect(String(out.failed!.toast), "a failed IPC call is toasted by guarded()").toContain("no handler");
  expect(out.second, "a second click while one check is in flight is ignored").toBeNull();
  expect(out.first).toBe("compatible");
});

test("the real store copies the fingerprint: success toast only after resolution, every failure toasted as an error", () => {
  const out = runProbe([
    "const reports: string[] = [];",
    "const api = new Proxy({}, { get: (_t, key) => {",
    "  if (key === 'reportError') return (s: string, m: string) => { reports.push(`${s}: ${m}`); };",
    "  if (typeof key === 'string' && key.startsWith('on')) return () => () => {};",
    "  return () => Promise.resolve(undefined);",
    "} });",
    "(globalThis as Record<string, unknown>).window = { api };",
    `const { useDeck } = await import(${JSON.stringify(storePath)});`,
    "const writes: string[] = [];",
    "const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value });",
    "let n = 0;",
    "const run = async (clipboard: unknown) => {",
    "  setClipboard(clipboard);",
    "  reports.length = 0;",
    "  const fp = `fp-${++n}`;",
    "  useDeck.setState({ toast: null, toastVariant: 'success' });",
    "  let settled = false;",
    "  const pending = useDeck.getState().copyOperatorFingerprint(fp).then(() => { settled = true; });",
    "  const toastBeforeSettle = useDeck.getState().toast;",
    "  await pending;",
    "  const s = useDeck.getState();",
    "  return { toastBeforeSettle, toast: s.toast, variant: s.toastVariant, reported: reports.length, settled };",
    "};",
    "const out: Record<string, unknown> = {};",
    // Failures first: showToast throttles a repeated key for 5 s, so a success
    // toast shown earlier would mask a wrong one here.
    "out.rejected = await run({ writeText: async () => { throw new Error('denied'); } });",
    "out.syncThrow = await run({ writeText: () => { throw new Error('sync boom'); } });",
    "out.absent = await run(undefined);",
    "let resolveWrite: () => void = () => {};",
    "setClipboard({ writeText: (v: string) => new Promise<void>((r) => { writes.push(v); resolveWrite = r; }) });",
    "useDeck.setState({ toast: null });",
    "const slow = useDeck.getState().copyOperatorFingerprint('fp-slow');",
    "await Promise.resolve();",
    "out.slowBefore = useDeck.getState().toast;",
    "resolveWrite();",
    "await slow;",
    "out.slowAfter = useDeck.getState().toast;",
    "out.writes = writes;",
    "console.log(JSON.stringify(out));",
    "process.exit(0);",
  ]) as Record<string, { toastBeforeSettle: string | null; toast: string; variant: string; reported: number }> & {
    slowBefore: string | null;
    slowAfter: string | null;
    writes: string[];
  };
  expect(out.slowBefore, "no success toast while the clipboard has not resolved").toBeNull();
  expect(out.slowAfter).toBe("toast.fingerprintCopied");
  expect(out.writes).toEqual(["fp-slow"]);
  for (const [name, needle] of [
    ["rejected", "denied"],
    ["syncThrow", "sync boom"],
    ["absent", ""],
  ] as const) {
    const r = out[name]!;
    expect(r.variant, `${name}: an error toast`).toBe("error");
    expect(r.toast, `${name}: never the success toast`).not.toBe("toast.fingerprintCopied");
    expect(r.toast, `${name}: the toast names the failure`).toContain(`copy fingerprint: ${needle}`);
    expect(r.reported, `${name}: the failure is reported`).toBe(1);
  }
});

const appPath = resolve(import.meta.dir, "../desktop/src/renderer/src/components/App.tsx").replaceAll("\\", "/");
const harnessPath = resolve(import.meta.dir, "../desktop/tests-support/react-test-harness.ts").replaceAll("\\", "/");

test.each([["desktop"], ["mobile"]] as const)("App, %s shell: Details on the banner opens the dialog", (shell) => {
  const out = runProbe([
    "import { GlobalRegistrator } from '@happy-dom/global-registrator';",
    "GlobalRegistrator.register();",
    "const api = new Proxy({}, { get: (_t, key) => {",
    "  if (typeof key !== 'string') return undefined;",
    "  if (key.startsWith('on')) return () => () => {};",
    "  if (key === 'reportError') return () => {};",
    "  return () => Promise.resolve(undefined);",
    "} });",
    "(window as unknown as { api: unknown }).api = api;",
    `const { act, React, createRoot } = await import(${JSON.stringify(harnessPath)});`,
    `const { useDeck } = await import(${JSON.stringify(storePath)});`,
    `const { App } = await import(${JSON.stringify(appPath)});`,
    "const el = document.createElement('div');",
    "document.body.appendChild(el);",
    "const root = createRoot(el);",
    "useDeck.setState({ config: {} as never });",
    "await act(async () => root.render(React.createElement(App)));",
    // init() runs from App's first effect and recomputes `mobile`, so the shell is chosen after it.
    `await act(async () => useDeck.setState({ config: {} as never, mobile: ${shell === "mobile"}, operatorTrustStatus: { state: 'not-trusted', fingerprint: 'a'.repeat(64) } }));`,
    "const before = !!el.querySelector('.operator-trust-modal');",
    "const details = [...el.querySelectorAll('.status-banner-action')].find((b) => b.textContent === 'banner.operatorDetails') as HTMLButtonElement | undefined;",
    "await act(async () => details?.click());",
    "console.log(JSON.stringify({ shell: el.querySelector('.app-mobile') ? 'mobile' : 'desktop', details: !!details, before, after: !!el.querySelector('.operator-trust-modal') }));",
    "process.exit(0);",
  ]);
  expect(out, "the dialog opens from the banner in this shell").toEqual({
    shell,
    details: true,
    before: false,
    after: true,
  });
});
