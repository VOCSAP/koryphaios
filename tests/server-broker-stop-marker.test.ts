import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerStopMarkerPath, writeBrokerStopMarker } from "../shared/broker-stop-marker.ts";
import { scrubEnv } from "./_helper.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freeLoopbackPort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("the port probe did not bind");
  return port;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

/** The process listening on 127.0.0.1:<port>, read from the socket table: never a kill by image name. */
function listenerPid(port: number, dir: string): number | null {
  const command = process.platform === "win32" ? ["netstat", "-ano", "-p", "TCP"] : ["lsof", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"];
  const out = Bun.spawnSync(command, { env: scrubEnv(dir) }).stdout.toString();
  if (process.platform !== "win32") {
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }
  for (const line of out.split(/\r?\n/)) {
    const [, local, , state, pid] = line.trim().split(/\s+/);
    if (local === `127.0.0.1:${port}` && state === "LISTENING") return Number(pid);
  }
  return null;
}

async function runServerWithMarker(placeMarker: (markerPath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cp-server-stop-marker-"));
  dirs.push(dir);
  const logDir = join(dir, "logs");
  const port = freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  placeMarker(brokerStopMarkerPath(join(dir, "claude-peers", "config.json")));

  const proc = Bun.spawn(["bun", "server.ts"], {
    env: scrubEnv(dir, {
      CLAUDE_PEERS_BROKER_URL: url,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_LOG_DIR: logDir,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const exited = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "still running" as const)]);
    const stderr = exited === "still running" ? "" : await new Response(proc.stderr).text();
    const brokerAnswered = await answers(url);
    const errorLines = exited === 1
      ? readFileSync(join(logDir, "server.log"), "utf8").split(/\r?\n/).filter((line) => line.includes(" ERROR ") && line.includes("stopped manually"))
      : [];
    return { exited, stderr, brokerAnswered, errorLines };
  } finally {
    proc.kill();
    if (await answers(url)) {
      const pid = listenerPid(port, dir);
      if (pid !== null && pid !== process.pid) process.kill(pid);
    }
  }
}

const REMEDY = "the local broker was stopped manually; start it again from the Avatar Tray or the Deck banner, or delete ";

test("server.ts refuses to start a manually stopped local broker, traces why, and spawns nothing", async () => {
  const run = await runServerWithMarker((markerPath) =>
    writeBrokerStopMarker(markerPath, { stopped_at: "2026-10-16T19:00:00.000Z", by: "avatar-tray", killed_pid: null })
  );

  expect(run.exited).toBe(1);
  expect(run.stderr).toContain(REMEDY);
  expect(run.errorLines).toHaveLength(1);
  expect(run.brokerAnswered, "no broker may have been spawned on the configured port").toBe(false);
}, 30_000);

test("a corrupted stop marker still stops server.ts from spawning the broker", async () => {
  const run = await runServerWithMarker((markerPath) => {
    mkdirSync(join(markerPath, ".."), { recursive: true });
    writeFileSync(markerPath, "{stopped");
  });

  expect(run.exited).toBe(1);
  expect(run.stderr).toContain(REMEDY);
  expect(run.brokerAnswered, "a corrupted marker must not read as absent").toBe(false);
}, 30_000);
