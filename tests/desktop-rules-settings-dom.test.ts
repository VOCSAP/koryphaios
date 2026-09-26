// Settings > Rules (TTSR, docs/DESIGN-TTSR-RULES.md 4.5): the table renders
// the three sources with their identity badge, a toggle flips the row's OWN
// toggleKey (never a re-derived one), a pending repo project surfaces
// Approuver wired to its file's hash, a Kory rule opens read-only (no Save),
// and saving an edited rule rebuilds the WHOLE target file rather than
// PATCHing the one rule.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased, no runtime resolution
import { mockStore, storeMockStubs } from "./_store-mock";
import type {
  TtsrApproveResult,
  TtsrRulesList,
  TtsrSaveResult,
  TtsrTestResult,
} from "../desktop/src/shared/types.ts";
import type { TtsrRule } from "../desktop/src/shared/ttsr-types.ts";

const { act, React, createRoot, create } = await import(
  "../desktop/tests-support/react-test-harness"
);

// RuleEditorModal.tsx imports TTSR_EVENTS/TTSR_MODES/TTSR_TOOLS as VALUES from
// the tsconfig-only `@shared/*` alias, which bun test does not resolve from
// the repo root. Re-exporting the REAL module (already imported above by a
// relative path for the fixtures) keeps the mount running the same
// enumerations the app ships.
const realTtsrTypes = await import("../desktop/src/shared/ttsr-types.ts");
mock.module("@shared/ttsr-types", () => realTtsrTypes);

interface FakeDeckState {
  dict: Record<string, string>;
}

function initialFakeState(): FakeDeckState {
  return { dict: {} };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());

mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });

const { RulesSettings } = await import(
  "../desktop/src/renderer/src/components/RulesSettings.tsx"
);

function koryRule(): TtsrRule {
  return {
    id: "empty-catch",
    event: "PreToolUse",
    tools: ["Edit", "Write"],
    field: "added",
    pattern: "catch\\s*\\(\\s*\\)\\s*\\{\\s*\\}",
    mode: "deny",
    message: "Never swallow an error silently: add a trace.",
  };
}

function globalRule(): TtsrRule {
  return {
    id: "no-console-log",
    event: "PreToolUse",
    tools: ["Edit"],
    field: "added",
    pattern: "console\\.log\\(",
    mode: "warn",
    message: "Use the layer's log sink instead of console.log.",
  };
}

function repoRule(): TtsrRule {
  return {
    id: "no-emoji-ui",
    event: "PreToolUse",
    tools: ["Edit", "Write"],
    field: "added",
    paths: ["desktop/src/renderer/**"],
    pattern: "\\p{Extended_Pictographic}",
    flags: "u",
    mode: "deny",
    message: "No emoji in the Deck UI.",
  };
}

function baseList(projectFileStatus: "approved" | "pending" | "invalid" | "absent" = "approved"): TtsrRulesList {
  const repoRow = {
    qualifiedId: "repo/no-emoji-ui",
    source: "repo" as const,
    toggleKey: "repo:/proj:no-emoji-ui",
    enabled: true,
    active: projectFileStatus === "approved",
    rule: repoRule(),
  };
  return {
    kory: [
      {
        qualifiedId: "kory/empty-catch",
        source: "kory",
        toggleKey: "kory:empty-catch",
        enabled: true,
        active: true,
        rule: koryRule(),
      },
    ],
    global: {
      file: {
        path: "/config/ttsr-rules.json",
        status: "valid",
        hash: "globalhash",
        errors: [],
        text: JSON.stringify({ version: 1, rules: [globalRule()] }, null, 2),
      },
      rules: [
        {
          qualifiedId: "user/no-console-log",
          source: "user",
          toggleKey: "user:no-console-log",
          enabled: true,
          active: true,
          rule: globalRule(),
        },
      ],
    },
    projects:
      projectFileStatus === "absent"
        ? [
            {
              projectDir: "/proj",
              projectKey: "proj-key",
              sessionIds: ["s1"],
              file: { path: "/proj/.claude/claude-peers/rules.json", status: "absent", hash: null, errors: [], text: null },
              rules: [],
            },
          ]
        : [
            {
              projectDir: "/proj",
              projectKey: "proj-key",
              sessionIds: ["s1"],
              file: {
                path: "/proj/.claude/claude-peers/rules.json",
                status: projectFileStatus,
                hash: projectFileStatus === "invalid" ? null : "repohash",
                errors: projectFileStatus === "invalid" ? ["rules[0]: pattern: does not compile"] : [],
                text: JSON.stringify({ version: 1, rules: [repoRule()] }, null, 2),
              },
              rules: projectFileStatus === "invalid" ? [] : [repoRow],
            },
          ],
  };
}

let setEnabledCalls: Array<[string, boolean]> = [];
let approveCalls: Array<[string, string]> = [];
let saveGlobalCalls: string[] = [];
let saveRepoCalls: Array<[string, string]> = [];
let currentList: TtsrRulesList = baseList();
let approveResult: TtsrApproveResult = { ok: true };
let saveResult: TtsrSaveResult = { ok: true, hash: "newhash" };
let reportedErrors: Array<[string, string]> = [];

function installApi(): void {
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {
    rulesList: () => Promise.resolve(currentList),
    rulesSetEnabled: (toggleKey: string, enabled: boolean) => {
      setEnabledCalls.push([toggleKey, enabled]);
      return Promise.resolve(currentList);
    },
    rulesSaveGlobal: (text: string) => {
      saveGlobalCalls.push(text);
      return Promise.resolve(saveResult);
    },
    rulesSaveRepo: (projectDir: string, text: string) => {
      saveRepoCalls.push([projectDir, text]);
      return Promise.resolve(saveResult);
    },
    rulesApproveRepo: (projectDir: string, hash: string) => {
      approveCalls.push([projectDir, hash]);
      return Promise.resolve(approveResult);
    },
    rulesTest: (): Promise<TtsrTestResult> =>
      Promise.resolve({ ok: true, timedOut: false, matched: false, match: null, pathMatched: null }),
    onRulesChanged: () => () => {},
    reportError: (scope: string, msg: string) => {
      reportedErrors.push([scope, msg]);
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setEnabledCalls = [];
  approveCalls = [];
  saveGlobalCalls = [];
  saveRepoCalls = [];
  reportedErrors = [];
  currentList = baseList();
  approveResult = { ok: true };
  saveResult = { ok: true, hash: "newhash" };
  fakeUseDeck.setState(initialFakeState(), true);
  installApi();
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

async function mount(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(RulesSettings));
    // rulesList() resolves on a microtask; let it flush.
    await Promise.resolve();
    await Promise.resolve();
  });
}

test("rows render per source with their identity badge", async () => {
  await mount();
  expect(container.textContent).toContain("kory/empty-catch");
  expect(container.textContent).toContain("rules.sourceKory");
  expect(container.textContent).toContain("user/no-console-log");
  expect(container.textContent).toContain("rules.sourceGlobal");
  expect(container.textContent).toContain("repo/no-emoji-ui");
  expect(container.textContent).toContain("rules.sourceRepo");
});

test("toggling a row calls rulesSetEnabled with THAT row's toggleKey, not a re-derived one", async () => {
  await mount();
  const checkboxes = [...container.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
  expect(checkboxes.length).toBeGreaterThan(0);
  const koryCheckbox = checkboxes[0]!;
  expect(koryCheckbox.checked).toBe(true);
  await act(async () => {
    koryCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(setEnabledCalls).toEqual([["kory:empty-catch", false]]);
});

test("a pending repo project shows Approuver and calls rulesApproveRepo with the file's OWN hash", async () => {
  currentList = baseList("pending");
  await mount();
  expect(container.textContent).toContain("rules.badgePending");
  const buttons = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  const approveBtn = buttons.find((b) => b.textContent === "rules.approve");
  expect(approveBtn).not.toBeUndefined();
  act(() => {
    approveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(approveCalls).toEqual([["/proj", "repohash"]]);
});

test("a stale approval reloads the list and tells the operator, without reporting it as an error", async () => {
  currentList = baseList("pending");
  approveResult = { ok: false, reason: "stale" };
  await mount();
  const buttons = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  const approveBtn = buttons.find((b) => b.textContent === "rules.approve")!;
  act(() => {
    approveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).toContain("rules.approveStale");
  expect(reportedErrors).toEqual([]);
});

test("a Kory rule opens read-only: no Save button, and the pattern input cannot be edited", async () => {
  await mount();
  const buttons = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  const viewBtn = buttons.find((b) => b.textContent === "rules.view")!;
  act(() => {
    viewBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.textContent).toContain("rules.modalTitleView");
  const saveBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "common.save");
  expect(saveBtn).toBeUndefined();
  const patternInput = container.querySelector('input[readonly]') as HTMLInputElement | null;
  expect(patternInput).not.toBeNull();
});

test("saving an edited global rule rebuilds the WHOLE file, keeping other rules and the id, changing only the edited field", async () => {
  await mount();
  const buttons = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  const editBtn = buttons.find((b) => b.textContent === "rules.edit")!;
  act(() => {
    editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(container.textContent).toContain("rules.modalTitleEdit");

  const messageArea = [...container.querySelectorAll("textarea")].find(
    (ta) => ta.value === globalRule().message
  ) as HTMLTextAreaElement;
  expect(messageArea).not.toBeUndefined();
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!nativeSetter) throw new Error("textarea has no native value setter");
  act(() => {
    nativeSetter.call(messageArea, "Use the shared log sink, never console.log.");
    messageArea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const saveBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "common.save")!;
  act(() => {
    saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(saveGlobalCalls.length).toBe(1);
  const written = JSON.parse(saveGlobalCalls[0]!) as { version: number; rules: TtsrRule[] };
  expect(written.version).toBe(1);
  expect(written.rules).toHaveLength(1);
  expect(written.rules[0]!.id).toBe("no-console-log");
  expect(written.rules[0]!.message).toBe("Use the shared log sink, never console.log.");
  // Untouched fields survive the rebuild verbatim.
  expect(written.rules[0]!.pattern).toBe(globalRule().pattern);
});
