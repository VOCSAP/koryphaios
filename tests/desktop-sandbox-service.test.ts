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
    if (args[0] === "inspect") return { code: 0, stdout: `abc123\t${state}\t[]`, stderr: "" };
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

// Audit fix 1: containment, symlinks included. Root and target are real
// tmpdir trees (mirrors tests/desktop-explorer.test.ts's resolveWithin
// pattern), not mocked -- isWithinDir does real realpathSync calls.
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

  // Lexically under containDir, but realpath resolves outside it -- must be refused.
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

// Card e35b2791: runDirHost/peersDirHost keying by containerName (previously
// ONE directory shared read-write by every sandboxed project on the
// machine), purge on remove/rebuild, and the shared-mount drift signal.

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

// Card e35b2791 audit round 3, point 3: the P-e/P-e bis/P-g tests above all
// start from a HAND-BUILT SandboxMountInfo (source already a parsed string),
// which is structurally blind to whatever `docker/podman inspect --format
// {{json .Mounts}}` actually emits. This test instead runs the REAL
// parseMounts on realistic raw JSON, using the exact field names and BOTH
// Source representations measured live on a real container this session
// (see the round-1 report: kory-sbx-0e0a7a172d92, 2026-08-14).
//
// PODMAN RESIDUAL, DOCUMENTED NOT ASSUMED COVERED: podman is not installed
// on this machine (`podman --version` -> command not found, measured just
// now) -- its actual `inspect --format {{json .Mounts}}` output was NOT
// captured, so this test proves the Docker Desktop Windows case only. The
// containment approach (containerName substring in Source) is BELIEVED to
// generalize because podman targets Docker CLI/API compatibility for this
// exact command shape, but that is an unverified assumption, not a
// measurement -- flag as open with whoever next has a podman engine to test.
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
