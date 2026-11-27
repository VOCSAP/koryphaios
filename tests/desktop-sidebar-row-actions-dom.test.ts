// The session row's hover buttons live in ONE overlay container so they take no
// width from the name, and the context ring names the model so the row can hide
// its model badge when narrow without losing the information. Layout itself is
// measured in Chromium (happy-dom has none); this file pins the structure that
// layout depends on.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";
import * as sharedReorder from "../desktop/src/shared/reorder.ts";
import * as sharedModels from "../desktop/src/shared/models.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  config: { autoResumeQuota: boolean; countBadgeStyle?: string };
  selectedId: string | null;
  maximizedId: string | null;
  dict: Record<string, string>;
  setSelected: (id: string) => void;
  setMaximized: (id: string | null) => void;
  removeSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  setColor: (id: string, color: string) => Promise<void>;
  setAutoResume: (id: string, enabled: boolean) => Promise<void>;
  clearAttention: (id: string) => Promise<void>;
  showToast: (key: string) => void;
  openDiff: (id: string) => void;
  runSkill: (...args: unknown[]) => Promise<null>;
  sessionSequences: Record<string, unknown>;
}

function initialFakeState(): FakeDeckState {
  return {
    config: { autoResumeQuota: false },
    selectedId: null,
    maximizedId: null,
    dict: {},
    setSelected: () => {},
    setMaximized: () => {},
    removeSession: async () => {},
    renameSession: async () => {},
    setColor: async () => {},
    setAutoResume: async () => {},
    clearAttention: async () => {},
    showToast: () => {},
    openDiff: () => {},
    runSkill: async () => null,
    sessionSequences: {}
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });
mock.module("@shared/reorder", () => sharedReorder);
mock.module("@shared/models", () => sharedModels);
mock.module("../desktop/src/renderer/src/components/CreateMenu.tsx", () => ({
  CreateMenu: () => {
    throw new Error("CreateMenu stub rendered -- this file only mounts SessionRow");
  }
}));

const { SessionRow, SKILL_BLOCK_KEY } = await import("../desktop/src/renderer/src/components/Sidebar.tsx");

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

const LIVE = { model: "Haiku 4.5", modelId: "claude-haiku-4-5", contextPct: 27, contextWindow: 200000, at: 0 };

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tile-a",
    name: "worker",
    cwd: "/proj",
    command: "",
    args: "",
    sessionId: "sid-1",
    color: "#fff",
    createdAt: 0,
    status: "running",
    exitCode: null,
    pid: 1,
    peerId: "peer-a",
    expired: false,
    rateLimited: false,
    resumeAt: null,
    needsAttention: false,
    claudeLaunch: true,
    liveStatus: LIVE,
    ...overrides
  };
}

const dnd = {
  dragId: null,
  overId: null,
  onDragStart: () => {},
  onDragEnter: () => {},
  onDrop: () => {},
  onDragEnd: () => {}
};

function renderRow(s: Record<string, unknown>, collapsed = false): void {
  act(() => {
    root.render(
      React.createElement(SessionRow, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake fixture, real component
        session: s as any,
        dnd,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake fixture, real component
        roster: [s as any],
        collapsed
      })
    );
  });
}

function row(): HTMLElement {
  const el = container.querySelector("li");
  if (!el) throw new Error("SessionRow did not render its <li> row");
  return el as HTMLElement;
}

function directChildren(el: Element, cls: string): Element[] {
  return [...el.children].filter((c) => c.classList.contains(cls));
}

const ROW_ACTION_TITLES = ["sidebar.lock", "sidebar.renameTitle", "common.maximize", "sidebar.removeTitle"];

function overlayTitles(): string[] {
  return [...row().querySelectorAll<HTMLButtonElement>(".row-actions .row-btn")].map((b) => b.title);
}

test("the row buttons sit in one overlay container, a direct child of the row", () => {
  renderRow(session());
  const overlays = directChildren(row(), "row-actions");
  expect(overlays, "one .row-actions overlay per row, anchored on the row itself").toHaveLength(1);
  const inside = [...overlays[0]!.children];
  expect(inside.every((b) => b.tagName === "BUTTON" && b.classList.contains("row-btn"))).toBe(true);
  expect(overlayTitles(), "lock, rename, maximize and remove all ride the overlay").toEqual(ROW_ACTION_TITLES);
  expect(
    directChildren(row(), "row-btn"),
    "a row button left in the row's flow takes width from the session name again"
  ).toHaveLength(0);
});

test("the overlay's buttons stay keyboard-reachable", () => {
  renderRow(session());
  for (const b of row().querySelectorAll<HTMLButtonElement>(".row-actions .row-btn")) {
    expect(b.disabled).toBe(false);
    expect(b.tabIndex, `${b.title} must stay in the tab order to be revealed by :focus-within`).toBeGreaterThanOrEqual(0);
  }
});

test("the context ring names the model, so hiding the badge on a narrow row loses nothing", () => {
  renderRow(session());
  const ring = row().querySelector("svg.context-ring");
  expect(ring?.getAttribute("aria-label"), "the ring's label must carry the model name").toContain("Haiku 4.5");
  expect(ring?.querySelector("title")?.textContent).toContain("Haiku 4.5");
});

test("a measured ring says what it measures in its tooltip, and keeps a short spoken label", () => {
  renderRow(session());
  const ring = row().querySelector("svg.context-ring");
  expect(ring?.querySelector("title")?.textContent).toContain("sidebar.contextRingScope");
  expect(ring?.getAttribute("aria-label")).toContain("sidebar.contextRingTitle");
  expect(ring?.getAttribute("aria-label"), "the scope sentence would be read on every row").not.toContain("sidebar.contextRingScope");
});

test("a ring with a source but no reading yet stays the dashed unknown ring, not unavailable", () => {
  renderRow(session({ liveStatus: { ...LIVE, contextPct: null } }));
  const ring = row().querySelector("svg.context-ring");
  expect(ring?.classList.contains("context-ring-unknown")).toBe(true);
  expect(ring?.classList.contains("context-ring-unavailable")).toBe(false);
});

test("without a live status the row shows an unavailable ring that says why, and keeps its actions", () => {
  renderRow(session({ liveStatus: null }));
  const ring = row().querySelector("svg.context-ring");
  expect(ring, "the ring vanished: an empty slot reads as a zero context").not.toBeNull();
  expect(ring!.classList.contains("context-ring-unavailable")).toBe(true);
  expect(ring!.getAttribute("aria-label")).toBe("sidebar.contextRingUnavailable");
  expect(ring!.querySelector("title")?.textContent, "the tooltip must say why").toBe("sidebar.contextRingUnavailable");
  expect(ring!.querySelector(".context-ring-fill"), "an unavailable ring draws no fill arc").toBeNull();
  expect(ring!.querySelector(".context-ring-bar"), "the bar is what tells it apart from 0%").not.toBeNull();
  expect(row().querySelector(".row-model"), "no model badge without a report").toBeNull();
  expect(overlayTitles()).toEqual(ROW_ACTION_TITLES);
});

test("a non-Claude tile has no context ring at all, and keeps its actions", () => {
  renderRow(session({ claudeLaunch: false, liveStatus: null }));
  expect(row().querySelector("svg.context-ring"), "a shell or codex tile can never report a context").toBeNull();
  expect(overlayTitles()).toEqual(ROW_ACTION_TITLES);
});

test("a folded row shows no ring, measured or not", () => {
  renderRow(session({ liveStatus: null }), true);
  expect(row().querySelector("svg.context-ring")).toBeNull();
});

test("while renaming, the overlay drops the rename button and keeps the others", () => {
  renderRow(session());
  const rename = row().querySelector<HTMLButtonElement>('.row-actions .row-btn[title="sidebar.renameTitle"]');
  if (!rename) throw new Error("no rename button in the overlay");
  act(() => {
    rename.click();
  });
  expect(row().querySelector(".row-edit")).not.toBeNull();
  expect(overlayTitles()).toEqual(ROW_ACTION_TITLES.filter((t) => t !== "sidebar.renameTitle"));
});

// happy-dom applies no stylesheet, so the three rules the layout depends on are
// pinned on the text of styles.css, whitespace-normalized.
const CSS = readFileSync(
  join(import.meta.dir, "../desktop/src/renderer/src/styles.css"),
  "utf-8"
).replace(/\s+/g, " ");

function ruleBody(selectorList: string): string | null {
  const start = CSS.indexOf(`${selectorList} {`);
  if (start < 0) return null;
  const open = start + selectorList.length + 2;
  return CSS.slice(open, CSS.indexOf("}", open));
}

test("the overlay is revealed by hover AND keyboard focus, and only then catches clicks", () => {
  const body = ruleBody(".row:hover .row-actions, .row:focus-within .row-actions");
  expect(body, "the reveal rule must cover :hover and :focus-within together").not.toBeNull();
  expect(body!, "revealed, the overlay must be visible").toMatch(/opacity: 1;/);
  expect(body!, "revealed, the overlay must take clicks again").toMatch(/pointer-events: auto;/);
});

test("a narrow row drops the model badge before the name gives up its floor", () => {
  expect(
    CSS,
    "the container query hiding .row-model is what keeps the name readable on a narrow sidebar"
  ).toMatch(/@container session-row \(max-width: \d+px\) \{ \.row-model \{ display: none; \} \}/);
});

test("renaming hides the overlay, which would otherwise cover the caret through :focus-within", () => {
  const body = ruleBody(".row:has(.row-edit) .row-actions");
  expect(body, "the edit field must never sit under the opaque overlay").not.toBeNull();
  expect(body!).toMatch(/display: none;/);
});

test("a folded row renders no overlay at all", () => {
  renderRow(session(), true);
  expect(row().querySelector(".row-actions")).toBeNull();
});

test("an unlocked row, locked field absent, wears no frame and no padlock", () => {
  renderRow(session());
  expect(row().classList.contains("row-locked"), "an absent `locked` must read as unlocked").toBe(false);
  expect(row().querySelector(".row-lock")).toBeNull();
});

test("a locked row wears the frame and the padlock, AHEAD of the role glyph", () => {
  renderRow(session({ locked: true, role: "developer" }));
  expect(row().classList.contains("row-locked")).toBe(true);
  const children = [...row().children];
  const lock = children.findIndex((c) => c.classList.contains("row-lock"));
  const role = children.findIndex((c) => c.classList.contains("row-role"));
  expect(lock, "the padlock must be a direct child of the row, in the badge column").toBeGreaterThanOrEqual(0);
  expect(role, "fixture must carry a role for the order to mean anything").toBeGreaterThanOrEqual(0);
  expect(lock, "the operator asked for the padlock BEFORE the role glyph").toBeLessThan(role);
  expect(row().querySelector(".row-lock")?.getAttribute("title")).toBe("sidebar.lockedTitle");
});

test("a dormant peer wears the disconnected mark with its label, and the peer id stays visible", () => {
  renderRow(session({ peerStatus: "dormant" }));
  const mark = row().querySelector(".row-peer-off");
  expect(mark, "a dormant tile must show it lost its claude-peers server").not.toBeNull();
  expect(mark!.getAttribute("role")).toBe("img");
  expect(mark!.getAttribute("aria-label")).toBe("sidebar.peerDormant");
  expect(row().querySelector(".row-sub")?.textContent).toContain("peer-a");
});

test("an active or unreported peer wears no disconnected mark", () => {
  for (const peerStatus of ["active", null]) {
    renderRow(session({ peerStatus }));
    expect(row().querySelector(".row-peer-off"), `peerStatus ${String(peerStatus)}`).toBeNull();
  }
});

test("folded, a locked row keeps its frame class, so the rail still shows the lock", () => {
  renderRow(session({ locked: true }), true);
  expect(row().classList.contains("row-locked")).toBe(true);
});

test("the lock button offers the gesture the row does NOT have yet", () => {
  renderRow(session({ locked: true }));
  const titles = overlayTitles();
  expect(titles).toContain("sidebar.unlock");
  expect(titles).not.toContain("sidebar.lock");
  const btn = row().querySelector<HTMLButtonElement>('.row-actions .row-btn[title="sidebar.unlock"]');
  expect(btn?.getAttribute("aria-pressed")).toBe("true");
});

function withApi(api: Record<string, unknown>, body: () => Promise<void>): Promise<void> {
  const w = window as unknown as { api?: unknown };
  const prev = w.api;
  w.api = api;
  return body().finally(() => {
    w.api = prev;
  });
}

test("clicking the lock button asks main to flip the lock of THIS session", async () => {
  const calls: Array<[string, boolean]> = [];
  await withApi(
    {
      setSessionLocked: async (id: string, locked: boolean) => {
        calls.push([id, locked]);
      },
      reportError: () => {}
    },
    async () => {
      renderRow(session());
      const btn = row().querySelector<HTMLButtonElement>('.row-actions .row-btn[title="sidebar.lock"]');
      if (!btn) throw new Error("no lock button in the overlay");
      await act(async () => {
        btn.click();
      });
      expect(calls).toEqual([["tile-a", true]]);
    }
  );
});

function labelOf(b: Element): string {
  return [...b.childNodes]
    .filter((n) => !(n instanceof Element && n.classList.contains("context-menu-hint")))
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
}

function menuItem(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.context-menu [role="menuitem"]')].find(
    (b) => labelOf(b) === label
  );
}

function openMenu(): void {
  act(() => {
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

function closeMenu(): void {
  act(() => {
    container.querySelector<HTMLElement>(".context-menu-backdrop")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true })
    );
  });
}

async function pickFromMenu(label: string): Promise<void> {
  openMenu();
  const item = menuItem(label);
  if (!item) throw new Error(`the right-click menu offers no "${label}" entry`);
  await act(async () => {
    item.click();
  });
}

test("the right-click menu flips the lock both ways, on THIS session", async () => {
  const calls: Array<[string, boolean]> = [];
  await withApi(
    {
      setSessionLocked: async (id: string, locked: boolean) => {
        calls.push([id, locked]);
      },
      reportError: () => {}
    },
    async () => {
      renderRow(session());
      await pickFromMenu("sidebar.lock");
      renderRow(session({ locked: true }));
      await pickFromMenu("sidebar.unlock");
      expect(calls, "unlocked offers Lock, locked offers Unlock, each asking for the inverse").toEqual([
        ["tile-a", true],
        ["tile-a", false]
      ]);
    }
  );
});

test("a refused lock is traced and toasted, never swallowed", async () => {
  const reported: string[] = [];
  const toasts: string[] = [];
  fakeUseDeck.setState({ showToast: (key: string) => void toasts.push(key) });
  await withApi(
    {
      setSessionLocked: async () => {
        throw new Error("unknown session");
      },
      reportError: (_scope: string, msg: string) => void reported.push(msg)
    },
    async () => {
      renderRow(session({ locked: true }));
      const btn = row().querySelector<HTMLButtonElement>('.row-actions .row-btn[title="sidebar.unlock"]');
      if (!btn) throw new Error("no unlock button in the overlay");
      await act(async () => {
        btn.click();
      });
      expect(reported.join("\n"), "the refusal must reach the Deck journal").toContain("unknown session");
      expect(toasts.join("\n"), "and the operator, or the frame keeps lying").toContain("unknown session");
    }
  );
});

test("folded, the padlock badge is hidden by CSS alone and the frame stays", () => {
  expect(ruleBody(".sidebar-collapsed .row-lock"), "option B: no badge in the folded rail").toMatch(/display: none;/);
  expect(ruleBody(".row-locked:not(.row-drag-over)"), "the frame must be inset, on the --locked token").toMatch(
    /box-shadow: inset 0 0 0 1px var\(--locked\);/
  );
});

test("on a locked row the hover overlay stands 1px inside the frame, or it paints over its edge", () => {
  const body = ruleBody(".row-locked .row-actions");
  expect(body, "measured on screen: the opaque overlay hid the frame's top, right and bottom").not.toBeNull();
  for (const side of ["top", "right", "bottom"]) expect(body!).toMatch(new RegExp(`${side}: 1px;`));
});

const SEQUENCE_LABELS = ["sidebar.skillStart", "sidebar.skillEnd", "sidebar.skillStopSoft"];
const ELIGIBLE_LEAD = { lead: true, skillEligibility: { eligible: true } };

function blocked(reason: string): Record<string, unknown> {
  return { skillEligibility: { eligible: false, reason } };
}

function menuShape(): string[] {
  return [...container.querySelectorAll(".context-menu > li")].map((li) =>
    li.classList.contains("context-menu-sep") ? "sep" : labelOf(li.querySelector('[role="menuitem"]')!)
  );
}

function hints(): string[] {
  return [...container.querySelectorAll(".context-menu .context-menu-hint")].map((h) => h.textContent ?? "");
}

test("a lead tile's menu ends with the sequence group, then Interrupt alone and last", () => {
  renderRow(session(ELIGIBLE_LEAD));
  openMenu();
  expect(menuShape().slice(-6)).toEqual(["sep", ...SEQUENCE_LABELS, "sep", "sidebar.interrupt"]);
  expect(menuItem("sidebar.interrupt")!.classList.contains("context-menu-item-danger")).toBe(true);
  for (const label of SEQUENCE_LABELS) expect(menuItem(label)!.disabled, label).toBe(false);
  expect(hints(), "an eligible tile describes the gentle stop and the interrupt").toEqual([
    "sidebar.skillStopSoftHint",
    "sidebar.interruptHint"
  ]);
});

test("Interrupt is exactly the --danger colour at rest in both themes, and a disabled one is not", () => {
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(join(import.meta.dir, "../desktop/src/renderer/src/styles.css"), "utf8");
  document.head.appendChild(sheet);
  const remount = (): void => {
    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  };
  const color = (el: Element): string => getComputedStyle(el).color;
  try {
    const dangerByTheme: string[] = [];
    for (const theme of ["dark", "light"]) {
      document.documentElement.setAttribute("data-theme", theme);
      remount();
      renderRow(session(ELIGIBLE_LEAD));
      openMenu();
      const witness = document.createElement("div");
      witness.setAttribute("style", "color: var(--danger)");
      container.appendChild(witness);
      const danger = color(witness);
      expect(danger, `${theme}: the sheet must resolve --danger`).not.toBe("");
      dangerByTheme.push(danger);
      expect(color(menuItem("sidebar.interrupt")!), `${theme}: at rest, no hover`).toBe(danger);
      remount();
      renderRow(session({ ...ELIGIBLE_LEAD, peerId: null }));
      openMenu();
      const disabled = menuItem("sidebar.interrupt")!;
      expect(disabled.disabled).toBe(true);
      expect(color(disabled), `${theme}: a disabled entry dims instead of staying red`).not.toBe(danger);
    }
    expect(new Set(dangerByTheme).size, "the two themes must give two --danger values").toBe(2);
  } finally {
    document.documentElement.removeAttribute("data-theme");
    sheet.remove();
  }
});

test("each sequence entry asks for its own moment; Start carries no mode, the gentle stop asks soft", async () => {
  const calls: unknown[][] = [];
  fakeUseDeck.setState({
    runSkill: async (...args: unknown[]) => {
      calls.push(args);
      return null;
    }
  });
  renderRow(session(ELIGIBLE_LEAD));
  for (const label of SEQUENCE_LABELS) await pickFromMenu(label);
  expect(calls).toEqual([
    ["tile-a", "start"],
    ["tile-a", "end"],
    ["tile-a", "stop", "soft"]
  ]);
});

test("Interrupt asks main for a pause of THIS peer only", async () => {
  const calls: unknown[][] = [];
  await withApi(
    {
      agentsStop: async (...args: unknown[]) => {
        calls.push(args);
        return { mode: "pause", outcomes: [{ result: "interrupted" }], locks: {} };
      },
      reportError: () => {}
    },
    async () => {
      renderRow(session(ELIGIBLE_LEAD));
      await pickFromMenu("sidebar.interrupt");
      expect(calls).toEqual([["pause", ["peer-a"]]]);
    }
  );
});

test("an interrupt main did not deliver is traced and toasted with its outcome", async () => {
  const reported: string[] = [];
  const toasts: unknown[][] = [];
  fakeUseDeck.setState({ showToast: (...args: unknown[]) => void toasts.push(args) } as never);
  await withApi(
    {
      agentsStop: async () => ({ mode: "pause", outcomes: [{ result: "refused-modal" }], locks: {} }),
      reportError: (_scope: string, msg: string) => void reported.push(msg)
    },
    async () => {
      renderRow(session(ELIGIBLE_LEAD));
      await pickFromMenu("sidebar.interrupt");
    }
  );
  expect(reported.join("\n")).toContain("refused-modal");
  expect(toasts).toEqual([["toast.interruptRefused", "error", { params: { reason: "refused-modal" } }]]);
});

test("an interrupt main rejects is traced and toasted with the error text", async () => {
  const reported: string[] = [];
  const toasts: unknown[][] = [];
  const failure = new Error("main unreachable");
  fakeUseDeck.setState({ showToast: (...args: unknown[]) => void toasts.push(args) } as never);
  await withApi(
    {
      agentsStop: async () => {
        throw failure;
      },
      reportError: (_scope: string, msg: string) => void reported.push(msg)
    },
    async () => {
      renderRow(session(ELIGIBLE_LEAD));
      await pickFromMenu("sidebar.interrupt");
    }
  );
  const reason = storeMockStubs.errorText(failure);
  expect(reported.join("\n"), "the rejection must reach the Deck journal").toContain(reason);
  expect(toasts, "and the operator").toEqual([["toast.interruptRefused", "error", { params: { reason } }]]);
});

test("without a peer id Interrupt is offered but disabled", () => {
  renderRow(session({ ...ELIGIBLE_LEAD, peerId: null }));
  openMenu();
  expect(menuItem("sidebar.interrupt")?.disabled).toBe(true);
});

test("each ineligibility greys the three sequence entries with ITS one line, and leaves Interrupt usable", () => {
  for (const [reason, line] of Object.entries(SKILL_BLOCK_KEY)) {
    renderRow(session(blocked(reason)));
    openMenu();
    for (const label of SEQUENCE_LABELS) expect(menuItem(label)?.disabled, `${reason}: ${label}`).toBe(true);
    expect(menuItem("sidebar.interrupt")?.disabled, reason).toBe(false);
    expect(hints(), reason).toEqual([line, "sidebar.interruptHint"]);
    closeMenu();
  }
});

test("a tile without eligibility shows none of the four entries, as a non-Claude tile", () => {
  renderRow(session({ lead: true }));
  openMenu();
  const shape = menuShape();
  for (const label of [...SEQUENCE_LABELS, "sidebar.interrupt"]) expect(shape).not.toContain(label);
  expect(shape).not.toContain("sep");
});

test("an active sequence names its step even when the tile is also ineligible", () => {
  act(() => {
    fakeUseDeck.setState({
      dict: { "sidebar.skillSequenceActive": "step {step} of {total}" },
      sessionSequences: { "tile-a": { tileId: "tile-a", moment: "start", step: 0, total: 3, phase: "running", background: null, reason: null } }
    });
  });
  renderRow(session(blocked("sandbox")));
  openMenu();
  expect(hints()[0]).toBe("step 1 of 3");
});

test("a non-Claude tile shows none of the four entries, nor their separators", () => {
  renderRow(session(blocked("not-claude")));
  openMenu();
  const shape = menuShape();
  for (const label of [...SEQUENCE_LABELS, "sidebar.interrupt"]) expect(shape).not.toContain(label);
  expect(shape).not.toContain("sep");
});

test("a running or waiting sequence greys the three entries and names the step one-based", () => {
  for (const phase of ["running", "waiting-background"]) {
    act(() => {
      fakeUseDeck.setState({
        dict: { "sidebar.skillSequenceActive": "step {step} of {total}" },
        sessionSequences: { "tile-a": { tileId: "tile-a", moment: "start", step: 1, total: 4, phase, background: null, reason: null } }
      });
    });
    renderRow(session(ELIGIBLE_LEAD));
    openMenu();
    for (const label of SEQUENCE_LABELS) expect(menuItem(label)?.disabled, `${phase}: ${label}`).toBe(true);
    expect(hints()[0], phase).toBe("step 2 of 4");
    closeMenu();
  }
});

test("a folded row's right-click selects that row and opens the same menu as an unfolded one", () => {
  const selected: string[] = [];
  fakeUseDeck.setState({ setSelected: (id: string) => void selected.push(id) });
  const menuState = (): unknown => ({
    shape: menuShape(),
    disabled: [...container.querySelectorAll<HTMLButtonElement>('.context-menu [role="menuitem"]')].map((b) => b.disabled),
    hints: hints()
  });
  renderRow(session(ELIGIBLE_LEAD));
  openMenu();
  const unfolded = menuState();
  closeMenu();
  selected.length = 0;
  renderRow(session(ELIGIBLE_LEAD), true);
  openMenu();
  expect(selected, "the right-clicked row becomes the selection").toEqual(["tile-a"]);
  expect(container.querySelector(".context-menu") !== null, "the rail must open the menu too").toBe(true);
  expect(menuState(), "folding the sidebar must not trim or grey the menu").toEqual(unfolded);
  const inherited = [...container.querySelectorAll('.context-menu [role="menuitem"]')].map(
    (b) => b.closest("[title]")?.getAttribute("title") ?? null
  );
  expect(inherited, "no menu entry may inherit the row's name tooltip").not.toContain("worker");
  closeMenu();
  expect(row().getAttribute("title"), "menu closed, the folded row names itself again").toBe("worker");
});

test("a menu opened near the bottom-right corner is pulled back inside the viewport", () => {
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("context-menu")) return { width: 260, height: 300 } as DOMRect;
    return original.call(this);
  };
  try {
    renderRow(session(ELIGIBLE_LEAD));
    act(() => {
      row().dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: window.innerWidth - 20, clientY: window.innerHeight - 20 })
      );
    });
    const menu = container.querySelector<HTMLElement>(".context-menu")!;
    expect(menu.style.top).toBe(`${window.innerHeight - 300 - 8}px`);
    expect(menu.style.left).toBe(`${window.innerWidth - 260 - 8}px`);
  } finally {
    proto.getBoundingClientRect = original;
  }
});

test("a menu near the bottom is pulled back again when an entry grows and the entry count stays", () => {
  const rect = { width: 260, height: 100 };
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("context-menu")) return { ...rect } as DOMRect;
    return original.call(this);
  };
  try {
    renderRow(session(ELIGIBLE_LEAD));
    act(() => {
      row().dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: window.innerHeight - 150 })
      );
    });
    const menu = container.querySelector<HTMLElement>(".context-menu")!;
    const entries = container.querySelectorAll(".context-menu [role=menuitem]").length;
    expect(menu.style.top, "a short menu stays where the click put it").toBe(`${window.innerHeight - 150}px`);

    rect.height = 300;
    act(() => {
      fakeUseDeck.setState({
        sessionSequences: { "tile-a": { tileId: "tile-a", moment: "start", step: 0, total: 3, phase: "running", background: null, reason: null } }
      });
    });
    expect(container.querySelectorAll(".context-menu [role=menuitem]").length, "the entry count must not change").toBe(entries);
    expect(menu.style.top, "a taller hint must be re-measured").toBe(`${window.innerHeight - 300 - 8}px`);
  } finally {
    proto.getBoundingClientRect = original;
  }
});

test("a finished or stopped sequence gives the entries back", () => {
  for (const phase of ["done", "stopped"]) {
    act(() => {
      fakeUseDeck.setState({
        sessionSequences: { "tile-a": { tileId: "tile-a", moment: "end", step: 2, total: 2, phase, background: null, reason: null } }
      });
    });
    renderRow(session(ELIGIBLE_LEAD));
    openMenu();
    for (const label of SEQUENCE_LABELS) expect(menuItem(label)?.disabled, `${phase}: ${label}`).toBe(false);
    closeMenu();
  }
});

function withSequence(phase: string, over: Record<string, unknown> = {}): void {
  act(() => {
    fakeUseDeck.setState({
      sessionSequences: {
        "tile-a": { tileId: "tile-a", spawnGeneration: 1, moment: "start", step: 1, total: 4, phase, background: 2, reason: null, ...over }
      }
    });
  });
}

function seqPill(): Element | null {
  return row().querySelector(".row-seq");
}

test("a running sequence puts its one-based step in a pill right of the name, ahead of the model badge", () => {
  withSequence("running");
  renderRow(session());
  expect(seqPill()?.textContent).toBe("2/4");
  expect(seqPill()?.querySelector(".row-seq-glyph svg") == null, "the clepsydra marks a wait only").toBe(true);
  const order = [...row().children].map((c) => c.className.split(" ")[0]).filter((c) => ["row-main", "row-seq", "row-model"].includes(c!));
  expect(order).toEqual(["row-main", "row-seq", "row-model"]);
  expect(seqPill()?.getAttribute("title")).toBe("sidebar.seqBadgeTitle");
});

test("a sequence waiting on background tasks wears the clepsydra and keeps its step", () => {
  withSequence("waiting-background", { step: 2 });
  renderRow(session());
  expect(seqPill()?.querySelector(".row-seq-glyph svg") !== null, "a waiting pill must show the clepsydra").toBe(true);
  expect(seqPill()?.textContent).toBe("3/4");
  expect(seqPill()?.getAttribute("title")).toBe("sidebar.seqBadgeWaitingTitle");
});

test("a racing view past its last step still reads n of n", () => {
  withSequence("running", { step: 4 });
  renderRow(session());
  expect(seqPill()?.textContent).toBe("4/4");
});

test("no pill for a finished, stopped or absent sequence, nor for another tile's", () => {
  for (const phase of ["done", "stopped"]) {
    withSequence(phase);
    renderRow(session());
    expect(seqPill() === null, phase).toBe(true);
  }
  act(() => {
    fakeUseDeck.setState({ sessionSequences: {} });
  });
  renderRow(session());
  expect(seqPill() === null, "no view").toBe(true);
  act(() => {
    fakeUseDeck.setState({
      sessionSequences: { "tile-b": { tileId: "tile-b", spawnGeneration: 1, moment: "start", step: 0, total: 2, phase: "running", background: null, reason: null } }
    });
  });
  renderRow(session());
  expect(seqPill() === null, "a neighbour's sequence").toBe(true);
});

test("a folded row drops the pill: the rail has no width for it", () => {
  withSequence("running");
  renderRow(session(), true);
  expect(seqPill() === null).toBe(true);
});

const COUNT_DICT = {
  "sidebar.subagentCount": "{count} active subagent(s)",
  "sidebar.shellCount": "{count} background process(es)"
};

function counts(): { kind: string; label: string | null; text: string; glyph: boolean }[] {
  return [...row().querySelectorAll(".row-counts > .row-count")].map((b) => ({
    kind: b.classList.contains("row-count-subagent") ? "subagent" : b.classList.contains("row-count-shell") ? "shell" : "?",
    label: b.getAttribute("role") === "img" ? b.getAttribute("aria-label") : null,
    text: b.textContent ?? "",
    glyph: b.querySelector("svg.glyph") !== null
  }));
}

test("a row without a count source shows no count badge, whether the field is null or missing", () => {
  renderRow(session({ backgroundCounts: null }));
  expect(row().querySelector(".row-counts"), "null source").toBeNull();
  renderRow(session());
  expect(row().querySelector(".row-counts"), "a runtime from before the field existed").toBeNull();
});

test("a zero count has no badge and the other count keeps its own", () => {
  act(() => fakeUseDeck.setState({ dict: COUNT_DICT }));
  renderRow(session({ backgroundCounts: { subagents: 0, shells: 3 } }));
  expect(counts().map((c) => c.kind)).toEqual(["shell"]);
  renderRow(session({ backgroundCounts: { subagents: 0, shells: 0 } }));
  expect(row().querySelector(".row-counts"), "two zeros leave no empty group behind").toBeNull();
});

test("each count is one image whose spoken label carries its number, glyph shown unfolded", () => {
  act(() => fakeUseDeck.setState({ dict: COUNT_DICT }));
  renderRow(session({ backgroundCounts: { subagents: 2, shells: 12 } }));
  expect(counts()).toEqual([
    { kind: "subagent", label: "2 active subagent(s)", text: "2", glyph: true },
    { kind: "shell", label: "12 background process(es)", text: "12", glyph: true }
  ]);
  expect(row().querySelector(".row-counts")!.className, "the default look is the tinted glyph").toBe("row-counts");
});

test("a folded row keeps both counts and their labels, numbers only", () => {
  act(() => fakeUseDeck.setState({ dict: COUNT_DICT }));
  renderRow(session({ backgroundCounts: { subagents: 1, shells: 2 } }), true);
  expect(counts()).toEqual([
    { kind: "subagent", label: "1 active subagent(s)", text: "1", glyph: false },
    { kind: "shell", label: "2 background process(es)", text: "2", glyph: false }
  ]);
});

test("the pill setting switches the look of the counts and nothing else", () => {
  act(() => fakeUseDeck.setState({ dict: COUNT_DICT, config: { autoResumeQuota: false, countBadgeStyle: "pill" } }));
  renderRow(session({ backgroundCounts: { subagents: 2, shells: 1 } }));
  expect(row().querySelector(".row-counts")!.className).toBe("row-counts row-counts-pill");
  expect(counts().map((c) => c.label)).toEqual(["2 active subagent(s)", "1 background process(es)"]);
  act(() => fakeUseDeck.setState({ config: { autoResumeQuota: false, countBadgeStyle: "glyph" } }));
  renderRow(session({ backgroundCounts: { subagents: 2, shells: 1 } }));
  expect(row().querySelector(".row-counts")!.className).toBe("row-counts");
});
