// Mounted directly, without App: the dialog reads its whole input from the
// store and is otherwise pure. What is proven here is the ONE promise the
// brief makes about it -- it shows the fields that differ and ONLY those --
// plus the three arbitration buttons routing the right channel value.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import * as roadmapSync from "../desktop/src/shared/roadmap-sync.ts";
import * as sharedWorkflow from "../desktop/src/shared/workflow.ts";
import type {
  RoadmapItem,
  RoadmapSyncConflict,
  RoadmapSyncResolution,
} from "../desktop/src/shared/types.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// The dialog's only VALUE import through the `@shared/*` tsconfig-only alias
// (not resolved by bun test from the repo root). Re-exporting the REAL module,
// already imported above by a relative path, rather than a hand-written stub:
// the diff logic under test must be the shipped one.
mock.module("@shared/roadmap-sync", () => roadmapSync);
mock.module("@shared/workflow", () => sharedWorkflow);

interface FakeDeckState {
  dict: Record<string, string>;
  sessions: unknown[];
  showToast: (key: string) => void;
  roadmapConflictId: string | null;
  roadmapSync: { status: { mode: string }; conflicts: RoadmapSyncConflict[] };
  openRoadmapConflict: (id: string | null) => void;
  resolveRoadmapConflict: (id: string, choice: RoadmapSyncResolution) => Promise<void>;
}

const resolveCalls: Array<{ id: string; choice: RoadmapSyncResolution }> = [];
const closeCalls: Array<string | null> = [];

function initialFakeState(): FakeDeckState {
  return {
    // Untranslated keys resolve to the key itself (i18n.ts's translate), so
    // the assertions below match on the literal key strings.
    dict: {},
    sessions: [],
    showToast: () => {},
    roadmapConflictId: null,
    roadmapSync: { status: { mode: "replica" }, conflicts: [] },
    openRoadmapConflict: (id) => {
      closeCalls.push(id);
      fakeUseDeck.setState({ roadmapConflictId: id });
    },
    resolveRoadmapConflict: async (id, choice) => {
      resolveCalls.push({ id, choice });
    },
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

function resetFakeStore(): void {
  resolveCalls.length = 0;
  closeCalls.length = 0;
  fakeUseDeck.setState(initialFakeState(), true);
}

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { RoadmapConflictDialog } = await import(
  "../desktop/src/renderer/src/components/RoadmapConflictDialog"
);
const { RoadmapItemModal } = await import(
  "../desktop/src/renderer/src/components/RoadmapItemModal"
);

function item(patch: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: "card-1",
    project_key: "github.com/vocsap/x",
    kind: "feature",
    title: "Card one",
    description: "d",
    rationale: "r",
    context: "c",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    triage: null,
    tags: [],
    depends_on: [],
    created_by: "p",
    updated_by: "p",
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    deleted_at: null,
    queue: null,
    locked: false,
    locked_by: null,
    locked_at: null,
    locked_group: null,
    directive: null,
    target_peer_ids: [],
    inactive: false,
    sync_state: "conflict",
    lock_scope: null,
    lock_contested_by: [],
    ...patch,
  };
}

function conflict(
  local: Partial<RoadmapItem>,
  remote: Partial<RoadmapItem>,
): RoadmapSyncConflict {
  return { local: item(local), remote: { ...item(remote), rev: 3, content_rev: 2 }, base: null };
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

function mount(): void {
  act(() => {
    root.render(React.createElement(RoadmapConflictDialog));
  });
}

function fieldLabels(): string[] {
  return [...container.querySelectorAll(".rm-conflict-row:not(.rm-conflict-head) .rm-conflict-field")]
    .map((el) => (el.textContent ?? "").trim());
}

test("nothing is rendered while no conflict is open", () => {
  mount();
  expect(container.querySelector(".rm-conflict-modal")).toBeNull();
});

test("only the DIFFERING fields are listed, lifecycle first", () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [
        conflict(
          { title: "kept title", description: "local text", status: "done" },
          { title: "kept title", description: "remote text", status: "planned" },
        ),
      ],
    },
  });
  mount();
  expect(container.querySelector(".rm-conflict-modal")).not.toBeNull();
  const labels = fieldLabels();
  // status differs and is a lifecycle field, so it leads; description differs
  // and follows; title is IDENTICAL on both sides and must not appear at all.
  expect(labels[0]).toContain("roadmap.sync.field.status");
  expect(labels.some((l) => l.includes("roadmap.sync.field.description"))).toBe(true);
  expect(labels.some((l) => l.includes("roadmap.sync.field.title"))).toBe(false);
  expect(labels).toHaveLength(2);
});

test("the base column is absent when the card was never synced", () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [conflict({ title: "a" }, { title: "b" })],
    },
  });
  mount();
  expect(container.querySelector(".rm-conflict-nobase")).not.toBeNull();
  expect(container.querySelector(".rm-conflict-base")).toBeNull();
});

test("the three buttons send the three channel values, on the open card's id", async () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [conflict({ title: "a" }, { title: "b" })],
    },
  });
  mount();
  const buttons = [...container.querySelectorAll(".rm-conflict-choice")] as HTMLButtonElement[];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) {
    // One click at a time, each awaited: the choices are disabled while a
    // resolution is in flight, which is exactly the double-submit guard, so
    // firing all three synchronously would only record the first.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  expect(resolveCalls).toEqual([
    { id: "card-1", choice: "remote" },
    { id: "card-1", choice: "local" },
    { id: "card-1", choice: "merge_reopen" },
  ]);
});

test("a conflict that disappears from the poll closes the dialog", () => {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [conflict({ title: "a" }, { title: "b" })],
    },
  });
  mount();
  expect(container.querySelector(".rm-conflict-modal")).not.toBeNull();
  // Arbitrated from another Deck, or auto-resolved by the lock-sweep rule:
  // the dialog must not keep offering three buttons over a settled card.
  act(() => {
    fakeUseDeck.setState({
      roadmapSync: { status: { mode: "replica" }, conflicts: [] },
    });
  });
  expect(container.querySelector(".rm-conflict-modal")).toBeNull();
  expect(closeCalls).toContain(null);
});

function openConflictOnCard(): void {
  fakeUseDeck.setState({
    roadmapConflictId: "card-1",
    roadmapSync: {
      status: { mode: "replica" },
      conflicts: [conflict({ title: "a" }, { title: "b" })],
    },
  });
}

/** The real stacking: the card's detail modal open, the dialog mounted beside it. */
function mountOverCardModal(card: RoadmapItem, onClose: () => void): void {
  const noop = (): void => {};
  act(() => {
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(RoadmapItemModal, {
          item: card,
          items: [card],
          onClose,
          onEdit: noop,
          onLaunch: noop,
          onStop: noop,
          onQueue: noop,
          onUnqueue: noop,
          onArchive: noop,
          onRestore: noop,
          onAddDep: noop,
          onRemoveDep: noop,
        }),
        React.createElement(RoadmapConflictDialog),
      ),
    );
  });
}

function pressEscape(): void {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function translate(): { x: number; y: number } {
  const modal = container.querySelector(".rm-conflict-modal") as HTMLElement;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(modal.style.transform);
  if (!m) throw new Error(`dialog transform is not a translate: "${modal.style.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** happy-dom lays nothing out (every rect is 0x0 at the origin), which would pin
 *  the dialog to its clamp from the first move. Give it a centred 600x400 box that
 *  follows its own translate, as Chromium's getBoundingClientRect does. */
function layOut(): void {
  const modal = container.querySelector(".rm-conflict-modal") as HTMLElement;
  modal.getBoundingClientRect = () => {
    const { x, y } = translate();
    return new DOMRect(200 + x, 100 + y, 600, 400);
  };
}

function pointer(el: Element, type: string, x: number, y: number): void {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }),
    );
  });
}

test("one Escape closes the stacked dialog only, the next one closes the card modal", () => {
  openConflictOnCard();
  let cardClosed = 0;
  mountOverCardModal(item({}), () => cardClosed++);
  expect(container.querySelector(".rm-conflict-modal")).not.toBeNull();

  pressEscape();
  expect(container.querySelector(".rm-conflict-modal")).toBeNull();
  expect(cardClosed, "the first Escape leaked through to the card modal underneath").toBe(0);

  pressEscape();
  expect(cardClosed).toBe(1);
});

test("with no conflict open the dialog does not swallow Escape", () => {
  let cardClosed = 0;
  mountOverCardModal(item({}), () => cardClosed++);
  pressEscape();
  expect(cardClosed, "a closed dialog still intercepts Escape app-wide").toBe(1);
});

test("the dialog's backdrop carries its own stacking class", () => {
  openConflictOnCard();
  mount();
  const backdrop = container.querySelector(".rm-conflict-modal")!.parentElement!;
  expect(backdrop.classList.contains("modal-backdrop")).toBe(true);
  expect(backdrop.classList.contains("rm-conflict-backdrop")).toBe(true);
});

/** Value of `prop` in the LAST rule whose selector is exactly `selector` (the one the cascade keeps). */
function declarationOf(css: string, selector: string, prop: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  for (const rule of rules.reverse()) {
    const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`).exec(rule[1]!);
    if (m) return m[1]!.trim();
  }
  return null;
}

function zIndexOf(css: string, selector: string): number | null {
  const z = declarationOf(css, selector, "z-index");
  return z === null ? null : Number(z);
}

const stylesheet = (): Promise<string> =>
  Bun.file(new URL("../desktop/src/renderer/src/styles.css", import.meta.url)).text();

test("over a card modal the veil lets pointer events through to the card, the dialog keeps them", async () => {
  const css = await stylesheet();
  expect(
    declarationOf(css, "body:has(.rm-modal) .rm-conflict-backdrop", "pointer-events"),
    "the transparent veil still catches the wheel and clicks aimed at the card beneath",
  ).toBe("none");
  expect(
    declarationOf(css, "body:has(.rm-modal) .rm-conflict-modal", "pointer-events"),
    "the dialog inherits pointer-events:none from its veil and becomes unclickable",
  ).toBe("auto");
});

test("a mousedown outside the dialog closes it alone, never over a card modal", () => {
  openConflictOnCard();
  mountOverCardModal(item({}), () => {});
  const backdrop = () => container.querySelector(".rm-conflict-backdrop");
  act(() => {
    backdrop()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(backdrop(), "a click aimed at the card beneath closed the dialog").not.toBeNull();

  act(() => {
    root.render(React.createElement(RoadmapConflictDialog));
  });
  act(() => {
    backdrop()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(backdrop(), "opened alone, the dialog no longer closes on an outside click").toBeNull();
});

test("the stylesheet stacks the conflict backdrop above every other modal backdrop", async () => {
  // happy-dom applies no stylesheet, so the stacking is read from the source the
  // renderer ships; the class assertion above only proves the hook exists.
  const css = await Bun.file(
    new URL("../desktop/src/renderer/src/styles.css", import.meta.url),
  ).text();
  const modal = zIndexOf(css, ".modal-backdrop");
  const conflictZ = zIndexOf(css, ".rm-conflict-backdrop");
  expect(modal, "no z-index found on .modal-backdrop").not.toBeNull();
  expect(conflictZ, "no z-index on .rm-conflict-backdrop: it ties with the card modal and DOM order hides it").not.toBeNull();
  expect(conflictZ!).toBeGreaterThan(modal!);
});

test("Escape inside a text field outside the dialog is left to that field", () => {
  openConflictOnCard();
  let cardClosed = 0;
  mountOverCardModal(item({}), () => cardClosed++);
  const field = document.createElement("input");
  document.body.appendChild(field);
  let fieldSaw = 0;
  field.addEventListener("keydown", (e) => {
    if (e.key === "Escape") fieldSaw++;
  });
  act(() => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  field.remove();
  expect(fieldSaw, "the dialog swallowed an Escape aimed at a text field of the app").toBe(1);
  expect(container.querySelector(".rm-conflict-modal")).not.toBeNull();
});

test("a window resize re-clamps a dialog parked at the edge", () => {
  openConflictOnCard();
  mount();
  layOut();
  const head = container.querySelector(".rm-conflict-modal .modal-head")!;
  pointer(head, "pointerdown", 100, 100);
  pointer(head, "pointermove", 100 + 50_000, 100);
  pointer(head, "pointerup", 0, 0);
  const width = window.innerWidth;
  expect(200 + translate().x).toBe(width - 120);

  const narrower = width - 300;
  const own = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: narrower });
  try {
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(200 + translate().x, "the dialog stayed beyond the shrunken window").toBe(narrower - 120);
  } finally {
    if (own) Object.defineProperty(window, "innerWidth", own);
    else delete (window as { innerWidth?: number }).innerWidth;
  }
  expect(window.innerWidth).toBe(width);
});

test("dragging the header moves the dialog, clamped inside the window", () => {
  openConflictOnCard();
  mount();
  layOut();
  const head = container.querySelector(".rm-conflict-modal .modal-head")!;
  pointer(head, "pointerdown", 100, 100);
  pointer(head, "pointermove", 140, 130);
  expect(translate()).toEqual({ x: 40, y: 30 });

  pointer(head, "pointermove", 100 + 50_000, 100 + 50_000);
  const far = translate();
  expect(200 + far.x, "the dialog's left edge left the window").toBe(window.innerWidth - 120);
  expect(100 + far.y, "the dialog's top edge left the window").toBe(window.innerHeight - 120);

  pointer(head, "pointermove", 100 - 50_000, 100 - 50_000);
  const near = translate();
  expect(200 + near.x, "the dialog went out to the left past its grab margin").toBe(120 - 600);
  expect(100 + near.y, "the dialog's top climbed above the backdrop").toBe(0);
  pointer(head, "pointermove", 100 + 50_000, 100 + 50_000);
  pointer(head, "pointerup", 0, 0);

  pointer(head, "pointermove", 0, 0);
  expect(translate(), "a move after pointerup still dragged the dialog").toEqual(far);
});

test("a press on the close cross does not start a drag", () => {
  openConflictOnCard();
  mount();
  const head = container.querySelector(".rm-conflict-modal .modal-head")!;
  const cross = head.querySelector("button")!;
  pointer(cross, "pointerdown", 100, 100);
  pointer(head, "pointermove", 300, 300);
  expect(translate()).toEqual({ x: 0, y: 0 });
});

test("arrow keys move the focused header by one step, and a reopen recentres", () => {
  openConflictOnCard();
  mount();
  layOut();
  const head = container.querySelector(".rm-conflict-modal .modal-head") as HTMLElement;
  expect(head.tabIndex).toBe(0);
  act(() => {
    head.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  act(() => {
    head.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(translate()).toEqual({ x: 16, y: 16 });

  act(() => fakeUseDeck.setState({ roadmapConflictId: null }));
  act(() => fakeUseDeck.setState({ roadmapConflictId: "card-1" }));
  expect(translate()).toEqual({ x: 0, y: 0 });
});

test("a conflicting card offers a labelled arbitration action next to Archive", () => {
  mountOverCardModal(item({}), () => {});
  const actions = [...container.querySelectorAll(".rm-detail-actions button")];
  const resolve = actions.find((b) => (b.textContent ?? "").includes("roadmap.sync.resolve"));
  expect(resolve, "no arbitration button in the card's action row").toBeDefined();
  const archive = actions.find((b) => (b.textContent ?? "").includes("roadmap.archive"));
  expect(actions.indexOf(resolve!)).toBe(actions.indexOf(archive!) - 1);
  expect(
    container.querySelector('.rm-detail-head [title="roadmap.sync.resolve"]'),
    "the bare header icon must be gone: one control for one action",
  ).toBeNull();

  act(() => {
    resolve!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(closeCalls[0]).toBe("card-1");
});

test("a card that is not in conflict shows no arbitration action", () => {
  mountOverCardModal(item({ sync_state: "clean" }), () => {});
  expect(container.textContent).not.toContain("roadmap.sync.resolve");
});
