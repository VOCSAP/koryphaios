import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import type { RoadmapQuery } from "../desktop/src/shared/types.ts";

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");

const { RoadmapFilterChips } = await import(
  "../desktop/src/renderer/src/components/RoadmapFilterChips"
);

function t(key: string): string {
  return key;
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

function mount(): void {
  act(() => {
    root.render(
      React.createElement(RoadmapFilterChips, {
        criteria,
        setCriteria: (next: RoadmapQuery) => {
          setCriteriaCalls.push(next);
          criteria = next;
        },
        includeArchived: false,
        setIncludeArchived: () => {},
        hideInactive: false,
        setHideInactive: () => {},
        hiddenInactiveCount: 0,
        t
      })
    );
  });
}

/** The permanent hide-inactive toggle is a chip too; only removable ones count. */
function chipLabels(): string[] {
  return [...container.querySelectorAll(".rm-filter-chip:not(.rm-filter-chip-toggle)")]
    .map((el) => (el.querySelector(".rm-filter-chip-label")?.textContent ?? "").trim())
    .filter((label) => label !== "");
}

function clickChip(label: string): void {
  const chip = [...container.querySelectorAll(".rm-filter-chip")].find(
    (el) => (el.querySelector(".rm-filter-chip-label")?.textContent ?? "").trim() === label
  ) as HTMLButtonElement | undefined;
  if (!chip) throw new Error(`no chip rendered for "${label}"`);
  act(() => {
    chip.click();
  });
}

test("each selected triage role gets its own dimension-prefixed chip", () => {
  criteria = { triages: ["ready-for-agent", "needs-info"] };
  mount();
  expect(
    chipLabels(),
    "an active triage filter must be visible and removable without reopening the panel"
  ).toEqual([
    "roadmap.filter.triage: roadmap.triage.ready-for-agent",
    "roadmap.filter.triage: roadmap.triage.needs-info"
  ]);
});

test("removing one triage chip leaves the other role filtering", () => {
  criteria = { triages: ["ready-for-agent", "needs-info"] };
  mount();
  clickChip("roadmap.filter.triage: roadmap.triage.ready-for-agent");
  expect(setCriteriaCalls, "one click must write the criteria once").toHaveLength(1);
  expect(
    setCriteriaCalls[0]!.triages,
    "removing one value of a dimension must not clear the whole dimension"
  ).toEqual(["needs-info"]);
});

test("removing the last triage chip drops the key instead of leaving an empty array", () => {
  criteria = { triages: ["wontfix"] };
  mount();
  clickChip("roadmap.filter.triage: roadmap.triage.wontfix");
  expect(
    setCriteriaCalls[0]!.triages,
    "an emptied dimension is undefined here, so no request carries a dead filter key"
  ).toBeUndefined();
});

test("clear-all takes the triage filter with it", () => {
  criteria = { triages: ["ready-for-agent"] };
  mount();
  const clear = container.querySelector(".rm-filter-chip-clear") as HTMLButtonElement | null;
  if (!clear) throw new Error("no clear-all chip rendered while a filter was active");
  act(() => {
    clear.click();
  });
  expect(
    setCriteriaCalls[0]!.triages,
    "a dimension the clear-all forgot would survive a gesture that claims to reset everything"
  ).toBeUndefined();
});
