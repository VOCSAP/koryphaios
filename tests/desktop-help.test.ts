import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { test, expect, afterAll, mock } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { mockStore, storeMockStubs } from "./_store-mock";

GlobalRegistrator.register();
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHelpSystemPrompt,
  buildHelpPrompt,
  runHelp,
  sanitizeHelpSelection,
  HELP_SELECTION_TEXT_MAX,
  HELP_SYSTEM_PROMPT
} from "../desktop/src/main/help-assistant.ts";
import { buildAdapterCommand, buildClaudeHeadlessEnv } from "../desktop/src/main/model-adapters.ts";

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  await GlobalRegistrator.unregister();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-help-"));
  tmpDirs.push(d);
  return d;
}

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");
const fakeUseDeck = create<any>(() => ({
  dict: {},
  config: { helpButton: true, helpTarget: { cli: "claude", model: "" } },
  view: "home",
  updateConfig: () => undefined,
  showToast: () => undefined,
  helpSeed: null,
  clearHelpSeed: () => undefined
}));
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs });
const realModels = await import("../desktop/src/shared/models.ts");
mock.module("@shared/models", () => ({ ...realModels, targetLabel: () => "Claude" }));
const { HelpAssistant } = await import("../desktop/src/renderer/src/components/HelpAssistant");

// The default runners of the utility and graph inferences reach execFile only through runHelp, with no
// injectable runner: this spy observes their spawn options and delegates to the real execFile when unarmed.
type SpawnRecord = { file: string; args: readonly string[]; options: { env?: NodeJS.ProcessEnv } };
const realChildProcess = await import("node:child_process");
const realExecFile = realChildProcess.execFile;
let recordedSpawns: SpawnRecord[] | null = null;
mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFile: (...args: unknown[]) => {
    if (recordedSpawns === null) return (realExecFile as (...a: unknown[]) => unknown)(...args);
    const [file, fileArgs, options, callback] = args as [
      string,
      readonly string[],
      SpawnRecord["options"],
      (err: Error | null, stdout: string, stderr: string) => void
    ];
    recordedSpawns.push({ file, args: fileArgs, options });
    queueMicrotask(() => callback(null, "", ""));
    return undefined;
  }
}));
const { runUtilityInference } = await import("../desktop/src/main/utility-inference.ts");
const { runInference } = await import("../desktop/src/main/graph-engine.ts");

async function spawnsWithWitness(run: () => Promise<unknown>): Promise<SpawnRecord[]> {
  const previous = process.env.KORY_DEFAULT_RUNNER_WITNESS;
  process.env.KORY_DEFAULT_RUNNER_WITNESS = "inherited-secret";
  const spawns: SpawnRecord[] = [];
  recordedSpawns = spawns;
  try {
    await run();
    return spawns;
  } finally {
    recordedSpawns = null;
    if (previous === undefined) delete process.env.KORY_DEFAULT_RUNNER_WITNESS;
    else process.env.KORY_DEFAULT_RUNNER_WITNESS = previous;
  }
}

function expectAllowlistedSpawns(spawns: SpawnRecord[]): void {
  expect(spawns.map(({ args }) => args.some((arg) => arg.includes("auth status")))).toEqual([true, false]);
  for (const { options } of spawns) {
    expect(options.env, "an undefined env makes execFile inherit the whole process.env").toBeDefined();
    expect(options.env?.KORY_DEFAULT_RUNNER_WITNESS).toBeUndefined();
  }
}

// ----- code selection (PLAN GX7) -----

test("sanitizeHelpSelection validates, snake_cases and caps the payload", () => {
  const sel = sanitizeHelpSelection({
    file: "src/app.ts",
    startLine: 3,
    endLine: 7,
    text: "const x = 1"
  });
  expect(sel).toEqual({ file: "src/app.ts", start_line: 3, end_line: 7, text: "const x = 1" });

  const capped = sanitizeHelpSelection({
    file: "a.ts",
    startLine: 1,
    endLine: 2,
    text: "y".repeat(HELP_SELECTION_TEXT_MAX + 50)
  });
  expect(capped!.text.length).toBe(HELP_SELECTION_TEXT_MAX);

  // Malformed / hostile payloads degrade to null (question goes out bare).
  expect(sanitizeHelpSelection(undefined)).toBeNull();
  expect(sanitizeHelpSelection("nope")).toBeNull();
  expect(sanitizeHelpSelection({ file: "a", text: "   " })).toBeNull();
  expect(sanitizeHelpSelection({ file: 42, text: "x" })).toBeNull();
  // Non-numeric lines degrade to 1, they never break the call.
  expect(sanitizeHelpSelection({ file: "a", text: "x", startLine: "z" })!.start_line).toBe(1);
});

// ----- system prompt -----

test("system prompt embeds the code constant, the view and the snapshot", () => {
  const text = buildHelpSystemPrompt({ view: "roadmap", data: [{ id: "a1", title: "Item X" }] });
  expect(text).toContain(HELP_SYSTEM_PROMPT);
  expect(text).toContain("Active view: roadmap");
  expect(text).toContain("Item X");
  expect(HELP_SYSTEM_PROMPT).toContain("read-only");
});

test("a docsDir adds the reference-documentation section; absent otherwise", () => {
  const withDocs = buildHelpSystemPrompt({
    view: "agents",
    data: null,
    docsDir: "/opt/app/resources/docs"
  });
  expect(withDocs).toContain("## Reference documentation");
  expect(withDocs).toContain("/opt/app/resources/docs");
  expect(withDocs).toContain("README.md");

  const without = buildHelpSystemPrompt({ view: "agents", data: null });
  expect(without).not.toContain("## Reference documentation");
  expect(buildHelpSystemPrompt({ view: "agents", data: null, docsDir: "" })).not.toContain(
    "## Reference documentation"
  );
});

test("the claude adapter grants the docs dir via --add-dir (quoted), others unchanged", () => {
  const cmd = buildAdapterCommand({
    promptFile: "/tmp/q.md",
    contextFile: "/tmp/sys.md",
    target: { cli: "claude", model: "haiku" },
    addDir: "/opt/app/resources/docs",
    platform: "linux"
  });
  expect(cmd).toContain('--add-dir "/opt/app/resources/docs"');
  const bare = buildAdapterCommand({
    promptFile: "/tmp/q.md",
    contextFile: "/tmp/sys.md",
    target: { cli: "claude", model: "haiku" },
    platform: "linux"
  });
  expect(bare).not.toContain("--add-dir");
});

test("an oversized snapshot is truncated, never unbounded", () => {
  const text = buildHelpSystemPrompt({ view: "agents", data: { blob: "x".repeat(200_000) } });
  expect(text.length).toBeLessThan(70_000);
  expect(text).toContain("[snapshot truncated]");
});

// ----- transcript replay -----

test("prompt replays only the last 4 completed exchanges", () => {
  const transcript = Array.from({ length: 6 }, (_, i) => ({
    question: `q${i}`,
    answer: `a${i}`
  }));
  const p = buildHelpPrompt("new question", transcript);
  expect(p).not.toContain("q0");
  expect(p).not.toContain("q1");
  expect(p).toContain("q2");
  expect(p).toContain("a5");
  expect(p).toContain("new question");
  expect(buildHelpPrompt("solo", [])).toBe("solo");
});

// ----- runHelp against a fake claude binary -----

// The two tests below pin `platform: "linux"` and drive a `#!/bin/sh` fixture
// through `shell: "/bin/sh"` — they exercise the POSIX branch BY CONSTRUCTION
// and there is no /bin/sh to run them against on a Windows runner. The Windows
// command SHAPE is covered by the pure adapter tests (which pass an explicit
// platform), and the OS-agnostic runHelp contract by the two tests after them.
const posixOnly = process.platform === "win32" ? test.skip : test;

posixOnly("runHelp resolves the binary through the login shell and returns stdout", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  // The question now rides stdin (D5 extended — 07dc42c0), never a positional
  // arg: the fake binary reads it off its own stdin.
  writeFileSync(fake, '#!/bin/sh\nq="$(cat)"\necho "fake answer: $q"\n', "utf-8");
  chmodSync(fake, 0o755);
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "which item next?", "utf-8");

  const cmd = buildAdapterCommand({
    promptFile,
    contextFile: join(dir, "sys.md"),
    target: { cli: "claude", model: "haiku" },
    bin: fake,
    platform: "linux"
  });
  const out = await runHelp({ command: cmd, shell: "/bin/sh", cwd: dir });
  expect(out).toBe("fake answer: which item next?");
});

test("runHelp passes only its explicit environment to the headless command", async () => {
  const previous = process.env.KORY_TEST_FORBIDDEN;
  process.env.KORY_TEST_FORBIDDEN = "inherited-secret";
  try {
    const win = process.platform === "win32";
    // PowerShell stalls up to the test timeout on windows-latest under a two-variable env; the production allowlist is the env it really gets.
    const isolatedHome = win ? tmp() : "/isolated-home";
    const out = await runHelp({
      command: win
        ? 'if ($env:KORY_TEST_FORBIDDEN) { Write-Output "$env:USERPROFILE/$env:KORY_TEST_FORBIDDEN" } else { Write-Output "$env:USERPROFILE/missing" }'
        : 'printf "%s/%s" "$HOME" "${KORY_TEST_FORBIDDEN:-missing}"',
      shell: win ? "powershell.exe" : "/bin/sh",
      cwd: tmp(),
      env: win
        ? { ...buildClaudeHeadlessEnv(), USERPROFILE: isolatedHome }
        : { PATH: process.env.PATH, HOME: isolatedHome }
    });
    expect(out).toBe(`${isolatedHome}/missing`);
  } finally {
    if (previous === undefined) delete process.env.KORY_TEST_FORBIDDEN;
    else process.env.KORY_TEST_FORBIDDEN = previous;
  }
}, 30_000);

test("the default utility runner spawns Claude with the allowlisted environment only", async () => {
  const spawns = await spawnsWithWitness(() =>
    runUtilityInference(
      { stateDir: tmp(), shell: "", cwd: tmp() },
      { target: { cli: "claude", model: "" }, system: "system", prompt: "question", kind: "digest" }
    )
  );
  expectAllowlistedSpawns(spawns);
});

test("the default graph runner spawns Claude with the allowlisted environment only", async () => {
  const spawns = await spawnsWithWitness(() =>
    runInference(
      { stateDir: tmp(), shell: "", cwd: tmp() },
      {
        id: "g1",
        name: "g",
        nodes: [{ id: "q", type: "user", parents: [], text: "hello", x: 0, y: 0, createdAt: 1 }],
        createdAt: 1,
        updatedAt: 1
      },
      { nodeId: "q", targets: [{ cli: "claude", model: "" }], battle: false }
    )
  );
  expectAllowlistedSpawns(spawns);
});

posixOnly("runHelp surfaces a failing invocation as a rejected promise", async () => {
  const dir = tmp();
  const fake = join(dir, "claude");
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "boom" >&2\nexit 1\n', "utf-8");
  chmodSync(fake, 0o755);
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "q", "utf-8");
  const cmd = buildAdapterCommand({
    promptFile,
    contextFile: join(dir, "sys.md"),
    target: { cli: "claude", model: "haiku" },
    bin: fake,
    platform: "linux"
  });
  await expect(runHelp({ command: cmd, shell: "/bin/sh", cwd: dir })).rejects.toThrow(/boom/);
});

test("Help digest failure reports and toasts the direct action", async () => {
  const reports: string[][] = [];
  const toasts: unknown[][] = [];
  const hadApi = "api" in window;
  const previousApi = (window as any).api;
  const previousShowToast = fakeUseDeck.getState().showToast;
  (window as any).api = {
    askDigest: () => Promise.reject(new Error("offline")),
    reportError: (...args: string[]) => reports.push(args)
  };
  fakeUseDeck.setState({ showToast: (...args: unknown[]) => toasts.push(args) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(HelpAssistant));
    });
    await act(async () => {
      (container.querySelector(".help-fab") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector(".help-head .icon-btn") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(reports).toEqual([["help", "digest failed: offline"]]);
    expect(toasts[0]?.[1]).toBe("error");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (hadApi) (window as any).api = previousApi;
    else delete (window as any).api;
    fakeUseDeck.setState({ showToast: previousShowToast });
  }
});

// 30_000 because both spawn a process, and a spawn on the windows-latest runner
// costs one to two orders of magnitude more than on ubuntu.
test("runHelp strips its start marker and returns the command's stdout", async () => {
  const out = await runHelp({ command: "echo hello-from-help", shell: "", cwd: tmp() });
  expect(out).toBe("hello-from-help");
}, 30_000);

test("runHelp rejects when the command cannot run", async () => {
  await expect(
    runHelp({ command: "definitely-not-a-command-xyz", shell: "", cwd: tmp() })
  ).rejects.toThrow();
}, 30_000);

// ----- plan import prompt (PLAN C7, code constant like the help prompt) -----

import { composePlanImportPrompt } from "../desktop/src/main/import-plan.ts";

test("plan-import prompt embeds the file, the roadmap_add flow and the /exit", () => {
  const p = composePlanImportPrompt("/home/u/proj/PLAN-v0.4.md");
  expect(p).toContain("/home/u/proj/PLAN-v0.4.md");
  expect(p).toContain("roadmap_list");
  expect(p).toContain("roadmap_add");
  expect(p).toContain('"PLAN-v0.4.md"'); // tag = plan basename
  expect(p).toContain("/exit");
  expect(p).toContain("Do not modify any file");
});
