// The proxy spawn, run for real on Windows: a witness stands in for clodex,
// writes a file, registers itself as a proxy in a private CLODEX_HOME, and the
// owned tree is then stopped.

import { expect, test } from "bun:test";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClodexControllerDeps, runCommand } from "../desktop/src/main/clodex-lifecycle-deps.ts";
import type { OwnerRecord } from "../desktop/src/main/clodex-process-identity.ts";
import { createClodexProcessIo } from "../desktop/src/main/clodex-process-io.ts";

const WITNESS = "kory-clodex-spawn-witness";
const SAFE_SEARCH = "nodefaultcurrentdirectoryinexepath";

async function killTrees(pids: number[]): Promise<void> {
  for (const pid of pids) await runCommand("taskkill", ["/T", "/F", "/PID", String(pid)]);
}

function withPathEntry(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "Path";
  return { ...env, [key]: `${dir};${env[key] ?? ""}` };
}

// This shell may export the variable, which hides the current-directory search
// each planted case has to prove absent in the child.
function withoutSafeSearch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== SAFE_SEARCH));
}

function witnessScript(script: string, marker: string, home: string): void {
  writeFileSync(
    script,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
      `mkdirSync(${JSON.stringify(home)}, { recursive: true });`,
      `writeFileSync(${JSON.stringify(join(home, "server-runtime.json"))}, JSON.stringify([`,
      '  { mode: "proxy", port: 17999, pid: process.pid, startedAt: new Date().toISOString() }',
      "]));",
      "setInterval(() => {}, 1000);"
    ].join("\n")
  );
}

async function runOwnedSpawn(root: string, env: NodeJS.ProcessEnv, inspect: () => void): Promise<void> {
  const logsDir = join(root, "logs");
  mkdirSync(logsDir);
  const deps = createClodexControllerDeps({ shell: "", logsDir, env });
  const logs: number[] = [];
  const openLog = deps.openLog;
  deps.openLog = () => {
    const fd = openLog();
    if (fd !== null) logs.push(fd);
    return fd;
  };
  const relayPids: number[] = [];
  const spawn = deps.spawn;
  deps.spawn = (file, args, options) => {
    const child = spawn(file, args, options);
    if (child.pid !== undefined) relayPids.push(child.pid);
    return child;
  };
  const io = createClodexProcessIo(deps, { registerAttempts: 60, registerIntervalMs: 250 });
  let owner: OwnerRecord | null = null;
  let stopped = false;
  try {
    owner = await io.spawn(WITNESS, ["server", "--proxy"]);
    inspect();
    expect(owner.tree.platform).toBe("win32");
    expect(owner.tree.root.pid).not.toBe(owner.tree.runtime.pid);
    expect(relayPids).not.toContain(owner.tree.root.pid);
    await io.stopTree(owner);
    expect(() => process.kill(owner!.tree.runtime.pid, 0)).toThrow();
    stopped = true;
  } finally {
    if (!stopped) await killTrees([...(owner ? [owner.tree.root.pid] : []), ...relayPids]);
    for (const fd of logs) closeSync(fd);
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A still-locked temp dir must not mask the assertion that failed.
    }
  }
}

test.skipIf(process.platform !== "win32")(
  "a detached win32 spawn runs its command and the owned tree stops",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "kory-clodex-spawn-"));
    const home = join(root, "home");
    const marker = join(root, "ran.txt");
    const script = join(root, "witness.mjs");
    witnessScript(script, marker, home);
    writeFileSync(join(root, `${WITNESS}.cmd`), `@"${process.execPath}" "${script}"\r\n`);

    await runOwnedSpawn(root, withPathEntry({ ...process.env, CLODEX_HOME: home }, root), () => {
      expect(existsSync(marker)).toBe(true);
    });
  },
  30_000
);

test.skipIf(process.platform !== "win32")(
  "a clodex planted in the inherited working directory is not the one the win32 spawn runs",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "kory-clodex-plant-"));
    const onPath = join(root, "path");
    const planted = mkdtempSync(join(tmpdir(), "kory-clodex-cwd-"));
    mkdirSync(onPath);
    const home = join(root, "home");
    const marker = join(root, "ran.txt");
    const hijacked = join(planted, "hijacked.txt");
    const script = join(onPath, "witness.mjs");
    witnessScript(script, marker, home);
    writeFileSync(join(onPath, `${WITNESS}.cmd`), `@"${process.execPath}" "${script}"\r\n`);
    writeFileSync(join(planted, `${WITNESS}.cmd`), `@echo PLANTED> "${hijacked}"\r\n`);

    const env = withoutSafeSearch(withPathEntry({ ...process.env, CLODEX_HOME: home }, onPath));
    const previous = process.cwd();
    process.chdir(planted);
    try {
      await runOwnedSpawn(root, env, () => {
        expect(existsSync(marker), "the clodex on PATH did not run").toBe(true);
      });
    } finally {
      process.chdir(previous);
      const ranPlanted = existsSync(hijacked);
      rmSync(planted, { recursive: true, force: true, maxRetries: 3 });
      expect(ranPlanted, "the planted clodex ran").toBe(false);
    }
  },
  30_000
);

test.skipIf(process.platform !== "win32")(
  "a clodex planted in the clodex home, the child's working directory, is not the one the win32 spawn runs",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "kory-clodex-home-plant-"));
    const onPath = join(root, "path");
    const home = join(root, "home");
    mkdirSync(onPath);
    mkdirSync(home);
    const marker = join(root, "ran.txt");
    const evidence = mkdtempSync(join(tmpdir(), "kory-clodex-evidence-"));
    const hijacked = join(evidence, "hijacked.txt");
    const script = join(onPath, "witness.mjs");
    witnessScript(script, marker, home);
    writeFileSync(join(onPath, `${WITNESS}.cmd`), `@"${process.execPath}" "${script}"\r\n`);
    writeFileSync(join(home, `${WITNESS}.cmd`), `@echo PLANTED> "${hijacked}"\r\n`);

    const env = withoutSafeSearch(withPathEntry({ ...process.env, CLODEX_HOME: home }, onPath));
    try {
      await runOwnedSpawn(root, env, () => {
        expect(existsSync(marker), "the clodex on PATH did not run").toBe(true);
      });
    } finally {
      const ranPlanted = existsSync(hijacked);
      rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
      expect(ranPlanted, "the planted clodex ran").toBe(false);
    }
  },
  30_000
);

test.skipIf(process.platform !== "win32")(
  "a clodex planted in the clodex home is not run through an explicit dot entry leading the inherited PATH",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "kory-clodex-dot-plant-"));
    const onPath = join(root, "path");
    const home = join(root, "home");
    mkdirSync(onPath);
    mkdirSync(home);
    const marker = join(root, "ran.txt");
    const evidence = mkdtempSync(join(tmpdir(), "kory-clodex-evidence-"));
    const hijacked = join(evidence, "hijacked.txt");
    const script = join(onPath, "witness.mjs");
    witnessScript(script, marker, home);
    writeFileSync(join(onPath, `${WITNESS}.cmd`), `@"${process.execPath}" "${script}"\r\n`);
    writeFileSync(join(home, `${WITNESS}.cmd`), `@echo PLANTED> "${hijacked}"\r\n`);

    const env = withPathEntry(withPathEntry({ ...process.env, CLODEX_HOME: home }, onPath), ".");
    try {
      await runOwnedSpawn(root, env, () => {
        expect(existsSync(marker), "the clodex on PATH did not run").toBe(true);
      });
    } finally {
      const ranPlanted = existsSync(hijacked);
      rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
      expect(ranPlanted, "the planted clodex ran").toBe(false);
    }
  },
  30_000
);

const REPO = join(import.meta.dir, "..");
// Read from the package files, never required: another file of the same run
// may mock.module("electron"), and a require would then return that mock.
const ELECTRON_PACKAGE = join(REPO, "desktop", "node_modules", "electron");

function electronBinary(): string {
  const pointer = join(ELECTRON_PACKAGE, "path.txt");
  expect(existsSync(pointer), `electron is not installed: ${pointer} is missing`).toBe(true);
  return join(ELECTRON_PACKAGE, "dist", readFileSync(pointer, "utf8").trim());
}
const MAIN_DIR = join(REPO, "desktop", "src", "main").replaceAll("\\", "/");

const CONSOLE_PROBE = [
  "Add-Type -Name W -Namespace KoryProbe -MemberDefinition '",
  '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  "';",
  '"visible=$([KoryProbe.W]::IsWindowVisible([KoryProbe.W]::GetConsoleWindow()))"'
].join(" ");

/** Every window that becomes visible between `ready` and `stop`, with the name of its owner. */
const WINDOW_SAMPLER = [
  "param([string]$Ready, [string]$Stop, [string]$Out)",
  "Add-Type -TypeDefinition @'",
  "using System; using System.Collections.Generic; using System.Runtime.InteropServices;",
  "public static class KoryWindows {",
  "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  "  public static List<string> Visible() {",
  "    var r = new List<string>();",
  '    EnumWindows((h, l) => { if (IsWindowVisible(h)) { uint pid; GetWindowThreadProcessId(h, out pid); r.Add(h.ToInt64() + "|" + pid); } return true; }, IntPtr.Zero);',
  "    return r;",
  "  }",
  "}",
  "'@",
  "$before = @{}; foreach ($w in [KoryWindows]::Visible()) { $before[$w] = $true }",
  "$seen = @{}",
  "Set-Content -LiteralPath $Ready -Value ready",
  "while (-not (Test-Path -LiteralPath $Stop)) {",
  "  foreach ($w in [KoryWindows]::Visible()) {",
  "    if (-not $before.ContainsKey($w) -and -not $seen.ContainsKey($w)) {",
  "      $seen[$w] = [string](Get-Process -Id ([int]$w.Split('|')[1]) -ErrorAction SilentlyContinue).ProcessName",
  "    }",
  "  }",
  "  Start-Sleep -Milliseconds 20",
  "}",
  'Set-Content -LiteralPath $Out -Value @($seen.GetEnumerator() | ForEach-Object { "$($_.Key)|$($_.Value)" })'
].join("\r\n");

/** An owner that exited before being named stays suspect; a known unrelated application does not. */
const CONSOLE_OWNERS = /^(|windowsterminal|openconsole|conhost|cmd|powershell|pwsh|bun|node|electron)$/i;

const ENTRY = `
import { writeFileSync } from "node:fs";
import { createClodexControllerDeps } from "${MAIN_DIR}/clodex-lifecycle-deps.ts";
import { createClodexProcessIo } from "${MAIN_DIR}/clodex-process-io.ts";
const [result, logsDir] = process.argv.slice(2);
const traces = [];
const relays = [];
const deps = createClodexControllerDeps({ shell: "", logsDir, onError: (_scope, message, error) => { traces.push(message + ": " + String(error)); } });
const spawn = deps.spawn;
deps.spawn = (file, args, options) => { const child = spawn(file, args, options); relays.push(child.pid); return child; };
const io = createClodexProcessIo(deps, { registerAttempts: 120, registerIntervalMs: 250 });
try {
  writeFileSync(result, JSON.stringify({ owner: await io.spawn(${JSON.stringify(WITNESS)}, ["server", "--proxy"]), relays, traces }));
} catch (error) {
  writeFileSync(result, JSON.stringify({ error: String(error), relays, traces }));
}
process.exit(0);
`;

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(process.platform !== "win32")(
  "a proxy launched from a console-less Electron opens no visible console and outlives it, then stops",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "kory-clodex-conwin-"));
    const home = join(root, "home");
    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    const consoleFile = join(root, "console.txt");
    const script = join(root, "witness.mjs");
    writeFileSync(
      script,
      [
        'import { spawnSync } from "node:child_process";',
        'import { mkdirSync, writeFileSync } from "node:fs";',
        `const probe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", ${JSON.stringify(CONSOLE_PROBE)}], { encoding: "utf8" });`,
        `writeFileSync(${JSON.stringify(consoleFile)}, String(probe.stdout) + String(probe.stderr));`,
        `mkdirSync(${JSON.stringify(home)}, { recursive: true });`,
        `writeFileSync(${JSON.stringify(join(home, "server-runtime.json"))}, JSON.stringify([`,
        '  { mode: "proxy", port: 17998, pid: process.pid, startedAt: new Date().toISOString() }',
        "]));",
        "setInterval(() => {}, 1000);"
      ].join("\n")
    );
    writeFileSync(join(root, `${WITNESS}.cmd`), `@"${process.execPath}" "${script}"\r\n`);
    writeFileSync(join(root, "entry.ts"), ENTRY);
    const built = await Bun.build({
      entrypoints: [join(root, "entry.ts")],
      target: "node",
      format: "esm",
      outdir: join(root, "bundle"),
      naming: "[name].mjs"
    });
    expect(built.success, built.logs.map(String).join("\n")).toBe(true);

    const sampler = [join(root, "sampler.ps1"), join(root, "ready"), join(root, "stop"), join(root, "windows.txt")];
    writeFileSync(sampler[0]!, WINDOW_SAMPLER);
    const samplerProcess = spawnProcess(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sampler[0]!, sampler[1]!, sampler[2]!, sampler[3]!],
      { stdio: "ignore", windowsHide: true }
    );
    const env = withPathEntry({ ...process.env, CLODEX_HOME: home, ELECTRON_RUN_AS_NODE: "1" }, root);
    const result = join(root, "result.json");
    let outcome: { owner?: OwnerRecord; error?: string; relays: number[]; traces: string[] } | null = null;
    let stopped = false;
    try {
      await waitFor(() => existsSync(sampler[1]!), "the window sampler");
      const electron = spawnSync(electronBinary(), [join(root, "bundle", "entry.mjs"), result, logsDir], {
        env,
        timeout: 60_000,
        encoding: "utf8"
      });
      writeFileSync(sampler[2]!, "stop");
      await waitFor(() => existsSync(sampler[3]!), "the window sampler report");
      outcome = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : null;
      expect(outcome, `electron exited ${electron.status}: ${electron.stderr}`).not.toBeNull();
      expect(outcome!.error, outcome!.traces.join("\n")).toBeUndefined();
      const owner = outcome!.owner!;

      expect(readFileSync(consoleFile, "utf8").trim(), "the proxy's console window").toBe("visible=False");
      const opened = readFileSync(sampler[3]!, "utf8")
        .split(/\r?\n/)
        .filter((line) => line !== "" && CONSOLE_OWNERS.test(line.split("|")[2] ?? ""));
      expect(opened, "windows opened while Electron launched the proxy").toEqual([]);

      await waitFor(() => outcome!.relays.every((pid) => !isRunning(pid)), "the relay to die with Electron");
      expect(outcome!.relays).not.toContain(owner.tree.root.pid);
      expect(isRunning(owner.tree.root.pid), "the owned root outlived Electron").toBe(true);
      expect(isRunning(owner.tree.runtime.pid), "the proxy outlived Electron").toBe(true);

      const io = createClodexProcessIo(createClodexControllerDeps({ shell: "", logsDir, env }), {
        registerAttempts: 1
      });
      await io.stopTree(owner);
      expect(isRunning(owner.tree.runtime.pid), "the proxy survived the stop").toBe(false);
      stopped = true;
    } finally {
      if (!existsSync(sampler[2]!)) writeFileSync(sampler[2]!, "stop");
      if (!stopped) {
        const tree = outcome?.owner?.tree;
        await killTrees([...(tree ? [tree.root.pid, tree.runtime.pid] : []), ...(outcome?.relays ?? [])]);
      }
      samplerProcess.kill();
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A still-locked temp dir must not mask the assertion that failed.
      }
    }
  },
  120_000
);
