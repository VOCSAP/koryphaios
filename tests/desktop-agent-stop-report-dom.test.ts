// Mounts the real StopReportModal against the shipped English dictionary and
// reads what the operator sees for each injection refusal reason.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness";
import type { StopOutcome, StopReport } from "../desktop/src/shared/types";
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

const EN = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "desktop", "locales", "en.json"), "utf-8"),
) as Record<string, string>;
mockStore({ useDeck: create(() => ({ dict: EN })), ...storeMockStubs });

const { AgentStopControls, StopReportModal } = await import("../desktop/src/renderer/src/components/AgentStopControls.tsx");
const { translate } = await import("../desktop/src/renderer/src/i18n.ts");
const t = (key: string, params?: Record<string, string | number>): string => translate(EN, key, params);

const REFUSALS = ["screen-unavailable", "refused-modal", "needs-attention", "rate-limited"] as const;

function outcome(id: string, result: StopOutcome["result"], peerId: string | null = id): StopOutcome {
  return { id: `${id}-tile-0000`, peerId, result };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(report: StopReport): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(StopReportModal, {
        report,
        failure: null,
        t,
        onEscalate: () => {},
        onClose: () => {},
      }),
    );
  });
}

function refusalBoxes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-refusal]")];
}

test("each refusal reason renders its own box, title, note and tally line", async () => {
  await mount({ mode: "soft", outcomes: REFUSALS.map((r) => outcome(r, r)) });

  const boxes = refusalBoxes();
  expect(boxes.map((b) => b.dataset.refusal)).toEqual([...REFUSALS]);
  const titles = boxes.map((b) => b.querySelector("h3")?.textContent ?? "");
  const notes = boxes.map((b) => b.querySelector(".rm-stop-note")?.textContent ?? "");
  for (const text of [...titles, ...notes]) {
    expect(text.startsWith("roadmap."), `untranslated key rendered: ${text}`).toBe(false);
  }
  expect(new Set(titles).size, "two refusal reasons share one title").toBe(REFUSALS.length);
  expect(new Set(notes).size, "two refusal reasons share one note").toBe(REFUSALS.length);

  const tally = [...document.querySelectorAll(".rm-stop-tally li")].map((li) => li.textContent ?? "");
  expect(new Set(tally).size, "two refusal reasons share one tally line").toBe(REFUSALS.length);
  for (const line of tally) expect(line.startsWith("1 agent(s) not stopped")).toBe(true);
});

test("only the modal refusal speaks of an open dialog", async () => {
  await mount({ mode: "pause", outcomes: REFUSALS.map((r) => outcome(r, r)) });

  for (const box of refusalBoxes()) {
    const mentionsDialog = /dialog/i.test(box.textContent ?? "");
    expect(mentionsDialog, `${box.dataset.refusal} box mentions a dialog`).toBe(box.dataset.refusal === "refused-modal");
  }
  const tally = document.querySelector(".rm-stop-tally")?.textContent ?? "";
  expect(tally.match(/dialog/gi)?.length ?? 0).toBe(1);
  const hint = [...document.querySelectorAll(":scope .modal > .rm-stop-note")].map((p) => p.textContent).join(" ");
  expect(hint).not.toMatch(/dialog/i);
});

test("the report escapes its host, so no column-head text style reaches it", async () => {
  container.style.textTransform = "uppercase";
  container.style.letterSpacing = "0.06em";
  await mount({ mode: "soft", outcomes: [outcome("dev-2", "needs-attention")] });

  const modal = document.querySelector<HTMLElement>(".rm-stop-report");
  expect(modal, "report not rendered").not.toBeNull();
  expect(container.contains(modal), "report rendered inside its host").toBe(false);
  expect(modal!.closest(".modal-backdrop")?.parentElement).toBe(document.body);
  const note = modal!.querySelector<HTMLElement>(".rm-stop-note")!;
  expect(getComputedStyle(note).textTransform).not.toBe("uppercase");
});

test("the stop confirm dialog also escapes the column head it is launched from", async () => {
  container.style.textTransform = "uppercase";
  (window as unknown as { api: unknown }).api = {
    agentsStopState: async () => ({ live: 2, busy: 1, unknown: 0, paused: 0, parkedCards: 0 }),
    agentsStop: async () => ({ mode: "pause", outcomes: [] }),
    reportError: () => {},
  };
  await act(async () => {
    root.render(React.createElement(AgentStopControls, { t }));
  });
  const pause = container.querySelector<HTMLButtonElement>(`button[aria-label="${t("roadmap.stop.pause")}"]`);
  expect(pause?.disabled, "pause button missing or disabled").toBe(false);
  await act(async () => pause!.click());

  const confirm = document.querySelector<HTMLElement>(".modal-confirm");
  expect(confirm, "confirm dialog not rendered").not.toBeNull();
  expect(container.contains(confirm), "confirm dialog rendered inside its host").toBe(false);
  expect(confirm!.closest(".modal-backdrop")?.parentElement).toBe(document.body);
  expect(getComputedStyle(confirm!.querySelector("h2")!).textTransform).not.toBe("uppercase");
});

test("tiles are grouped under their own reason and a refused tile stays escalable", async () => {
  await mount({
    mode: "soft",
    outcomes: [
      outcome("lead-1", "rate-limited"),
      outcome("dev-2", "needs-attention"),
      outcome("dev-3", "rate-limited", null),
      outcome("rev-4", "busy-timeout"),
    ],
  });

  const boxes = refusalBoxes();
  expect(boxes.map((b) => b.dataset.refusal)).toEqual(["needs-attention", "rate-limited"]);
  const peers = (b: HTMLElement): string[] =>
    [...b.querySelectorAll(".rm-stop-peer")].map((s) => s.textContent ?? "");
  expect(peers(boxes[0]!)).toEqual(["dev-2"]);
  expect(peers(boxes[1]!)).toEqual(["lead-1", t("roadmap.stop.noPeer")]);
  expect(document.querySelector(".modal-actions .danger")?.textContent).toBe(t("roadmap.stop.hard"));
});
