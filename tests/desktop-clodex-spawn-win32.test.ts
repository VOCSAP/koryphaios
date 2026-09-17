// The detached proxy spawn, run for real on Windows: a witness stands in for
// clodex, writes a file, registers itself as a proxy in a private CLODEX_HOME,
// and the owned tree is then stopped.

import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClodexControllerDeps } from "../desktop/src/main/clodex-lifecycle-deps.ts";
import { createClodexProcessIo } from "../desktop/src/main/clodex-process-io.ts";

const WITNESS = "kory-clodex-spawn-witness";
const SAFE_SEARCH = "nodefaultcurrentdirectoryinexepath";

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
  const rootPids: number[] = [];
  const spawn = deps.spawn;
  deps.spawn = (file, args, options) => {
    const child = spawn(file, args, options);
    if (child.pid !== undefined) rootPids.push(child.pid);
    return child;
  };
  const io = createClodexProcessIo(deps, { registerAttempts: 60, registerIntervalMs: 250 });
  let stopped = false;
  try {
    const owner = await io.spawn(WITNESS, ["server", "--proxy"]);
    inspect();
    expect(owner.tree.platform).toBe("win32");
    expect(owner.tree.root.pid).not.toBe(owner.tree.runtime.pid);
    await io.stopTree(owner);
    expect(() => process.kill(owner.tree.runtime.pid, 0)).toThrow();
    stopped = true;
  } finally {
    if (!stopped) {
      for (const pid of rootPids) await deps.run("taskkill", ["/T", "/F", "/PID", String(pid)]);
    }
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
