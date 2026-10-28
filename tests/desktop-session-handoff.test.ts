import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionHandoffLaunch,
  createSessionHandoffStore,
  isWithin,
  purgeSessionHandoffDrafts,
  publishSessionHandoff,
  readSessionHandoff,
  readSessionHandoffBinding,
  removeSessionHandoffLaunch,
  sessionHandoffSupported,
  writeSessionHandoffBinding
} from "../desktop/src/main/session-handoff";
import { readSessionSkills, writeSessionSkills } from "../desktop/src/main/session-skills";

const dirs: string[] = [];
const HELPER_WRAPPER = join(import.meta.dir, "..", "desktop", "deck-lead-plugin", "bin", "kory-session-handoff.sh");
const RUN_ID = "00000000-0000-4000-8000-000000000001";

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kory-session-handoff-"));
  dirs.push(dir);
  return dir;
}

function boundHelper(root: string, tileId = "tile-a", generation = "generation-a") {
  const store = createSessionHandoffStore(root, "project-key");
  const launchDir = join(root, "session-handoff-drafts", RUN_ID, generation);
  mkdirSync(launchDir, { recursive: true });
  const draftPath = join(launchDir, "handoff.md");
  const bindingPath = join(launchDir, "binding.json");
  writeSessionHandoffBinding(bindingPath, {
    version: 1, projectKey: store.projectKey, archiveDir: store.archiveDir, draftPath, helperPath: HELPER_WRAPPER,
    logDir: join(root, "logs"), launchId: `launch-${tileId}`, tileId, generation, runId: RUN_ID
  });
  return { draftPath, env: { ...process.env, KORY_SESSION_HANDOFF_BINDING: bindingPath } };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("qualifies only win32 for native session handoff", () => {
  expect(sessionHandoffSupported("win32")).toBe(true);
  expect(sessionHandoffSupported("darwin")).toBe(false);
});

test("rejects absolute relatives on another drive from state containment", () => {
  expect(isWithin("C:\\state", "D:\\evil")).toBe(false);
});

test("publishes distinct numbered handoffs and reads the newest valid entry", () => {
  const store = createSessionHandoffStore(stateDir(), "project-key");

  expect(publishSessionHandoff(store, "# First", { author: "launch-a", now: new Date("2026-10-27T10:00:00.000Z") })).toBe(1);
  expect(publishSessionHandoff(store, "# Second", { author: "launch-b", now: new Date("2026-10-27T10:01:00.000Z") })).toBe(2);

  expect(readSessionHandoff(store, "latest")).toMatchObject({ number: 2, markdown: "# Second" });
  expect(readSessionHandoff(store, 1)).toMatchObject({ number: 1, markdown: "# First" });
});

test("skips an abandoned reservation and never treats temporary files as the latest handoff", () => {
  const store = createSessionHandoffStore(stateDir(), "project-key");
  mkdirSync(store.archiveDir, { recursive: true });
  writeFileSync(join(store.archiveDir, "000001.reserve"), "");
  writeFileSync(join(store.archiveDir, "000003.md.tmp"), "partial");

  expect(publishSessionHandoff(store, "# Published", { author: "launch-a", now: new Date("2026-10-27T10:00:00.000Z") })).toBe(2);
  expect(existsSync(join(store.archiveDir, "000002.md"))).toBe(true);
  expect(readSessionHandoff(store, "latest")).toMatchObject({ number: 2, markdown: "# Published" });
});

test("publishes once and warns when reservation cleanup fails after the final rename", () => {
  const store = createSessionHandoffStore(stateDir(), "project-key");
  const cleanupError = new Error("reservation cleanup failed");
  const warnings: Array<[string, unknown]> = [];

  expect(publishSessionHandoff(
    store,
    "# Published",
    { author: "launch-a", now: new Date("2026-10-27T10:00:00.000Z") },
    (message, error) => warnings.push([message, error]),
    () => { throw cleanupError; }
  )).toBe(1);
  expect(readdirSync(store.archiveDir).filter((name) => name.endsWith(".md"))).toEqual(["000001.md"]);
  expect(warnings).toEqual([["session handoff: could not remove archive reservation", cleanupError]]);
});

test("rejects invalid handoff selectors and content before reading or publishing", () => {
  const store = createSessionHandoffStore(stateDir(), "project-key");

  expect(() => readSessionHandoff(store, "../1")).toThrow("Invalid handoff selector");
  expect(() => readSessionHandoff(store, "latest extra")).toThrow("Invalid handoff selector");
  expect(() => publishSessionHandoff(store, "", { author: "launch-a", now: new Date("2026-10-27T10:00:00.000Z") })).toThrow("Handoff content is empty");
});

test("launch binding confines a tile to one external draft and the helper operations", () => {
  const root = stateDir();
  const launch = createSessionHandoffLaunch(root, "project-key", "C:\\Kory\\deck-lead-plugin\\bin\\kory-session-handoff.sh", "tile-a", RUN_ID, join(root, "logs"));

  expect(launch.additionalDirectory.startsWith(root)).toBe(true);
  expect(launch.allowedTools).toEqual([
    expect.stringMatching(/^Edit\(.+\/handoff\.md\)$/),
    'Bash("$KORY_SESSION_HELPER" context)',
    'Bash("$KORY_SESSION_HELPER" read:*)',
    'Bash("$KORY_SESSION_HELPER" publish)'
  ]);
  expect(launch.environment.KORY_SESSION_HELPER).toBe('/c/Kory/deck-lead-plugin/bin/kory-session-handoff.sh');
  const binding = readSessionHandoffBinding(launch.environment.KORY_SESSION_HANDOFF_BINDING!);
  expect(binding.helperPath).toBe(launch.environment.KORY_SESSION_HELPER);
  expect(binding.logDir).toBe(join(root, "logs"));
  expect(launch.environment.KORY_SESSION_HANDOFF_BINDING).toBe(join(launch.additionalDirectory, "binding.json"));
});

test("ending a launch removes its handoff draft and a replacement has a distinct binding", () => {
  const root = stateDir();
  const first = createSessionHandoffLaunch(root, "project-key", HELPER_WRAPPER, "tile-a", RUN_ID, join(root, "logs"));
  const firstBinding = first.environment.KORY_SESSION_HANDOFF_BINDING!;

  removeSessionHandoffLaunch(first);
  expect(existsSync(first.additionalDirectory)).toBe(false);
  expect(existsSync(firstBinding)).toBe(false);

  const replacement = createSessionHandoffLaunch(root, "project-key", HELPER_WRAPPER, "tile-a", RUN_ID, join(root, "logs"));
  expect(replacement.additionalDirectory).not.toBe(first.additionalDirectory);
  expect(existsSync(replacement.environment.KORY_SESSION_HANDOFF_BINDING!)).toBe(true);
});

test("launches created through a symlinked state directory keep a valid canonical binding", () => {
  const root = stateDir();
  const canonical = join(root, "canonical");
  const alias = join(root, "alias");
  mkdirSync(canonical);
  symlinkSync(canonical, alias, process.platform === "win32" ? "junction" : "dir");

  const launch = createSessionHandoffLaunch(alias, "project-key", HELPER_WRAPPER, "tile-a", RUN_ID, join(root, "logs"));
  const binding = readSessionHandoffBinding(launch.environment.KORY_SESSION_HANDOFF_BINDING!);

  expect(launch.additionalDirectory.startsWith(canonical)).toBe(true);
  expect(binding.draftPath.startsWith(canonical)).toBe(true);
});

test("startup purge removes only a run whose valid owner is proven dead", () => {
  const root = stateDir();
  const drafts = join(root, "session-handoff-drafts");
  const deadRun = "00000000-0000-4000-8000-000000000002";
  const liveRun = "00000000-0000-4000-8000-000000000003";
  for (const [runId, pid] of [[deadRun, 100], [liveRun, 200]] as const) {
    mkdirSync(join(drafts, runId), { recursive: true });
    writeFileSync(join(drafts, runId, "owner.json"), JSON.stringify({ version: 1, runId, pid }));
  }

  const reports: string[] = [];
  expect(purgeSessionHandoffDrafts(root, RUN_ID, (message) => reports.push(message), (pid) => pid === 200)).toBe(1);
  expect(existsSync(join(drafts, deadRun))).toBe(false);
  expect(existsSync(join(drafts, liveRun))).toBe(true);
  expect(reports).toEqual([]);

  rmSync(drafts, { recursive: true, force: true });
  writeFileSync(drafts, "not a directory");
  expect(purgeSessionHandoffDrafts(root, RUN_ID, (message) => reports.push(message))).toBe(0);
  expect(reports).toEqual(["session handoff: could not inspect draft directories"]);
});

test("startup purge retains protected, unreadable, and invalid draft owners", () => {
  const root = stateDir();
  const drafts = join(root, "session-handoff-drafts");
  const protectedRun = "00000000-0000-4000-8000-000000000004";
  const unreadableRun = "00000000-0000-4000-8000-000000000005";
  const invalidRun = "00000000-0000-4000-8000-000000000006";
  for (const [runId, pid] of [[protectedRun, 400], [unreadableRun, 500]] as const) {
    mkdirSync(join(drafts, runId), { recursive: true });
    writeFileSync(join(drafts, runId, "owner.json"), JSON.stringify({ version: 1, runId, pid }));
  }
  mkdirSync(join(drafts, invalidRun), { recursive: true });
  writeFileSync(join(drafts, invalidRun, "owner.json"), "not JSON");

  const protectedReports: string[] = [];
  expect(purgeSessionHandoffDrafts(root, RUN_ID, (message) => protectedReports.push(message), () => {
    throw Object.assign(new Error("protected process"), { code: "EPERM" });
  })).toBe(0);
  expect(existsSync(join(drafts, protectedRun))).toBe(true);
  expect(protectedReports).toEqual([]);

  const unreadableReports: string[] = [];
  expect(purgeSessionHandoffDrafts(root, RUN_ID, (message) => unreadableReports.push(message), (pid) => {
    if (pid === 400) return true;
    if (pid === 500) throw new Error("probe failed");
    throw new Error("invalid owner was probed");
  })).toBe(0);
  expect(existsSync(join(drafts, unreadableRun))).toBe(true);
  expect(unreadableReports).toEqual([`session handoff: could not remove draft directory ${unreadableRun}`]);
  expect(existsSync(join(drafts, invalidRun))).toBe(true);
});

test("handoff launch, publication, and purge refuse linked filesystem parents", () => {
  const root = stateDir();
  const external = stateDir();
  const linkedDrafts = join(root, "session-handoff-drafts");
  symlinkSync(external, linkedDrafts, process.platform === "win32" ? "junction" : "dir");

  expect(() => createSessionHandoffLaunch(root, "project-key", HELPER_WRAPPER, "tile-a", RUN_ID, join(root, "logs"))).toThrow("symbolic link");
  const reports: string[] = [];
  expect(purgeSessionHandoffDrafts(root, RUN_ID, (message) => reports.push(message))).toBe(0);
  expect(reports).toEqual(["session handoff: could not inspect draft directories"]);

  const archiveRoot = stateDir();
  const archiveExternal = stateDir();
  const store = createSessionHandoffStore(archiveRoot, "project-key");
  mkdirSync(join(archiveRoot, "session-handoffs"));
  symlinkSync(archiveExternal, store.archiveDir, process.platform === "win32" ? "junction" : "dir");
  expect(() => publishSessionHandoff(store, "# End", { author: "launch-a", now: new Date("2026-10-27T10:00:00.000Z") })).toThrow("symbolic link");
});

test("helper reports the launch context and publishes its bound draft without stdin", () => {
  const root = stateDir();
  const store = createSessionHandoffStore(root, "project-key");
  const launchDir = join(root, "session-handoff-drafts", RUN_ID, "generation-a");
  mkdirSync(launchDir, { recursive: true });
  const draftPath = join(launchDir, "handoff.md");
  const bindingPath = join(launchDir, "binding.json");
  writeSessionHandoffBinding(bindingPath, {
    version: 1,
    projectKey: store.projectKey,
    archiveDir: store.archiveDir,
    draftPath,
    helperPath: HELPER_WRAPPER,
    logDir: join(root, "logs"),
    launchId: "launch-a",
    tileId: "tile-a",
    generation: "generation-a",
    runId: RUN_ID
  });
  const env = { ...process.env, KORY_SESSION_HANDOFF_BINDING: bindingPath };
  writeSessionSkills(root, {
    version: 2,
    addendum: { start: "Prepare context.", end: "Publish the handoff.", stop: "Explain the stop." },
    storage: { mode: "custom", instructions: "Store and read with the configured tool." }
  });

  const context = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env });
  expect(context.exitCode).toBe(0);
  expect(JSON.parse(context.stdout.toString())).toEqual({
    project: "project-key",
    draft: draftPath,
    helper: '"$KORY_SESSION_HELPER"',
    addendum: { start: "Prepare context.", end: "Publish the handoff.", stop: "Explain the stop." },
    storage: { mode: "custom", instructions: "Store and read with the configured tool." }
  });
  writeSessionSkills(root, {
    version: 2,
    addendum: { start: "New context.", end: "New handoff.", stop: "New stop." },
    storage: { mode: "kory", instructions: "" }
  });
  const refreshed = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env });
  expect(refreshed.exitCode).toBe(0);
  expect(JSON.parse(refreshed.stdout.toString()).addendum).toEqual({
    start: "New context.", end: "New handoff.", stop: "New stop."
  });
  writeFileSync(draftPath, "# End\n");
  const publish = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "publish"], env });
  expect(publish.exitCode).toBe(0);
  expect(JSON.parse(publish.stdout.toString())).toEqual({ number: 1 });
  const read = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "read", "latest"], env });
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout.toString())).toEqual({ number: 1, markdown: "# End\n" });
  const numbered = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "read", "1"], env });
  expect(numbered.exitCode).toBe(0);
  expect(JSON.parse(numbered.stdout.toString())).toEqual({ number: 1, markdown: "# End\n" });
});

test("helper assigns distinct exit codes to missing bindings, handoffs, invalid content, and I/O", () => {
  const root = stateDir();
  const store = createSessionHandoffStore(root, "project-key");
  const launchDir = join(root, "session-handoff-drafts", RUN_ID, "generation-a");
  mkdirSync(launchDir, { recursive: true });
  const draftPath = join(launchDir, "handoff.md");
  const bindingPath = join(launchDir, "binding.json");
  writeSessionHandoffBinding(bindingPath, {
    version: 1,
    projectKey: store.projectKey,
    archiveDir: store.archiveDir,
    draftPath,
    helperPath: HELPER_WRAPPER,
    logDir: join(root, "logs"),
    launchId: "launch-a",
    tileId: "tile-a",
    generation: "generation-a",
    runId: RUN_ID
  });
  const env = { ...process.env, KORY_SESSION_HANDOFF_BINDING: bindingPath };
  const withoutBinding = { ...process.env };
  delete withoutBinding.KORY_SESSION_HANDOFF_BINDING;

  expect(Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env: withoutBinding }).exitCode).toBe(77);
  writeFileSync(join(root, "session-skills.json"), "{");
  const invalidSkills = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env });
  expect(invalidSkills.exitCode).toBe(74);
  expect(invalidSkills.stdout.toString()).toBe("");
  rmSync(join(root, "session-skills.json"));
  expect(Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "read", "latest"], env }).exitCode).toBe(66);
  const missingDraft = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "publish"], env });
  expect(missingDraft.exitCode).toBe(65);
  expect(missingDraft.stderr.toString()).toBe("Handoff content is empty\n");
  writeFileSync(draftPath, "");
  expect(Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "publish"], env }).exitCode).toBe(65);
  rmSync(store.archiveDir, { recursive: true, force: true });
  writeFileSync(store.archiveDir, "not a directory");
  writeFileSync(draftPath, "# Valid\n");
  expect(Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "publish"], env }).exitCode).toBe(74);
  writeSessionHandoffBinding(bindingPath, {
    version: 1,
    projectKey: store.projectKey,
    archiveDir: join(root, "outside-state"),
    draftPath,
    helperPath: HELPER_WRAPPER,
    logDir: join(root, "logs"),
    launchId: "launch-a",
    tileId: "tile-a",
    generation: "generation-a",
    runId: RUN_ID
  });
  expect(Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env }).exitCode).toBe(77);
  const outsideBinding = join(root, "outside-binding.json");
  writeSessionHandoffBinding(outsideBinding, {
    version: 1,
    projectKey: store.projectKey,
    archiveDir: store.archiveDir,
    draftPath,
    helperPath: HELPER_WRAPPER,
    logDir: join(root, "logs"),
    launchId: "launch-a",
    tileId: "tile-a",
    generation: "generation-a",
    runId: RUN_ID
  });
  expect(Bun.spawnSync({
    cmd: ["bash", HELPER_WRAPPER, "context"],
    env: { ...env, KORY_SESSION_HANDOFF_BINDING: outsideBinding }
  }).exitCode).toBe(77);
});

test("helper rejects hostile read selectors with exit code 64", () => {
  const root = stateDir();
  const store = createSessionHandoffStore(root, "project-key");
  const launchDir = join(root, "session-handoff-drafts", RUN_ID, "generation-a");
  mkdirSync(launchDir, { recursive: true });
  const draftPath = join(launchDir, "handoff.md");
  const bindingPath = join(launchDir, "binding.json");
  writeSessionHandoffBinding(bindingPath, {
    version: 1,
    projectKey: store.projectKey,
    archiveDir: store.archiveDir,
    draftPath,
    helperPath: HELPER_WRAPPER,
    logDir: join(root, "logs"),
    launchId: "launch-a",
    tileId: "tile-a",
    generation: "generation-a",
    runId: RUN_ID
  });

  for (const selector of ["../x", "1;touch", "latest extra"]) {
    const result = Bun.spawnSync({
      cmd: ["bash", HELPER_WRAPPER, "read", selector],
      env: { ...process.env, KORY_SESSION_HANDOFF_BINDING: bindingPath }
    });
    expect(result.exitCode).toBe(64);
    expect(result.stdout.toString()).toBe("");
  }
});

test("a corrupt skills document does not block handoff publish or read", () => {
  const root = stateDir();
  const { draftPath, env } = boundHelper(root);
  writeFileSync(join(root, "session-skills.json"), "{");
  writeFileSync(draftPath, "# End\n");

  const publish = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "publish"], env });
  expect(publish.exitCode, `publish stderr: ${publish.stderr.toString()}`).toBe(0);
  expect(Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "read", "latest"], env }).exitCode).toBe(0);
});

test("context returns all empty addenda when no skills document exists", () => {
  const root = stateDir();
  const { env } = boundHelper(root);
  const context = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env });

  expect(context.exitCode).toBe(0);
  expect(JSON.parse(context.stdout.toString()).addendum).toEqual({ start: "", end: "", stop: "" });
});

test("context retains empty addenda next to a filled addendum", () => {
  const root = stateDir();
  const { env } = boundHelper(root);
  writeSessionSkills(root, { version: 2, addendum: { start: "only start", end: "", stop: "" }, storage: { mode: "kory", instructions: "" } });

  const addendum = JSON.parse(Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env }).stdout.toString()).addendum;
  expect(addendum).toEqual({ start: "only start", end: "", stop: "" });
});

test("context ignores hostile skills documents in its working directory", () => {
  const root = stateDir();
  const hostileCwd = stateDir();
  const { env } = boundHelper(root);
  const global = { version: 2 as const, addendum: { start: "global", end: "", stop: "" }, storage: { mode: "kory" as const, instructions: "" } };
  writeSessionSkills(root, global);
  writeFileSync(join(hostileCwd, "session-skills.json"), JSON.stringify({ version: 1, addendum: { start: "cwd", end: "", stop: "" } }));
  mkdirSync(join(hostileCwd, ".claude", "claude-peers"), { recursive: true });
  writeFileSync(join(hostileCwd, ".claude", "claude-peers", "session-skills.json"), JSON.stringify({ version: 1, addendum: { start: "repo", end: "", stop: "" } }));

  expect(readSessionSkills(root)).toEqual(global);
  const context = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env, cwd: hostileCwd });
  expect(context.exitCode).toBe(0);
  expect(JSON.parse(context.stdout.toString()).addendum).toEqual(global.addendum);
});

test("two bound tiles read one shared skills document", () => {
  const root = stateDir();
  const first = boundHelper(root, "tile-a", "generation-a");
  const second = boundHelper(root, "tile-b", "generation-b");
  const value = { version: 2 as const, addendum: { start: "shared", end: "", stop: "" }, storage: { mode: "kory" as const, instructions: "" } };
  writeSessionSkills(root, value);

  for (const env of [first.env, second.env]) {
    const context = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context"], env });
    expect(context.exitCode).toBe(0);
    expect(JSON.parse(context.stdout.toString()).addendum).toEqual(value.addendum);
  }
});

test("context rejects trailing arguments with no stdout", () => {
  const root = stateDir();
  const { env } = boundHelper(root);
  const result = Bun.spawnSync({ cmd: ["bash", HELPER_WRAPPER, "context", "hostile"], env });

  expect(result.exitCode).toBe(64);
  expect(result.stdout.toString()).toBe("");
});

test("parallel helper publications retain every numbered handoff", async () => {
  const root = stateDir();
  const store = createSessionHandoffStore(root, "project-key");
  const launchDir = join(root, "session-handoff-drafts", RUN_ID, "generation-a");
  mkdirSync(launchDir, { recursive: true });
  const bindingPath = join(launchDir, "binding.json");
  writeFileSync(join(launchDir, "handoff.md"), "# Parallel\n");
  writeSessionHandoffBinding(bindingPath, {
    version: 1,
    projectKey: store.projectKey,
    archiveDir: store.archiveDir,
    draftPath: join(launchDir, "handoff.md"),
    helperPath: HELPER_WRAPPER,
    logDir: join(root, "logs"),
    launchId: "launch-a",
    tileId: "tile-a",
    generation: "generation-a",
    runId: RUN_ID
  });
  const env = { ...process.env, KORY_SESSION_HANDOFF_BINDING: bindingPath };
  const processes = Array.from({ length: 64 }, () => Bun.spawn({
    cmd: ["bash", HELPER_WRAPPER, "publish"],
    env,
    stdout: "pipe",
    stderr: "pipe"
  }));

  expect(await Promise.all(processes.map((process) => process.exited))).toEqual(Array(64).fill(0));
  expect(readdirSync(store.archiveDir).filter((name) => name.endsWith(".md"))).toHaveLength(64);
});
