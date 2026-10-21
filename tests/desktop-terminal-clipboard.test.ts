import { afterEach, expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { mockStore, storeMockStubs } from "./_store-mock.ts";

const toasts: Array<[string, string, { raw: boolean }]> = [];
mockStore({
  useDeck: { getState: () => ({ showToast: (...args: [string, string, { raw: boolean }]) => toasts.push(args) }) } as never,
  ...storeMockStubs
});
const { handleTerminalContextMenu } = await import("../desktop/src/renderer/src/terminal-clipboard.ts");

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  toasts.length = 0;
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, "navigator");
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

function terminal(
  mouseTrackingMode: string,
  selection = "",
  clipboard: { writeText?: (text: string) => Promise<void>; readText?: () => Promise<string> } = {}
): {
  term: Terminal;
  cleared: string[];
  pasted: string[];
  written: string[];
} {
  const written: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          written.push(text);
          await clipboard.writeText?.(text);
        },
        readText: clipboard.readText ?? (async () => "")
      }
    }
  });
  const cleared: string[] = [];
  const pasted: string[] = [];
  return {
    term: {
      modes: { mouseTrackingMode },
      getSelection: () => selection,
      clearSelection: () => cleared.push(selection),
      paste: (text: string) => pasted.push(text)
    } as unknown as Terminal,
    cleared,
    pasted,
    written
  };
}

function event(shiftKey = false): { event: MouseEvent; prevented: () => number } {
  let prevented = 0;
  return {
    event: { shiftKey, preventDefault: () => { prevented++; } } as MouseEvent,
    prevented: () => prevented
  };
}

function rendererErrors(): Array<[string, string]> {
  const errors: Array<[string, string]> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { api: { reportError: (scope: string, message: string) => errors.push([scope, message]) } }
  });
  return errors;
}

test("tracked mode suppresses local clipboard", async () => {
  const { term, cleared, pasted, written } = terminal("normal", "selected");
  const context = event();

  await handleTerminalContextMenu(term, context.event);

  expect(context.prevented()).toBe(1);
  expect(cleared).toEqual([]);
  expect(written).toEqual([]);
  expect(pasted).toEqual([]);
});

test("Shift forces local action", async () => {
  const { term, cleared, written } = terminal("normal", "selected");
  const context = event(true);

  await handleTerminalContextMenu(term, context.event);

  expect(context.prevented()).toBe(1);
  expect(written).toEqual(["selected"]);
  expect(cleared).toEqual(["selected"]);
});

test("untracked mode copies selection", async () => {
  const { term, cleared, written } = terminal("none", "selected");
  const context = event();

  await handleTerminalContextMenu(term, context.event);

  expect(context.prevented()).toBe(1);
  expect(written).toEqual(["selected"]);
  expect(cleared).toEqual(["selected"]);
});

test("empty selection pastes", async () => {
  const { term, pasted } = terminal("none", "", { readText: async () => "clipboard text" });
  const context = event();

  await handleTerminalContextMenu(term, context.event);

  expect(pasted).toEqual(["clipboard text"]);
});

test("clipboard copy rejection reports and preserves selection", async () => {
  const errors = rendererErrors();
  const { term, cleared, pasted, written } = terminal("none", "selected", {
    writeText: async () => { throw new Error("denied"); },
    readText: async () => "danger"
  });

  await handleTerminalContextMenu(term, event().event);

  expect(written).toEqual(["selected"]);
  expect(cleared).toEqual([]);
  expect(pasted).toEqual([]);
  expect(errors).toEqual([["terminal", "clipboard copy failed"]]);
  expect(toasts).toEqual([["clipboard copy failed", "error", { raw: true }]]);
});

test("clipboard paste rejection reports the failed action", async () => {
  const errors = rendererErrors();
  const { term, pasted } = terminal("none", "", {
    readText: async () => { throw new Error("denied"); }
  });

  await handleTerminalContextMenu(term, event().event);

  expect(pasted).toEqual([]);
  expect(errors).toEqual([["terminal", "clipboard paste failed"]]);
  expect(toasts).toEqual([["clipboard paste failed", "error", { raw: true }]]);
});
