import { afterEach, expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { mockStore, storeMockStubs } from "./_store-mock.ts";

const toasts: Array<[string, string, { raw: boolean }]> = [];
const undoActions: Array<() => void> = [];
let activeUndoAction: (() => void) | null = null;
let normalizeTerminalCopy = true;
mockStore({
  useDeck: {
    getState: () => ({
      config: { normalizeTerminalCopy },
      showToast: (...args: [string, string, { raw: boolean; action?: { label: string; onClick: () => void } }]) => {
        toasts.push(args)
        if (args[2].action) {
          undoActions.push(args[2].action.onClick)
          activeUndoAction = args[2].action.onClick
        }
      }
    })
  } as never,
  ...storeMockStubs
});
const { copySelection, handleTerminalContextMenu } = await import("../desktop/src/renderer/src/terminal-clipboard.ts");

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  normalizeTerminalCopy = true;
  undoActions.length = 0;
  activeUndoAction = null;
  toasts.length = 0;
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, "navigator");
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

function terminal(
  mouseTrackingMode: string,
  selection = "",
  clipboard: { writeText?: (text: string) => Promise<void>; readText?: () => Promise<string> } = {},
  options: {
    cols?: number;
    unicodeService?: { getStringCellWidth(text: string): number };
    screenRow?: { y: number; text: string };
  } = {}
): {
  term: Terminal;
  cleared: string[];
  pasted: string[];
  written: string[];
} {
  const written: string[] = [];
  let clipboardText = "";
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          written.push(text);
          clipboardText = text;
          await clipboard.writeText?.(text);
        },
        readText: clipboard.readText ?? (async () => clipboardText)
      }
    }
  });
  const cleared: string[] = [];
  const pasted: string[] = [];
  return {
    term: {
      cols: options.cols ?? 80,
      _core: options.unicodeService ? { unicodeService: options.unicodeService } : undefined,
      modes: { mouseTrackingMode },
      getSelection: () => selection,
      ...(options.screenRow ? {
        getSelectionPosition: () => ({ start: { x: 4, y: options.screenRow!.y }, end: { x: 25, y: options.screenRow!.y + 1 } }),
        buffer: {
          active: {
            getLine: (y: number) => y === options.screenRow!.y
              ? { translateToString: (trimRight?: boolean) => (trimRight ? options.screenRow!.text : `${options.screenRow!.text}   `) }
              : undefined
          }
        }
      } : {}),
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

test("copySelection normalizes a Claude Code hard wrap using terminal columns", async () => {
  const first = `  ${"x".repeat(73)} last`;
  const { term, written } = terminal("none", `${first}\n  next`);

  await copySelection(term);

  expect(written).toEqual([`${"x".repeat(73)} last next`]);
});

test("copySelection preserves the raw selection when normalization is disabled", async () => {
  normalizeTerminalCopy = false;
  const first = `  ${"x".repeat(73)} last`;
  const selection = `${first}\n  next`;
  const { term, written } = terminal("none", selection);

  await copySelection(term);

  expect(written).toEqual([selection]);
  expect(undoActions).toEqual([]);
});

test("copySelection preserves an unindented multiline selection", async () => {
  const first = `${"x".repeat(75)} last`;
  const selection = `${first}\nnext`;
  const { term, written } = terminal("none", selection);

  await copySelection(term);

  expect(written).toEqual([selection]);
});

test("copySelection uses xterm string width for an emoji cluster", async () => {
  const first = `  echo 👩‍💻${"z".repeat(31)}`;
  let calls = 0;
  const { term, written } = terminal("none", `${first}\n  y`, {}, {
    cols: 42,
    unicodeService: {
      getStringCellWidth: (text) => {
        calls++;
        return text.replace("👩‍💻", "xx").length;
      }
    }
  });

  await copySelection(term);

  expect(calls).toBeGreaterThan(0);
  expect(written).toEqual([`echo 👩‍💻${"z".repeat(31)}\ny`]);
});

test("copySelection falls back to grapheme width when xterm has no Unicode service", async () => {
  const first = `  echo 👩‍💻${"z".repeat(31)}`;
  const { term, written } = terminal("none", `${first}\n  y`, {}, { cols: 42 });

  await copySelection(term);

  expect(written).toEqual([`echo 👩‍💻${"z".repeat(31)}\ny`]);
});

test("copySelection unframes two partial Prosopon rows from the full first screen row", async () => {
  const border = String.fromCodePoint(0x2502);
  const command = `echo "prosopon copy test: ${"x".repeat(79)} oscar`;
  const fullRow = `${border} ${`  ${command}`.padEnd(116)} ${border}`;
  const selection = `${fullRow.slice(fullRow.indexOf("echo"))}\n${border}   papa zulu end"`;
  const { term, written } = terminal("none", selection, {}, { cols: 120, screenRow: { y: 37, text: fullRow } });

  await copySelection(term);

  expect(written).toEqual([`${command} papa zulu end"`]);
});

test("copySelection undo rewrites the raw selection", async () => {
  const first = `  ${"x".repeat(73)} last`;
  const selection = `${first}\n  next`;
  const { term, written } = terminal("none", selection);

  await copySelection(term);

  expect(undoActions).toHaveLength(1);
  undoActions[0]!();
  await Promise.resolve();
  expect(written).toEqual([`${"x".repeat(73)} last next`, selection]);
});

test("copySelection undo leaves a newer clipboard copy untouched", async () => {
  const first = `  ${"x".repeat(73)} last`;
  let clipboard = "";
  const { term, written } = terminal("none", `${first}\n  next`, {
    writeText: async (value) => { clipboard = value; },
    readText: async () => clipboard
  });

  await copySelection(term);
  clipboard = "a newer copy";
  undoActions[0]!();
  await Promise.resolve();

  expect(written).toEqual([`${"x".repeat(73)} last next`]);
});

test("the latest repair undo restores the second raw selection", async () => {
  const first = `  ${"x".repeat(73)} last`;
  let clipboard = "";
  const writes: string[] = [];
  const callbacks = {
    writeText: async (value: string) => { clipboard = value; writes.push(value); },
    readText: async () => clipboard
  };
  const firstCopy = terminal("none", `${first}\n  first`, callbacks);
  const secondCopy = terminal("none", `${first}\n  second`, callbacks);

  await copySelection(firstCopy.term);
  await copySelection(secondCopy.term);
  activeUndoAction!();
  await Promise.resolve();

  expect(writes).toEqual([
    `${"x".repeat(73)} last first`,
    `${"x".repeat(73)} last second`,
    `${first}\n  second`
  ]);
});

test("copySelection undo reports a clipboard read failure", async () => {
  const errors = rendererErrors();
  const first = `  ${"x".repeat(73)} last`;
  const { term, written } = terminal("none", `${first}\n  next`, {
    readText: async () => { throw new Error("not focused"); }
  });

  await copySelection(term);
  undoActions[0]!();
  await Promise.resolve();

  expect(written).toEqual([`${"x".repeat(73)} last next`]);
  expect(errors).toEqual([["terminal", "clipboard copy failed"]]);
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
