import { describe, expect, test } from "bun:test";
import { hostname as osHostname } from "node:os";
import { createBrokerEnsurer, type BrokerEnsureRequest, type BrokerEnsurer, type EnsureOutcome } from "../shared/broker-ensure.ts";
import { brokerStopMarkerPath } from "../shared/broker-stop-marker.ts";
import { settingsFilePath } from "../shared/config.ts";
import type { Logger } from "../shared/logger.ts";
import { createLinkIndex, linkKeyOf, type LinkedIdentity, type LinkIndex } from "../shared/mcp-daemon-links.ts";
import type { Hello } from "../shared/mcp-daemon-protocol.ts";
import type { FamilyContext, FamilyHandle, FamilyTicketClaims } from "../shared/mcp-daemon-server.ts";
import { createPeersFamily, ensureBrokerFor } from "../shared/peers-family.ts";
import { readPeersSessionSettings, type PeersSession, type PeersSessionDeps, type PeersSessionInput } from "../shared/peers-session.ts";

interface Lines {
  info: string[];
  warn: string[];
  error: string[];
}

function recordingLog(): { log: Logger; lines: Lines } {
  const lines: Lines = { info: [], warn: [], error: [] };
  const log: Logger = {
    info: (m) => void lines.info.push(m),
    warn: (m) => void lines.warn.push(m),
    error: (m) => void lines.error.push(m),
    child: () => log,
    file: "",
  };
  return { log, lines };
}

const hello: Hello = {
  proto: 1,
  family: "peers",
  relay_version: "0.1.0",
  code_root: "/code",
  pid: 4242,
  ppid: 100,
  pid_start: "1",
  ppid_start: "",
  cwd: "/work/a",
  stdin_is_tty: true,
  env: { CLAUDE_PEERS_PORT: "7899", MARK: "m" },
  replay: false,
};

interface Rig {
  ctx: FamilyContext;
  lines: Lines;
  issued: FamilyTicketClaims[];
  ensured: BrokerEnsureRequest[];
}

function rig(over: Partial<FamilyContext> = {}, outcome: EnsureOutcome = { action: "already-running" }): Rig {
  const { log, lines } = recordingLog();
  const issued: FamilyTicketClaims[] = [];
  const ensured: BrokerEnsureRequest[] = [];
  const brokers: BrokerEnsurer = {
    ensure: async (req) => {
      ensured.push(req);
      return outcome;
    },
  };
  const ctx: FamilyContext = {
    sessionId: "s1",
    log,
    home: "/home/u",
    resume: { kind: "none" },
    issueTicket: (claims) => void issued.push(claims),
    brokers,
    settings: readPeersSessionSettings({}, () => {}),
    ...over,
  };
  return { ctx, lines, issued, ensured };
}

interface SessionSeam {
  inputs: PeersSessionInput[];
  deps: PeersSessionDeps[];
  closes: string[];
  server: object;
  current: LinkedIdentity | null;
  createSession: (input: PeersSessionInput, deps: PeersSessionDeps) => PeersSession;
}

function sessionSeam(ready: Promise<void> = Promise.resolve()): SessionSeam {
  const seam: SessionSeam = {
    inputs: [],
    deps: [],
    closes: [],
    server: { name: "the server of the session" },
    current: null,
    createSession: (input, deps) => {
      seam.inputs.push(input);
      seam.deps.push(deps);
      return {
        server: seam.server,
        ready,
        close: async (reason: string) => void seam.closes.push(reason),
        openChannel: () => {},
        identity: () => seam.current,
      } as unknown as PeersSession;
    },
  };
  return seam;
}

function build(factory: ReturnType<typeof createPeersFamily>, ctx: FamilyContext): FamilyHandle {
  return factory(hello, ctx) as FamilyHandle;
}

describe("the peers family factory", () => {
  test("the session input comes from the HELLO of the relay: its pid and ppid, not those of the daemon", () => {
    const seam = sessionSeam();
    const r = rig({ resume: { kind: "refused", cause: "mac" } });
    build(createPeersFamily({ createSession: seam.createSession }), r.ctx);
    expect(seam.inputs).toEqual([
      {
        env: hello.env,
        cwd: "/work/a",
        pid: 4242,
        ppid: 100,
        stdinIsTty: true,
        resume: { kind: "refused", cause: "mac" },
      },
    ]);
    expect(seam.inputs[0]?.pid).not.toBe(process.pid);
  });

  test("the handle serves the server of the session and forwards the close reason", async () => {
    const seam = sessionSeam();
    const handle = build(createPeersFamily({ createSession: seam.createSession }), rig().ctx);
    expect(handle.server).toBe(seam.server as FamilyHandle["server"]);
    await handle.close("daemon_stop");
    await handle.close("bye");
    expect(seam.closes).toEqual(["daemon_stop", "bye"]);
  });

  test("the session logs through the log of the daemon session, writes its tickets through the daemon and sends its pid generation", () => {
    const seam = sessionSeam();
    const r = rig();
    build(createPeersFamily({ createSession: seam.createSession, hostname: () => "box" }), r.ctx);
    const deps = seam.deps[0] as PeersSessionDeps;
    deps.log.log("hello");
    deps.log.logError("broken", new Error("x"));
    expect(r.lines.info).toEqual(["hello"]);
    expect(r.lines.error).toEqual(["broken"]);
    const claims: FamilyTicketClaims = { writer_generation: null, instance_token: "t", peer_id: "p", group_id: "g", notified_hwm: 3 };
    deps.issueTicket?.(claims);
    expect(r.issued).toEqual([claims]);
    expect(deps.home).toBe("/home/u");
    expect(deps.hostname()).toBe("box");
    expect(deps.sendPidGeneration).toBe(true);
  });

  test("the host name is the one of the machine unless the factory is given another", () => {
    const seam = sessionSeam();
    build(createPeersFamily({ createSession: seam.createSession }), rig().ctx);
    expect((seam.deps[0] as PeersSessionDeps).hostname()).toBe(osHostname());
    expect(osHostname()).not.toBe("");
  });

  test("the pid generation is measured for the pid it is given, with the log of the session", async () => {
    const seam = sessionSeam();
    const r = rig();
    const measured: unknown[][] = [];
    build(
      createPeersFamily({
        createSession: seam.createSession,
        measureWriterGeneration: async (pid, log) => (measured.push([pid, log]), null),
      }),
      r.ctx,
    );
    await (seam.deps[0] as PeersSessionDeps).measureWriterGeneration(777);
    expect(measured).toEqual([[777, r.ctx.log]]);
  });

  test("settings missing from the daemon context come from the session defaults, and the daemon's own win", () => {
    const seam = sessionSeam();
    const defaults = readPeersSessionSettings({}, () => {});
    const partial = { contextResumeKeyTtlMs: 4_000, pollFallbackIntervalMs: 7_000, heartbeatIntervalMs: 9_000 };
    build(createPeersFamily({ createSession: seam.createSession }), rig({ settings: partial }).ctx);
    expect((seam.deps[0] as PeersSessionDeps).settings).toEqual({ ...defaults, ...partial });
  });

  test("a session that never registers is logged by the daemon, once, and does not escape as an unhandled rejection", async () => {
    const failure = new Error("register refused");
    const seam = sessionSeam(Promise.reject(failure));
    const r = rig();
    build(createPeersFamily({ createSession: seam.createSession }), r.ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.lines.error).toEqual(["peers session failed to register"]);
  });
});

describe("the publication of a session in the link index", () => {
  const linked: Hello = { ...hello, ppid_start: "gen-1", env: { ...hello.env, CLAUDE_CODE_MESSAGING_SOCKET: "sock-a" } };
  const key = linkKeyOf(linked) as NonNullable<ReturnType<typeof linkKeyOf>>;
  const mine: LinkedIdentity = { peerId: "p1", instanceToken: "t1", projectKey: "github.com/example/a", brokerUrl: "http://127.0.0.1:7899/" };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function open(links: LinkIndex, ready: Promise<void>, helloOver: Hello = linked) {
    const seam = sessionSeam(ready);
    seam.current = mine;
    const handle = createPeersFamily({ createSession: seam.createSession, links })(helloOver, rig().ctx) as FamilyHandle;
    return { seam, handle };
  }

  test("a session enters the index once it is registered, under the hello's key and the session id", async () => {
    const links = createLinkIndex();
    let registered!: () => void;
    open(links, new Promise<void>((resolve) => (registered = resolve)));
    await settle();
    expect(links.find(key), "a session still registering is not linked").toEqual({ kind: "none" });
    registered();
    await settle();
    expect(links.find(key)).toEqual({ kind: "one", sessionId: "s1", identity: mine });
  });

  test("the entry reads the identity of the session at each lookup", async () => {
    const links = createLinkIndex();
    const { seam } = open(links, Promise.resolve());
    await settle();
    seam.current = { ...mine, peerId: "renamed" };
    expect(links.find(key)).toMatchObject({ kind: "one", identity: { peerId: "renamed" } });
  });

  test("a closed session is out of the index", async () => {
    const links = createLinkIndex();
    const { handle } = open(links, Promise.resolve());
    await settle();
    await handle.close("bye");
    expect(links.find(key)).toEqual({ kind: "none" });
  });

  test("a session closed before it registered never enters the index", async () => {
    const links = createLinkIndex();
    let registered!: () => void;
    const { handle } = open(links, new Promise<void>((resolve) => (registered = resolve)));
    await handle.close("socket");
    registered();
    await settle();
    expect(links.find(key)).toEqual({ kind: "none" });
  });

  test("a session that fails to register never enters the index", async () => {
    const links = createLinkIndex();
    open(links, Promise.reject(new Error("register refused")));
    await settle();
    expect(links.find(key)).toEqual({ kind: "none" });
  });

  test("a session of another parent start time is not found under this key", async () => {
    const links = createLinkIndex();
    open(links, Promise.resolve(), { ...linked, ppid_start: "gen-2" });
    await settle();
    expect(links.find(key)).toEqual({ kind: "none" });
  });

  test("a hello without a messaging socket publishes nothing", async () => {
    const links = createLinkIndex();
    open(links, Promise.resolve(), { ...linked, env: { CLAUDE_PEERS_PORT: "7899" } });
    await settle();
    expect(links.find(key)).toEqual({ kind: "none" });
  });
});

describe("ensureBrokerFor", () => {
  const env = { CLAUDE_PEERS_PORT: "7899", DROPPED: undefined, MARK: "m", APPDATA: "/session/appdata", XDG_CONFIG_HOME: "/session/xdg" };
  const url = "http://127.0.0.1:7899";

  async function ensureWith(outcome: EnsureOutcome, isAlive: (url: string) => Promise<boolean> = async () => false) {
    const r = rig({}, outcome);
    const run = ensureBrokerFor(r.ctx.brokers, r.ctx.log, isAlive);
    return { r, result: run({ url, env }).then(() => null, (error: Error & { retryable?: boolean }) => error) };
  }

  test("the ensurer gets the url, the settings file of the session and its environment without undefined values", async () => {
    const { r, result } = await ensureWith({ action: "started", script: "/code/broker.ts" });
    expect(await result).toBeNull();
    expect(r.ensured).toStrictEqual([
      {
        url,
        settingsPath: settingsFilePath(env),
        env: { CLAUDE_PEERS_PORT: "7899", MARK: "m", APPDATA: "/session/appdata", XDG_CONFIG_HOME: "/session/xdg" },
      },
    ]);
    expect(settingsFilePath(env)).not.toBe(settingsFilePath(process.env));
  });

  test.each<[string, EnsureOutcome]>([
    ["a broker that already runs", { action: "already-running" }],
    ["a broker that was started", { action: "started", script: "/code/broker.ts" }],
  ])("%s lets the session go on", async (_name, outcome) => {
    expect(await (await ensureWith(outcome)).result).toBeNull();
  });

  test("a broker the operator stopped refuses the session, names the marker to delete and says what the marker says", async () => {
    const error = await (await ensureWith({ action: "skipped", reason: "manual-stop", detail: "stopped at 2026-11-09T08:00:00Z" })).result;
    expect(error?.message).toContain("stopped manually");
    expect(error?.message).toContain(brokerStopMarkerPath(settingsFilePath(env)));
    expect(error?.message).toContain("(stopped at 2026-11-09T08:00:00Z)");
    expect(error?.retryable).toBeUndefined();
  });

  test("a clone without broker.ts refuses the session for good", async () => {
    const error = await (await ensureWith({ action: "not-found" })).result;
    expect(error?.message).toContain("broker.ts was not found");
    expect(error?.retryable).toBeUndefined();
  });

  test("a launch that failed refuses the session with its reason, for good", async () => {
    const error = await (await ensureWith({ action: "failed", script: "/code/broker.ts", reason: "ENOENT bun" })).result;
    expect(error?.message).toBe("ENOENT bun");
    expect(error?.retryable).toBeUndefined();
  });

  test("a launch that got no /health answer in time may be tried again by the session", async () => {
    const error = await (
      await ensureWith({ action: "failed", script: "/code/broker.ts", reason: "no /health answer after 30 attempts", retryable: true })
    ).result;
    expect(error?.message).toBe("no /health answer after 30 attempts");
    expect(error?.retryable).toBe(true);
  });

  test("a remote broker that answers /health lets the session go on, one that does not may be tried again", async () => {
    const alive: string[] = [];
    const answering = async (asked: string) => (alive.push(asked), true);
    expect(await (await ensureWith({ action: "skipped", reason: "remote-mode" }, answering)).result).toBeNull();
    expect(alive).toEqual([url]);
    const error = await (await ensureWith({ action: "skipped", reason: "remote-mode" })).result;
    expect(error?.message).toContain("offline_replica");
    expect(error?.message).toContain(url);
    expect(error?.retryable).toBe(true);
  });

  test("a remote broker is never launched: the real ensurer behind the adapter spawns nothing for it", async () => {
    const remote = "http://192.0.2.23:7899";
    const spawns: string[] = [];
    const probes: string[] = [];
    const { log } = recordingLog();
    const ensurer = createBrokerEnsurer({
      isAlive: async (asked) => (probes.push(asked), false),
      stopped: () => null,
      locate: () => ({ command: "/bin/bun", script: "/code/broker.ts" }),
      spawn: (command) => void spawns.push(command),
      sleep: async () => {},
      baseEnv: {},
      home: "/home/u",
      log,
      attempts: 1,
    });
    const error = await ensureBrokerFor(ensurer, log, async () => false)({ url: remote, env }).then(
      () => null,
      (e: Error & { retryable?: boolean }) => e,
    );
    expect(error?.message).toContain(remote);
    expect(error?.retryable).toBe(true);
    expect(spawns).toEqual([]);
    expect(probes).toEqual([]);
  });
});
