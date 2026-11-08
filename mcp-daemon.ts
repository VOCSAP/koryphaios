import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { coreLogDir, createLogger } from "./shared/logger.ts";
import { daemonCodeRoot, installProcessHandlers, osUsername, runDaemon, scrubSessionEnv } from "./shared/mcp-daemon-lifecycle.ts";

const logDir = coreLogDir();
const log = createLogger({ dir: logDir, name: "server", mirrorToConsole: false }).child("daemon");

scrubSessionEnv(process.env, log);

// Imported after the scrub: the roadmap server must never read a session variable of the shell that started the daemon.
const { createRoadmapServer } = await import("./shared/roadmap-server.ts");

const codeDir = realpathSync.native(import.meta.dir);
const run = runDaemon({
  home: homedir(),
  username: osUsername,
  env: process.env,
  codeRoot: daemonCodeRoot(codeDir),
  codeDir,
  logDir,
  families: { roadmap: (hello) => createRoadmapServer({ env: hello.env }) },
});

installProcessHandlers(process, { stop: (reason) => void run.stop(reason), log, now: Date.now });

process.exit(await run.done);
