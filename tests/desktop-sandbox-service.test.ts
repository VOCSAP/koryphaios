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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  isProtectionRebuildNeeded,
  parseMounts,
  toProtectionStatus,
  type SandboxMountInfo,
} from "../desktop/src/main/sandbox-service.ts";
import type { ProtectionPlan } from "../desktop/src/main/sandbox-protect.ts";

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
    { destination: "/work/.git/hooks", rw: false },
    { destination: "/work/.mcp.json", rw: false },
  ];
  expect(isProtectionRebuildNeeded(APPLIED_PLAN, "running", mounts)).toBe(false);
});

test("N-f ter: a matching Destination that is NOT read-only still needs a rebuild (RW compared, not just presence)", () => {
  const mounts: SandboxMountInfo[] = [
    { destination: "/work/.git/hooks", rw: true }, // present, but read-write -- not the protection bind
    { destination: "/work/.mcp.json", rw: false },
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
    { destination: "/work/.git/hooks", rw: false },
    { destination: "/work", rw: true },
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
    { destination: "/work/a", rw: true },
    { destination: "/work/b", rw: true },
    { destination: "/work/c", rw: true },
    { destination: "/work/d", rw: false },
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
