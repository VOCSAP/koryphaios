// Card 9e529177 (+ partie 6e3863ef): mount-mode protection sub-policy made
// visible/predictive. Two pure surfaces exercised here without electron:
// - desktop/src/main/sandbox-prompt.ts: composes --append-system-prompt-file
//   (index.ts's wrap() companion) -- index.ts itself imports electron and
//   cannot be bun-tested directly (electron.md rule), which is why this
//   composition logic lives in its own pure module.
// - desktop/src/main/sandbox-service.ts's exported pure helpers: parseMounts,
//   toProtectionStatus (operator-facing not-applicable/applied split, A10),
//   isProtectionRebuildNeeded (container-already-in-flight detection).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  composeAppendSystemPrompt,
  extractAppendSystemPromptFile,
  isValidSandboxSessionId,
  isWithinDir,
  sandboxPromptRoot,
} from "../desktop/src/main/sandbox-prompt.ts";
import { writeSupervisorSystemPrompt } from "../desktop/src/main/supervisor.ts";
import { writeEmbeddedAgentPrompt } from "../desktop/src/main/team-embedded.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import {
  computeRebuildReasons,
  isProtectionRebuildNeeded,
  isRunDirMountShared,
  parseMounts,
  toProtectionStatus,
  SandboxService,
  type SandboxExecResult,
  type SandboxMountInfo,
  type SandboxServiceDeps,
} from "../desktop/src/main/sandbox-service.ts";
import { containerNameFor, isSandboxContainerName } from "../desktop/src/main/sandbox-command.ts";
import { writeSandboxSettings } from "../desktop/src/main/sandbox-store.ts";
import type { ProtectionPlan } from "../desktop/src/main/sandbox-protect.ts";

/** Minimal SandboxServiceDeps for constructor/keying-level tests -- no exec calls unless provided. */
function makeDeps(
  projectDir: string,
  stateDir: string,
  exec?: SandboxServiceDeps["exec"]
): SandboxServiceDeps {
  return {
    projectDir,
    projectKey: "k",
    stateDir,
    claudeHomeDir: join(stateDir, "claude-home"),
    deckPluginDir: () => "",
    imageContextDir: join(stateDir, "image-ctx"),
    containerBrokerUrl: () => "http://127.0.0.1:0",
    journal: () => {},
    exec,
  };
}

/**
 * Answers every `run()` call containerAction's happy path makes: the engine
 * probe `run()` itself requires before ANY other call succeeds (private
 * `run()` returns `{code: -1}` unconditionally until `detectEngine()` has
 * set `this.probe`), the sandbox-label probe, then the actual command.
 */
async function fakeExecOk(file: string, args: string[]): Promise<SandboxExecResult> {
  if (args[0] === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
  if (args[0] === "inspect" && args.some((a) => a.includes("kory.sandbox"))) {
    return { code: 0, stdout: "1\n", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
}

/**
 * Same happy path as fakeExecOk, but also answers inspectIdState's
 * `{{.Id}}\t{{.State.Status}}\t{{json .Mounts}}` format with a controlled
 * State.Status -- used to prove the fail-closed purge guard (card e35b2791
 * audit round 3).
 */
function makeFakeExecWithState(state: string): (file: string, args: string[]) => Promise<SandboxExecResult> {
  return async (file, args) => {
    if (args[0] === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
    if (args[0] === "inspect" && args.some((a) => a.includes("kory.sandbox"))) {
      return { code: 0, stdout: "1\n", stderr: "" };
    }
    if (args[0] === "inspect") return { code: 0, stdout: `${"a".repeat(64)}\t${state}\t[]`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

const CONTAINER_PATH = "/kory-run/prompt-sess-1.txt";

const APPLIED_PLAN: ProtectionPlan = {
  status: "applied",
  applied: [
    { rel: ".git/hooks", kind: "dir", hostPath: "/host/.git/hooks", containerPath: "/work/.git/hooks" },
    { rel: ".mcp.json", kind: "file", hostPath: "/host/.mcp.json", containerPath: "/work/.mcp.json" },
  ],
  skipped: [{ rel: ".vscode", kind: "dir", reason: "file-absent" }],
};

const NOT_APPLICABLE_PLAN: ProtectionPlan = {
  status: "not-applicable",
  reason: "copy-mode",
  applied: [],
  skipped: [],
};

// N-a: the flag must point a CONTAINER path, never the host path it started
// with -- rougit si la reecriture est retiree (assertion sur le chemin
// conteneur PRESENT et le chemin hote ABSENT du resultat, pas seulement
// "differe de l'entree").
test("N-a: rewrites an existing flag to the container path, never leaves the host path", () => {
  const command = `claude --append-system-prompt-file "/host/role.md" --session-id "x"`;
  const result = composeAppendSystemPrompt(command, "role content", "", CONTAINER_PATH);
  expect(result.composed).not.toBeNull();
  expect(result.command).toContain(`--append-system-prompt-file "${CONTAINER_PATH}"`);
  expect(result.command).not.toContain("/host/role.md");
});

// N-b: both pieces present -> the composed file carries BOTH, role first.
test("N-b: role prompt + protection notice compose into one file, both present", () => {
  const command = `claude --append-system-prompt-file "/host/role.md" --session-id "x"`;
  const roleContent = "You are the QA lead role.";
  const notice = "The following paths are mounted read-only and cannot be modified:";
  const result = composeAppendSystemPrompt(command, roleContent, notice, CONTAINER_PATH);
  expect(result.composed).not.toBeNull();
  expect(result.composed).toContain(roleContent);
  expect(result.composed).toContain(notice);
  // role first, notice after (composition order per the brief)
  expect(result.composed!.indexOf(roleContent)).toBeLessThan(result.composed!.indexOf(notice));
});

// N-c: role prompt alone, plan not-applicable (copy mode) -- the bug the
// mission exhumed: the role content must still reach the container.
test("N-c: role prompt alone (not-applicable plan) still reaches the container", () => {
  const command = `claude --append-system-prompt-file "/host/role.md" --session-id "x"`;
  const roleContent = "You are the QA lead role.";
  const notice = ""; // renderProtectionNotice('not-applicable') === ''
  const result = composeAppendSystemPrompt(command, roleContent, notice, CONTAINER_PATH);
  expect(result.composed).toBe(roleContent);
  expect(result.command).toContain(`--append-system-prompt-file "${CONTAINER_PATH}"`);
});

// N-c bis: plan applied but NO existing flag (ordinary agent tile, mount
// mode) -- the flag must be INSERTED, not silently dropped, or the notice
// never reaches the container for the common case.
test("N-c bis: notice alone with no pre-existing flag inserts the flag", () => {
  const command = `claude --session-id "x"`;
  const notice = "The following paths are mounted read-only and cannot be modified:";
  const result = composeAppendSystemPrompt(command, "", notice, CONTAINER_PATH);
  expect(result.composed).toBe(notice);
  expect(result.command).toBe(`${command} --append-system-prompt-file "${CONTAINER_PATH}"`);
});

// N-d: both absent -> composed is null, command returned UNCHANGED (exact
// equality, not just "still contains the same substrings").
test("N-d: both pieces absent leaves the command line untouched", () => {
  const command = `claude --session-id "x"`;
  const result = composeAppendSystemPrompt(command, "", "", CONTAINER_PATH);
  expect(result.composed).toBeNull();
  expect(result.command).toBe(command);
});

test("extractAppendSystemPromptFile reads the host path, or undefined when absent", () => {
  expect(extractAppendSystemPromptFile(`claude --append-system-prompt-file "/host/x.md" --session-id "y"`)).toBe(
    "/host/x.md"
  );
  expect(extractAppendSystemPromptFile(`claude --session-id "y"`)).toBeUndefined();
});

// N-e: 'not-applicable' and 'applied' (even with skipped.length === 0) are
// DISTINCT shapes the operator UI branches on -- rougit si on les confond
// (ex: 'not-applicable' rendu comme applied avec appliedCount: 0).
test("N-e: not-applicable and applied+zero-skip are distinct SandboxProtectionStatus shapes", () => {
  const notApplicable = toProtectionStatus(NOT_APPLICABLE_PLAN);
  expect(notApplicable).toEqual({ status: "not-applicable" });

  const appliedZeroSkip: ProtectionPlan = { status: "applied", applied: [], skipped: [] };
  const applied = toProtectionStatus(appliedZeroSkip);
  expect(applied).toEqual({ status: "applied", appliedCount: 0, skipped: [] });

  // Never the same shape -- the renderer's `.status === 'not-applicable'` vs
  // `.status === 'applied'` branch must never see the wrong one.
  expect(notApplicable.status).not.toBe(applied.status);
});

test("N-e bis: toProtectionStatus surfaces appliedCount and skipped reasons for the operator", () => {
  const status = toProtectionStatus(APPLIED_PLAN);
  expect(status).toEqual({
    status: "applied",
    appliedCount: 2,
    skipped: [{ rel: ".vscode", reason: "file-absent" }],
  });
});

// N-f: container already in flight (created before this feature) -- no
// protected mounts present although the current plan expects some.
test("N-f: a container with none of the expected :ro binds needs a rebuild", () => {
  const noMounts: SandboxMountInfo[] = [];
  expect(isProtectionRebuildNeeded(APPLIED_PLAN, "running", noMounts)).toBe(true);
});

test("N-f bis: a container carrying all expected ro binds does not need a rebuild", () => {
  const mounts: SandboxMountInfo[] = [
    { destination: "/work/.git/hooks", source: "/host/.git/hooks", rw: false },
    { destination: "/work/.mcp.json", source: "/host/.mcp.json", rw: false },
  ];
  expect(isProtectionRebuildNeeded(APPLIED_PLAN, "running", mounts)).toBe(false);
});

test("N-f ter: a matching Destination that is NOT read-only still needs a rebuild (RW compared, not just presence)", () => {
  const mounts: SandboxMountInfo[] = [
    { destination: "/work/.git/hooks", source: "/host/.git/hooks", rw: true }, // present, but read-write -- not the protection bind
    { destination: "/work/.mcp.json", source: "/host/.mcp.json", rw: false },
  ];
  expect(isProtectionRebuildNeeded(APPLIED_PLAN, "running", mounts)).toBe(true);
});

test("N-f quater: never flagged in copy mode (not-applicable plan), whatever the mounts", () => {
  expect(isProtectionRebuildNeeded(NOT_APPLICABLE_PLAN, "running", [])).toBe(false);
});

test("N-f quinquies: never flagged when no container exists yet", () => {
  expect(isProtectionRebuildNeeded(APPLIED_PLAN, "missing", [])).toBe(false);
});

test("parseMounts reduces docker inspect JSON to destination/rw, tolerating malformed input", () => {
  const raw = JSON.stringify([
    { Destination: "/work/.git/hooks", RW: false, Source: "C:\\proj\\.git\\hooks" },
    { Destination: "/work", RW: true, Source: "/run/desktop/mnt/host/c/proj" },
  ]);
  expect(parseMounts(raw)).toEqual([
    { destination: "/work/.git/hooks", source: "C:\\proj\\.git\\hooks", rw: false },
    { destination: "/work", source: "/run/desktop/mnt/host/c/proj", rw: true },
  ]);
  expect(parseMounts(undefined)).toEqual([]);
  expect(parseMounts("{not json")).toEqual([]);
  expect(parseMounts("{}")).toEqual([]); // not an array
});

// Audit fix 2: RW must fail SAFE (assume writable / not protected), never
// fail OPEN (assume protected) on anything but a literal JSON `false`.
test("audit fix 2: parseMounts treats string/omitted/numeric RW as NOT protected (rw=true)", () => {
  const raw = JSON.stringify([
    { Destination: "/work/a", RW: "true" }, // string, not a JSON boolean
    { Destination: "/work/b" }, // omitted entirely
    { Destination: "/work/c", RW: 1 }, // numeric
    { Destination: "/work/d", RW: false }, // nominal Docker case, unaffected
  ]);
  expect(parseMounts(raw)).toEqual([
    { destination: "/work/a", source: "", rw: true },
    { destination: "/work/b", source: "", rw: true },
    { destination: "/work/c", source: "", rw: true },
    { destination: "/work/d", source: "", rw: false },
  ]);
});

test("audit fix 2 bis: a plan expecting protection on an ambiguous-RW mount signals rebuild, not silence", () => {
  const plan: ProtectionPlan = {
    status: "applied",
    applied: [{ rel: ".git/hooks", kind: "dir", hostPath: "/host/.git/hooks", containerPath: "/work/.git/hooks" }],
    skipped: [],
  };
  const mounts = parseMounts(JSON.stringify([{ Destination: "/work/.git/hooks", RW: "true" }]));
  expect(isProtectionRebuildNeeded(plan, "running", mounts)).toBe(true);
});

// Audit fix 3: sessionId must have the exact uuid shape before it reaches a
// filename or container path (restoreFrom() takes a persisted id verbatim).
test("audit fix 3: isValidSandboxSessionId accepts a uuid, rejects shell-hostile input", () => {
  expect(isValidSandboxSessionId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  expect(isValidSandboxSessionId('x" ; touch /tmp/PWNED #')).toBe(false);
  expect(isValidSandboxSessionId("$(id)")).toBe(false);
  expect(isValidSandboxSessionId("")).toBe(false);
  expect(isValidSandboxSessionId("not-a-uuid")).toBe(false);
});

// Root and target are real tmpdir trees, not mocked: isWithinDir makes real
// symlink-resolving calls, so symlink containment is exercised for real.
let containDir: string;
let outsideDir: string;
beforeEach(() => {
  containDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-root-"));
  outsideDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-outside-"));
});
afterEach(() => {
  rmSync(containDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

test("audit fix 1: isWithinDir accepts a file inside root, rejects one outside", () => {
  const inside = join(containDir, "prompt.md");
  writeFileSync(inside, "role content");
  const outside = join(outsideDir, "secret.md");
  writeFileSync(outside, "should never be read");

  expect(isWithinDir(containDir, inside)).toBe(true);
  expect(isWithinDir(containDir, outside)).toBe(false);
});

test("audit fix 1 bis: isWithinDir follows a symlink to its REAL target, not its lexical position", () => {
  const outsideSecret = join(outsideDir, "secret.md");
  writeFileSync(outsideSecret, "leak me");
  const linkInsideRoot = join(containDir, "looks-local.md");
  symlinkSync(outsideSecret, linkInsideRoot);

  // Lexically under containDir, but the resolved target lies outside it -- must be refused.
  expect(isWithinDir(containDir, linkInsideRoot)).toBe(false);
});

test("audit fix 1 ter: isWithinDir fails closed on a missing target or missing root", () => {
  expect(isWithinDir(containDir, join(containDir, "does-not-exist.md"))).toBe(false);
  expect(isWithinDir(join(containDir, "no-such-root"), join(containDir, "x"))).toBe(false);
});

// End-to-end: an uncontained hostPromptPath must not leak its content into
// the composed prompt, even when composeAppendSystemPrompt is fed it
// directly -- this is the exact assertion the audit asked for ("le contenu
// ne se retrouve PAS dans le prompt compose").
test("audit fix 1 quater: content from an uncontained path never reaches the composed prompt (caller-side gate)", () => {
  const outsideSecret = join(outsideDir, "off-limits.txt");
  const marker = "sensitive host file contents that must never leak";
  writeFileSync(outsideSecret, marker);
  const hostPromptPath = outsideSecret;

  // index.ts's composeSandboxAppendPrompt only ever calls readFileSync when
  // isWithinDir(secretsDir(), hostPromptPath) is true; simulate the gate a
  // caller MUST apply before ever handing content to composeAppendSystemPrompt.
  const allowed = isWithinDir(containDir, hostPromptPath);
  const roleContent = allowed ? "should not happen" : "";
  const command = `claude --append-system-prompt-file "${hostPromptPath}" --session-id "x"`;
  const result = composeAppendSystemPrompt(command, roleContent, "a notice", CONTAINER_PATH);

  expect(allowed).toBe(false);
  expect(result.composed).not.toContain(marker);
  expect(result.composed).not.toContain(outsideSecret);
});

// Team-lead round 2: the four "audit fix 1" tests above prove refusal --
// none of them prove that the root wired into production (index.ts's
// secretsDir(), which now delegates to sandboxPromptRoot) is the SAME
// directory legitimate role prompts actually land in. This uses the REAL
// production writers (writeSupervisorSystemPrompt, writeEmbeddedAgentPrompt)
// -- not a hand-rolled writeFileSync standing in for them -- and pins
// sandboxPromptRoot's output against `productionStateDir`, an INDEPENDENTLY
// built expression (mirrors index.ts's own local `stateDir` const at the
// writeSupervisorSystemPrompt call site, built without calling
// sandboxPromptRoot) so a future divergence between the two is caught here,
// not discovered as a silent refusal of every legitimate role prompt.
test("audit fix 1 quinquies: writeSupervisorSystemPrompt's real output is accepted, pinned against production's own stateDir expression", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-userdata-"));
  const productionStateDir = join(userDataDir, "config"); // APP_STATE_SUBDIR's real value (migrate-data-dir.ts)
  const roleFile = writeSupervisorSystemPrompt(productionStateDir);

  const containmentRoot = sandboxPromptRoot(userDataDir);
  // Pins the two expressions TOGETHER -- this is what a divergence mutation reddens.
  expect(containmentRoot).toBe(productionStateDir);
  expect(isWithinDir(containmentRoot, roleFile)).toBe(true);

  const roleContent = readFileSync(roleFile, "utf8");
  const result = composeAppendSystemPrompt(
    `claude --append-system-prompt-file "${roleFile}" --session-id "x"`,
    roleContent,
    "",
    CONTAINER_PATH
  );
  expect(result.composed).toBe(roleContent);
  expect(result.composed).toContain("SUPERVISOR"); // sanity: really is the supervisor anchor text

  rmSync(userDataDir, { recursive: true, force: true });
});

test("audit fix 1 sexies: writeEmbeddedAgentPrompt's real output (team-role anchor) is also accepted end to end", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-userdata2-"));
  const productionStateDir = join(userDataDir, "config");
  const roleFile = writeEmbeddedAgentPrompt(productionStateDir, "team-lead");

  const containmentRoot = sandboxPromptRoot(userDataDir);
  expect(isWithinDir(containmentRoot, roleFile)).toBe(true);

  const roleContent = readFileSync(roleFile, "utf8");
  const result = composeAppendSystemPrompt(
    `claude --append-system-prompt-file "${roleFile}" --session-id "x"`,
    roleContent,
    "",
    CONTAINER_PATH
  );
  // This is the exact bug card 9e529177 exhumed: an embedded team role's
  // anchor content must reach the composed prompt, not be silently refused.
  expect(result.composed).toBe(roleContent);

  rmSync(userDataDir, { recursive: true, force: true });
});

test("probeRoadmapMcp answers null before the container is ready, then the registration verdict of the container's own claude", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-roadmap-probe-"));
  const calls: string[][] = [];
  let reply: SandboxExecResult = { code: 0, stdout: "kory-roadmap:\n  Scope: User config (available in all your projects)\n", stderr: "" };
  const svc = new SandboxService(
    makeDeps("/project/roadmap-probe", stateDir, async (_file, args) => {
      calls.push(args);
      if (args[0] === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
      return reply;
    })
  );
  writeSandboxSettings(join(stateDir, "sandbox.json"), "k", { enabled: true });
  await svc.detectEngine();

  expect(await svc.probeRoadmapMcp(), "an unready container is unknown, not unregistered").toBeNull();
  expect(calls.filter((args) => args[0] === "exec")).toEqual([]);

  (svc as unknown as { lastReady: boolean }).lastReady = true;
  expect(await svc.probeRoadmapMcp()).toBe(true);
  expect(calls.at(-1)).toEqual(["exec", containerNameFor("/project/roadmap-probe"), "claude", "mcp", "get", "kory-roadmap"]);

  reply = { code: 1, stdout: 'No MCP server named "kory-roadmap".', stderr: "" };
  expect(await svc.probeRoadmapMcp()).toBe(false);
  expect(((await svc.status()) as { roadmapMcp: boolean | null }).roadmapMcp, "the verdict reaches the status the Docker view renders").toBe(false);
  rmSync(stateDir, { recursive: true, force: true });
});

test("cleanupSession reports an unavailable launch with its tile id", async () => {
  const reports: Array<[string, string]> = [];
  onDeckError((scope, text) => reports.push([scope, text]));
  const svc = new SandboxService(makeDeps("/project/cleanup-trace", join(tmpdir(), "cp-sandbox-svc-cleanup-trace")));

  await svc.cleanupSession("tile-cleanup-trace");

  expect(reports).toEqual([["sandbox", "sandbox cleanup skipped for tile tile-cleanup-trace: no active launch"]]);
  onDeckError(() => {});
});

test("cleanupSession reports an empty-stderr pid read failure", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-read-failure-"));
  const calls: string[][] = [];
  const svc = new SandboxService(
    makeDeps("/project/read-failure", stateDir, async (_file, args) => {
      calls.push(args);
      if (args[0] === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
      return { code: 7, stdout: "", stderr: "" };
    })
  );
  writeSandboxSettings(join(stateDir, "sandbox.json"), "k", { enabled: true });
  await svc.detectEngine();
  (svc as unknown as { lastReady: boolean }).lastReady = true;
  svc.execCommand({ engine: "docker", container: containerNameFor("/project/read-failure"), containerId: "a".repeat(64), runDirHost: "", workSource: "", protection: NOT_APPLICABLE_PLAN }, "tile-read-failure");
  const reports: Array<[string, string]> = [];
  onDeckError((scope, text) => reports.push([scope, text]));

  await svc.cleanupSession("tile-read-failure");

  expect(calls).toEqual([
    ["version", "--format", "{{.Client.Version}}"],
    ["exec", "a".repeat(64), "cat", "/kory-run/pid-tile-read-failure"]
  ]);
  expect(reports).toEqual([[
    "sandbox",
    "failed to read sandbox pid for tile tile-read-failure: exit code 7"
  ]]);
  onDeckError(() => {});
  rmSync(stateDir, { recursive: true, force: true });
});

test("cleanupSession reads a valid pid before killing its process group", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-cleanup-flow-"));
  const projectDir = "/project/cleanup-flow";
  const calls: string[][] = [];
  const svc = new SandboxService(
    makeDeps(projectDir, stateDir, async (_file, args) => {
      calls.push(args);
      if (args[0] === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
      if (args[2] === "cat") return { code: 0, stdout: "517\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    })
  );
  writeSandboxSettings(join(stateDir, "sandbox.json"), "k", { enabled: true });
  await svc.detectEngine();
  (svc as unknown as { lastReady: boolean }).lastReady = true;
  svc.execCommand({ engine: "docker", container: containerNameFor(projectDir), containerId: "b".repeat(64), runDirHost: "", workSource: "", protection: NOT_APPLICABLE_PLAN }, "tile-cleanup-flow");

  await svc.cleanupSession("tile-cleanup-flow");

  expect(calls).toEqual([
    ["version", "--format", "{{.Client.Version}}"],
    ["exec", "b".repeat(64), "cat", "/kory-run/pid-tile-cleanup-flow"],
    [
      "exec",
      "b".repeat(64),
      "bash",
      "-c",
      "kill -- -\"$1\" 2>/dev/null || true; rm -f \"$2\"",
      "sandbox-cleanup",
      "517",
      "/kory-run/pid-tile-cleanup-flow"
    ]
  ]);
  rmSync(stateDir, { recursive: true, force: true });
});

test("cleanupSession refuses an invalid pid before the kill command", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-invalid-pid-"));
  const calls: string[][] = [];
  const svc = new SandboxService(
    makeDeps("/project/invalid-pid", stateDir, async (_file, args) => {
      calls.push(args);
      if (args[0] === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
      return { code: 0, stdout: "2147483648\n", stderr: "" };
    })
  );
  writeSandboxSettings(join(stateDir, "sandbox.json"), "k", { enabled: true });
  await svc.detectEngine();
  (svc as unknown as { lastReady: boolean }).lastReady = true;
  svc.execCommand({ engine: "docker", container: containerNameFor("/project/invalid-pid"), containerId: "c".repeat(64), runDirHost: "", workSource: "", protection: NOT_APPLICABLE_PLAN }, "tile-invalid-pid");

  await svc.cleanupSession("tile-invalid-pid");

  expect(calls).toHaveLength(2);
  expect(calls.at(-1)).toEqual(["exec", "c".repeat(64), "cat", "/kory-run/pid-tile-invalid-pid"]);
  rmSync(stateDir, { recursive: true, force: true });
});

// runDirHost/peersDirHost are keyed by containerName and purged on remove or
// rebuild -- the shared-mount drift signal depends on this per-container
// isolation.
test("P-a: two projects' writeLaunchScript land in DIFFERENT, containerName-keyed run dirs", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-keying-"));
  const svcA = new SandboxService(makeDeps("/project/a", stateDir));
  const svcB = new SandboxService(makeDeps("/project/b", stateDir));
  const idA = "11111111-1111-1111-1111-111111111111";
  const idB = "22222222-2222-2222-2222-222222222222";

  svcA.writeLaunchScript(idA, { command: "echo a", cwd: "/work", env: {} });
  svcB.writeLaunchScript(idB, { command: "echo b", cwd: "/work", env: {} });

  const nameA = containerNameFor("/project/a");
  const nameB = containerNameFor("/project/b");
  expect(nameA).not.toBe(nameB);
  expect(existsSync(join(stateDir, "sandbox-run", nameA, `cmd-${idA}.sh`))).toBe(true);
  expect(existsSync(join(stateDir, "sandbox-run", nameB, `cmd-${idB}.sh`))).toBe(true);
  // The OLD unkeyed shared location must receive NEITHER script.
  expect(existsSync(join(stateDir, "sandbox-run", `cmd-${idA}.sh`))).toBe(false);

  rmSync(stateDir, { recursive: true, force: true });
});

test("P-b: two projects get different peersDirHost, each keyed by its own containerName", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-keying2-"));
  const svcA = new SandboxService(makeDeps("/project/a", stateDir));
  const svcB = new SandboxService(makeDeps("/project/b", stateDir));

  expect(svcA.peersDirHost).not.toBe(svcB.peersDirHost);
  expect(svcA.peersDirHost).toBe(join(stateDir, "sandbox-peers", containerNameFor("/project/a")));
  expect(svcB.peersDirHost).toBe(join(stateDir, "sandbox-peers", containerNameFor("/project/b")));

  rmSync(stateDir, { recursive: true, force: true });
});

test("P-c: containerAction('remove') purges the containerName-keyed run/peers dirs", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-purge-"));
  const projectDir = "/project/c";
  const name = containerNameFor(projectDir);
  const svc = new SandboxService(makeDeps(projectDir, stateDir, fakeExecOk));

  const runDir = join(stateDir, "sandbox-run", name);
  const peersDir = join(stateDir, "sandbox-peers", name);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(peersDir, { recursive: true });
  writeFileSync(join(runDir, "cmd-x.sh"), "#!/bin/bash");

  await svc.detectEngine();
  await svc.containerAction(name, "remove");

  expect(existsSync(runDir)).toBe(false);
  expect(existsSync(peersDir)).toBe(false);

  rmSync(stateDir, { recursive: true, force: true });
});

test("P-c bis: containerAction('remove') on a DIFFERENT project's container purges THAT project's dirs, not this.containerName's", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-purge2-"));
  const svc = new SandboxService(makeDeps("/project/mine", stateDir, fakeExecOk));
  const otherName = containerNameFor("/project/other");
  const otherRunDir = join(stateDir, "sandbox-run", otherName);
  mkdirSync(otherRunDir, { recursive: true });

  await svc.detectEngine();
  await svc.containerAction(otherName, "remove");

  expect(existsSync(otherRunDir)).toBe(false);

  rmSync(stateDir, { recursive: true, force: true });
});

test("P-d: containerAction('remove') does NOT purge copyDirHost (asymmetry is intentional, A4)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-purge3-"));
  const projectDir = "/project/d";
  const name = containerNameFor(projectDir);
  const svc = new SandboxService(makeDeps(projectDir, stateDir, fakeExecOk));

  const copyDir = join(stateDir, "sandbox-copies", name);
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, "marker.txt"), "keep me");

  await svc.detectEngine();
  await svc.containerAction(name, "remove");

  expect(existsSync(copyDir)).toBe(true);

  rmSync(stateDir, { recursive: true, force: true });
});

// Card e35b2791 audit round 3: fail-closed against a race with a live
// session in ANOTHER Deck window (no requestSingleInstanceLock in this app).
test("P-h: containerAction('remove') skips the purge (fail-closed) when the target container was RUNNING", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-purge4-"));
  const projectDir = "/project/h";
  const name = containerNameFor(projectDir);
  const svc = new SandboxService(makeDeps(projectDir, stateDir, makeFakeExecWithState("running")));

  const runDir = join(stateDir, "sandbox-run", name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "cmd-live.sh"), "#!/bin/bash");

  await svc.detectEngine();
  await svc.containerAction(name, "remove");

  // The container is still force-removed either way (docker rm -f runs
  // regardless) -- only the directory purge is gated on the running check.
  expect(existsSync(runDir)).toBe(true);

  rmSync(stateDir, { recursive: true, force: true });
});

test("P-h bis: containerAction('remove') DOES purge when the target container was NOT running", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-purge5-"));
  const projectDir = "/project/h2";
  const name = containerNameFor(projectDir);
  const svc = new SandboxService(makeDeps(projectDir, stateDir, makeFakeExecWithState("exited")));

  const runDir = join(stateDir, "sandbox-run", name);
  mkdirSync(runDir, { recursive: true });

  await svc.detectEngine();
  await svc.containerAction(name, "remove");

  expect(existsSync(runDir)).toBe(false);

  rmSync(stateDir, { recursive: true, force: true });
});

// P-e: the shared-run-dir drift signal (isRunDirMountShared).
test("P-e: flags a container whose /kory-run source is the OLD shared dir (containerName absent from Source)", () => {
  const containerName = "kory-sbx-abcdef123456";
  const mounts: SandboxMountInfo[] = [
    {
      destination: "/kory-run",
      source: "/run/desktop/mnt/host/c/Users/x/AppData/Roaming/koryphaios/config/sandbox-run",
      rw: true,
    },
  ];
  expect(isRunDirMountShared(mounts, containerName, "running")).toBe(true);
});

test("P-e bis: accepts a /kory-run source keyed to the current containerName, in EITHER path representation", () => {
  const containerName = "kory-sbx-abcdef123456";
  const winForm: SandboxMountInfo[] = [
    {
      destination: "/kory-run",
      source: `C:\\Users\\x\\AppData\\Roaming\\koryphaios\\config\\sandbox-run\\${containerName}`,
      rw: true,
    },
  ];
  const wslForm: SandboxMountInfo[] = [
    {
      destination: "/kory-run",
      source: `/run/desktop/mnt/host/c/Users/x/AppData/Roaming/koryphaios/config/sandbox-run/${containerName}`,
      rw: true,
    },
  ];
  expect(isRunDirMountShared(winForm, containerName, "running")).toBe(false);
  expect(isRunDirMountShared(wslForm, containerName, "running")).toBe(false);
});

test("P-e ter: a missing /kory-run mount is drift (fail-safe); 'missing' containerState is never drift", () => {
  expect(isRunDirMountShared([], "kory-sbx-abcdef123456", "running")).toBe(true);
  expect(isRunDirMountShared([], "kory-sbx-abcdef123456", "missing")).toBe(false);
});

// P-f: the containerName key can never escape its parent directory.
test("P-f: isSandboxContainerName rejects path-traversal-shaped names before they ever reach a join()", () => {
  expect(isSandboxContainerName("../../etc")).toBe(false);
  expect(isSandboxContainerName("kory-sbx-" + "a".repeat(12) + "/../x")).toBe(false);
  expect(isSandboxContainerName("kory-sbx-ABCDEF123456")).toBe(false); // uppercase hex rejected
  const valid = containerNameFor("/some/project"); // always matches NAME_RE by construction
  expect(isSandboxContainerName(valid)).toBe(true);
});

test("P-f bis: a valid containerName can never make join(root, 'sandbox-run', name) escape root", () => {
  const root = join(tmpdir(), "cp-sandbox-svc-root-check");
  for (const projectDir of ["/a", "/b/c", "/weird spaces/dir"]) {
    const name = containerNameFor(projectDir);
    const built = join(root, "sandbox-run", name);
    expect(built.startsWith(root + sep)).toBe(true);
    expect(built).not.toContain("..");
  }
});

// Team-lead round 2: a single "rebuild needed" boolean is actively
// misleading when the two possible causes need two different responses --
// this proves the closed, cumulable reason set stays DISTINCT across three
// container profiles, never merged into one.
test("P-g: three container profiles (only missing-protection-binds, only shared-run-dir, both) produce three DISTINCT rebuildReasons", () => {
  const containerName = "kory-sbx-abcdef123456";
  const keyedRunMount: SandboxMountInfo = {
    destination: "/kory-run",
    source: `/run/desktop/mnt/host/c/state/sandbox-run/${containerName}`,
    rw: true,
  };
  const sharedRunMount: SandboxMountInfo = {
    destination: "/kory-run",
    source: "/run/desktop/mnt/host/c/state/sandbox-run", // old, unkeyed
    rw: true,
  };
  const protectedBinds: SandboxMountInfo[] = [
    { destination: "/work/.git/hooks", source: "/host/.git/hooks", rw: false },
    { destination: "/work/.mcp.json", source: "/host/.mcp.json", rw: false },
  ];

  const onlyProtection = computeRebuildReasons(APPLIED_PLAN, [keyedRunMount], containerName, "running");
  const onlySharedRunDir = computeRebuildReasons(
    APPLIED_PLAN,
    [...protectedBinds, sharedRunMount],
    containerName,
    "running"
  );
  const both = computeRebuildReasons(APPLIED_PLAN, [sharedRunMount], containerName, "running");
  const neither = computeRebuildReasons(APPLIED_PLAN, [...protectedBinds, keyedRunMount], containerName, "running");

  expect(onlyProtection).toEqual(["missing-protection-binds"]);
  expect(onlySharedRunDir).toEqual(["shared-run-dir"]);
  expect(both).toEqual(["missing-protection-binds", "shared-run-dir"]);
  expect(neither).toEqual([]);

  // Three non-empty results, pairwise DISTINCT -- never silently merged.
  expect(onlyProtection).not.toEqual(onlySharedRunDir);
  expect(onlyProtection).not.toEqual(both);
  expect(onlySharedRunDir).not.toEqual(both);
});

test("P-g bis: rebuildReasons is always empty when the container is 'missing', regardless of plan/mounts", () => {
  expect(computeRebuildReasons(APPLIED_PLAN, [], "kory-sbx-abcdef123456", "missing")).toEqual([]);
});

// Runs the real parseMounts on realistic raw docker-inspect JSON rather than a
// hand-built SandboxMountInfo, using both Source representations measured on a
// real container.
// Podman is not installed here, so its inspect --format {{json .Mounts}} output
// is untested; the containerName-substring containment approach is assumed, not
// verified, to generalize to it.
test("P-i: computeRebuildReasons through the REAL parseMounts on realistic docker-inspect JSON (both measured Source forms)", () => {
  const containerName = "kory-sbx-abcdef123456";
  const rawKeyedWsl = JSON.stringify([
    {
      Type: "bind",
      Source: `/run/desktop/mnt/host/c/Users/x/AppData/Roaming/koryphaios/config/sandbox-run/${containerName}`,
      Destination: "/kory-run",
      Mode: "",
      RW: true,
      Propagation: "rprivate",
    },
  ]);
  const rawSharedWin = JSON.stringify([
    {
      Type: "bind",
      Source: "C:\\Users\\x\\AppData\\Roaming\\koryphaios\\config\\sandbox-run",
      Destination: "/kory-run",
      Mode: "",
      RW: true,
      Propagation: "rprivate",
    },
  ]);

  expect(computeRebuildReasons(NOT_APPLICABLE_PLAN, parseMounts(rawKeyedWsl), containerName, "running")).toEqual([]);
  expect(
    computeRebuildReasons(NOT_APPLICABLE_PLAN, parseMounts(rawSharedWin), containerName, "running")
  ).toEqual(["shared-run-dir"]);
});

const MODS_ID_A = "a".repeat(64);
const MODS_ID_B = "b".repeat(64);
const MODS_FP1 = "1".repeat(64);
const MODS_FP2 = "2".repeat(64);
const MODS_ROOT = "/opt/kory-mods";
const MODS_PLUGIN = "readable-layout";
const modsPublished = (plugin: string, fingerprint: string): string => `${MODS_ROOT}/${plugin}/${fingerprint}`;

interface FsNode {
  kind: "dir" | "file" | "link";
  uid: number;
  gid: number;
  mode: number;
}

interface EngineCall {
  args: string[];
  argv: string[];
  kind: string;
  target: string | null;
}

function classifyEngineCall(args: string[]): EngineCall {
  if (args[0] === "version") return { args, argv: [], kind: "version", target: null };
  if (args[0] === "inspect") {
    const format = args[2] ?? "";
    const kind = format.startsWith("{{.Id}}") ? "inspect-id" : format.startsWith("{{json .Mounts}}") ? "inspect-ns" : "inspect-other";
    return { args, argv: [], kind, target: args[3] ?? null };
  }
  if (args[0] === "cp") return { args, argv: [], kind: "cp", target: (args.at(-1) ?? "").split(":")[0] ?? null };
  if (args[0] === "exec") {
    const index = args[1] === "--user" ? 3 : 1;
    const argv = args.slice(index + 1);
    const command = argv[0];
    let kind: string = command ?? "exec";
    if (command === "stat") kind = argv.includes("/opt") ? "stat-ns" : "stat-published";
    else if (command === "mkdir") kind = argv.includes("-m") ? "mkdir-ns" : argv.some((a) => a.includes("/.stage-")) ? "mkdir-stage" : "mkdir-parent";
    else if (command === "find" && argv.includes("-maxdepth")) kind = "find-staging";
    else if (command === "cat") kind = "cat-pid";
    else if (command === "bash") kind = "kill";
    return { args, argv, kind, target: args[index] ?? null };
  }
  return { args, argv: [], kind: "other", target: null };
}

function symbolicClearMask(spec: string): number | null {
  const bits: Record<string, Record<string, number>> = { u: { s: 0o4000, w: 0o200 }, g: { s: 0o2000, w: 0o020 }, o: { w: 0o002 } };
  let mask = 0;
  for (const clause of spec.split(",")) {
    const match = /^([ugo]+)-([sw]+)$/.exec(clause);
    if (!match) return null;
    for (const who of match[1]!) {
      for (const perm of match[2]!) {
        const bit = bits[who]?.[perm];
        if (bit === undefined) return null;
        mask |= bit;
      }
    }
  }
  return mask;
}

class FakeContainer {
  readonly nodes = new Map<string, FsNode>();

  constructor(readonly id: string, readonly user: string, readonly mounts: string[]) {
    this.put("/", "dir");
    this.put("/opt", "dir");
  }

  put(path: string, kind: FsNode["kind"], uid = 0, gid = 0, mode = kind === "dir" ? 0o755 : 0o644): void {
    this.nodes.set(path, { kind, uid, gid, mode });
  }

  below(path: string): string[] {
    return [...this.nodes.keys()].filter((key) => key.startsWith(`${path}/`));
  }

  snapshot(prefix: string): string {
    return JSON.stringify([...this.nodes].filter(([key]) => key === prefix || key.startsWith(`${prefix}/`)).sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  stagings(): string[] {
    return [...this.nodes.keys()].filter((key) => /\/\.stage-[^/]+$/.test(key));
  }

  private remove(path: string): void {
    for (const key of [...this.nodes.keys()]) if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
  }

  private move(from: string, to: string): void {
    for (const [key, node] of [...this.nodes]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      this.nodes.delete(key);
      this.nodes.set(to + key.slice(from.length), node);
    }
  }

  exec(argv: string[]): SandboxExecResult | null {
    const [command, ...rest] = argv;
    const ok = (stdout = ""): SandboxExecResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string): SandboxExecResult => ({ code: 1, stdout: "", stderr });
    switch (command) {
      case "stat": {
        if (rest[0] !== "-c" || rest[1] !== "%u %g %a %F") return null;
        const lines: string[] = [];
        let stderr = "";
        for (const path of rest.slice(2)) {
          const node = this.nodes.get(path);
          if (!node) {
            stderr += `stat: cannot statx '${path}': No such file or directory\n`;
            continue;
          }
          const type = node.kind === "dir" ? "directory" : node.kind === "file" ? "regular file" : "symbolic link";
          lines.push(`${node.uid} ${node.gid} ${node.mode.toString(8)} ${type}`);
        }
        return { code: stderr ? 1 : 0, stdout: lines.map((l) => `${l}\n`).join(""), stderr };
      }
      case "mkdir": {
        let args = rest;
        let mode = 0o755;
        if (args[0] === "-m") {
          mode = Number.parseInt(args[1] ?? "", 8);
          args = args.slice(2);
        }
        const path = args[0];
        if (args.length !== 1 || path === undefined || path.startsWith("-")) return null;
        if (this.nodes.has(path)) return fail(`mkdir: cannot create directory '${path}': File exists`);
        const parent = this.nodes.get(path.slice(0, path.lastIndexOf("/")) || "/");
        if (parent?.kind !== "dir") return fail(`mkdir: cannot create directory '${path}': No such file or directory`);
        this.put(path, "dir", 0, 0, mode);
        return ok();
      }
      case "chmod": {
        const path = rest[2];
        const cleared = rest[0] === "-R" && rest[1] !== undefined ? symbolicClearMask(rest[1]) : null;
        if (cleared === null || path === undefined) return null;
        if (!this.nodes.has(path)) return fail(`chmod: cannot access '${path}': No such file or directory`);
        for (const key of [path, ...this.below(path)]) {
          const node = this.nodes.get(key);
          if (node && node.kind !== "link") node.mode &= ~cleared;
        }
        return ok();
      }
      case "id":
        if (rest.length !== 1 || rest[0] !== "-u") return null;
        return ok(this.user === "root" || this.user === "0" || this.user.startsWith("0:") ? "0\n" : "1000\n");
      case "rm": {
        const path = rest[1];
        if (rest[0] !== "-rf" || path === undefined) return null;
        this.remove(path);
        return ok();
      }
      case "mv": {
        const flags = rest.filter((a) => a.startsWith("-"));
        const [from, to] = rest.filter((a) => !a.startsWith("-"));
        if (flags.some((f) => f !== "-T" && f !== "-n") || from === undefined || to === undefined) return null;
        if (!this.nodes.has(from)) return fail(`mv: cannot stat '${from}': No such file or directory`);
        const existing = this.nodes.get(to);
        if (flags.includes("-T")) {
          if (existing) {
            if (existing.kind !== "dir" || this.below(to).length > 0) return fail(`mv: cannot overwrite '${to}': Directory not empty`);
            this.remove(to);
          }
          this.move(from, to);
          return ok();
        }
        if (flags.includes("-n")) {
          if (!existing) this.move(from, to);
          return ok();
        }
        if (existing?.kind === "dir") {
          this.move(from, `${to}/${from.slice(from.lastIndexOf("/") + 1)}`);
          return ok();
        }
        this.remove(to);
        this.move(from, to);
        return ok();
      }
      case "find": {
        if (rest.includes("-maxdepth")) {
          const [dir, ...tail] = rest;
          if (dir === undefined || tail.join(" ") !== "-maxdepth 1 -mindepth 1 -type d -name .stage-* -printf %f\\n") return null;
          if (!this.nodes.has(dir)) return fail(`find: '${dir}': No such file or directory`);
          const names = [...this.nodes]
            .filter(([key, node]) => node.kind === "dir" && key.startsWith(`${dir}/.stage-`) && !key.slice(dir.length + 1).includes("/"))
            .map(([key]) => `${key.slice(dir.length + 1)}\n`);
          return ok(names.sort().join(""));
        }
        const path = rest[0];
        const format = rest[3];
        if (path === undefined || rest[1] !== "-xdev" || rest[2] !== "-printf" || (format !== "%u %g %m %y\\n" && format !== "%U %G %m %y\\n") || rest.length !== 4) return null;
        if (!this.nodes.has(path)) return fail(`find: '${path}': No such file or directory`);
        const lines = [path, ...this.below(path).sort()].map((key) => {
          const node = this.nodes.get(key)!;
          const owner = format === "%u %g %m %y\\n" ? "root root" : `${node.uid} ${node.gid}`;
          return `${owner} ${node.mode.toString(8)} ${node.kind === "dir" ? "d" : node.kind === "file" ? "f" : "l"}\n`;
        });
        return ok(lines.join(""));
      }
      case "cat":
        return ok("4242\n");
      case "bash":
        return ok();
      default:
        return null;
    }
  }
}

class FakeEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly names = new Map<string, string>();
  readonly calls: EngineCall[] = [];
  readonly events: string[] = [];
  readonly eventPlugins: Array<string | null> = [];
  readonly unknown: string[] = [];
  readonly hostTrees = new Map<string, Array<{ rel: string; mode: number }>>();
  readonly forced = new Map<string, SandboxExecResult>();
  before: (call: EngineCall) => void = () => {};

  add(container: FakeContainer, name: string): void {
    this.containers.set(container.id, container);
    this.names.set(name, container.id);
  }

  count(kind: string): number {
    return this.calls.filter((c) => c.kind === kind).length;
  }

  handle = async (_file: string, args: string[]): Promise<SandboxExecResult> => {
    const call = classifyEngineCall(args);
    if (call.kind === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
    this.calls.push(call);
    this.events.push(call.kind);
    this.eventPlugins.push(/(?:kory-mods|host\/mods)\/([a-z0-9-]+)/.exec(call.args.join(" "))?.[1] ?? null);
    this.before(call);
    const forced = this.forced.get(call.kind);
    if (forced) return forced;
    const container = call.target ? this.containers.get(call.target) : undefined;
    if (call.kind === "inspect-id") {
      const id = this.names.get(call.target ?? "");
      return id ? { code: 0, stdout: `${id}\trunning\t[]`, stderr: "" } : { code: 1, stdout: "", stderr: "No such container" };
    }
    if (!container) return { code: 1, stdout: "", stderr: `Error: No such container: ${call.target}` };
    if (call.kind === "inspect-ns") {
      const mounts = JSON.stringify(container.mounts.map((Destination) => ({ Destination })));
      return { code: 0, stdout: `${mounts}\t${JSON.stringify(container.user)}`, stderr: "" };
    }
    if (call.kind === "cp") {
      const staging = (args.at(-1) ?? "").split(":")[1] ?? "";
      const hostDir = (args[args.length - 2] ?? "").replace(/\/\.$/, "");
      if (container.nodes.get(staging)?.kind !== "dir") return { code: 1, stdout: "", stderr: "no such directory" };
      for (const entry of this.hostTrees.get(hostDir) ?? []) {
        const parts = entry.rel.split("/");
        for (let i = 1; i < parts.length; i++) container.put(`${staging}/${parts.slice(0, i).join("/")}`, "dir", 0, 0, 0o775);
        container.put(`${staging}/${entry.rel}`, "file", 0, 0, entry.mode);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    const result = container.exec(call.argv);
    if (result === null) {
      this.unknown.push(call.args.join(" "));
      return { code: 127, stdout: "", stderr: "unknown command" };
    }
    return result;
  };
}

interface ModRigOptions {
  user?: string;
  mounts?: string[];
  namespace?: boolean;
}

const modRigDirs: string[] = [];
afterEach(() => {
  for (const dir of modRigDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function makeModRig(options: ModRigOptions = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-mods-"));
  modRigDirs.push(stateDir);
  const projectDir = "/project/mods";
  const engine = new FakeEngine();
  const container = new FakeContainer(MODS_ID_A, options.user ?? "kory", options.mounts ?? ["/work", "/kory-run", "/home/kory/.claude"]);
  if (options.namespace !== false) container.put(MODS_ROOT, "dir");
  const name = containerNameFor(projectDir);
  engine.add(container, name);
  const svc = new SandboxService(makeDeps(projectDir, stateDir, engine.handle));
  writeSandboxSettings(join(stateDir, "sandbox.json"), "k", { enabled: true });
  await svc.detectEngine();
  const internals = svc as unknown as { lastReady: boolean; readyContainerId: string | null; ensure: () => Promise<unknown> };
  const rig = {
    svc,
    engine,
    container,
    name,
    projectDir,
    verify: (_copy: { plugin: string }): { ok: true } | { ok: false; reason: string } => ({ ok: true }),
    ensureCalls: 0,
    onEnsure: async (): Promise<void> => {},
    setReady(id: string | null): void {
      internals.readyContainerId = id;
    },
    setLastReady(value: boolean): void {
      internals.lastReady = value;
    },
    copy(plugin = MODS_PLUGIN, fingerprint = MODS_FP1) {
      const hostDir = `/host/mods/${plugin}`;
      engine.hostTrees.set(hostDir, [
        { rel: "plugin.json", mode: 0o644 },
        { rel: "hooks/hooks.json", mode: 0o666 },
        { rel: "bin/run", mode: 0o777 },
      ]);
      return { plugin, fingerprint, hostDir };
    },
    prepare(copies = [rig.copy()], signal: AbortSignal = new AbortController().signal) {
      return svc.prepareMods({
        attemptId: "attempt-1",
        copies,
        signal,
        verifyHostCopy: (copy) => {
          engine.events.push(`verify:${copy.plugin}`);
          engine.eventPlugins.push(copy.plugin);
          return rig.verify(copy);
        },
      });
    },
  };
  internals.ensure = () => {
    rig.ensureCalls++;
    return rig.onEnsure();
  };
  internals.lastReady = true;
  internals.readyContainerId = MODS_ID_A;
  return rig;
}

type ModRig = Awaited<ReturnType<typeof makeModRig>>;
type ModResult = Awaited<ReturnType<ModRig["prepare"]>>;

function okPreparation(result: ModResult): Extract<ModResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a prepared namespace, got ${JSON.stringify(result)}`);
  return result;
}

function omittedPlugins(result: ModResult): string[] {
  return okPreparation(result).diagnostics.omitted.map((o) => o.plugin);
}

const MUTATING_KINDS = ["mkdir-parent", "mkdir-stage", "cp", "chmod", "mv", "rm"];

test("prepareMods runs parents, then the host copy check, then cp, root permissions and publication", async () => {
  const rig = await makeModRig();
  const result = okPreparation(await rig.prepare([rig.copy("alpha"), rig.copy("beta")]));

  for (const plugin of ["alpha", "beta"]) {
    const order = rig.engine.events.filter((e, i) => rig.engine.eventPlugins[i] === plugin && ["mkdir-parent", "mkdir-stage", "cp", "chmod", "mv"].concat(`verify:${plugin}`).includes(e));
    expect(order, `${plugin}: parents, staging, host check, cp, permissions, publication`).toEqual([
      "mkdir-parent", "mkdir-stage", `verify:${plugin}`, "cp", "chmod", "mv",
    ]);
  }
  expect(result.references.map((r) => r.containerDir)).toEqual([modsPublished("alpha", MODS_FP1), modsPublished("beta", MODS_FP1)]);
  expect(rig.engine.unknown, "the fake engine must understand every command issued").toEqual([]);
});

test("prepareMods issues no engine call between the host copy check and its own cp", async () => {
  const rig = await makeModRig();
  okPreparation(await rig.prepare([rig.copy("alpha"), rig.copy("beta")]));

  const events = rig.engine.events;
  const cps = events.flatMap((e, i) => (e === "cp" ? [i] : []));
  expect(cps).toHaveLength(2);
  for (const i of cps) {
    expect(events[i - 1], `an await between the check and the cp lets the host copy drift unobserved: ${events.join(",")}`).toMatch(/^verify:/);
  }
});

test("a published mod is root owned and neither group nor other writable, staging gone", async () => {
  const rig = await makeModRig();
  let writableAtPublication: string[] = [];
  rig.engine.before = (call) => {
    if (call.kind !== "mv") return;
    writableAtPublication = [...rig.container.nodes].filter(([key, n]) => key.includes("/.stage-") && (n.mode & 0o022) !== 0).map(([key]) => key);
  };

  const result = okPreparation(await rig.prepare());

  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  const tree = [published, ...rig.container.below(published)];
  expect(tree.length, "the copied tree must be present under the final name").toBeGreaterThan(3);
  for (const key of tree) {
    const node = rig.container.nodes.get(key)!;
    expect(node.uid, `${key} must not belong to the agent user`).toBe(0);
    expect(node.mode & 0o022, `${key} must not be writable by group or others`).toBe(0);
  }
  expect(writableAtPublication, "the tree must be locked down BEFORE the rename exposes it").toEqual([]);
  expect(rig.container.stagings()).toEqual([]);
  expect(result.references).toEqual([{ plugin: MODS_PLUGIN, fingerprint: MODS_FP1, containerDir: published }]);
});

test("mod publication never follows links, changes ownership or adds a mount", async () => {
  const rig = await makeModRig();
  okPreparation(await rig.prepare());

  const flat = rig.engine.calls.map((c) => c.args.join(" "));
  const cp = rig.engine.calls.find((c) => c.kind === "cp")!;
  expect(cp.args.slice(0, 1).concat(cp.args.slice(1, -2)), "cp takes no option at all").toEqual(["cp"]);
  for (const line of flat) {
    expect(line, `unexpected link-following, ownership or mount option in: ${line}`).not.toMatch(/(^| )(-L|--follow-link|--dereference|-v|--mount)( |$)|chown/);
  }
  const destinations = rig.engine.calls.flatMap((c) => c.args).filter((a) => a.includes("/opt/") || a.includes(":/"));
  for (const destination of destinations) {
    expect(destination.replace(/^[0-9a-f]{64}:/, ""), "every written path lives under the reserved namespace").toMatch(/^\/opt\/kory-mods(\/|$)|^\/host\//);
  }
  expect(rig.container.below("/kory-run").concat(rig.container.below("/work"), rig.container.below("/home"))).toEqual([]);
});

test.each([
  ["cp", ["mv", "chmod"]],
  ["chmod", ["mv"]],
  ["mv", []],
] as const)("a %s failure returns no reference and removes only the staging it created", async (step, forbiddenAfter) => {
  const rig = await makeModRig();
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign`, "dir");
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign/keep`, "file");
  const foreign = rig.container.snapshot(`${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign`);
  rig.engine.forced.set(step, { code: 1, stdout: "", stderr: `${step} failed` });

  const result = await rig.prepare();

  expect(okPreparation(result).references, `a ${step} failure must not publish a reference`).toEqual([]);
  expect(omittedPlugins(result)).toEqual([MODS_PLUGIN]);
  const kinds = rig.engine.calls.map((c) => c.kind);
  for (const later of forbiddenAfter) expect(kinds, `${later} must not run after a failed ${step}`).not.toContain(later);
  expect(rig.container.nodes.has(modsPublished(MODS_PLUGIN, MODS_FP1)), "no incomplete final version").toBe(false);
  expect(rig.container.snapshot(`${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign`), "a staging this operation did not create is left alone").toBe(foreign);
  expect(rig.container.stagings()).toEqual([`${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign`]);
});

test("a host copy that fails its check at cp time yields no cp, no publication, no reference", async () => {
  const rig = await makeModRig();
  rig.verify = () => ({ ok: false, reason: "host-copy-drifted" });

  const result = await rig.prepare();

  expect(okPreparation(result).references).toEqual([]);
  expect(okPreparation(result).diagnostics.omitted).toEqual([{ plugin: MODS_PLUGIN, reason: "host-copy-drifted" }]);
  const kinds = rig.engine.calls.map((c) => c.kind);
  expect(kinds, "no content may reach the container once the check failed").not.toContain("cp");
  expect(kinds).not.toContain("mv");
  expect(rig.container.stagings(), "the staging created for this attempt is removed").toEqual([]);
  expect(rig.container.nodes.has(modsPublished(MODS_PLUGIN, MODS_FP1))).toBe(false);
});

test("a throwing host copy check is an omission and the next copy is still prepared", async () => {
  const rig = await makeModRig();
  rig.verify = (copy) => {
    if (copy.plugin === "alpha") throw new Error("disk read failed");
    return { ok: true };
  };
  const reports: Array<[string, string]> = [];
  onDeckError((scope, text) => reports.push([scope, text]));

  const result = await rig.prepare([rig.copy("alpha"), rig.copy("beta")]);
  onDeckError(() => {});

  expect(omittedPlugins(result)).toEqual(["alpha"]);
  expect(okPreparation(result).references.map((r) => r.plugin)).toEqual(["beta"]);
  expect(reports.some(([scope]) => scope === "sandbox"), "the failure leaves a trace in the log sink").toBe(true);
  expect(rig.engine.calls.filter((c) => c.kind === "cp")).toHaveLength(1);
  expect(rig.container.stagings()).toEqual([]);
});

const ABORT_POINTS = ["inspect-ns", "stat-ns", "mkdir-parent", "stat-published", "mkdir-stage", "cp", "chmod", "mv"] as const;

test.each(ABORT_POINTS)("an abort during %s returns no reference and removes only the staging it created", async (point) => {
  const rig = await makeModRig({ namespace: point === "stat-ns" ? false : true });
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign`, "dir");
  const controller = new AbortController();
  let abortedAt = -1;
  rig.engine.before = (call) => {
    if (call.kind === point && abortedAt < 0) {
      abortedAt = rig.engine.calls.length;
      controller.abort();
    }
  };

  const result = await rig.prepare([rig.copy()], controller.signal);

  expect(result.ok, "an aborted preparation must not hand out references").toBe(false);
  const after = rig.engine.calls.slice(abortedAt);
  for (const call of after) {
    expect(["rm", point], `after the abort only the cleanup of an own staging may run, saw ${call.args.join(" ")}`).toContain(call.kind);
  }
  expect(rig.container.stagings(), "only the foreign staging remains").toEqual([`${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign`]);
  if (point === "mv") {
    expect(rig.container.nodes.has(modsPublished(MODS_PLUGIN, MODS_FP1)), "an already published version is never removed").toBe(true);
  }
});

test("an already aborted signal prepares nothing and does not touch the engine", async () => {
  const rig = await makeModRig();
  const controller = new AbortController();
  controller.abort();

  const result = await rig.prepare([rig.copy()], controller.signal);

  expect(result.ok).toBe(false);
  expect(rig.engine.calls).toEqual([]);
  expect(rig.ensureCalls, "an aborted attempt must not start or create a container").toBe(0);
});

test("an abort raised while the container is being ensured stops before any engine call", async () => {
  const rig = await makeModRig();
  const controller = new AbortController();
  rig.onEnsure = async () => controller.abort();

  const result = await rig.prepare([rig.copy()], controller.signal);

  expect(result.ok).toBe(false);
  expect(rig.engine.calls, "the abort observed after ensure() must prevent every container write").toEqual([]);
});

test.each([
  ["the container is not known to be running", (rig: ModRig) => rig.setLastReady(false)],
  ["no container id has been captured", (rig: ModRig) => rig.setReady(null)],
])("a preparation where %s is refused without any engine call", async (_name, arrange) => {
  const rig = await makeModRig();
  arrange(rig);

  const result = await rig.prepare();

  expect(result.ok, "writing into a container the service does not consider ready would target a stale id").toBe(false);
  expect(rig.engine.calls).toEqual([]);
});

test("a second preparation of a published version reuses it without a cp", async () => {
  const rig = await makeModRig();
  const first = okPreparation(await rig.prepare());
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  const before = rig.container.snapshot(published);

  const second = okPreparation(await rig.prepare());

  expect(second.references).toEqual(first.references);
  expect(rig.engine.count("cp"), "the second tile reuses the root version").toBe(1);
  expect(rig.engine.count("mkdir-stage")).toBe(1);
  expect(rig.container.snapshot(published), "reuse leaves the published tree untouched").toBe(before);
  expect(rig.engine.unknown).toEqual([]);
});

test("a new fingerprint is published next to the old version without replacing it", async () => {
  const rig = await makeModRig();
  okPreparation(await rig.prepare([rig.copy(MODS_PLUGIN, MODS_FP1)]));
  const oldSnapshot = rig.container.snapshot(modsPublished(MODS_PLUGIN, MODS_FP1));

  const result = okPreparation(await rig.prepare([rig.copy(MODS_PLUGIN, MODS_FP2)]));

  expect(result.references.map((r) => r.containerDir)).toEqual([modsPublished(MODS_PLUGIN, MODS_FP2)]);
  expect(rig.container.snapshot(modsPublished(MODS_PLUGIN, MODS_FP1)), "the older version stays as it was").toBe(oldSnapshot);
  expect(rig.container.below(modsPublished(MODS_PLUGIN, MODS_FP2)).length).toBeGreaterThan(0);
});

test("simultaneous preparations of two fingerprints of one plugin each publish their own version", async () => {
  const rig = await makeModRig();

  const [one, two] = await Promise.all([
    rig.prepare([rig.copy(MODS_PLUGIN, MODS_FP1)]),
    rig.prepare([rig.copy(MODS_PLUGIN, MODS_FP2)]),
  ]);

  expect(okPreparation(one).references.map((r) => r.containerDir)).toEqual([modsPublished(MODS_PLUGIN, MODS_FP1)]);
  expect(okPreparation(two).references.map((r) => r.containerDir), "a version must never be answered with another fingerprint").toEqual([modsPublished(MODS_PLUGIN, MODS_FP2)]);
  expect(rig.container.nodes.has(modsPublished(MODS_PLUGIN, MODS_FP1))).toBe(true);
  expect(rig.container.nodes.has(modsPublished(MODS_PLUGIN, MODS_FP2))).toBe(true);
});

test("three simultaneous preparations of the same two mods copy each version once", async () => {
  const rig = await makeModRig();
  const copies = [rig.copy("alpha"), rig.copy("beta")];

  const results = await Promise.all([rig.prepare(copies), rig.prepare(copies), rig.prepare(copies)]);

  for (const result of results) {
    expect(okPreparation(result).references.map((r) => r.plugin).sort()).toEqual(["alpha", "beta"]);
  }
  expect(rig.engine.count("cp"), "N tiles must not multiply the cp by N").toBe(2);
  expect(rig.container.stagings()).toEqual([]);
});

test("overlapping simultaneous preparations copy each shared version once", async () => {
  const rig = await makeModRig();
  const alpha = rig.copy("alpha");
  const beta = rig.copy("beta");

  const results = await Promise.all([rig.prepare([alpha]), rig.prepare([alpha, beta])]);

  expect(results.map((r) => okPreparation(r).references.map((x) => x.plugin).sort())).toEqual([["alpha"], ["alpha", "beta"]]);
  expect(rig.engine.count("cp"), "the sharing is per version, not per identical request").toBe(2);
});

test("one tile aborting its preparation does not abort a simultaneous preparation of the same version", async () => {
  const rig = await makeModRig();
  const copies = [rig.copy()];
  const first = new AbortController();
  rig.engine.before = (call) => {
    if (call.kind === "cp") first.abort();
  };

  const [aborted, surviving] = await Promise.all([rig.prepare(copies, first.signal), rig.prepare(copies, new AbortController().signal)]);

  expect(aborted.ok, "the aborted attempt itself must not hand out references").toBe(false);
  expect(okPreparation(surviving).references.map((r) => r.containerDir), "another tile's cancellation must not cancel this one").toEqual([modsPublished(MODS_PLUGIN, MODS_FP1)]);
  expect(rig.container.stagings()).toEqual([]);
});

test("two simultaneous first uses of a fresh container both obtain the reserved namespace", async () => {
  const rig = await makeModRig({ namespace: false });

  const results = await Promise.all([rig.prepare([rig.copy("alpha")]), rig.prepare([rig.copy("beta")])]);

  expect(results.map((r) => r.ok), `the losing creator must re-check the namespace instead of failing: ${JSON.stringify(results)}`).toEqual([true, true]);
});

const NONCONFORMING_PUBLISHED: Array<[string, (c: FakeContainer, path: string) => void]> = [
  ["a symlink", (c, p) => c.put(p, "link")],
  ["a regular file", (c, p) => c.put(p, "file")],
  ["a directory writable by the group", (c, p) => c.put(p, "dir", 0, 0, 0o775)],
  ["a directory owned by the agent user", (c, p) => c.put(p, "dir", 1000, 1000, 0o755)],
  ["a directory owned by the agent user with group root", (c, p) => c.put(p, "dir", 1000, 0, 0o755)],
  ["a directory holding an agent writable file", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/plugin.json`, "file", 1000, 1000, 0o666);
  }],
  ["a directory holding a symlink", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/plugin.json`, "link");
  }],
  ["a directory holding a file owned by the agent user with group root", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/plugin.json`, "file", 1000, 0, 0o644);
  }],
  ["a directory holding a file with an agent group and owner root", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/plugin.json`, "file", 0, 1000, 0o644);
  }],
  ["a directory holding a group writable file", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/plugin.json`, "file", 0, 0, 0o664);
  }],
  ["a directory holding an other writable file", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/plugin.json`, "file", 0, 0, 0o646);
  }],
  ["a directory holding a nested directory writable by the group", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/hooks`, "dir", 0, 0, 0o775);
  }],
  ["a directory holding a setuid file", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/helper`, "file", 0, 0, 0o4755);
  }],
  ["a directory holding a setgid file", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/helper`, "file", 0, 0, 0o2755);
  }],
  ["a directory holding a setgid directory", (c, p) => {
    c.put(p, "dir");
    c.put(`${p}/hooks`, "dir", 0, 0, 0o2755);
  }],
];

test.each([
  ["a column beyond the four expected", "0 0 644 f x\n"],
  ["a type outside directory and file", "0 0 755 d\n0 0 644 p\n"],
  ["a non octal mode", "0 0 6x4 f\n"],
  ["no line at all", ""],
  ["free text", "find: unknown\n"],
] as Array<[string, string]>)("a published tree whose listing has %s is refused and not reused", async (_name, stdout) => {
  const rig = await makeModRig();
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
  rig.container.put(published, "dir");
  rig.container.put(`${published}/plugin.json`, "file");
  rig.engine.forced.set("find", { code: 0, stdout, stderr: "" });

  const result = await rig.prepare();

  expect(okPreparation(result).references, "an unreadable tree listing must never read as conforming").toEqual([]);
  expect(omittedPlugins(result)).toEqual([MODS_PLUGIN]);
  expect(rig.engine.count("cp")).toBe(0);
});

test("a published tree whose listing fails is refused and not reused", async () => {
  const rig = await makeModRig();
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
  rig.container.put(published, "dir");
  rig.engine.forced.set("find", { code: 1, stdout: "0 0 755 d\n", stderr: "find: permission denied" });

  const result = await rig.prepare();

  expect(okPreparation(result).references).toEqual([]);
});

test("a concurrent winner whose tree holds an agent writable file is refused", async () => {
  const rig = await makeModRig();
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  rig.engine.before = (call) => {
    if (call.kind !== "mv") return;
    rig.container.put(published, "dir");
    rig.container.put(`${published}/plugin.json`, "file", 1000, 1000, 0o666);
  };

  const result = await rig.prepare();

  expect(okPreparation(result).references, "the winner's root directory looks fine, its content does not").toEqual([]);
  expect(omittedPlugins(result)).toEqual([MODS_PLUGIN]);
});

test.each(NONCONFORMING_PUBLISHED)("a final version that is %s is refused and left as found", async (_name, seed) => {
  const rig = await makeModRig();
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
  seed(rig.container, published);
  const before = rig.container.snapshot(published);

  const result = await rig.prepare();

  expect(okPreparation(result).references, `an unknown final version must not be referenced (engine saw: ${rig.engine.events.join(",")})`).toEqual([]);
  expect(omittedPlugins(result)).toEqual([MODS_PLUGIN]);
  expect(rig.container.snapshot(published), "a colliding version is never overwritten").toBe(before);
  expect(rig.engine.count("cp")).toBe(0);
  expect(rig.container.stagings()).toEqual([]);
});

test("a conforming published tree is reused without a cp", async () => {
  const rig = await makeModRig();
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
  rig.container.put(published, "dir");
  rig.container.put(`${published}/plugin.json`, "file");

  const result = await rig.prepare();

  expect(okPreparation(result).references.map((r) => r.containerDir), `unknown commands: ${rig.engine.unknown.join(" | ")}`).toEqual([published]);
  expect(rig.engine.count("cp")).toBe(0);
});

test("a concurrent winner that is not conforming is refused and not overwritten", async () => {
  const rig = await makeModRig();
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  rig.engine.before = (call) => {
    if (call.kind !== "mv") return;
    rig.container.put(published, "dir", 1000, 1000, 0o777);
    rig.container.put(`${published}/payload`, "file", 1000, 1000, 0o666);
  };

  const result = await rig.prepare();

  expect(okPreparation(result).references).toEqual([]);
  expect(omittedPlugins(result)).toEqual([MODS_PLUGIN]);
  expect([...rig.container.below(published)].sort(), "the winner's content is untouched, nothing nested into it").toEqual([`${published}/payload`]);
  expect(rig.container.stagings()).toEqual([]);
});

test("a concurrent winner that is conforming is accepted as the published version", async () => {
  const rig = await makeModRig();
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  rig.engine.before = (call) => {
    if (call.kind !== "mv") return;
    rig.container.put(published, "dir");
    rig.container.put(`${published}/plugin.json`, "file");
  };

  const result = await rig.prepare();

  expect(okPreparation(result).references.map((r) => r.containerDir), `unknown commands: ${rig.engine.unknown.join(" | ")}`).toEqual([published]);
  expect(rig.container.stagings()).toEqual([]);
});

const UNSAFE_NAMESPACE_INSPECTIONS: Array<[string, ModRigOptions]> = [
  ["a mount on /", { mounts: ["/"] }],
  ["a mount on /opt", { mounts: ["/work", "/opt"] }],
  ["a mount on /opt/", { mounts: ["/opt/"] }],
  ["a mount on /opt/kory-mods", { mounts: ["/opt/kory-mods"] }],
  ["a mount on /opt/kory-mods/", { mounts: ["/opt/kory-mods/"] }],
  ["a mount below /opt/kory-mods", { mounts: ["/opt/kory-mods/readable-layout"] }],
  ["an empty Config.User", { user: "" }],
  ["Config.User root", { user: "root" }],
  ["Config.User 0", { user: "0" }],
  ["Config.User 0:0", { user: "0:0" }],
  ["Config.User 0:1000", { user: "0:1000" }],
];

test.each(UNSAFE_NAMESPACE_INSPECTIONS)("a container with %s is refused before any write", async (_name, options) => {
  const rig = await makeModRig(options);

  const result = await rig.prepare();

  expect(result.ok, "the reserved namespace contract is violated").toBe(false);
  expect(rig.engine.calls.filter((c) => MUTATING_KINDS.includes(c.kind) || c.kind === "mkdir-ns")).toEqual([]);
  expect(rig.container.below(MODS_ROOT)).toEqual([]);
});

test.each([
  ["Config.User kory", { user: "kory" }],
  ["Config.User 1000", { user: "1000" }],
  ["Config.User 1000:1000", { user: "1000:1000" }],
  ["a mount on a lookalike /optional", { mounts: ["/optional", "/opt-extra", "/work"] }],
  ["a mount on a sibling of the namespace /opt/other", { mounts: ["/opt/other"] }],
] as Array<[string, ModRigOptions]>)("a container with %s is accepted", async (_name, options) => {
  const rig = await makeModRig(options);

  const result = await rig.prepare();

  expect(okPreparation(result).references).toHaveLength(1);
});

test("a failing inspect refuses the namespace instead of assuming it safe", async () => {
  const rig = await makeModRig();
  rig.engine.forced.set("inspect-ns", { code: 1, stdout: "", stderr: "inspect failed" });

  const result = await rig.prepare();

  expect(result.ok).toBe(false);
  expect(rig.engine.calls.filter((c) => MUTATING_KINDS.includes(c.kind))).toEqual([]);
});

const UNSAFE_NAMESPACE_STATS: Array<[string, (c: FakeContainer) => void]> = [
  ["/opt group writable (775)", (c) => c.put("/opt", "dir", 0, 0, 0o775)],
  ["/opt other writable (757)", (c) => c.put("/opt", "dir", 0, 0, 0o757)],
  ["/opt owned by the agent user", (c) => c.put("/opt", "dir", 1000, 1000, 0o755)],
  ["/opt owned by the agent user with group root", (c) => c.put("/opt", "dir", 1000, 0, 0o755)],
  ["/opt a symlink", (c) => c.put("/opt", "link")],
  ["the namespace owned by the agent user with group root", (c) => c.put(MODS_ROOT, "dir", 1000, 0, 0o755)],
  ["the namespace group writable (775)", (c) => c.put(MODS_ROOT, "dir", 0, 0, 0o775)],
  ["the namespace other writable (777)", (c) => c.put(MODS_ROOT, "dir", 0, 0, 0o777)],
  ["the namespace owned by the agent user", (c) => c.put(MODS_ROOT, "dir", 1000, 1000, 0o755)],
  ["the namespace a symlink", (c) => c.put(MODS_ROOT, "link")],
  ["the namespace a regular file", (c) => c.put(MODS_ROOT, "file", 0, 0, 0o755)],
];

test.each(UNSAFE_NAMESPACE_STATS)("%s is refused before any write", async (_name, seed) => {
  const rig = await makeModRig();
  seed(rig.container);

  const result = await rig.prepare();

  expect(result.ok).toBe(false);
  expect(rig.engine.calls.filter((c) => MUTATING_KINDS.includes(c.kind) || c.kind === "mkdir-ns")).toEqual([]);
});

test.each([
  ["empty output with success", { code: 0, stdout: "", stderr: "" }],
  ["a single line", { code: 0, stdout: "0 0 755 directory\n", stderr: "" }],
  ["three lines", { code: 0, stdout: "0 0 755 directory\n0 0 755 directory\n0 0 755 directory\n", stderr: "" }],
  ["free text", { code: 0, stdout: "stat: unrecognised\n", stderr: "" }],
  ["an extra column", { code: 0, stdout: "0 0 755 directory x\n0 0 755 directory x\n", stderr: "" }],
  ["a single word type that is not a directory", { code: 0, stdout: "0 0 755 fifo\n0 0 755 directory\n", stderr: "" }],
  ["a second line that is not a directory", { code: 0, stdout: "0 0 755 directory\n0 0 755 fifo\n", stderr: "" }],
  ["a root group but an agent owner", { code: 0, stdout: "1000 0 755 directory\n0 0 755 directory\n", stderr: "" }],
  ["a non octal mode",{ code: 0, stdout: "0 0 7x5 directory\n0 0 755 directory\n", stderr: "" }],
  ["a multi word file type", { code: 0, stdout: "0 0 755 symbolic link\n0 0 755 directory\n", stderr: "" }],
] as Array<[string, SandboxExecResult]>)("a namespace stat answering %s is refused", async (_name, forced) => {
  const rig = await makeModRig();
  rig.engine.forced.set("stat-ns", forced);

  const result = await rig.prepare();

  expect(result.ok, "an unrecognised stat output must never read as safe").toBe(false);
  expect(rig.engine.calls.filter((c) => MUTATING_KINDS.includes(c.kind))).toEqual([]);
});

test("an absent namespace is created once in mode 755 as root then checked again", async () => {
  const rig = await makeModRig({ namespace: false });

  const result = await rig.prepare();

  expect(okPreparation(result).references).toHaveLength(1);
  const kinds = rig.engine.calls.map((c) => c.kind);
  expect(kinds.filter((k) => k === "mkdir-ns")).toHaveLength(1);
  expect(kinds.filter((k) => k === "stat-ns"), "the created directory is re-checked, not trusted").toHaveLength(2);
  const create = rig.engine.calls.find((c) => c.kind === "mkdir-ns")!;
  expect(create.args).toEqual(["exec", "--user", "root", MODS_ID_A, "mkdir", "-m", "755", MODS_ROOT]);
  expect(rig.container.nodes.get(MODS_ROOT)).toEqual({ kind: "dir", uid: 0, gid: 0, mode: 0o755 });
});

test("a namespace that fails to be created, or is created writable, is refused", async () => {
  const failing = await makeModRig({ namespace: false });
  failing.engine.forced.set("mkdir-ns", { code: 1, stdout: "", stderr: "mkdir failed" });
  expect((await failing.prepare()).ok).toBe(false);
  expect(failing.engine.calls.filter((c) => MUTATING_KINDS.includes(c.kind))).toEqual([]);

  const writable = await makeModRig({ namespace: false });
  writable.engine.before = (call) => {
    if (call.kind === "stat-ns" && writable.engine.count("stat-ns") === 2) writable.container.put(MODS_ROOT, "dir", 0, 0, 0o777);
  };
  expect((await writable.prepare()).ok, "the re-stat after creation must be honoured").toBe(false);
  expect(writable.engine.calls.filter((c) => MUTATING_KINDS.includes(c.kind))).toEqual([]);

  const noOpt = await makeModRig({ namespace: false });
  noOpt.container.nodes.delete("/opt");
  expect((await noOpt.prepare()).ok).toBe(false);
});

test("a verified namespace is not inspected again for the same container id", async () => {
  const rig = await makeModRig();

  okPreparation(await rig.prepare());
  okPreparation(await rig.prepare([rig.copy("other-plugin")]));

  expect(rig.engine.count("inspect-ns")).toBe(1);
  expect(rig.engine.count("stat-ns")).toBe(1);
});

test("a preparation started after the container was replaced does not join the one still running on the old id", async () => {
  const rig = await makeModRig();
  const copies = [rig.copy()];
  const replacement = new FakeContainer(MODS_ID_B, "kory", ["/work"]);
  replacement.put(MODS_ROOT, "dir");

  let onNew: ReturnType<typeof rig.prepare> | null = null;
  rig.engine.before = (call) => {
    if (call.kind !== "mkdir-parent" || onNew) return;
    rig.engine.add(replacement, rig.name);
    rig.setReady(MODS_ID_B);
    onNew = rig.prepare(copies);
  };
  const oldResult = await rig.prepare(copies);
  const newResult = await onNew!;

  expect(okPreparation(oldResult).containerId).toBe(MODS_ID_A);
  expect(okPreparation(newResult).containerId, "the sharing key must carry the container id").toBe(MODS_ID_B);
  expect(replacement.below(modsPublished(MODS_PLUGIN, MODS_FP1)).length, "the replacement container received its own copy").toBeGreaterThan(0);
});

test("a replacement container is inspected afresh even when the previous id was verified", async () => {
  const rig = await makeModRig();
  okPreparation(await rig.prepare());
  const replacement = new FakeContainer(MODS_ID_B, "root", ["/work"]);
  replacement.put(MODS_ROOT, "dir");
  rig.engine.add(replacement, rig.name);
  rig.setReady(MODS_ID_B);

  const result = await rig.prepare([rig.copy("other-plugin")]);

  expect(result.ok, "the cache is keyed by the container id, not by the project or name").toBe(false);
  expect(rig.engine.count("inspect-ns")).toBe(2);
  expect(replacement.below(MODS_ROOT)).toEqual([]);
});

test("every preparation call targets the pinned container id, never its name or a replacement", async () => {
  const rig = await makeModRig();
  const replacement = new FakeContainer(MODS_ID_B, "kory", ["/work"]);
  replacement.put(MODS_ROOT, "dir");
  rig.engine.before = (call) => {
    if (call.kind !== "stat-published") return;
    rig.engine.add(replacement, rig.name);
    rig.setReady(MODS_ID_B);
  };

  const result = okPreparation(await rig.prepare([rig.copy("alpha"), rig.copy("beta")]));

  const targets = new Set(rig.engine.calls.map((c) => c.target));
  expect([...targets], "a replaced container must receive nothing").toEqual([MODS_ID_A]);
  expect(rig.engine.calls.some((c) => c.args.includes(rig.name))).toBe(false);
  expect(replacement.below(MODS_ROOT)).toEqual([]);
  expect(result.containerId).toBe(MODS_ID_A);
});

test("the id returned by prepareMods is the id launchInfo hands to the spawn", async () => {
  const rig = await makeModRig();

  const result = okPreparation(await rig.prepare());

  expect(result.containerId).toBe(rig.svc.launchInfo()!.containerId);
  expect(result.engine).toBe(rig.svc.launchInfo()!.engine);
});

function launchFor(rig: ModRig, containerId: string) {
  return { engine: "docker" as const, container: rig.name, containerId, runDirHost: "", workSource: "", protection: NOT_APPLICABLE_PLAN };
}

test("exec command, pid read and kill stay on the id pinned at exec time after the container is replaced", async () => {
  const rig = await makeModRig();
  const replacement = new FakeContainer(MODS_ID_B, "kory", ["/work"]);
  const first = rig.svc.execCommand(launchFor(rig, MODS_ID_A), "tile-one");
  rig.engine.add(replacement, rig.name);
  rig.setReady(MODS_ID_B);
  const second = rig.svc.execCommand(launchFor(rig, MODS_ID_B), "tile-two");

  await rig.svc.cleanupSession("tile-one");
  const afterFirst = rig.engine.calls.map((c) => [c.kind, c.target]);
  await rig.svc.cleanupSession("tile-two");
  const afterSecond = rig.engine.calls.map((c) => [c.kind, c.target]).slice(afterFirst.length);

  expect(first).toContain(MODS_ID_A);
  expect(first).not.toContain(rig.name);
  expect(second).toContain(MODS_ID_B);
  expect(afterFirst, "tile-one's cleanup must not reach the replacement").toEqual([["cat-pid", MODS_ID_A], ["kill", MODS_ID_A]]);
  expect(afterSecond).toEqual([["cat-pid", MODS_ID_B], ["kill", MODS_ID_B]]);
});

test("an invalid inspected container id prevents every exec and launch", async () => {
  const rig = await makeModRig();
  rig.engine.forced.set("other", { code: 0, stdout: "", stderr: "" });
  rig.engine.forced.set("inspect-id", { code: 0, stdout: "kory-sbx-0123456789ab\trunning\t[]", stderr: "" });

  await expect(SandboxService.prototype.ensure.call(rig.svc)).rejects.toThrow("sandbox-container-id-invalid");

  expect(() => rig.svc.launchInfo()).toThrow("sandbox enabled but container not ready");
  expect(rig.engine.calls.map((call) => call.args[0]), "the invalid engine result must not reach an exec command").not.toContain("exec");
});

test("status rejects an invalid inspected container id", async () => {
  const rig = await makeModRig();
  rig.engine.forced.set("inspect-id", { code: 0, stdout: "kory-sbx-0123456789ab\trunning\t[]", stderr: "" });

  await expect(rig.svc.status()).rejects.toThrow("sandbox-container-id-invalid");
});

test("removing another project's invalid-id container preserves this project's ready state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cp-sandbox-svc-other-id-"));
  const projectDir = "/project/mine";
  const otherName = containerNameFor("/project/other");
  const readyContainerId = "a".repeat(64);
  const svc = new SandboxService(
    makeDeps(projectDir, stateDir, async (_file, args) => {
      if (args[0] === "version") return { code: 0, stdout: "1.2.3", stderr: "" };
      if (args[0] === "inspect" && args.some((arg) => arg.includes("kory.sandbox"))) return { code: 0, stdout: "1\n", stderr: "" };
      if (args[0] === "inspect" && args[2]?.startsWith("{{.Id}}")) {
        return { code: 0, stdout: `kory-sbx-0123456789ab\trunning\t[]`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    })
  );
  const internals = svc as unknown as { lastReady: boolean; readyContainerId: string | null };
  await svc.detectEngine();
  internals.lastReady = true;
  internals.readyContainerId = readyContainerId;

  await expect(svc.containerAction(otherName, "remove")).rejects.toThrow("sandbox-container-id-invalid");

  expect(internals.lastReady).toBe(true);
  expect(internals.readyContainerId).toBe(readyContainerId);
  rmSync(stateDir, { recursive: true, force: true });
});

test("execCommand does not retain a target when the container id is invalid", async () => {
  const rig = await makeModRig();
  const internals = rig.svc as unknown as { sessionTargets: Map<string, unknown> };

  expect(() => rig.svc.execCommand(launchFor(rig, "invalid-container-id"), "tile-invalid-target")).toThrow("sandbox-container-id-invalid");

  expect(internals.sessionTargets.has("tile-invalid-target")).toBe(false);
});

async function collectingReports<T>(body: (reports: Array<[string, string]>) => Promise<T>): Promise<T> {
  const reports: Array<[string, string]> = [];
  onDeckError((scope, text) => reports.push([scope, text]));
  try {
    return await body(reports);
  } finally {
    onDeckError(() => {});
  }
}

const orphanReports = (reports: Array<[string, string]>): Array<[string, string]> => reports.filter(([, text]) => /orphan/i.test(text));

test("a staging left by another Deck is reported once, never deleted, and does not block the launch", async () => {
  await collectingReports(async (reports) => {
    const rig = await makeModRig();
    const foreignDir = `${MODS_ROOT}/${MODS_PLUGIN}/.stage-foreign`;
    rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
    rig.container.put(foreignDir, "dir");
    rig.container.put(`${foreignDir}/partial`, "file");
    const before = rig.container.snapshot(foreignDir);

    const first = await rig.prepare();
    const second = await rig.prepare([rig.copy("other-plugin")]);

    expect(okPreparation(first).references, "an orphan never blocks the preparation").toHaveLength(1);
    expect(okPreparation(second).references).toHaveLength(1);
    const orphans = orphanReports(reports);
    expect(orphans, `exactly one report per container, got ${JSON.stringify(reports)}`).toHaveLength(1);
    expect(orphans[0]![0]).toBe("sandbox");
    expect(orphans[0]![1]).toContain(MODS_ID_A);
    expect(orphans[0]![1]).toContain(`${MODS_PLUGIN}/.stage-foreign`);
    expect(rig.container.snapshot(foreignDir), "a staging this Deck did not create is never removed").toBe(before);
    expect(rig.engine.count("rm"), "a successful run removes nothing").toBe(0);
    expect(rig.engine.unknown).toEqual([]);
  });
});

test("orphan stagings of several plugins are aggregated into one report", async () => {
  await collectingReports(async (reports) => {
    const rig = await makeModRig();
    for (const plugin of ["alpha", "beta"]) {
      rig.container.put(`${MODS_ROOT}/${plugin}`, "dir");
      rig.container.put(`${MODS_ROOT}/${plugin}/.stage-old`, "dir");
    }

    okPreparation(await rig.prepare([rig.copy("alpha"), rig.copy("beta")]));

    const orphans = orphanReports(reports);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]![1]).toContain("alpha/.stage-old");
    expect(orphans[0]![1]).toContain("beta/.stage-old");
  });
});

test("a replacement container with an orphan staging gets its own report", async () => {
  await collectingReports(async (reports) => {
    const rig = await makeModRig();
    rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
    rig.container.put(`${MODS_ROOT}/${MODS_PLUGIN}/.stage-first`, "dir");
    okPreparation(await rig.prepare());
    const replacement = new FakeContainer(MODS_ID_B, "kory", ["/work"]);
    replacement.put(MODS_ROOT, "dir");
    replacement.put(`${MODS_ROOT}/${MODS_PLUGIN}`, "dir");
    replacement.put(`${MODS_ROOT}/${MODS_PLUGIN}/.stage-second`, "dir");
    rig.engine.add(replacement, rig.name);
    rig.setReady(MODS_ID_B);

    okPreparation(await rig.prepare());

    const orphans = orphanReports(reports);
    expect(orphans, "one report per container id").toHaveLength(2);
    expect(orphans[1]![1]).toContain(MODS_ID_B);
    expect(orphans[1]![1]).toContain(".stage-second");
    expect(orphans[1]![1]).not.toContain(".stage-first");
  });
});

test("no orphan staging means no report, and a staging of a simultaneous preparation is not an orphan", async () => {
  await collectingReports(async (reports) => {
    const rig = await makeModRig();
    let second: ReturnType<typeof rig.prepare> | null = null;
    let stagingsSeenBySecond = -1;
    rig.engine.before = (call) => {
      if (call.kind !== "cp" || second) return;
      stagingsSeenBySecond = rig.container.stagings().length;
      second = rig.prepare([rig.copy(MODS_PLUGIN, MODS_FP2)]);
    };

    await rig.prepare([rig.copy(MODS_PLUGIN, MODS_FP1)]);
    await second!;

    expect(stagingsSeenBySecond, "the second preparation must start while the first staging is alive").toBe(1);
    expect(orphanReports(reports), "a live staging of this Deck must not be reported as an orphan").toEqual([]);
    expect(rig.container.stagings()).toEqual([]);
  });
});

test("an unrecognised staging listing is reported once and does not block the launch", async () => {
  await collectingReports(async (reports) => {
    const rig = await makeModRig();
    rig.engine.forced.set("find-staging", { code: 0, stdout: "not-a-staging-name\n", stderr: "" });

    const first = await rig.prepare();
    const second = await rig.prepare([rig.copy("other-plugin")]);

    expect(okPreparation(first).references).toHaveLength(1);
    expect(okPreparation(second).references).toHaveLength(1);
    expect(reports.filter(([scope]) => scope === "sandbox"), "one trace for the container, not one per call").toHaveLength(1);
    expect(reports[0]![1], "an unrecognised listing is not interpreted as staging names").not.toContain("not-a-staging-name");
  });
});

test("a failing plugin parent creation omits the mod without staging or copying anything", async () => {
  const rig = await makeModRig();
  rig.engine.forced.set("mkdir-parent", { code: 1, stdout: "", stderr: "mkdir: Permission denied" });

  const result = await rig.prepare();

  expect(okPreparation(result).references).toEqual([]);
  expect(omittedPlugins(result)).toEqual([MODS_PLUGIN]);
  const kinds = rig.engine.calls.map((c) => c.kind);
  expect(kinds, "nothing is written once the controlled parent could not be prepared").not.toContain("mkdir-stage");
  expect(kinds).not.toContain("cp");
});

test("cleanup still reaches the pinned container when the service no longer reports a ready launch", async () => {
  const rig = await makeModRig();
  rig.svc.execCommand(launchFor(rig, MODS_ID_A), "tile-orphan");
  rig.setLastReady(false);
  rig.setReady(null);
  expect(() => rig.svc.launchInfo()).toThrow();

  await rig.svc.cleanupSession("tile-orphan");

  expect(rig.engine.calls.map((c) => [c.kind, c.target])).toEqual([["cat-pid", MODS_ID_A], ["kill", MODS_ID_A]]);
});

const PLUGIN_PARENT = `${MODS_ROOT}/${MODS_PLUGIN}`;

test.each([
  ["answers 0", { code: 0, stdout: "0\n", stderr: "" }],
  ["answers with a failure", { code: 1, stdout: "", stderr: "exec failed" }],
] as Array<[string, SandboxExecResult]>)("a container whose id -u %s is refused before any write", async (_name, forced) => {
  const rig = await makeModRig();
  rig.engine.forced.set("id", forced);

  const result = await rig.prepare();

  expect(result.ok, "Config.User named an unprivileged user while the process runs as uid 0: the agent would own what the mods are trusted for").toBe(false);
  expect(result.ok ? null : result.reason).toBe("sandbox-mod-root-user");
  expect(rig.engine.calls.filter((c) => MUTATING_KINDS.includes(c.kind))).toEqual([]);
});

const UNSAFE_PLUGIN_PARENTS: Array<[string, (c: FakeContainer) => void]> = [
  ["owned by the agent user", (c) => c.put(PLUGIN_PARENT, "dir", 1000, 1000, 0o755)],
  ["owned by the agent user with group root", (c) => c.put(PLUGIN_PARENT, "dir", 1000, 0, 0o755)],
  ["owned by root with the agent group", (c) => c.put(PLUGIN_PARENT, "dir", 0, 1000, 0o755)],
  ["group writable (775)", (c) => c.put(PLUGIN_PARENT, "dir", 0, 0, 0o775)],
  ["other writable (757)", (c) => c.put(PLUGIN_PARENT, "dir", 0, 0, 0o757)],
  ["a symlink", (c) => c.put(PLUGIN_PARENT, "link")],
  ["a regular file", (c) => c.put(PLUGIN_PARENT, "file", 0, 0, 0o755)],
];

test.each(UNSAFE_PLUGIN_PARENTS)("a plugin parent %s omits that mod, writes nothing under it and spares the others", async (_name, seed) => {
  const rig = await makeModRig();
  seed(rig.container);
  const before = rig.container.snapshot(PLUGIN_PARENT);

  const prepared = okPreparation(await rig.prepare([rig.copy(), rig.copy("other-plugin")]));

  expect(prepared.diagnostics.omitted).toEqual([{ plugin: MODS_PLUGIN, reason: "sandbox-mod-parent-invalid" }]);
  expect(prepared.references.map((r) => r.plugin), "an unsafe parent of one mod must not cost the next mod").toEqual(["other-plugin"]);
  expect(rig.container.snapshot(PLUGIN_PARENT), "an agent-controlled parent is left as found").toBe(before);
  const writes = rig.engine.calls.filter((c) => ["mkdir-stage", "cp", "chmod", "mv"].includes(c.kind) && c.args.join(" ").includes(`${PLUGIN_PARENT}/`));
  expect(writes, "nothing is staged or published under a parent the agent could have replaced").toEqual([]);
});

test.each([
  ["root 755", 0o755],
  ["root 750", 0o750],
])("a plugin parent already present as %s is used as found", async (_name, mode) => {
  const rig = await makeModRig();
  rig.container.put(PLUGIN_PARENT, "dir", 0, 0, mode);

  const prepared = okPreparation(await rig.prepare());

  expect(prepared.references.map((r) => r.plugin)).toEqual([MODS_PLUGIN]);
  expect(prepared.diagnostics.omitted).toEqual([]);
  expect(rig.container.nodes.get(PLUGIN_PARENT)).toEqual({ kind: "dir", uid: 0, gid: 0, mode });
});

test("a preparation without any copy succeeds with no reference, pinned to the ready container", async () => {
  const rig = await makeModRig();

  const result = await rig.prepare([]);

  expect(result.ok, `a sandboxed tile with no mod enabled still needs a plan naming its container: ${JSON.stringify(result)}`).toBe(true);
  const prepared = okPreparation(result);
  expect(prepared.references).toEqual([]);
  expect(prepared.diagnostics.omitted).toEqual([]);
  expect(prepared.containerId).toBe(MODS_ID_A);
  expect(["docker", "podman"]).toContain(prepared.engine);
});

test("a published mod keeps no setuid or setgid bit, stripped before the rename exposes it", async () => {
  const rig = await makeModRig();
  const copy = rig.copy();
  rig.engine.hostTrees.set(copy.hostDir, [
    { rel: "plugin.json", mode: 0o644 },
    { rel: "bin/suid-helper", mode: 0o4755 },
    { rel: "bin/sgid-helper", mode: 0o2755 },
  ]);
  let plantedAtChmod = 0;
  let specialAtPublication: string[] = [];
  rig.engine.before = (call) => {
    const nodes = [...rig.container.nodes].filter(([key]) => key.includes("/.stage-"));
    if (call.kind === "chmod") plantedAtChmod = nodes.filter(([, n]) => (n.mode & 0o6000) !== 0).length;
    if (call.kind === "mv") specialAtPublication = nodes.filter(([, n]) => (n.mode & 0o6000) !== 0).map(([key]) => key);
  };

  const prepared = okPreparation(await rig.prepare([copy]));

  expect(plantedAtChmod, "the fixture must hand chmod a tree that really carries both special bits").toBe(2);
  expect(prepared.references).toHaveLength(1);
  const published = modsPublished(MODS_PLUGIN, MODS_FP1);
  expect(rig.container.nodes.get(`${published}/bin/suid-helper`)?.mode, "setuid stripped, execute bits kept").toBe(0o755);
  expect(rig.container.nodes.get(`${published}/bin/sgid-helper`)?.mode, "setgid stripped, execute bits kept").toBe(0o755);
  for (const key of [published, ...rig.container.below(published)]) {
    expect(rig.container.nodes.get(key)!.mode & 0o6000, `${key} must carry no setuid or setgid bit`).toBe(0);
  }
  expect(specialAtPublication, "the bits must be gone BEFORE the rename exposes the tree").toEqual([]);
});
