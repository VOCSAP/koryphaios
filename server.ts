#!/usr/bin/env bun
/**
 * Stdio entry of the claude-peers MCP server: one session per process.
 * SIGINT/SIGTERM transitions the peer to 'dormant' via /disconnect
 * (resume-able) rather than /unregister (DELETE).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isLoopbackBrokerUrl, settingsFilePath } from "./shared/config.ts";
import { brokerStopMarkerPath, readBrokerStopMarker } from "./shared/broker-stop-marker.ts";
import { measureWriterGeneration } from "./shared/process-generation.ts";
import { createLogger, coreLogDir, stderrMirror } from "./shared/logger.ts";
import {
  createPeersSession,
  readPeersSessionSettings,
  type EnsureBrokerRequest,
} from "./shared/peers-session.ts";

const BROKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");

// stdout carries the MCP stdio protocol: the file logger has no console mirror
// and stderrMirror writes the stderr line.
const serverLog = stderrMirror(
  createLogger({ dir: coreLogDir(), name: "server", mirrorToConsole: false }),
  "claude-peers"
);
const { log, logError } = serverLog;

async function isBrokerAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker({ url, env }: EnsureBrokerRequest): Promise<void> {
  if (await isBrokerAlive(url)) {
    log("Broker already running");
    return;
  }

  // HTTP-remote mode fails fast instead of spawning a local broker: a local
  // spawn would bind 127.0.0.1 and never satisfy the remote URL, leaking the
  // spawned process as a zombie after the outer throw.
  if (!isLoopbackBrokerUrl(url)) {
    throw new Error(
      `Broker at ${url} is unreachable. Remote brokers (HTTP mode) must be started manually; refusing to spawn a local broker that would not serve this URL. If this machine must keep working while the broker is unreachable, set offline_replica: true in ~/.config/claude-peers/config.json (%APPDATA%\\claude-peers\\config.json on Windows) (or CLAUDE_PEERS_OFFLINE_REPLICA=1) to run a local replica.`
    );
  }

  const markerPath = brokerStopMarkerPath(settingsFilePath(env));
  const stop = readBrokerStopMarker(markerPath);
  if (stop.stopped) {
    const detail = stop.marker ? ` at ${stop.marker.stopped_at}` : `, marker unreadable: ${stop.problem}`;
    const message = `the local broker was stopped manually; start it again from the Avatar Tray or the Deck banner, or delete ${markerPath} (stopped${detail})`;
    logError(message);
    throw new Error(message);
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive(url)) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

async function main() {
  // Last-resort safety nets: Bun exits on unhandled rejections; leave a trace
  // first. Async cleanup (POST /disconnect) is not reliable here -- the broker's
  // stale sweeps will mark the peer dormant.
  process.on("uncaughtException", (e) => {
    logError("uncaught exception, exiting", e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logError("unhandled rejection, exiting", e);
    process.exit(1);
  });

  const session = createPeersSession(
    {
      env: process.env,
      cwd: process.cwd(),
      pid: process.pid,
      ppid: process.ppid,
      stdinIsTty: Boolean(process.stdin.isTTY),
    },
    {
      log: serverLog,
      home: homedir(),
      hostname,
      ensureBroker,
      measureWriterGeneration,
      settings: readPeersSessionSettings(process.env, logError),
    }
  );
  await session.ready;

  await session.server.connect(new StdioServerTransport(process.stdin, process.stdout));
  log("MCP connected");

  let shuttingDown = false;
  const shutdown = async (stdinReason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (stdinReason) log(`stdin ${stdinReason} -- Claude Code closed, shutting down`);
    try {
      await session.close("bye");
    } catch (e) {
      logError("Session close failed", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => void shutdown("end"));
  process.stdin.on("close", () => void shutdown("close"));
}

if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
