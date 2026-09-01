// Pick-context dialog (PickContextDialog.tsx, `pickContextPrompt` flag,
// DeckConfig): the modal that opens after an element pick so the operator
// can add an optional note/intent/priority before the prompt is composed
// and delivered by the two call sites (BrowserView.tsx's webview handler,
// App.tsx's onDesignPick). Pure and prop-driven -- like TemplateEntryCard's
// EntryCard (tests/desktop-templates-composer-role.test.ts, the harness this
// file is modelled on) -- so it is mounted DIRECTLY, no BrowserView/App in
// sight.
//
// happy-dom, registered globally -- see tests/desktop-explorer-selection-dom.test.ts's
// header comment for the measured cross-file blast radius of a missing
// GlobalRegistrator.unregister().
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import { PICK_BUDGET } from "../desktop/src/shared/pick-security.ts";
import type { ElementPick, PickAnnotationIntent, PickAnnotationPriority, PickNote } from "../desktop/src/shared/types.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  dict: Record<string, string>;
}

function initialFakeState(): FakeDeckState {
  return {
    // Untranslated keys resolve to the key itself (i18n.ts's `translate`),
    // so assertions below match on the literal key strings; the one
    // template actually interpolated by a test (the summary line) is
    // spelled out here to match main/i18n.ts's real string.
    dict: {
      "browser.pickContextSummary": "<{tag}> {w}x{h}px, selector: {selector}"
    }
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  fakeUseDeck.setState(initialFakeState(), true);
}

// store.ts's own `@shared/types` value import does not resolve under plain
// `bun test` from the repo root (tests/_store-mock.ts's header comment) --
// required regardless of whether this file's component under test reaches
// useDeck's STATE for anything beyond `dict` (i18n.ts's useT calls useDeck
// unconditionally, and PickContextDialog.tsx calls useT).
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

// PickContextDialog.tsx's only VALUE import through the `@shared/*`
// tsconfig-only alias (desktop/tsconfig.web.json, not resolved by bun test
// from the repo root -- same gap as above) is PICK_BUDGET. Re-exporting the
// REAL module (already imported above via a relative path, which bun test
// resolves fine -- pick-security.ts has zero imports of its own, per its
// header comment) rather than hand-duplicating the budget, so this test
// stays honest about the actual cap.
mock.module("@shared/pick-security", () => ({ PICK_BUDGET }));

const { PickContextDialog } = await import(
  "../desktop/src/renderer/src/components/PickContextDialog"
);

/** Minimal valid ElementPick, overridable per test -- same shape as
 *  tests/desktop-pick-note.test.ts's helper. */
function pick(overrides: Partial<ElementPick> = {}): ElementPick {
  return {
    tagName: "button",
    id: "",
    classes: [],
    text: "",
    selectors: [{ type: "css", value: "button.btn-save" }],
    width: 120,
    height: 40,
    pageUrl: "https://example.com/settings",
    ...overrides
  };
}

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

// Same native-setter bypass as tests/desktop-templates-composer-role.test.ts's
// typeInto/setValue: React patches the element's own `value` property
// setter, so a bare `el.value = x` leaves React's change-tracker unaware and
// the subsequent event finds "no change" -- onChange never fires. `<select>`
// and a plain `<input>` fire on 'change'; a controlled `<textarea>` (typing)
// fires on 'input'.
function setValue(
  el: HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventType: "input" | "change"
): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (!setter) throw new Error("no native value setter found on element prototype");
  setter.call(el, value);
  el.dispatchEvent(new Event(eventType, { bubbles: true }));
}

interface MountResult {
  onSend: (note: PickNote, dontAskAgain: boolean) => void;
  onCancel: () => void;
  sendCalls: Array<{ note: PickNote; dontAskAgain: boolean }>;
  cancelCalls: number;
}

function mountDialog(p: ElementPick, shot: "pending" | "ready" | "none" = "none"): MountResult {
  const sendCalls: Array<{ note: PickNote; dontAskAgain: boolean }> = [];
  let cancelCalls = 0;
  const onSend = (note: PickNote, dontAskAgain: boolean): void => {
    sendCalls.push({ note, dontAskAgain });
  };
  const onCancel = (): void => {
    cancelCalls++;
  };
  act(() => {
    root.render(React.createElement(PickContextDialog, { pick: p, shot, onSend, onCancel }));
  });
  return {
    onSend,
    onCancel,
    sendCalls,
    get cancelCalls() {
      return cancelCalls;
    }
  } as MountResult;
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector(".annotate-comment");
  if (!el) throw new Error(".annotate-comment textarea not found");
  return el as HTMLTextAreaElement;
}

function selects(): { intent: HTMLSelectElement; priority: HTMLSelectElement } {
  const els = Array.from(container.querySelectorAll(".annotate-select")) as HTMLSelectElement[];
  if (els.length !== 2) throw new Error(`expected 2 .annotate-select elements, found ${els.length}`);
  return { intent: els[0]!, priority: els[1]! };
}

function sendButton(): HTMLButtonElement {
  const el = container.querySelector(".modal-actions button.primary");
  if (!el) throw new Error(".modal-actions button.primary not found");
  return el as HTMLButtonElement;
}

function dontAskButton(): HTMLButtonElement {
  const el = container.querySelector(".rm-filter-value");
  if (!el) throw new Error(".rm-filter-value (don't-ask-again toggle) not found");
  return el as HTMLButtonElement;
}

test("typing a comment and clicking Send calls onSend with that comment, no intent/priority, dontAskAgain false", () => {
  const m = mountDialog(pick());
  act(() => setValue(textarea(), "the button is misaligned", "input"));
  act(() => sendButton().click());

  expect(m.sendCalls).toHaveLength(1);
  const call = m.sendCalls[0]!;
  expect(call.note).toEqual({ comment: "the button is misaligned", intent: undefined, priority: undefined });
  expect(call.dontAskAgain).toBe(false);
});

test("choosing an intent and a priority passes both through untouched", () => {
  const m = mountDialog(pick());
  const { intent, priority } = selects();
  act(() => setValue(intent, "fix" satisfies PickAnnotationIntent, "change"));
  act(() => setValue(priority, "blocking" satisfies PickAnnotationPriority, "change"));
  act(() => sendButton().click());

  expect(m.sendCalls).toHaveLength(1);
  const call = m.sendCalls[0]!;
  expect(call.note.intent).toBe("fix");
  expect(call.note.priority).toBe("blocking");
});

test("Escape calls onCancel and never onSend", () => {
  const m = mountDialog(pick());
  act(() => setValue(textarea(), "some note", "input"));
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(m.cancelCalls).toBe(1);
  expect(m.sendCalls).toHaveLength(0);
});

test("Ctrl+Enter fired from inside the textarea calls onSend (bubbles to the window listener)", () => {
  const m = mountDialog(pick());
  act(() => setValue(textarea(), "ship it", "input"));
  act(() => {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })
    );
  });

  expect(m.sendCalls).toHaveLength(1);
  expect(m.sendCalls[0]!.note.comment).toBe("ship it");
});

test("ticking the don't-ask-again box passes dontAskAgain true", () => {
  const m = mountDialog(pick());
  act(() => dontAskButton().click());
  act(() => sendButton().click());

  expect(m.sendCalls).toHaveLength(1);
  expect(m.sendCalls[0]!.dontAskAgain).toBe(true);
});

test("the summary renders the selector and sourceFile as TEXT, never injected markup", () => {
  const malicious = 'src/App.tsx<b>injected</b>:42:7';
  mountDialog(
    pick({
      selectors: [{ type: "css", value: 'button[data-x="<b>evil</b>"]' }],
      sourceFile: malicious
    })
  );

  const text = container.textContent ?? "";
  expect(text).toContain('button[data-x="<b>evil</b>"]');
  expect(text).toContain(`source: ${malicious}`);
  // The literal markup must never have been parsed as HTML: no real <b>
  // element exists in the rendered tree, and the raw "<b>" text survives
  // only escaped in the serialized markup.
  expect(container.querySelector("b")).toBeNull();
  expect(container.innerHTML).not.toContain("<b>evil</b>");
  expect(container.innerHTML).not.toContain("<b>injected</b>");
});
