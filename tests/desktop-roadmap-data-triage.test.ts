import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import * as sharedWorkflow from "../desktop/src/shared/workflow.ts";
import type { RoadmapItem, RoadmapQuery } from "../desktop/src/shared/types.ts";

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");

// '@shared/workflow' is a tsconfig-only alias that bun does not resolve from the
// repo root; the real module is re-exported here rather than stubbed so the
// queue branding under test is the shipped one.
mock.module("@shared/workflow", () => sharedWorkflow);

const { useRoadmapData } = await import("../desktop/src/renderer/src/roadmap-data");

function item(patch: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: "card-a",
    project_key: "github.com/vocsap/x",
    kind: "feature",
    title: "a card",
    description: "",
    rationale: "",
    context: "",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "planned",
    triage: null,
    tags: [],
    depends_on: [],
    created_by: "agent-a",
    updated_by: "agent-a",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    deleted_at: null,
    queue: null,
    directive: null,
    target_peer_ids: [],
    locked: false,
    locked_by: null,
    locked_at: null,
    locked_group: null,
    inactive: false,
    sync_state: "clean",
    lock_scope: null,
    lock_contested_by: [],
    ...patch
  };
}

const UNFILTERED = [item({ id: "unfiltered-1" }), item({ id: "unfiltered-2" })];

interface SearchCall {
  query: RoadmapQuery;
  resolve: (items: RoadmapItem[]) => void;
  reject: (e: Error) => void;
}

let calls: SearchCall[] = [];
/** Queries carrying no dimension: the hook's unfiltered poll, answered at once. */
function isPollQuery(q: RoadmapQuery): boolean {
  return q.triages === undefined && q.kinds === undefined && q.q === undefined;
}

function installApi(): void {
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    roadmapSearch: (query: RoadmapQuery) => {
      if (isPollQuery(query)) {
        return Promise.resolve({ items: UNFILTERED, facets: null });
      }
      return new Promise((resolvePromise, rejectPromise) => {
        calls.push({
          query,
          resolve: (items) => resolvePromise({ items, facets: null }),
          reject: (e) => rejectPromise(e)
        });
      });
    }
  };
}

/** The hook's live return value, refreshed on every render. */
let hook: ReturnType<typeof useRoadmapData>;

function Harness(): React.JSX.Element {
  hook = useRoadmapData({ facets: false });
  return React.createElement(
    "div",
    null,
    hook.board.map((i) => i.id).join(",")
  );
}

let container: HTMLDivElement;
let root: Root;

/** Real timers, not fake ones: the defect under test lives in the window
 *  between a fired debounce and a settled promise, which a fake clock skips. */
const DEBOUNCE_WAIT_MS = 320;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  calls = [];
  installApi();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    // StrictMode, because production mounts under it and it double-invokes
    // effects: the cleanup/effect ordering the superseded flag relies on is
    // only really exercised here.
    root.render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function setCriteria(next: RoadmapQuery): Promise<void> {
  await act(async () => {
    hook.setCriteria(next);
  });
}

async function settleDebounce(): Promise<void> {
  await act(async () => {
    await sleep(DEBOUNCE_WAIT_MS);
  });
}

test("two selected roles reach the service call as one triages array", async () => {
  await setCriteria({ triages: ["ready-for-agent", "needs-info"] });
  await settleDebounce();
  expect(calls, "the debounced run must have issued exactly one filtering call").toHaveLength(1);
  expect(
    calls[0]!.query.triages,
    "both selected roles must travel in the request the broker filters on"
  ).toEqual(["ready-for-agent", "needs-info"]);
});

test("an empty triages array issues no filtering call at all", async () => {
  await setCriteria({ triages: [] });
  await settleDebounce();
  expect(
    calls,
    "an empty array is not a criterion: deselecting everything must reach the network as nothing"
  ).toHaveLength(0);
});

test("the board keeps a card the criteria exclude, because the renderer never selects", async () => {
  await setCriteria({ triages: ["ready-for-agent"] });
  await settleDebounce();
  const offCriteria = item({ id: "off-criteria", triage: "wontfix" });
  await act(async () => {
    calls[0]!.resolve([offCriteria]);
    await sleep(0);
  });
  expect(
    hook.board.map((i) => i.id),
    "whatever the broker answers is the board verbatim; a renderer-side filter would drop this card"
  ).toEqual(["off-criteria"]);
});

test("a response that lands after the filter was cleared must not reinstate a filtered board", async () => {
  await setCriteria({ triages: ["ready-for-agent"] });
  await settleDebounce();
  expect(calls, "the filtering call must be in flight before the filter is cleared").toHaveLength(1);

  await setCriteria({ triages: [] });
  expect(
    hook.board.map((i) => i.id),
    "clearing the filter must put the unfiltered set back immediately"
  ).toEqual(["unfiltered-1", "unfiltered-2"]);

  await act(async () => {
    calls[0]!.resolve([item({ id: "stale-filtered" })]);
    await sleep(0);
  });
  expect(
    hook.board.map((i) => i.id),
    "a superseded request must not overwrite the board the operator is already looking at"
  ).toEqual(["unfiltered-1", "unfiltered-2"]);
});

test("a superseded request that REJECTS raises no error on a filter nobody is waiting for", async () => {
  await setCriteria({ triages: ["ready-for-agent"] });
  await settleDebounce();
  await setCriteria({ triages: [] });

  await act(async () => {
    calls[0]!.reject(new Error("request abandoned"));
    await sleep(0);
  });
  expect(
    hook.error,
    "the failure of a request the hook itself abandoned must never reach the operator's banner"
  ).toBeNull();
});
