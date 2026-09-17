// The detached proxy spawn of desktop/src/main/clodex-process-io, run for real
// on Windows: a witness stands in for clodex, writes a file, registers itself
// as a proxy in a private CLODEX_HOME, and the owned tree is then stopped.

import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClodexControllerDeps } from "../desktop/src/main/clodex-lifecycle-deps.ts";
import { createClodexProcessIo } from "../desktop/src/main/clodex-process-io.ts";

const WITNESS = "kory-clodex-spawn-witness";

function withPathEntry(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "Path";
  return { ...env, [key]: `${dir};${env[key] ?? ""}` };
}

test.skipIf(process.platform !== "win32")(
  "a detached win32 spawn runs its command and the owned tree stops",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "kory-clodex-spawn-"));
    const home = join(root, "home");
    const marker = join(root, "ran.txt");
    const script = join(root, "witness.mjs");
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
    writeFileSync(join(root, `${WITNESS}.cmd`), `@"${process.execPath}" "${script}"\r\n`);

    const logsDir = join(root, "logs");
    mkdirSync(logsDir);
    const deps = createClodexControllerDeps({
      shell: "",
      logsDir,
      env: withPathEntry({ ...process.env, CLODEX_HOME: home }, root)
    });
    const logs: number[] = [];
    const openLog = deps.openLog;
    deps.openLog = () => {
      const fd = openLog();
      if (fd !== null) logs.push(fd);
      return fd;
    };
    const io = createClodexProcessIo(deps, { registerAttempts: 60, registerIntervalMs: 250 });
    let owner: Awaited<ReturnType<typeof io.spawn>> | null = null;
    try {
      owner = await io.spawn(WITNESS, ["server", "--proxy"]);
      expect(existsSync(marker)).toBe(true);
      expect(owner.tree.platform).toBe("win32");
      expect(owner.tree.root.pid).not.toBe(owner.tree.runtime.pid);
      await io.stopTree(owner);
      expect(() => process.kill(owner!.tree.runtime.pid, 0)).toThrow();
      owner = null;
    } finally {
      if (owner) await deps.run("taskkill", ["/T", "/F", "/PID", String(owner.tree.root.pid)]);
      for (const fd of logs) closeSync(fd);
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  },
  30_000
);
