import { hostname as osHostname } from "node:os";
import { brokerAnswers, type BrokerEnsurer } from "./broker-ensure.ts";
import { brokerStopMarkerPath } from "./broker-stop-marker.ts";
import { settingsFilePath } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { FamilyContext, FamilyFactory } from "./mcp-daemon-server.ts";
import { createPeersSession, readPeersSessionSettings, type EnsureBrokerRequest } from "./peers-session.ts";
import { measureWriterGeneration } from "./process-generation.ts";

export interface PeersFamilyDeps {
  createSession?: typeof createPeersSession;
  measureWriterGeneration?: typeof measureWriterGeneration;
  hostname?: () => string;
  /** GET <url>/health: true when the broker answers 2xx. */
  isAlive?: (url: string, log: Logger) => Promise<boolean>;
}

function remoteBrokerUnreachable(url: string): Error {
  return new Error(
    `Broker at ${url} is unreachable. Remote brokers (HTTP mode) must be started manually; refusing to spawn a local broker that would not serve this URL. If this machine must keep working while the broker is unreachable, set offline_replica: true in ~/.config/claude-peers/config.json (%APPDATA%\\claude-peers\\config.json on Windows) (or CLAUDE_PEERS_OFFLINE_REPLICA=1) to run a local replica.`,
  );
}

/**
 * The session's own way to a broker: the daemon's ensurer launches a local broker once for all sessions.
 * Only a rejection marked `retryable` is tried again by the session: a launch that got no /health answer,
 * and a remote broker that does not answer /health.
 */
export function ensureBrokerFor(
  brokers: BrokerEnsurer,
  log: Logger,
  isAlive: NonNullable<PeersFamilyDeps["isAlive"]> = brokerAnswers,
): (request: EnsureBrokerRequest) => Promise<void> {
  return async ({ url, env }) => {
    const settingsPath = settingsFilePath(env);
    const sessionEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const outcome = await brokers.ensure({ url, settingsPath, env: sessionEnv });
    switch (outcome.action) {
      case "already-running":
      case "started":
        return;
      case "skipped":
        if (outcome.reason === "remote-mode") {
          if (await isAlive(url, log)) return;
          throw Object.assign(remoteBrokerUnreachable(url), { retryable: true });
        }
        throw new Error(
          `the local broker was stopped manually; start it again from the Avatar Tray or the Deck banner, or delete ${brokerStopMarkerPath(settingsPath)} (${outcome.detail})`,
        );
      case "not-found":
        throw new Error("broker.ts was not found in the code root of the daemon: the local broker cannot be started");
      case "failed":
        throw Object.assign(new Error(outcome.reason), outcome.retryable ? { retryable: true } : {});
    }
  };
}

export function createPeersFamily(deps: PeersFamilyDeps = {}): FamilyFactory {
  const createSession = deps.createSession ?? createPeersSession;
  const measure = deps.measureWriterGeneration ?? measureWriterGeneration;
  return (hello, ctx: FamilyContext) => {
    const session = createSession(
      {
        env: hello.env,
        cwd: hello.cwd,
        pid: hello.pid,
        ppid: hello.ppid,
        stdinIsTty: hello.stdin_is_tty,
        resume: ctx.resume,
      },
      {
        log: { log: (message) => ctx.log.info(message), logError: (message, error) => ctx.log.error(message, error) },
        home: ctx.home,
        hostname: deps.hostname ?? osHostname,
        ensureBroker: ensureBrokerFor(ctx.brokers, ctx.log, deps.isAlive),
        measureWriterGeneration: (pid) => measure(pid, ctx.log),
        settings: { ...readPeersSessionSettings({}, () => {}), ...ctx.settings },
        issueTicket: (claims) => ctx.issueTicket(claims),
        sendPidGeneration: true,
      },
    );
    session.ready.catch((error) => ctx.log.error("peers session failed to register", error));
    return { server: session.server, close: (reason) => session.close(reason) };
  };
}
