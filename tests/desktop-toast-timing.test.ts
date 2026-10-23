import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body.ts";
import { TOAST_ACTION_MS, TOAST_MS } from "../desktop/src/renderer/src/toast-timing.ts";

const STORE = readFileSync(join(import.meta.dir, "..", "desktop", "src", "renderer", "src", "store.ts"), "utf8").replace(/\r\n/g, "\n");
const SHOW_TOAST_ANCHOR = "showToast: (key, variant = 'success', opts) => {";

function extractShowToast(source: string): string {
  const showToastAnchor = source.indexOf(SHOW_TOAST_ANCHOR);
  if (showToastAnchor < 0) throw new Error("showToast anchor not found");
  if (source.indexOf(SHOW_TOAST_ANCHOR, showToastAnchor + SHOW_TOAST_ANCHOR.length) >= 0) {
    throw new Error("showToast anchor is ambiguous");
  }
  return extractBracedBody(source, showToastAnchor + SHOW_TOAST_ANCHOR.length - 1, true);
}

const SHOW_TOAST_BODY = extractShowToast(STORE);

type ToastAction = { label: string; onClick: () => void };
type ToastState = { toast: string | null; toastAction: ToastAction | null };

function toastHarness(): {
  advance(ms: number): void;
  fireDue(): void;
  fireNext(): void;
  showToast(key: string, variant: "success" | "info" | "error", opts?: { action?: ToastAction }): boolean;
  state(): ToastState;
} {
  let now = 10_000;
  let state: ToastState = { toast: null, toastAction: null };
  const timers: Array<{ callback: () => void; dueAt: number }> = [];
  const showToast = new Function("get", "set", "lastToastAt", "TOAST_ACTION_MS", "TOAST_MS", "Date", "setTimeout", `
    let toastToken = 0;
    return (key, variant = 'success', opts) => {${SHOW_TOAST_BODY}};
  `)(
    () => state,
    (patch: Partial<ToastState>) => { state = { ...state, ...patch }; },
    new Map<string, number>(),
    TOAST_ACTION_MS,
    TOAST_MS,
    { now: () => now },
    (callback: () => void, delay: number) => { timers.push({ callback, dueAt: now + delay }); }
  ) as (key: string, variant: "success" | "info" | "error", opts?: { action?: ToastAction }) => boolean;
  return {
    advance: (ms) => { now += ms; },
    fireDue: () => {
      while (timers[0]?.dueAt !== undefined && timers[0].dueAt <= now) timers.shift()!.callback();
    },
    fireNext: () => timers.shift()?.callback(),
    showToast,
    state: () => state
  };
}

test("showToast extraction rejects an ambiguous anchor", () => {
  expect(() => extractShowToast(`${STORE}\n${SHOW_TOAST_ANCHOR}`)).toThrow("showToast anchor is ambiguous");
});

test("an error toast stays on screen longer than 3 s", () => {
  // A blocked Save changes nothing on screen but this toast: at 3 s an operator
  // glancing away never learns why the Save did nothing.
  expect(TOAST_MS.error, "the error toast vanishes before a refusal can be read").toBeGreaterThan(3000);
});

test("an error toast outlasts every confirmation toast", () => {
  expect(TOAST_MS.error, "an error toast leaves no later than a success toast").toBeGreaterThan(TOAST_MS.success);
  expect(TOAST_MS.error, "an error toast leaves no later than an info toast").toBeGreaterThan(TOAST_MS.info);
});

test("a toast action outlasts the info duration (mutation: action uses TOAST_MS.info)", () => {
  const toast = toastHarness();
  const action: ToastAction = { label: "common.undo", onClick: () => undefined };

  toast.showToast("toast.terminalCopyRepaired", "info", { action });
  expect(TOAST_ACTION_MS).toBe(10_000);
  toast.advance(TOAST_ACTION_MS - 1);
  toast.fireDue();

  expect(toast.state().toast).toBe("toast.terminalCopyRepaired");
  expect(toast.state().toastAction).toBe(action);
  toast.advance(1);
  toast.fireDue();
  expect(toast.state().toast).toBeNull();
});

test("a toast without action expires at its variant duration (mutation: all toasts use TOAST_ACTION_MS)", () => {
  const toast = toastHarness();

  toast.showToast("toast.terminalCopyRepaired", "info");
  toast.advance(TOAST_MS.info);
  toast.fireDue();

  expect(toast.state().toast).toBeNull();
});

test("a repair after the info toast expires recreates its undo action before the throttle ends", () => {
  const toast = toastHarness();
  const first: ToastAction = { label: "common.undo", onClick: () => undefined };
  const second: ToastAction = { label: "common.undo", onClick: () => undefined };

  expect(toast.showToast("toast.terminalCopyRepaired", "info", { action: first })).toBe(true);
  toast.advance(TOAST_MS.info);
  toast.fireNext();
  toast.advance(1000);

  expect(toast.showToast("toast.terminalCopyRepaired", "info", { action: second })).toBe(true);
  expect(toast.state().toast).toBe("toast.terminalCopyRepaired");
  expect(toast.state().toastAction).toBe(second);
});
