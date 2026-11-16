import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import * as sharedWorkflow from "../desktop/src/shared/workflow.ts";
import * as sharedTypes from "../desktop/src/shared/types.ts";
import type { RoadmapFacets, RoadmapQuery } from "../desktop/src/shared/types.ts";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

// '@shared/*' is a tsconfig-only alias that bun does not resolve from the repo
// root; the real modules are re-exported rather than stubbed, so the role list
// and the queue branding under test are the shipped ones.
mock.module("@shared/workflow", () => sharedWorkflow);
mock.module("@shared/types", () => sharedTypes);

const fakeUseDeck = create<{ showToast: (key: string) => void }>(() => ({
  showToast: () => {}
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { RoadmapFilterPanel } = await import(
  "../desktop/src/renderer/src/components/RoadmapFilterPanel"
);

// A key whose real English value carries {count}, so an assertion on the
// rendered text pins the arithmetic and not the key name.
const UNTRIAGED_TEMPLATE = "Never triaged: {count}";
const DICT: Record<string, string> = { "roadmap.filter.untriaged": UNTRIAGED_TEMPLATE };

function t(key: string, params?: Record<string, string | number>): string {
  const template = DICT[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  );
}

const ROLES = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix"
] as const;

function facetsWith(triageCounts: Partial<Record<string, number>>, referenceTotal: number): RoadmapFacets {
  return {
    kind: [],
    priority: [],
    effort: [],
    value: [],
    status: [],
    triage: ROLES.map((value) => ({ value, count: triageCounts[value] ?? 0 })),
    tags: [],
    reference_total: referenceTotal
  };
}

let container: HTMLDivElement;
let root: Root;
let criteria: RoadmapQuery;
let setCriteriaCalls: RoadmapQuery[];

beforeEach(() => {
  criteria = {};
  setCriteriaCalls = [];
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

function mount(facets: RoadmapFacets | null): void {
  act(() => {
    root.render(
      React.createElement(RoadmapFilterPanel, {
        criteria,
        setCriteria: (next: RoadmapQuery) => {
          setCriteriaCalls.push(next);
          criteria = next;
        },
        facets,
        includeArchived: false,
        setIncludeArchived: () => {},
        folded: false,
        onToggleFold: () => {},
        t
      })
    );
  });
}

/** The panel renders six sections; every query below is scoped to this one, or
 *  it would answer for whichever dimension happens to sit first in the DOM. */
function triageSection(): HTMLElement {
  const sections = [...container.querySelectorAll(".rm-filter-section")] as HTMLElement[];
  const section = sections.find(
    (s) =>
      (s.querySelector(".rm-filter-section-toggle")?.textContent ?? "").trim() ===
      "roadmap.filter.triage"
  );
  if (!section) throw new Error("the panel rendered no Triage section");
  return section;
}

function triageRow(label: string): HTMLButtonElement {
  const rows = [...triageSection().querySelectorAll(".rm-filter-value")] as HTMLButtonElement[];
  const row = rows.find((r) => r.textContent?.includes(label));
  if (!row) throw new Error(`the Triage section has no row for "${label}"`);
  return row;
}

function untriagedLine(): string | null {
  return triageSection().querySelector(".rm-filter-section-note")?.textContent ?? null;
}

test("clicking a triage role puts exactly that role in the criteria handed upwards", () => {
  mount(facetsWith({ "ready-for-agent": 2 }, 5));
  act(() => {
    triageRow("roadmap.triage.ready-for-agent").click();
  });
  expect(setCriteriaCalls, "one click must produce exactly one criteria write").toHaveLength(1);
  expect(
    setCriteriaCalls[0]!.triages,
    "the role must travel as a triages array, the shape the broker filters on"
  ).toEqual(["ready-for-agent"]);
});

test("deselecting the only active role empties the array rather than dropping the key", () => {
  criteria = { triages: ["ready-for-agent"] };
  mount(facetsWith({ "ready-for-agent": 2 }, 5));
  act(() => {
    triageRow("roadmap.triage.ready-for-agent").click();
  });
  expect(setCriteriaCalls).toHaveLength(1);
  expect(
    setCriteriaCalls[0]!.triages,
    "an emptied dimension stays an empty array, which both the hook and the broker read as no filter"
  ).toEqual([]);
});

test("the untriaged line states reference_total minus the five buckets", () => {
  mount(facetsWith({ "ready-for-agent": 2, "needs-info": 1 }, 5));
  expect(
    untriagedLine(),
    "5 cards in the reference set and 3 of them triaged leaves 2 that never were"
  ).toBe("Never triaged: 2");
});

test("the untriaged line clamps at zero instead of printing a negative population", () => {
  mount(facetsWith({ "ready-for-agent": 4, "needs-info": 4 }, 3));
  expect(
    untriagedLine(),
    "a reference total below the counts it was computed with must not yield a negative"
  ).toBe("Never triaged: 0");
});

test("untriaged is never a selectable row, only the five roles are", () => {
  mount(facetsWith({ "ready-for-agent": 2 }, 5));
  const labels = [...triageSection().querySelectorAll(".rm-filter-value-label")].map((el) =>
    (el.textContent ?? "").trim()
  );
  expect(
    labels,
    "a sixth checkbox would be a control the broker answers with a 400"
  ).toEqual(ROLES.map((r) => `roadmap.triage.${r}`));
});

test("facets:null renders no untriaged line at all, never a false zero", () => {
  mount(null);
  expect(
    untriagedLine(),
    "with no counters at all the remainder is unknown, and an unknown number is not displayed"
  ).toBeNull();
});

const { todayRange } = await import("../desktop/src/renderer/src/roadmap-date-range");

async function render(folded = false): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(RoadmapFilterPanel, {
        criteria,
        setCriteria: (next: RoadmapQuery) => {
          setCriteriaCalls.push(next);
          criteria = next;
        },
        facets: null,
        includeArchived: false,
        setIncludeArchived: () => {},
        folded,
        onToggleFold: () => {},
        t
      })
    );
  });
}

function dateSection(): HTMLElement {
  const sections = [...container.querySelectorAll(".rm-filter-section")] as HTMLElement[];
  const section = sections.find(
    (s) => (s.querySelector(".rm-filter-section-toggle")?.textContent ?? "").trim() === "roadmap.filter.date"
  );
  if (!section) throw new Error("the panel rendered no Date section");
  return section;
}

function radio(value: string): HTMLInputElement {
  const el = dateSection().querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`the Date section has no "${value}" choice`);
  return el;
}

function editorToggle(): HTMLButtonElement {
  const el = dateSection().querySelector("button[aria-expanded]") as HTMLButtonElement | null;
  if (!el) throw new Error("the Date section has no custom range toggle");
  return el;
}

function checkedPeriods(): string[] {
  return [...dateSection().querySelectorAll('input[type="radio"]:checked')]
    .map((el) => (el as HTMLInputElement).value)
    .filter((v) => v !== "created" && v !== "updated");
}

function dateInputs(): HTMLInputElement[] {
  return [...dateSection().querySelectorAll(".rm-date-input")] as HTMLInputElement[];
}

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

async function applyButton(): Promise<HTMLButtonElement> {
  const b = dateSection().querySelector(".rm-date-apply") as HTMLButtonElement | null;
  if (!b) throw new Error("the custom range has no Apply button");
  return b;
}

test("a preset on the Modified axis sends that axis with a rolling duration", async () => {
  await render();
  await click(radio("updated"));
  await click(radio("7d"));
  expect(setCriteriaCalls, "one preset click is one criteria write").toHaveLength(1);
  expect(
    setCriteriaCalls[0]!.date,
    "the chosen axis must reach the filter, and 7 days is a duration, not a civil range"
  ).toEqual({ field: "updated", since: "7d" });
});

test("Today sends the civil day of the local zone, both bounds", async () => {
  await render();
  await click(radio("today"));
  const expected = todayRange(new Date());
  expect(setCriteriaCalls[0]!.date, "Today is [local midnight, next local midnight)").toEqual({
    field: "created",
    ...expected,
  });
});

test("a custom range converts its included last day into the next local midnight", async () => {
  await render();
  await click(editorToggle());
  const [from, through] = dateInputs();
  await typeInto(from!, "2026-11-01");
  await typeInto(through!, "2026-11-03");
  await click(await applyButton());
  expect(setCriteriaCalls, "Apply on a valid range is one criteria write").toHaveLength(1);
  expect(setCriteriaCalls[0]!.date, "the typed days travel as instants, the last one included").toEqual({
    field: "created",
    since: new Date(2026, 10, 1).toISOString(),
    before: new Date(2026, 10, 4).toISOString(),
  });
});

test("an invalid range is refused on screen and never applied", async () => {
  await render();
  await click(editorToggle());
  const [from, through] = dateInputs();
  await typeInto(from!, "2026-11-10");
  await typeInto(through!, "2026-11-09");
  await click(await applyButton());
  expect(setCriteriaCalls, "a reversed range must not reach the criteria").toHaveLength(0);
  expect(
    dateSection().querySelector(".field-error")?.textContent,
    "the refusal names its reason instead of failing silently"
  ).toBe("roadmap.filter.dateError.order");
  expect(from!.getAttribute("aria-invalid"), "the fields are marked invalid").toBe("true");
});

test("the typed range survives folding its section and folding the whole panel", async () => {
  await render();
  await click(editorToggle());
  await typeInto(dateInputs()[0]!, "2026-11-01");

  const toggle = dateSection().querySelector(".rm-filter-section-toggle") as HTMLButtonElement;
  await click(toggle);
  expect(dateInputs(), "a folded section shows no field").toHaveLength(0);
  await click(toggle);
  expect(dateInputs()[0]!.value, "unfolding the section gives back what was typed").toBe("2026-11-01");

  await render(true);
  expect(container.querySelector(".rm-date-input"), "a folded panel renders no date field").toBeNull();
  await render(false);
  expect(dateInputs()[0]!.value, "unfolding the panel gives back what was typed").toBe("2026-11-01");
});

test("with Today applied, opening the range editor keeps Today checked until Apply", async () => {
  criteria = { date: { field: "updated", ...todayRange(new Date()) } };
  await render();
  await click(editorToggle());
  const [from, through] = dateInputs();
  await typeInto(from!, "2026-11-01");
  await typeInto(through!, "2026-11-03");
  expect(checkedPeriods(), "a draft is not a filter: the checked period is the one still applied").toEqual(["today"]);
  expect(editorToggle().className, "the range is not the applied filter yet").not.toContain("is-on");

  await click(await applyButton());
  await render();
  expect(checkedPeriods(), "once applied, no preset is checked").toEqual([]);
  expect(editorToggle().className, "the applied range is marked on its own control").toContain("is-on");
});

test("removing the date from outside the panel closes the range editor and drops the draft", async () => {
  await render();
  await click(editorToggle());
  const [from, through] = dateInputs();
  await typeInto(from!, "2026-11-01");
  await typeInto(through!, "2026-11-03");
  await click(await applyButton());
  await render();

  criteria = {};
  await render();
  expect(dateInputs(), "with no date filter left, no editor stays open").toHaveLength(0);
  expect(editorToggle().getAttribute("aria-expanded"), "the toggle says the editor is closed").toBe("false");
  expect(checkedPeriods(), "nothing is checked when nothing filters").toEqual([]);
  await click(editorToggle());
  expect(
    dateInputs().map((i) => i.value),
    "reopening starts from an empty draft, not from the removed range"
  ).toEqual(["", ""]);
});

test("a triage dimension short of a role states no remainder at all", () => {
  const facets = facetsWith({ "ready-for-agent": 2 }, 5);
  facets.triage = facets.triage.filter((b) => b.value !== "wontfix");
  mount(facets);
  expect(
    untriagedLine(),
    "subtracting an incomplete sum would invent untriaged cards, so the line must not render"
  ).toBeNull();
});
