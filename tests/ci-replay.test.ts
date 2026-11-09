import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  balanceBins,
  classifyStep,
  describeDrift,
  dockerRunArgs,
  expandExpressions,
  failedTests,
  isHostileEnvKey,
  nulList,
  parseFileDurations,
  parseWorkflowSteps,
  planSteps,
  purgeEnv,
  recap,
  stepTimeoutMs,
  treeArchiveArgv,
} from "../scripts/ci-replay/steps.ts";
import { scrubEnv } from "./_scrub-env.ts";

// Imported dynamically to measure what the import itself does.
const replayFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith("ci-replay-")).sort();
const before = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM"), folders: replayFolders() };
const replay = await import("../scripts/ci-replay.ts");
const after = { sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM"), folders: replayFolders() };

const SAMPLE = `
name: x
jobs:
  build:
    steps:
      - uses: actions/checkout@v7
      - name: Bun install (root)
        run: bun install
      - name: Typecheck core
        run: bun run typecheck
      - name: Install CLI
        working-directory: desktop
        run: echo "\${{ runner.temp }}/cli" >> "$GITHUB_PATH"
      - name: Bun tests (pure modules)
        run: bun scripts/partition-pure-tests.ts
      - name: Rebuild node-pty (ABI gate)
        run: npm run rebuild
      - name: A step added later
        run: echo hello
      - name: Bun tests (integration)
        timeout-minutes: 25
        run: bun scripts/partition-integration-tests.ts
`;

describe("workflow step derivation", () => {
  const steps = parseWorkflowSteps(SAMPLE);
  const kinds = steps.map((s) => classifyStep(s, { allSteps: false }));

  test("each step keeps its run block, working directory and timeout", () => {
    expect(steps[3]?.workingDirectory).toBe("desktop");
    expect(steps[7]?.timeoutMinutes).toBe(25);
    expect(steps[1]?.run).toBe("bun install");
  });

  test("the partitions are recognised and typecheck / ABI steps are skipped", () => {
    expect(kinds).toEqual(["action", "plain", "skipped", "plain", "pure", "skipped", "plain", "integration"]);
  });

  test("a step added to the workflow runs by default", () => {
    expect(classifyStep({ name: "Lint the docs", run: "bun lint" }, { allSteps: false })).toBe("plain");
  });

  test("--all-steps replays the typecheck and ABI steps too", () => {
    expect(classifyStep({ name: "Typecheck core", run: "x" }, { allSteps: true })).toBe("plain");
  });

  test("the real workflow yields one pure step before one integration step", () => {
    const real = parseWorkflowSteps(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "desktop-build.yml"), "utf8"));
    const k = real.map((s) => classifyStep(s, { allSteps: false }));
    expect(k.filter((x) => x === "pure")).toHaveLength(1);
    expect(k.filter((x) => x === "integration")).toHaveLength(1);
    expect(k.indexOf("pure")).toBeLessThan(k.indexOf("integration"));
  });

  test("a workflow without steps is refused", () => {
    expect(() => parseWorkflowSteps("jobs:\n  build: {}\n")).toThrow(/no steps/);
    expect(() => parseWorkflowSteps("jobs:\n  build:\n    steps: []\n")).toThrow(/no steps/);
  });

  test("the step that installs the desktop dependencies comes after the pure partition and before the integration one", () => {
    const names = realSteps().steps.map((s) => s.name);
    const pure = realSteps().kinds.indexOf("pure");
    expect(pure).toBeGreaterThan(-1);
    expect(names.indexOf("Install desktop deps")).toBeGreaterThan(pure);
    expect(names.indexOf("Install desktop deps")).toBeLessThan(realSteps().kinds.indexOf("integration"));
  });
});

function realSteps() {
  const steps = parseWorkflowSteps(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "desktop-build.yml"), "utf8"));
  return { steps, kinds: steps.map((s) => classifyStep(s, { allSteps: false })) };
}

describe("a workflow key the replay does not model is refused, not dropped", () => {
  const withStep = (stepKeys: string, jobKeys = "") => `jobs:\n  build:\n${jobKeys}    steps:\n      - name: s\n        run: x\n${stepKeys}`;

  test("step-level if:, env: and continue-on-error: throw and name the key", () => {
    expect(() => parseWorkflowSteps(withStep("        if: always()\n"))).toThrow(/if/);
    expect(() => parseWorkflowSteps(withStep("        env:\n          A: b\n"))).toThrow(/env/);
    expect(() => parseWorkflowSteps(withStep("        continue-on-error: true\n"))).toThrow(/continue-on-error/);
  });

  test("a job-level env: or defaults: throws", () => {
    expect(() => parseWorkflowSteps(withStep("", "    env:\n      A: b\n"))).toThrow(/env/);
    expect(() => parseWorkflowSteps(withStep("", "    defaults:\n      run:\n        shell: bash\n"))).toThrow(/defaults/);
  });

  test("a workflow-level env: throws", () => {
    expect(() => parseWorkflowSteps(`env:\n  A: b\n${withStep("")}`)).toThrow(/env/);
  });

  test("the keys the replay models, with: on an action step included, are accepted", () => {
    const steps = parseWorkflowSteps("jobs:\n  build:\n    steps:\n      - uses: a/b@v1\n        with:\n          x: 1\n      - name: s\n        shell: bash\n        working-directory: d\n        timeout-minutes: 3\n        run: x\n");
    expect(steps).toHaveLength(2);
  });
});

describe("step plan", () => {
  const kinds = ["plain", "pure", "plain", "integration"] as const;

  test("in CI order the pure partition runs at its place and alone", () => {
    expect(planSteps(kinds, true).map((p) => [p.index, p.kind, p.withPure])).toEqual([
      [0, "plain", false],
      [1, "pure", false],
      [2, "plain", false],
      [3, "integration", false],
    ]);
  });

  test("otherwise it rides with the integration partition instead of running at its place", () => {
    expect(planSteps(kinds, false).map((p) => [p.index, p.kind, p.withPure])).toEqual([
      [0, "plain", false],
      [2, "plain", false],
      [3, "integration", true],
    ]);
  });

  test("a pure step without an integration step still runs, and actions and skipped steps never do", () => {
    expect(planSteps(["action", "pure", "skipped"], false).map((p) => p.index)).toEqual([1]);
  });
});

describe("step timeout", () => {
  test("timeout-minutes becomes milliseconds and an absent one stays absent", () => {
    expect(stepTimeoutMs({ timeoutMinutes: 25 })).toBe(1_500_000);
    expect(stepTimeoutMs({})).toBeUndefined();
  });

  test("the integration step of the real workflow carries a timeout the replay applies", () => {
    const { steps, kinds } = realSteps();
    expect(stepTimeoutMs(steps[kinds.indexOf("integration")]!)).toBeGreaterThan(0);
  });
});

describe("child environment", () => {
  test("the Deck control channel, identities and path switches never reach a child, whatever the case", () => {
    const kept = purgeEnv({
      DECK_CONTROL_URL: "u",
      DECK_CONTROL_TOKEN: "t",
      deck_control_x: "x",
      CLAUDE_PEERS_GROUP: "g",
      KORY_X: "1",
      ANTHROPIC_API_KEY: "k",
      MSYS_NO_PATHCONV: "1",
      NoDefaultCurrentDirectoryInExePath: "1",
      PATH: "/bin",
      HOME: "/h",
      UNSET: undefined,
    });
    expect(Object.keys(kept).sort()).toEqual(["HOME", "PATH"]);
  });

  test("every variable scrubEnv removes from a test child is refused here too", () => {
    const keys = ["CLAUDE_PEERS_GROUP", "CLAUDE_CODE_MESSAGING_SOCKET", "KORY_OPERATOR_TOOLS", "DECK_CONTROL_URL", "DECK_CONTROL_TOKEN"];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) process.env[k] = "live";
    try {
      const survivors = scrubEnv("/scratch");
      for (const k of keys) {
        expect([k, survivors[k]]).toEqual([k, undefined]);
        expect([k, isHostileEnvKey(k)]).toEqual([k, true]);
      }
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("the replay script's own wiring", () => {
  const work = mkdtempSync(join(tmpdir(), "kory-replay-wiring-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  test("importing the script starts nothing: no signal handler, no temp folder", () => {
    expect(after).toEqual(before);
  });

  test("childEnv drops the Deck control channel and sets the CI variables", () => {
    const env = replay.childEnv({ DECK_CONTROL_TOKEN: "t", DECK_CONTROL_URL: "u", PATH: "/b", KEEP: "k" }, "/t", ["/x"]);
    expect(Object.keys(env).filter((k) => k.startsWith("DECK_CONTROL_"))).toEqual([]);
    expect([env.KEEP, env.CI, env.RUNNER_TEMP]).toEqual(["k", "true", "/t"]);
    expect(env.PATH?.startsWith("/x")).toBe(true);
  });

  test("a child started by run() does not see the Deck control token", async () => {
    const saved = [process.env.CI_REPLAY_TMP, process.env.DECK_CONTROL_TOKEN] as const;
    process.env.CI_REPLAY_TMP = join(work, "run");
    process.env.DECK_CONTROL_TOKEN = "live";
    try {
      replay.setup([]);
      const log = join(work, "child.log");
      const code = await replay.run([process.execPath, "--print", "String(process.env.DECK_CONTROL_TOKEN)"], work, log);
      expect([code, readFileSync(log, "utf8").trim()]).toEqual([0, "undefined"]);
    } finally {
      for (const [k, v] of [["CI_REPLAY_TMP", saved[0]], ["DECK_CONTROL_TOKEN", saved[1]]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("dockerJob gives docker run the replay folder and the output folder, and no other mount", async () => {
    const calls: string[] = [];
    const fake = ((argv: string[]) => {
      calls.push(argv[0]!);
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }) as unknown as typeof Bun.spawnSync;
    let dockerRun: string[] = [];
    const result = await replay.dockerJob(
      { tmp: join(work, "docker-job"), split: 6 },
      {
        spawnSync: fake,
        run: async (argv, _cwd, log) => {
          dockerRun = argv;
          writeFileSync(log, "== ci-replay verdict == linux (logs: /work/tmp/logs)\nPASS x 1s\n");
          return 0;
        },
      },
    );
    expect(calls).toEqual(["git", "tar", "docker"]);
    expect(dockerRun.filter((a) => a === "-v")).toHaveLength(2);
    const targets = dockerRun.filter((_, i) => dockerRun[i - 1] === "-v").map((m) => m.slice(m.lastIndexOf(":/") + 1));
    expect(targets).toEqual(["/replay:ro", "/out"]);
    expect(result.lines[0]).not.toContain("/work/tmp/logs");
  });
});

describe("tracked-file drift", () => {
  const a = { hash: "h1", names: ["x.ts"] };

  test("no change is no drift", () => {
    expect(describeDrift(a, { ...a })).toBeNull();
  });

  test("an edit to a file that was already modified is drift though the names are the same", () => {
    expect(describeDrift(a, { hash: "h2", names: ["x.ts"] })).toMatch(/already modified/);
  });

  test("a newly modified and a reverted file are both named", () => {
    expect(describeDrift(a, { hash: "h2", names: ["y.ts"] })).toBe("newly modified: y.ts; no longer modified: x.ts");
  });
});

describe("container hand-over", () => {
  test("the container is given the replay folder and the output folder, never the working tree", () => {
    const args = dockerRunArgs({ name: "n", image: "i", replayDir: "/r", outDir: "/o", user: [], split: 3 });
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toEqual(["/r:/replay:ro", "/o:/out"]);
    expect(args.slice(-3)).toEqual(["bash", "/replay/in-container.sh", "3"]);
  });

  test("a tar list keeps awkward names verbatim, with no trailing separator", () => {
    expect(nulList(["a b", "-c", "it's"])).toBe("a b\0-c\0it's");
    expect(nulList([])).toBe("");
  });

  const dir = mkdtempSync(join(tmpdir(), "ci-replay-tar-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the archive built from the list holds exactly the listed files, awkward names included", () => {
    const names = ["plain.txt", "-dash.txt", "it's a file.txt", "sub/in.txt"];
    mkdirSync(join(dir, "sub"));
    for (const n of names) writeFileSync(join(dir, n), n);
    writeFileSync(join(dir, "unlisted.txt"), "x");
    writeFileSync(join(dir, "files.list"), nulList(names));
    const packed = Bun.spawnSync(treeArchiveArgv(join(dir, "files.list")), { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect([packed.exitCode, packed.stderr.toString()]).toEqual([0, ""]);
    const listed = Bun.spawnSync(["tar", "-tf", "-"], { stdin: packed.stdout, stdout: "pipe", stderr: "pipe" });
    expect(listed.stdout.toString().split(/\r?\n/).filter((l) => l && !l.endsWith("/")).sort()).toEqual([...names].sort());
  });
});

describe("expression expansion", () => {
  test("runner.temp is replaced and any other expression throws", () => {
    expect(expandExpressions('echo "${{ runner.temp }}/x"', { runnerTemp: "/t" })).toBe('echo "/t/x"');
    expect(() => expandExpressions("echo ${{ github.sha }}", { runnerTemp: "/t" })).toThrow(/github\.sha/);
  });

  test("every occurrence of runner.temp is replaced, with or without inner spaces", () => {
    expect(expandExpressions("${{runner.temp}}/a ${{ runner.temp }}/b", { runnerTemp: "/t" })).toBe("/t/a /t/b");
  });
});

describe("integration bins", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g"];
  const w: Record<string, number> = { a: 1, b: 9, c: 2, d: 8, e: 3, f: 7, g: 4 };

  test("every file lands in exactly one bin, in the input order inside the bin", () => {
    const bins = balanceBins(files, (f) => w[f]!, 3);
    expect(bins.flat().sort()).toEqual([...files].sort());
    for (const b of bins) expect(b).toEqual([...b].sort((x, y) => files.indexOf(x) - files.indexOf(y)));
  });

  test("the heaviest bin stays within one file of the ideal share", () => {
    const bins = balanceBins(files, (f) => w[f]!, 3);
    const loads = bins.map((b) => b.reduce((s, f) => s + w[f]!, 0));
    expect(Math.max(...loads)).toBeLessThanOrEqual(34 / 3 + 9);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(9);
  });

  test("when an even split exists the heaviest bin reaches exactly the ideal share", () => {
    const ws = [4, 4, 4, 5, 5, 6, 6, 7, 7];
    const names = ws.map((_, i) => `f${i}`);
    const load = (b: string[]) => b.reduce((s, f) => s + ws[Number(f.slice(1))]!, 0);
    const bins = balanceBins(names, (f) => ws[Number(f.slice(1))]!, 3);
    expect(bins.map(load)).toEqual([16, 16, 16]);
  });

  test("more bins than files gives no empty bin, and a bad count or weight throws", () => {
    expect(balanceBins(["a", "b"], () => 1, 6)).toHaveLength(2);
    expect(() => balanceBins(files, () => 1, 0)).toThrow(/positive integer/);
    expect(() => balanceBins(files, () => Number.NaN, 2)).toThrow(/finite/);
  });
});

describe("bun log reading", () => {
  const log = [
    "::group::tests\\a.test.ts:",
    "(pass) one [12.50ms]",
    "(fail) two [1.5s]",
    "::endgroup::",
    "::group::tests/b.test.ts:",
    "(pass) three [3.00ms]",
    "::endgroup::",
    "1 tests failed:",
    "(fail) two [1.5s]",
    " Ran 4 tests across 2 files. [3.00s]",
  ].join("\n");

  test("a failure listed twice (inline and in the recap) is named once, without its time", () => {
    expect(failedTests(log)).toEqual(["(fail) two"]);
  });

  test("durations are summed per file for both path separators", () => {
    const d = parseFileDurations(log);
    expect(d.get("a.test.ts")).toBe(1512.5);
    expect(d.get("b.test.ts")).toBe(3);
  });

  test("the recap line is read, and an absent one is null", () => {
    expect(recap(log)).toEqual({ tests: 4, files: 2 });
    expect(recap("nothing here")).toBeNull();
  });
});
