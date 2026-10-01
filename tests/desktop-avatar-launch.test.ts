import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureAvatarLifetime } from "../desktop/src/main/avatar-lifetime.ts";

const REPO = join(import.meta.dir, "..");
const DESKTOP = join(REPO, "desktop");
const ELECTRON_PACKAGE = join(REPO, "desktop", "node_modules", "electron");
const LAUNCH = join(DESKTOP, "bin", "launch.js");
const dirs: string[] = [];
const children: ChildProcess[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kory-avatar-launch-"));
  dirs.push(dir);
  return dir;
}

function electronBinary(): string {
  const pointer = join(ELECTRON_PACKAGE, "path.txt");
  expect(existsSync(pointer), `electron is not installed: ${pointer} is missing`).toBe(true);
  return join(ELECTRON_PACKAGE, "dist", readFileSync(pointer, "utf-8").trim());
}

function writeElectronProbe(dir: string): string {
  const file = join(dir, "electron-probe.cjs");
  writeFileSync(file, [
    "const { app } = require('electron')",
    "const { writeFileSync } = require('node:fs')",
    "const [result] = process.argv.slice(2)",
    "app.setName('koryphaios')",
    "const acquired = app.requestSingleInstanceLock()",
    "writeFileSync(result, JSON.stringify({ acquired }))",
    "if (!acquired) app.exit(0)",
    "setInterval(() => {}, 1000)"
  ].join("\n"));
  return file;
}

const LINUX_PROBE_FLAGS = process.platform === "linux" ? ["--no-sandbox", "--ozone-platform=headless"] : [];

async function waitForResult(file: string, child: ChildProcess, stderr: { text: string }): Promise<{ acquired: boolean }> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Electron probe did not write ${file} (exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)})\nprobe stderr:\n${stderr.text || "(empty)"}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return JSON.parse(readFileSync(file, "utf-8")) as { acquired: boolean };
}

async function startProbe(probe: string, root: string, profile: string): Promise<{ child: ChildProcess; result: { acquired: boolean } }> {
  const resultFile = join(root, `${profile}-${randomId()}.json`);
  const child = spawn(electronBinary(), [probe, resultFile, `--user-data-dir=${join(root, profile)}`, ...LINUX_PROBE_FLAGS], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  children.push(child);
  const stderr = { text: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.text = (stderr.text + chunk.toString("utf-8")).slice(-4_000);
  });
  return { child, result: await waitForResult(resultFile, child, stderr) };
}

let nextId = 0;
function randomId(): number {
  nextId += 1;
  return nextId;
}

async function stopProbe(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    if (process.platform === "win32" && child.pid !== undefined) {
      const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (result.status !== 0) child.kill("SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  });
}

function runLaunch(args: string[]): { binary: string; args: string[]; env: Record<string, string | undefined> } {
  const dir = tempDir();
  const probe = join(dir, "launch-probe.cjs");
  writeFileSync(probe, [
    "const Module = require('node:module')",
    "const originalLoad = Module._load",
    "const [launch, argv] = process.argv.slice(2)",
    "let call",
    "Module._load = function(request) {",
    "  if (request === 'electron') return 'electron-binary'",
    "  if (request === 'node:child_process') return { spawn: (...args) => { call = args; return { on() { return this } } } }",
    "  return originalLoad.apply(this, arguments)",
    "}",
    "process.argv = ['node', launch, ...JSON.parse(argv)]",
    "require(launch)",
    "process.stdout.write(JSON.stringify({ binary: call[0], args: call[1], env: { project: call[2].env.CLAUDE_PEERS_DESK_PROJECT_DIR, scope: call[2].env.CLAUDE_PEERS_DESK_SCOPE_ID } }))"
  ].join("\n"));
  const env = { ...process.env };
  delete env.CLAUDE_PEERS_DESK_SCOPE_ID;
  const result = spawnSync(electronBinary(), [probe, LAUNCH, JSON.stringify(args)], {
    encoding: "utf-8",
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" }
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { binary: string; args: string[]; env: Record<string, string | undefined> };
}

afterAll(async () => {
  await Promise.all(children.map((child) => stopProbe(child)));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("kory routes --avatar to its dedicated Electron entry without turning it into a scope", () => {
  const normal = runLaunch(["shared-scope"]);
  expect(normal).toEqual({
    binary: "electron-binary",
    args: [DESKTOP],
    env: { project: process.cwd(), scope: "shared-scope" }
  });

  const avatar = runLaunch(["--avatar"]);
  expect(avatar).toEqual({
    binary: "electron-binary",
    args: [DESKTOP, "--avatar"],
    env: { project: process.cwd() }
  });
});

test("Avatar configures its profile before claiming its Electron lifetime through production code", () => {
  const calls: string[] = [];
  const lifetime = configureAvatarLifetime({
    setPath: (name, path) => calls.push(`setPath:${name}:${path}`),
    requestSingleInstanceLock: () => {
      calls.push("claim");
      return true;
    },
    releaseSingleInstanceLock: () => calls.push("release")
  }, join("C:", "Deck"));

  expect(calls).toEqual([`setPath:userData:${join("C:", "Deck", "avatar")}`, "claim"]);
  lifetime?.release();
  expect(calls).toEqual([`setPath:userData:${join("C:", "Deck", "avatar")}`, "claim", "release"]);
});

test("a real Electron using the Avatar profile does not capture the Deck profile singleton", async () => {
  const root = tempDir();
  const probe = writeElectronProbe(root);
  const avatar = await startProbe(probe, root, "avatar");
  let deck: { child: ChildProcess; result: { acquired: boolean } } | undefined;
  try {
    deck = await startProbe(probe, root, "deck");
    expect(avatar.result.acquired).toBe(true);
    expect(deck.result.acquired).toBe(true);
  } finally {
    await stopProbe(deck?.child);
    await stopProbe(avatar.child);
  }
}, 20_000);

test("a real Electron using the Deck profile does not capture the Avatar profile singleton", async () => {
  const root = tempDir();
  const probe = writeElectronProbe(root);
  const deck = await startProbe(probe, root, "deck");
  let avatar: { child: ChildProcess; result: { acquired: boolean } } | undefined;
  try {
    avatar = await startProbe(probe, root, "avatar");
    expect(deck.result.acquired).toBe(true);
    expect(avatar.result.acquired).toBe(true);
  } finally {
    await stopProbe(avatar?.child);
    await stopProbe(deck.child);
  }
}, 20_000);

test("a second real Electron using the same profile is denied the singleton", async () => {
  const root = tempDir();
  const probe = writeElectronProbe(root);
  const first = await startProbe(probe, root, "avatar");
  let second: { child: ChildProcess; result: { acquired: boolean } } | undefined;
  try {
    second = await startProbe(probe, root, "avatar");
    expect(first.result.acquired).toBe(true);
    expect(second.result.acquired).toBe(false);
  } finally {
    await stopProbe(second?.child);
    await stopProbe(first.child);
  }
}, 20_000);

const SINGLETON_LOSS_TRACE = "logWarn('avatar-entry', 'Avatar stopped because another process owns its singleton lock')";

function assertSingletonLossTrace(file: string): void {
  const source = readFileSync(file, "utf-8");
  const singletonLoss = source.indexOf("if (!lifetime) {");
  const startup = source.indexOf("  ensureAvatarPrivateDir", singletonLoss);
  expect(singletonLoss, "Avatar startup must handle an unavailable singleton lock").toBeGreaterThanOrEqual(0);
  expect(startup, "the singleton-loss branch must precede Avatar startup").toBeGreaterThan(singletonLoss);
  const branch = source.slice(singletonLoss, startup);
  expect(branch).toContain(SINGLETON_LOSS_TRACE);
  expect(branch.indexOf(SINGLETON_LOSS_TRACE)).toBeLessThan(branch.indexOf("app.quit()"));
}

test("records singleton-lock loss before the Avatar exits", () => {
  const source = resolve(DESKTOP, "src", "main", "avatar-entry.ts");
  assertSingletonLossTrace(source);

  const mirror = join(tempDir(), "avatar-entry.ts");
  copyFileSync(source, mirror);
  const original = readFileSync(mirror, "utf-8");
  const mutated = original.replace(SINGLETON_LOSS_TRACE, "void 0");
  expect(mutated, "the negative control must remove the singleton-loss trace").not.toBe(original);
  writeFileSync(mirror, mutated);
  expect(() => assertSingletonLossTrace(mirror)).toThrow(SINGLETON_LOSS_TRACE);
});
