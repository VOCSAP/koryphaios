import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { coreLogDir, createLogger } from "./shared/logger.ts";
import { daemonCodeRoot, installProcessHandlers, osUsername, runDaemon, scrubSessionEnv } from "./shared/mcp-daemon-lifecycle.ts";

const logDir = coreLogDir();
const log = createLogger({ dir: logDir, name: "server", mirrorToConsole: false }).child("daemon");

scrubSessionEnv(process.env, log);

// Imported after the scrub: these modules must never read a session variable of the shell that started the daemon.
const { createRoadmapServer } = await import("./shared/roadmap-server.ts");
const { createBrokerEnsurer, daemonBrokerDeps } = await import("./shared/broker-ensure.ts");
const { readPeersSessionSettings } = await import("./shared/peers-session.ts");
const { createPeersFamily } = await import("./shared/peers-family.ts");

const home = homedir();
const codeDir = realpathSync.native(import.meta.dir);
const brokers = createBrokerEnsurer(
  daemonBrokerDeps({ env: process.env, home, codeDir, log, which: (PATH) => Bun.which("bun", { PATH }) }),
);
const run = runDaemon({
  home,
  username: osUsername,
  env: process.env,
  codeRoot: daemonCodeRoot(codeDir),
  codeDir,
  logDir,
  families: { roadmap: (hello) => createRoadmapServer({ env: hello.env }), peers: createPeersFamily() },
  brokers,
  settings: readPeersSessionSettings(process.env, (message) => log.error(message)),
});

installProcessHandlers(process, { stop: (reason) => void run.stop(reason), log, now: Date.now });

process.exit(await run.done);
