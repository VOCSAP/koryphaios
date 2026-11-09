import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  NotificationDropped,
  aclScratchPath,
  loadKey,
  permissionVerdict,
  startDaemon,
  windowsAclVerdict,
  type AclTools,
  type CloseReason,
  type DaemonHandle,
  type FamilyContext,
  type FamilyFactory,
  type FamilyTicketClaims,
} from "../shared/mcp-daemon-server.ts";
import {
  FRAME_TYPE,
  b64u,
  buildChallenge,
  encodeFrame,
  mintTicket,
  verifyTicket,
  type TicketClaims,
} from "../shared/mcp-daemon-protocol.ts";
import type { Logger } from "../shared/logger.ts";
import { controlRequest, type ControlConnect } from "../shared/mcp-daemon-control.ts";
import {
  CODE_ROOT,
  FakeClock,
  FakeRelay,
  KEY_HEX,
  harness,
  helloFor,
  key,
  linkTestKey,
  protectForTest,
  settle,
  until,
  within,
  type Harness,
} from "./_mcp-daemon-fake-relay.ts";

let root: string;
let dirCounter = 0;

function freshDirs(): { keyPath: string; logDir: string } {
  const dir = join(root, `d${++dirCounter}`);
  return { keyPath: join(dir, "peers", "mcp-daemon.key"), logDir: join(dir, "logs") };
}

function logOf(logDir: string): string {
  return readFileSync(join(logDir, "server.log"), "utf8");
}

const toStop: DaemonHandle[] = [];

function launch(
  h: Harness,
  over: Partial<Parameters<typeof startDaemon>[0]> = {},
): { daemon: DaemonHandle; logDir: string; keyPath: string } {
  const dirs = freshDirs();
  linkTestKey(root, dirs.keyPath);
  const daemon = startDaemon({
    port: 0,
    ...dirs,
    codeRoot: CODE_ROOT,
    families: { roadmap: h.factory() },
    ...over,
  });
  toStop.push(daemon);
  return { daemon, ...dirs };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-daemon-server-"));
});

afterAll(async () => {
  for (const daemon of toStop) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("sessions on a shared daemon", () => {
  const h = harness();
  let daemon: DaemonHandle;
  let logDir: string;

  beforeAll(() => {
    ({ daemon, logDir } = launch(h, { clock: new FakeClock() }));
  });

  test("a full session reaches tools/list and tools/call through the family", async () => {
    const relay = await FakeRelay.open(daemon.port);
    const welcome = await relay.welcome({ cwd: "/work/full" });
    expect(welcome).toMatchObject({ family: "roadmap", resumed: false });
    expect(welcome.session_id).toMatch(/^[0-9a-f-]{36}$/);
    const init = await relay.rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-relay", version: "0" },
    });
    expect(init.result.serverInfo.name).toBe("fake-roadmap");
    const tools = await relay.rpc(2, "tools/list");
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(["whoami"]);
    expect(await relay.whoami(3)).toEqual({ cwd: "/work/full", calls: 1, env: "m" });
    relay.close();
  });

  test("two simultaneous sessions keep their own state, session id and hello", async () => {
    const a = await FakeRelay.open(daemon.port);
    const b = await FakeRelay.open(daemon.port);
    const wa = await a.welcome({ cwd: "/work/A", env: { MARK: "from-a" } });
    const wb = await b.welcome({ cwd: "/work/B", env: { MARK: "from-b" } });
    expect(wa.session_id).not.toBe(wb.session_id);
    expect(wa.tools_hash).toBe(wb.tools_hash);
    expect(await a.whoami(1)).toEqual({ cwd: "/work/A", calls: 1, env: "from-a" });
    expect(await b.whoami(1)).toEqual({ cwd: "/work/B", calls: 1, env: "from-b" });
    expect(await a.whoami(2)).toEqual({ cwd: "/work/A", calls: 2, env: "from-a" });
    expect(await b.whoami(2)).toEqual({ cwd: "/work/B", calls: 2, env: "from-b" });
    a.close();
    b.close();
  });

  test("tools_hash follows the served tool list", async () => {
    const other = launch(harness(), { families: { roadmap: harness().factory("extra_tool") } });
    const mine = await (await FakeRelay.open(daemon.port)).welcome({ cwd: "/work/hash" });
    const theirs = await (await FakeRelay.open(other.daemon.port)).welcome({ cwd: "/work/hash" });
    expect(mine.tools_hash).toHaveLength(43);
    expect(theirs.tools_hash).not.toBe(mine.tools_hash);
  });

  test.each([[undefined], [65_536]])(
    "once WELCOME is sent, MCP frames may exceed the HELLO bound (relay write cap %p)",
    async (writeCap) => {
      const relay = await FakeRelay.open(daemon.port, { writeCap });
      await relay.welcome({ cwd: "/work/big" });
      const reply = await relay.rpc(1, "tools/call", { name: "whoami", arguments: { pad: "x".repeat(700_000) } });
      expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ cwd: "/work/big" });
      relay.close();
    },
  );

  test("a reply larger than the socket accepts at once reaches the relay in full", async () => {
    const { daemon: capped } = launch(harness(), { writeCap: 65_536 });
    const relay = await FakeRelay.open(capped.port);
    await relay.welcome({ cwd: "/work/big-reply" });
    const reply = await relay.rpc(1, "tools/call", { name: "whoami", arguments: { reply_pad: 700_000 } });
    const body = JSON.parse(reply.result.content[0].text) as { cwd: string; pad: string };
    expect(body.cwd).toBe("/work/big-reply");
    expect(body.pad).toHaveLength(700_000);
    expect(await relay.whoami(2)).toMatchObject({ cwd: "/work/big-reply", calls: 2 });
    relay.close();
  });

  test("PING is answered by PONG on the sealed channel", async () => {
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/ping" });
    relay.send(FRAME_TYPE.PING, "");
    const pong = await relay.expectFrame(FRAME_TYPE.PONG, "PONG");
    expect(pong.payload).toHaveLength(0);
    relay.close();
  });

  test("an MCP frame that is not JSON-RPC is dropped and the session keeps working", async () => {
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/junk" });
    relay.send(FRAME_TYPE.MCP, "this is not json");
    expect(await relay.whoami(1)).toMatchObject({ cwd: "/work/junk", calls: 1 });
    expect(logOf(logDir)).toContain("dropping an MCP frame that is not a JSON-RPC message");
    relay.close();
  });

  test("BYE closes the session and its MCP server", async () => {
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/bye" });
    const live = daemon.stats().sessions;
    relay.send(FRAME_TYPE.BYE, JSON.stringify({ reason: "stdin_eof" }));
    await until(() => daemon.stats().sessions === live - 1, "the session count to drop after BYE");
    await until(() => h.closed.some((c) => c.cwd === "/work/bye"), "the MCP server to be closed after BYE");
    await relay.expectClosed("socket closed by the daemon after BYE");
    expect(logOf(logDir)).toContain("session closed reason=bye");
  });

  test("a socket closed without BYE ends the session as well", async () => {
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/drop" });
    relay.close();
    await until(() => h.closed.some((c) => c.cwd === "/work/drop"), "the MCP server to be closed after a socket drop");
    expect(logOf(logDir)).toContain("session closed reason=socket");
  });

  test("log lines of a session carry its s=<id 8> tag", async () => {
    const relay = await FakeRelay.open(daemon.port);
    const welcome = await relay.welcome({ cwd: "/work/tag" });
    const tag = `[s=${welcome.session_id.slice(0, 8)}]`;
    relay.close();
    await until(() => logOf(logDir).includes(`${tag} session closed`), "the tagged close line");
    expect(logOf(logDir)).toContain(`${tag} session open family=roadmap`);
  });

  test("frames sent while the family is still being built are served after WELCOME", async () => {
    let release!: () => void;
    h.gates.set("/work/slow", new Promise<void>((resolve) => (release = resolve)));
    const relay = await FakeRelay.open(daemon.port);
    relay.sendHello({ cwd: "/work/slow" });
    relay.send(FRAME_TYPE.MCP, JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
    await settle();
    release();
    await relay.expectFrame(FRAME_TYPE.WELCOME, "WELCOME");
    const reply = await relay.expectFrame(FRAME_TYPE.MCP, "reply to the early tools/list");
    expect(JSON.parse(reply.payload.toString()).id).toBe(9);
    relay.close();
  });

  test("a second HELLO on a live session closes it", async () => {
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/twice" });
    relay.sendHello({ cwd: "/work/twice" });
    await relay.expectClosed("connection closed after a second HELLO");
  });
});

describe("refusals", () => {
  const h = harness();
  let daemon: DaemonHandle;
  let logDir: string;

  beforeAll(() => {
    ({ daemon, logDir } = launch(h, { clock: new FakeClock() }));
  });

  async function sealedError(relay: FakeRelay): Promise<{ code: string; message: string }> {
    const frame = await relay.expectFrame(FRAME_TYPE.ERROR, "sealed ERROR");
    return JSON.parse(frame.payload.toString());
  }

  test("a MAC computed with another key closes the connection with no AUTH_OK and no HELLO read", async () => {
    const before = daemon.stats().authRefused;
    const relay = await FakeRelay.connect(daemon.port);
    await relay.sendAuth({ useKey: Buffer.alloc(32, 7) });
    await relay.expectClosed("close after a bad MAC");
    expect(h.created).toHaveLength(0);
    expect(daemon.stats().authRefused).toBe(before + 1);
  });

  test("a version range with no common version gets the one unauthenticated ERROR, proto_mismatch", async () => {
    const relay = await FakeRelay.connect(daemon.port);
    await relay.sendAuth({ protoMin: 2, protoMax: 2 });
    const frame = await relay.expectFrame(FRAME_TYPE.ERROR, "plain ERROR");
    expect(JSON.parse(frame.payload.toString()).code).toBe("proto_mismatch");
    await relay.expectClosed("close after proto_mismatch");
  });

  test("bytes glued after the AUTH frame close the connection", async () => {
    const relay = await FakeRelay.connect(daemon.port);
    await relay.sendAuth({ trailing: Buffer.from([1]) });
    await relay.expectClosed("close after trailing bytes");
  });

  test("a first frame that is not AUTH closes the connection", async () => {
    const relay = await FakeRelay.connect(daemon.port);
    await relay.expectFrame(FRAME_TYPE.CHALLENGE, "CHALLENGE");
    relay.writeRaw(encodeFrame(FRAME_TYPE.PING, Buffer.alloc(0)));
    await relay.expectClosed("close after a PING instead of AUTH");
  });

  test("an unauthenticated frame above 64 KiB closes the connection before its body", async () => {
    const relay = await FakeRelay.connect(daemon.port);
    await relay.expectFrame(FRAME_TYPE.CHALLENGE, "CHALLENGE");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(64 * 1024 + 2);
    relay.writeRaw(header);
    await relay.expectClosed("close after an oversized pre-auth length");
    await until(() => daemon.stats().preAuthFailures > 0, "the pre-auth failure to be counted");
  });

  test("a bit flipped in the sealed HELLO closes the connection with no reply and no session", async () => {
    const relay = await FakeRelay.open(daemon.port);
    const wire = relay.seal(FRAME_TYPE.HELLO, JSON.stringify(helloFor({ cwd: "/work/flip" })));
    wire[wire.length - 1] = (wire[wire.length - 1] as number) ^ 1;
    relay.writeRaw(wire);
    await relay.expectClosed("close after an invalid tag");
    expect(h.created).not.toContain("/work/flip");
    expect(logOf(logDir)).toContain("closing: frame rejected: sealed frame authentication failed");
  });

  test("a sealed frame above the HELLO bound closes the connection before its body", async () => {
    const relay = await FakeRelay.open(daemon.port);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(512 * 1024 + 17 + 1);
    relay.writeRaw(header);
    await relay.expectClosed("close after an oversized HELLO");
  });

  test("a hello from another code root gets root_mismatch and never reaches the factory", async () => {
    const relay = await FakeRelay.open(daemon.port);
    relay.sendHello({ cwd: "/work/root", code_root: "d".repeat(64) });
    expect((await sealedError(relay)).code).toBe("root_mismatch");
    await relay.expectClosed("close after root_mismatch");
    expect(h.created).not.toContain("/work/root");
  });

  test("the peers family is not served: family_unavailable", async () => {
    const relay = await FakeRelay.open(daemon.port);
    relay.sendHello({ family: "peers", cwd: "/work/peers" });
    expect((await sealedError(relay)).code).toBe("family_unavailable");
    await relay.expectClosed("close after family_unavailable");
    expect(logOf(logDir)).toContain("hello refused: family peers is not served");
  });

  test("an invalid hello gets hello_invalid with the cause", async () => {
    const relay = await FakeRelay.open(daemon.port);
    relay.sendHello({ pid: 0 });
    const error = await sealedError(relay);
    expect(error.code).toBe("hello_invalid");
    expect(error.message).toContain("pid");
  });

  test("a family factory that throws gets family_unavailable and a log line", async () => {
    const relay = await FakeRelay.open(daemon.port);
    relay.sendHello({ cwd: "/work/boom" });
    expect((await sealedError(relay)).code).toBe("family_unavailable");
    expect(logOf(logDir)).toContain("family factory failed");
  });

  test("a daemon at its session limit answers session_limit to the next hello", async () => {
    const limited = launch(harness(), { maxSessions: 1 });
    const first = await FakeRelay.open(limited.daemon.port);
    await first.welcome({ cwd: "/work/one" });
    const second = await FakeRelay.open(limited.daemon.port);
    second.sendHello({ cwd: "/work/two" });
    expect((await sealedError(second)).code).toBe("session_limit");
    first.close();
  });
});

describe("unauthenticated connections", () => {
  test("the 33rd pending connection is closed at once, counted, and a freed slot is reusable", async () => {
    const { daemon } = launch(harness(), { clock: new FakeClock() });
    const pending: FakeRelay[] = [];
    for (let i = 0; i < 32; i++) {
      const relay = await FakeRelay.connect(daemon.port);
      await relay.expectFrame(FRAME_TYPE.CHALLENGE, `CHALLENGE ${i}`);
      pending.push(relay);
    }
    expect(daemon.stats().unauthenticated).toBe(32);
    const outcome = await FakeRelay.connect(daemon.port).then(
      (relay) => relay.nextFrame("the 33rd connection to be closed"),
      () => "reset" as const,
    );
    expect(["reset", "closed"]).toContain(outcome as string);
    await until(() => daemon.stats().refusedUnauthenticated === 1, "the refusal to be counted");
    pending[0]?.close();
    await until(() => daemon.stats().unauthenticated === 31, "a slot to be freed");
    const again = await FakeRelay.connect(daemon.port);
    await again.expectFrame(FRAME_TYPE.CHALLENGE, "CHALLENGE after a slot was freed");
  });

  test("a silent peer is cut at 3 s of the injected clock, not before", async () => {
    const clock = new FakeClock();
    const { daemon, logDir } = launch(harness(), { clock });
    const relay = await FakeRelay.connect(daemon.port);
    await relay.expectFrame(FRAME_TYPE.CHALLENGE, "CHALLENGE");
    clock.advance(2999);
    await settle();
    expect(relay.closed).toBe(false);
    expect(daemon.stats().handshakeTimeouts).toBe(0);
    clock.advance(1);
    await relay.expectClosed("close at the stage deadline");
    expect(daemon.stats().handshakeTimeouts).toBe(1);
    expect(daemon.stats().unauthenticated).toBe(0);
    expect(daemon.stats().preAuthFailures).toBe(1);
    clock.advance(60_000);
    expect(logOf(logDir)).toContain('first: handshake stage "auth" exceeded 3000 ms');
  });

  test("pre-auth failures are counted and summarised once per 60 s of the injected clock", async () => {
    const clock = new FakeClock();
    const { daemon, logDir } = launch(harness(), { clock });
    const summaries = () => logOf(logDir).split("\n").filter((line) => line.includes("pre-auth:"));
    for (let i = 0; i < 3; i++) {
      const relay = await FakeRelay.connect(daemon.port);
      await relay.sendAuth({ useKey: Buffer.alloc(32, 7) });
      await relay.expectClosed("close after a bad MAC");
    }
    const broken = await FakeRelay.connect(daemon.port);
    await broken.expectFrame(FRAME_TYPE.CHALLENGE, "CHALLENGE");
    broken.writeRaw(Buffer.alloc(4));
    await broken.expectClosed("close after a zero length");
    await until(() => daemon.stats().preAuthFailures === 4, "four pre-auth failures to be counted");
    expect(logOf(logDir)).not.toContain("handshake refused");
    clock.advance(59_999);
    expect(summaries()).toHaveLength(0);
    clock.advance(1);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toContain("pre-auth: 4 connection(s)");
    const next = await FakeRelay.connect(daemon.port);
    await next.sendAuth({ useKey: Buffer.alloc(32, 7) });
    await next.expectClosed("close after another bad MAC");
    await until(() => daemon.stats().preAuthFailures === 5, "the fifth failure to be counted");
    clock.advance(60_000);
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1]).toContain("pre-auth: 1 connection(s)");
  });

  test("a peer that trickles one byte per second still hits the absolute stage deadline", async () => {
    const clock = new FakeClock();
    const { daemon } = launch(harness(), { clock });
    const relay = await FakeRelay.connect(daemon.port);
    await relay.expectFrame(FRAME_TYPE.CHALLENGE, "CHALLENGE");
    for (let second = 0; second < 3; second++) {
      relay.writeRaw(Buffer.from([0x20]));
      await settle();
      clock.advance(1000);
    }
    await relay.expectClosed("close at 3 s despite the trickle");
    expect(daemon.stats().handshakeTimeouts).toBe(1);
  });

  test("the second stage has its own 3 s: an authenticated peer that sends no HELLO is cut", async () => {
    const clock = new FakeClock();
    const { daemon, logDir } = launch(harness(), { clock });
    const relay = await FakeRelay.open(daemon.port);
    clock.advance(2999);
    await settle();
    expect(relay.closed).toBe(false);
    clock.advance(1);
    await relay.expectClosed("close at the HELLO deadline");
    expect(logOf(logDir)).toContain('handshake stage "hello" exceeded 3000 ms');
  });

  test("a family that never finishes building is cut by the third stage", async () => {
    const clock = new FakeClock();
    const h = harness();
    h.gates.set("/work/hang", new Promise<void>(() => undefined));
    const { daemon, logDir } = launch(h, { clock });
    const relay = await FakeRelay.open(daemon.port);
    relay.sendHello({ cwd: "/work/hang" });
    await settle();
    clock.advance(3000);
    await relay.expectClosed("close at the WELCOME deadline");
    expect(logOf(logDir)).toContain('handshake stage "building" exceeded 3000 ms');
  });

  test("a live session has no deadline", async () => {
    const clock = new FakeClock();
    const { daemon } = launch(harness(), { clock });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/live" });
    clock.advance(60_000);
    await settle();
    expect(relay.closed).toBe(false);
    expect(await relay.whoami(1)).toMatchObject({ calls: 1 });
  });
});

describe("control role and lifecycle hooks", () => {
  function withControl(h: Harness, over: Partial<Parameters<typeof startDaemon>[0]> = {}) {
    const control = { statusCalls: 0, stops: 0 };
    const launched = launch(h, {
      control: {
        status: () => ({ pid: 4242, sessions: control.statusCalls++ }),
        stop: () => void control.stops++,
      },
      ...over,
    });
    return { ...launched, control };
  }

  test("the control client gets the status from the handler", async () => {
    const { daemon, control } = withControl(harness());
    const outcome = await controlRequest({ port: daemon.port, key, op: "status" });
    expect(outcome).toEqual({ kind: "reply", body: { pid: 4242, sessions: 0 } });
    expect(control.stops).toBe(0);
  });

  test("a stop request is answered, then the handler runs once the connection is closed", async () => {
    const { daemon, control } = withControl(harness());
    const outcome = await controlRequest({ port: daemon.port, key, op: "stop" });
    expect(outcome).toEqual({ kind: "reply", body: { ok: true } });
    await until(() => control.stops === 1, "the stop handler to run");
  });

  test("a control client with another key is a foreign peer, not a daemon", async () => {
    const { daemon } = withControl(harness());
    const outcome = await controlRequest({ port: daemon.port, key: Buffer.alloc(32, 5), op: "status" });
    expect(outcome.kind).toBe("foreign");
  });

  test("the control client sends nothing but its AUTH to a listener that cannot prove the key", async () => {
    const received: Buffer[] = [];
    const impostor = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write(encodeFrame(FRAME_TYPE.CHALLENGE, buildChallenge({ daemonInstance: "x", daemonVersion: "0" }).payload));
        },
        data(socket, chunk) {
          received.push(Buffer.from(chunk));
          if (received.length === 1) {
            socket.write(
              encodeFrame(FRAME_TYPE.AUTH_OK, Buffer.from(JSON.stringify({ mac: b64u(Buffer.alloc(32)), proto: 1 }))),
            );
          }
        },
      },
    });
    try {
      const outcome = await controlRequest({ port: impostor.port, key, op: "stop" });
      expect(outcome.kind).toBe("foreign");
      await settle();
      expect(received).toHaveLength(1);
    } finally {
      impostor.stop(true);
    }
  });

  test("the control client writes nothing but its AUTH after an AUTH_OK it cannot verify", async () => {
    const writes: Buffer[] = [];
    let terminated = 0;
    const connect: ControlConnect = async (_port, handlers) => {
      const socket = {
        write(data: Uint8Array) {
          writes.push(Buffer.from(data));
          if (writes.length === 1) {
            const bogus = Buffer.from(JSON.stringify({ mac: b64u(Buffer.alloc(32)), proto: 1 }));
            queueMicrotask(() => handlers.data(socket, encodeFrame(FRAME_TYPE.AUTH_OK, bogus)));
          }
          return data.length;
        },
        terminate: () => void terminated++,
      };
      queueMicrotask(() => {
        handlers.open(socket);
        handlers.data(socket, encodeFrame(FRAME_TYPE.CHALLENGE, buildChallenge({ daemonInstance: "x", daemonVersion: "0" }).payload));
      });
    };
    const outcome = await controlRequest({ port: 1, key, op: "stop", connect });
    await settle();
    expect(outcome.kind).toBe("foreign");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.readUInt8(4)).toBe(FRAME_TYPE.AUTH);
    expect(terminated).toBeGreaterThan(0);
  });

  test("the control client sends its frames in full through a socket that takes 7 bytes per write", async () => {
    const { daemon, control } = withControl(harness());
    const accepted: number[] = [];
    const connect: ControlConnect = (port, handlers) =>
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(socket) {
            const capped = {
              write(data: Uint8Array) {
                const offered = data.subarray(0, 7);
                const taken = socket.write(offered);
                accepted.push(taken);
                if (taken >= offered.length && offered.length < data.length) setTimeout(() => handlers.drain(capped), 0);
                return taken;
              },
              terminate: () => socket.terminate(),
            };
            handlers.open(capped);
          },
          data: (socket, chunk) => handlers.data(socket, chunk),
          drain: (socket) => handlers.drain(socket),
          close: () => handlers.close(),
          error: (socket, error) => handlers.error(socket, error),
        },
      });
    const outcome = await controlRequest({ port: daemon.port, key, op: "stop", connect });
    expect(outcome).toEqual({ kind: "reply", body: { ok: true } });
    expect(accepted.length).toBeGreaterThan(10);
    await until(() => control.stops === 1, "the stop handler to run");
  });

  test("a refused connection means the port is free", async () => {
    const { daemon } = withControl(harness());
    const port = daemon.port;
    await daemon.stop();
    expect(await controlRequest({ port, key, op: "status" })).toEqual({ kind: "free" });
  });

  test("a relay-role connection cannot send CONTROL", async () => {
    const { daemon, control } = withControl(harness());
    const relay = await FakeRelay.open(daemon.port);
    relay.send(FRAME_TYPE.CONTROL, JSON.stringify({ op: "stop" }));
    await relay.expectClosed("close after CONTROL on a relay connection");
    expect(control.stops).toBe(0);
  });

  test("a control-role connection cannot send HELLO", async () => {
    const h = harness();
    const { daemon } = withControl(h);
    const relay = await FakeRelay.connect(daemon.port);
    await relay.sendAuth({ role: "control" });
    await relay.finishHandshake();
    relay.sendHello({ cwd: "/work/control-hello" });
    await relay.expectClosed("close after HELLO on a control connection");
    expect(h.created).toHaveLength(0);
  });

  test.each([
    ["an unknown op", JSON.stringify({ op: "restart" })],
    ["a payload that is not JSON", "nope"],
  ])("a control request with %s gets control_invalid", async (_label, payload) => {
    const { daemon } = withControl(harness());
    const relay = await FakeRelay.connect(daemon.port);
    await relay.sendAuth({ role: "control" });
    await relay.finishHandshake();
    relay.send(FRAME_TYPE.CONTROL, payload);
    const error = await relay.expectFrame(FRAME_TYPE.ERROR, "control_invalid");
    expect(JSON.parse(error.payload.toString()).code).toBe("control_invalid");
  });

  test("a daemon with no control handler refuses CONTROL", async () => {
    const { daemon } = launch(harness());
    const relay = await FakeRelay.connect(daemon.port);
    await relay.sendAuth({ role: "control" });
    await relay.finishHandshake();
    relay.send(FRAME_TYPE.CONTROL, JSON.stringify({ op: "status" }));
    const error = await relay.expectFrame(FRAME_TYPE.ERROR, "control_invalid");
    expect(JSON.parse(error.payload.toString()).code).toBe("control_invalid");
  });

  test("the session count callback follows opens and closes", async () => {
    const counts: number[] = [];
    const { daemon } = launch(harness(), { onSessions: (n) => void counts.push(n) });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/count" });
    expect(counts).toEqual([1]);
    relay.close();
    await until(() => counts.length === 2, "the close to be counted");
    expect(counts).toEqual([1, 0]);
  });

  test("pausing the listener refuses new connections and keeps the open session", async () => {
    const { daemon } = launch(harness());
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/pause" });
    daemon.pauseListening();
    expect(daemon.stats().listening).toBe(false);
    expect(await controlRequest({ port: daemon.port, key, op: "status" })).toEqual({ kind: "free" });
    expect(await relay.whoami(1)).toMatchObject({ cwd: "/work/pause" });
    daemon.resumeListening();
    expect(daemon.stats().listening).toBe(true);
    const again = await FakeRelay.open(daemon.port);
    expect((await again.welcome({ cwd: "/work/resumed" })).family).toBe("roadmap");
  });

  test("resuming fails when another listener took the port meanwhile", async () => {
    const { daemon } = launch(harness());
    daemon.pauseListening();
    const thief = Bun.listen({ hostname: "127.0.0.1", port: daemon.port, socket: { data() {} } });
    try {
      expect(() => daemon.resumeListening()).toThrow();
      expect(daemon.stats().listening).toBe(false);
    } finally {
      thief.stop(true);
    }
  });

  test("waitForHandshakes resolves only once a handshake in progress has reached WELCOME", async () => {
    const h = harness();
    let release!: () => void;
    h.gates.set("/work/gated", new Promise<void>((resolve) => (release = resolve)));
    const { daemon } = launch(h);
    const relay = await FakeRelay.open(daemon.port);
    relay.sendHello({ cwd: "/work/gated" });
    await until(() => daemon.stats().authenticated === 1, "the handshake to be in progress");
    let settled = false;
    const waiting = daemon.waitForHandshakes().then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    release();
    await within(waiting, "the handshake to settle");
    expect(daemon.stats().sessions).toBe(1);
  });

  test("waitForHandshakes resolves at once when nothing is pending", async () => {
    const { daemon } = launch(harness());
    await within(daemon.waitForHandshakes(), "an idle daemon to report no handshake");
  });
});

describe("daemon stop", () => {
  test("stop() closes every live session and refuses new connections", async () => {
    const h = harness();
    const { daemon, logDir } = launch(h);
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ cwd: "/work/stop" });
    await daemon.stop();
    expect(daemon.stats().sessions).toBe(0);
    expect(h.closed.map((c) => c.cwd)).toContain("/work/stop");
    await relay.expectClosed("close after stop()");
    expect(logOf(logDir)).toContain("session closed reason=daemon_stop");
  });
});

const PEER_PID = 4242;
const PEER_PID_START = "133750000000000000";
const OUTPUT_CAP = 8 * 1024 * 1024;
const BUFFER_CAP = OUTPUT_CAP + OUTPUT_CAP / 2;
const SEALED_OVERHEAD = 21;
const CHANNEL_METHOD = "notifications/claude/channel";

const familyClaims: FamilyTicketClaims = {
  writer_generation: null,
  instance_token: "tok",
  peer_id: "p1",
  group_id: "g1",
  notified_hwm: 5,
};

function ticketFor(over: Partial<TicketClaims> = {}, signedWith: Buffer = key): string {
  return mintTicket(signedWith, {
    v: 1,
    family: "peers",
    relay_pid: PEER_PID,
    relay_pid_start: PEER_PID_START,
    issued_at: 1,
    ...familyClaims,
    ...over,
  });
}

interface SeamFamily {
  ctxs: FamilyContext[];
  events: string[];
  factory: FamilyFactory;
}

/** A family that records its context and the order of its endings, and whose tools send notifications and big replies. */
function seamFamily(opts: { onClose?: (reason: CloseReason) => Promise<void>; ticketWhileBuilding?: FamilyTicketClaims } = {}): SeamFamily {
  const seam: SeamFamily = {
    ctxs: [],
    events: [],
    factory: async (_hello, ctx) => {
      seam.ctxs.push(ctx);
      if (opts.ticketWhileBuilding) ctx.issueTicket(opts.ticketWhileBuilding);
      const server = new Server({ name: "fake-peers", version: "0" }, { capabilities: { tools: {} } });
      const tool = (name: string) => ({ name, description: "d", inputSchema: { type: "object" as const } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("whoami"), tool("notify"), tool("huge")] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments ?? {};
        if (request.params.name === "huge") {
          return { content: [{ type: "text", text: "h".repeat(Number(args["bytes"])) }] };
        }
        let accepted = 0;
        let dropped = 0;
        for (let i = 0; i < Number(args["count"] ?? 0); i++) {
          try {
            await server.notification({ method: CHANNEL_METHOD, params: { content: "x".repeat(Number(args["bytes"])) } });
            accepted++;
          } catch (e) {
            if (!(e instanceof NotificationDropped)) throw e;
            dropped++;
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ accepted, dropped, pad: "p".repeat(Number(args["replyPad"] ?? 0)) }) }] };
      });
      server.onclose = () => seam.events.push("server");
      return {
        server,
        close: async (reason) => {
          seam.events.push(`family:${reason}`);
          await opts.onClose?.(reason);
        },
      };
    },
  };
  return seam;
}

function peersHello(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { family: "peers", pid: PEER_PID, pid_start: PEER_PID_START, ...over };
}

async function pongBarrier(relay: FakeRelay): Promise<void> {
  relay.send(FRAME_TYPE.PING, "");
  await relay.expectFrame(FRAME_TYPE.PONG, "the PONG that proves no other frame was sent before it");
}

async function drainUntilClosed(relay: FakeRelay): Promise<void> {
  while ((await relay.nextFrame("the connection to close")) !== "closed") continue;
}

describe("the seam between the daemon and a family", () => {
  test.each<CloseReason>(["bye", "socket", "daemon_stop"])("a family close is called with %s before the server closes", async (reason) => {
    const seam = seamFamily();
    const { daemon } = launch(harness(), { families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome(peersHello());
    if (reason === "bye") relay.send(FRAME_TYPE.BYE, "done");
    else if (reason === "socket") relay.close();
    else await daemon.stop();
    await until(() => seam.events.includes("server"), "the server to close");
    expect(seam.events).toEqual([`family:${reason}`, "server"]);
  });

  test("stop() waits for the family close of a session whose socket closed first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seam = seamFamily({ onClose: () => gate });
    const { daemon } = launch(harness(), { families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome(peersHello());
    let stopped = false;
    const stopping = daemon.stop().then(() => (stopped = true));
    await until(() => seam.events.includes("family:daemon_stop"), "the family to be asked to close");
    await settle();
    expect(stopped).toBe(false);
    release();
    await within(stopping, "stop() to finish once the family closed");
    expect(seam.events).toEqual(["family:daemon_stop", "server"]);
  });

  test("a family close that never settles is cut after 5 s of the daemon clock, then the server closes", async () => {
    const clock = new FakeClock();
    const seam = seamFamily({ onClose: () => new Promise<void>(() => undefined) });
    const { daemon, logDir } = launch(harness(), { clock, families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome(peersHello());
    relay.send(FRAME_TYPE.BYE, "done");
    await until(() => seam.events.includes("family:bye"), "the family to be asked to close");
    clock.advance(4999);
    await settle();
    expect(seam.events).toEqual(["family:bye"]);
    clock.advance(1);
    await until(() => seam.events.includes("server"), "the server to close after the 5 s bound");
    expect(logOf(logDir)).toContain("the family close did not finish in 5000 ms (bye)");
  });

  test("a family close that throws is logged and the server still closes", async () => {
    const seam = seamFamily({
      onClose: async () => {
        throw new Error("disconnect exploded");
      },
    });
    const { daemon, logDir } = launch(harness(), { families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome(peersHello());
    relay.send(FRAME_TYPE.BYE, "done");
    await until(() => seam.events.includes("server"), "the server to close");
    expect(logOf(logDir)).toContain("the family close failed (bye)");
  });

  test("the context carries the home, the settings and a broker ensurer, the daemon's own when none is given", async () => {
    const seam = seamFamily();
    const brokers = { ensure: async () => ({ action: "already-running" as const }) };
    const settings = { contextResumeKeyTtlMs: 2000, pollFallbackIntervalMs: 3000, heartbeatIntervalMs: 4000 };
    const { daemon } = launch(harness(), { families: { peers: seam.factory }, home: "/home/seam", brokers, settings });
    await (await FakeRelay.open(daemon.port)).welcome(peersHello());
    const ctx = seam.ctxs[0] as FamilyContext;
    expect(ctx.home).toBe("/home/seam");
    expect(ctx.brokers).toBe(brokers);
    expect(ctx.settings).toEqual(settings);

    const bare = seamFamily();
    const other = launch(harness(), { families: { peers: bare.factory } });
    await (await FakeRelay.open(other.daemon.port)).welcome(peersHello());
    const bareCtx = bare.ctxs[0] as FamilyContext;
    expect(bareCtx.settings.heartbeatIntervalMs).toBeGreaterThan(0);
    await expect(
      bareCtx.brokers.ensure({ url: "http://127.0.0.1:1", settingsPath: "s", env: {} }),
    ).rejects.toThrow("without a broker launcher");
  });
});

describe("the resume ticket at HELLO", () => {
  test("a ticket minted for this relay is accepted: WELCOME says resumed and the family gets the claims", async () => {
    const seam = seamFamily();
    const { daemon } = launch(harness(), { families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    const welcome = await relay.welcome(peersHello({ resume_ticket: ticketFor(), replay: true }));
    expect(welcome.resumed).toBe(true);
    expect(welcome.errors).toEqual([]);
    expect((seam.ctxs[0] as FamilyContext).resume).toMatchObject({
      kind: "accepted",
      claims: { peer_id: "p1", group_id: "g1", instance_token: "tok", notified_hwm: 5 },
    });
  });

  test.each([
    ["no generation", null],
    [
      "the canonical text of a generation",
      JSON.stringify({ platform: "win32", pid: 4242, creationUtc: "2026-11-08T17:22:36.7733341Z" }),
    ],
    ["a text of exactly 256 characters", "g".repeat(256)],
  ])("a bounded writer_generation is accepted: %s, with zero notice_at and outages", async (_name, writer_generation) => {
    const seam = seamFamily();
    const { daemon } = launch(harness(), { families: { peers: seam.factory } });
    const welcome = await (await FakeRelay.open(daemon.port)).welcome(
      peersHello({ resume_ticket: ticketFor({ writer_generation, notice_at: 0, outages: 0 }) }),
    );
    expect(welcome.resumed).toBe(true);
    expect((seam.ctxs[0] as FamilyContext).resume).toMatchObject({ kind: "accepted", claims: { writer_generation } });
  });

  test("no ticket is a fresh session", async () => {
    const seam = seamFamily();
    const { daemon } = launch(harness(), { families: { peers: seam.factory } });
    const welcome = await (await FakeRelay.open(daemon.port)).welcome(peersHello());
    expect(welcome.resumed).toBe(false);
    expect((seam.ctxs[0] as FamilyContext).resume).toEqual({ kind: "none" });
  });

  test.each<[string, string, string]>([
    ["a forged MAC", ticketFor({}, Buffer.alloc(32, 9)), "mac"],
    ["a ticket of another relay pid", ticketFor({ relay_pid: PEER_PID + 1 }), "relay_pid"],
    ["a ticket of another relay start", ticketFor({ relay_pid_start: "1" }), "pid_start"],
    ["an empty peer id", ticketFor({ peer_id: "" }), "peer_id"],
    ["a negative notified_hwm", ticketFor({ notified_hwm: -1 }), "notified_hwm"],
    ["a fractional notified_hwm", ticketFor({ notified_hwm: 1.5 }), "notified_hwm"],
    ["a negative notice_at", ticketFor({ notice_at: -1 }), "notice_at"],
    ["a fractional notice_at", ticketFor({ notice_at: 0.5 }), "notice_at"],
    ["a notice_at that is text", ticketFor({ notice_at: "now" as unknown as number }), "notice_at"],
    ["a negative outages count", ticketFor({ outages: -1 }), "outages"],
    ["an outages count that is null", ticketFor({ outages: null as unknown as number }), "outages"],
    ["a writer_generation that is a list", ticketFor({ writer_generation: [] as unknown as string }), "writer_generation"],
    ["a writer_generation that is a number", ticketFor({ writer_generation: 7 as unknown as string }), "writer_generation"],
    [
      "a writer_generation that is a record instead of its canonical text",
      ticketFor({ writer_generation: { platform: "win32", pid: 4242 } as unknown as string }),
      "writer_generation",
    ],
    ["a writer_generation text above 256 characters", ticketFor({ writer_generation: "g".repeat(257) }), "writer_generation"],
    ["a string that is no ticket", "not-a-ticket", "ticket"],
  ])("%s: ERROR ticket_refused, then WELCOME on the same open connection", async (_name, ticket, cause) => {
    const seam = seamFamily();
    const { daemon } = launch(harness(), { families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    const welcome = await relay.welcome(peersHello({ resume_ticket: ticket, replay: true }), { allowErrors: true });
    expect(welcome.errors).toEqual([expect.objectContaining({ code: "ticket_refused" })]);
    expect(welcome.resumed).toBe(false);
    const resume = (seam.ctxs[0] as FamilyContext).resume;
    expect(resume.kind).toBe("refused");
    expect((resume as { cause: string }).cause).toContain(cause);
    const reply = await relay.rpc(1, "tools/list");
    expect(reply.result.tools.map((t: { name: string }) => t.name)).toContain("whoami");
  });

  test("the fake relay fails a welcome that came after an ERROR unless the test allows errors", async () => {
    const seam = seamFamily();
    const { daemon } = launch(harness(), { families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    const failure = await relay.welcome(peersHello({ resume_ticket: "not-a-ticket", replay: true })).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toContain("ERROR frames before WELCOME");
  });

  test.each([
    ["a peers ticket", ticketFor()],
    ["a ticket that claims the roadmap family", ticketFor({ family: "roadmap" as unknown as "peers" })],
  ])("the roadmap family has no ticket: %s is refused", async (_name, ticket) => {
    const h = harness();
    const { daemon } = launch(h);
    const relay = await FakeRelay.open(daemon.port);
    const welcome = await relay.welcome({ pid: PEER_PID, pid_start: PEER_PID_START, resume_ticket: ticket }, { allowErrors: true });
    expect(welcome.errors).toEqual([expect.objectContaining({ code: "ticket_refused" })]);
    expect(welcome).toMatchObject({ family: "roadmap", resumed: false });
  });
});

describe("tickets minted for the relay", () => {
  async function livePeers(opts: Parameters<typeof seamFamily>[0] = {}) {
    const seam = seamFamily(opts);
    const clock = new FakeClock();
    const { daemon, logDir } = launch(harness(), { clock, families: { peers: seam.factory, roadmap: harness().factory() } });
    const relay = await FakeRelay.open(daemon.port);
    return { seam, clock, daemon, logDir, relay };
  }

  async function nextTicket(relay: FakeRelay): Promise<TicketClaims> {
    const frame = await relay.expectFrame(FRAME_TYPE.TICKET, "a TICKET frame");
    const verdict = verifyTicket(key, JSON.parse(frame.payload.toString()).ticket, {
      relayPid: PEER_PID,
      relayPidStart: PEER_PID_START,
      family: "peers",
    });
    if (!verdict.ok) throw new Error(`the daemon minted a ticket it refuses: ${verdict.cause}`);
    return verdict.claims;
  }

  test("a ticket completes the claims of the family with the relay's pid and start, and verifies", async () => {
    const { seam, relay } = await livePeers();
    await relay.welcome(peersHello());
    (seam.ctxs[0] as FamilyContext).issueTicket({ ...familyClaims, notice_at: 77, outages: 2 });
    const claims = await nextTicket(relay);
    expect(claims).toMatchObject({
      v: 1,
      family: "peers",
      relay_pid: PEER_PID,
      relay_pid_start: PEER_PID_START,
      instance_token: "tok",
      peer_id: "p1",
      group_id: "g1",
      notified_hwm: 5,
      notice_at: 77,
      outages: 2,
    });
    expect(typeof claims.issued_at).toBe("number");
  });

  test("claims that carry the daemon's own fields cannot override the binding to the relay", async () => {
    const { seam, relay } = await livePeers();
    await relay.welcome(peersHello());
    const forged = { ...familyClaims, v: 9, family: "roadmap", relay_pid: 1, relay_pid_start: "forged", issued_at: 0, extra: "x" };
    (seam.ctxs[0] as FamilyContext).issueTicket(forged as unknown as FamilyTicketClaims);
    const claims = await nextTicket(relay);
    expect(claims).toMatchObject({ v: 1, family: "peers", relay_pid: PEER_PID, relay_pid_start: PEER_PID_START, peer_id: "p1" });
    expect(claims.issued_at).not.toBe(0);
    expect(Object.keys(claims)).not.toContain("extra");
  });

  test("ten requests in a second give one frame at once and one more, with the last claims, when the second is over", async () => {
    const { seam, clock, relay } = await livePeers();
    await relay.welcome(peersHello());
    const ctx = seam.ctxs[0] as FamilyContext;
    ctx.issueTicket({ ...familyClaims, notified_hwm: 1 });
    expect((await nextTicket(relay)).notified_hwm).toBe(1);
    for (let hwm = 2; hwm <= 11; hwm++) ctx.issueTicket({ ...familyClaims, notified_hwm: hwm });
    await pongBarrier(relay);
    clock.advance(1000);
    expect((await nextTicket(relay)).notified_hwm).toBe(11);
    await pongBarrier(relay);
    clock.advance(1000);
    await pongBarrier(relay);
    ctx.issueTicket({ ...familyClaims, notified_hwm: 12 });
    expect((await nextTicket(relay)).notified_hwm).toBe(12);
  });

  test("a request made while the family is still being built is held until WELCOME", async () => {
    const { relay } = await livePeers({ ticketWhileBuilding: { ...familyClaims, notified_hwm: 9 } });
    await relay.welcome(peersHello());
    expect((await nextTicket(relay)).notified_hwm).toBe(9);
  });

  test("a family other than peers cannot ask for a ticket: nothing is sent and the refusal is logged", async () => {
    const roadmap = seamFamily();
    const clock = new FakeClock();
    const { daemon, logDir } = launch(harness(), { clock, families: { roadmap: roadmap.factory } });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome({ pid: PEER_PID, pid_start: PEER_PID_START });
    (roadmap.ctxs[0] as FamilyContext).issueTicket(familyClaims);
    await pongBarrier(relay);
    expect(logOf(logDir)).toContain("the roadmap family asked for a resume ticket");
  });
});

describe("the output buffer of a connection", () => {
  const notifyBase = Buffer.byteLength(JSON.stringify({ method: CHANNEL_METHOD, params: { content: "" }, jsonrpc: "2.0" }));
  const contentForFrameOf = (wire: number) => wire - SEALED_OVERHEAD - notifyBase;

  const replyBase = Buffer.byteLength(JSON.stringify({ result: { content: [{ type: "text", text: "" }] }, jsonrpc: "2.0", id: 1 }));
  const replyBytesForFrameOf = (wire: number) => wire - SEALED_OVERHEAD - replyBase;

  // A write takes 512 KiB at most, so 1 MiB notifications pile up in the queue while the family sends them in one tick.
  async function cappedPeers() {
    const seam = seamFamily();
    const { daemon, logDir } = launch(harness(), { writeCap: 512 * 1024, families: { peers: seam.factory } });
    const relay = await FakeRelay.open(daemon.port);
    await relay.welcome(peersHello());
    return { seam, daemon, logDir, relay };
  }

  const callNotify = async (relay: FakeRelay, count: number, bytes: number, replyPad = 0) => {
    const reply = await relay.rpc(1, "tools/call", { name: "notify", arguments: { count, bytes, replyPad } });
    return JSON.parse(reply.result.content[0].text) as { accepted: number; dropped: number; pad: string };
  };

  test.each([
    ["5 MiB", 5 << 20],
    ["just under 8 MiB", OUTPUT_CAP - 1024],
  ])("a burst of notifications is cut at half the buffer: counted, logged, and a reply of %s still arrives behind it", async (_name, replyPad) => {
    const { daemon, logDir, relay } = await cappedPeers();
    const result = await callNotify(relay, 20, 1 << 20, replyPad);
    expect(result.accepted).toBeGreaterThanOrEqual(1);
    expect(result.dropped).toBeGreaterThanOrEqual(1);
    expect(result.accepted + result.dropped).toBe(20);
    expect(result.pad).toHaveLength(replyPad);
    expect(daemon.stats().droppedNotifications).toBe(result.dropped);
    expect(logOf(logDir)).toContain("output buffer full: dropped a notification");
  });

  test("many small notifications cannot close the connection: the reply behind them arrives", async () => {
    const { relay } = await cappedPeers();
    const result = await callNotify(relay, 120_000, 10);
    expect(result.accepted + result.dropped).toBe(120_000);
  });

  test("a notification whose frame is exactly half the buffer is accepted, one byte more is dropped", async () => {
    const exact = await cappedPeers();
    expect(await callNotify(exact.relay, 1, contentForFrameOf(OUTPUT_CAP / 2))).toMatchObject({ accepted: 1, dropped: 0 });
    const over = await cappedPeers();
    expect(await callNotify(over.relay, 1, contentForFrameOf(OUTPUT_CAP / 2 + 1))).toMatchObject({ accepted: 0, dropped: 1 });
  });

  test("a reply of exactly 12 MiB is sent, one byte more closes the connection and the family hears a socket close", async () => {
    const exact = await cappedPeers();
    const sent = await exact.relay.rpc(1, "tools/call", { name: "huge", arguments: { bytes: replyBytesForFrameOf(BUFFER_CAP) } });
    expect(sent.result.content[0].text).toHaveLength(replyBytesForFrameOf(BUFFER_CAP));

    const { seam, logDir, relay } = await cappedPeers();
    relay.send(
      FRAME_TYPE.MCP,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "huge", arguments: { bytes: replyBytesForFrameOf(BUFFER_CAP + 1) } } }),
    );
    await within(drainUntilClosed(relay), "the connection to close on an oversized reply");
    await until(() => seam.events.includes("server"), "the session to close");
    expect(seam.events).toEqual(["family:socket", "server"]);
    expect(logOf(logDir)).toContain(`output buffer above ${BUFFER_CAP} bytes`);
  });

  test("a notification that is dropped does not burn a sealed counter: the relay still opens every later frame", async () => {
    const { relay } = await cappedPeers();
    const burst = await callNotify(relay, 20, 1 << 20);
    expect(burst.dropped).toBeGreaterThan(0);
    const tools = await relay.rpc(2, "tools/list");
    expect(tools.result.tools).toHaveLength(3);
  });
});

describe("shared key file", () => {
  const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silent, file: "" };
  const SID = "S-1-5-21-1-2-3-1001";
  const GOOD = `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${SID})`;
  const winOnly = process.platform !== "win32";

  /** A key file as a relay leaves it: protected for this OS. */
  function protectedKey(content: string = KEY_HEX): string {
    const { keyPath } = freshDirs();
    mkdirSync(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, content, { mode: 0o600 });
    protectForTest(keyPath);
    return keyPath;
  }

  /** Tools that read the ACL and nothing else: any other call is an error of the code under test. */
  function readOnlyAcl(sddl: string | Error): AclTools {
    const target = {
      userSid: () => SID,
      readSddl: () => {
        if (sddl instanceof Error) throw sddl;
        return sddl;
      },
    };
    return new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as keyof typeof t];
        throw new Error(`unexpected tool call: ${String(prop)}`);
      },
    }) as AclTools;
  }

  test("a key a relay created is read as 32 bytes", () => {
    expect(loadKey(protectedKey(`${KEY_HEX}\n`), silent).equals(key)).toBe(true);
  });

  test.each([["short", "abcd"], ["not hex", "z".repeat(64)], ["empty", ""], ["too long", "a".repeat(65)]])(
    "a key file that is %s is refused",
    (_label, content) => {
      expect(() => loadKey(protectedKey(content), silent)).toThrow("64 hexadecimal characters");
    },
  );

  test("an absent key is refused naming the path and the relay, and nothing is created", () => {
    const { keyPath } = freshDirs();
    expect(() => loadKey(keyPath, silent)).toThrow(`no shared key at ${keyPath}: a relay creates it`);
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(join(keyPath, ".."))).toBe(false);
  });

  test("an absent key in an existing directory leaves the directory empty", () => {
    const { keyPath } = freshDirs();
    mkdirSync(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    expect(() => loadKey(keyPath, silent)).toThrow("a relay creates it");
    expect(readdirSync(join(keyPath, ".."))).toEqual([]);
  });

  test.each([
    [0o600, false, false],
    [0o400, false, false],
    [0o640, false, true],
    [0o604, false, true],
    [0o755, true, false],
    [0o700, true, false],
    [0o775, true, true],
    [0o757, true, true],
  ])("mode %o (directory: %p) is refused: %p", (mode, isDir, refused) => {
    expect(permissionVerdict(mode, isDir) !== null).toBe(refused);
  });

  test.skipIf(process.platform === "win32")("POSIX only: a key readable by others is refused", () => {
    const keyPath = protectedKey();
    chmodSync(keyPath, 0o644);
    expect(() => loadKey(keyPath, silent)).toThrow("grants rights to group or others");
  });

  test.skipIf(process.platform === "win32")("POSIX only: a key in a directory writable by others is refused", () => {
    const keyPath = protectedKey();
    chmodSync(join(keyPath, ".."), 0o777);
    expect(() => loadKey(keyPath, silent)).toThrow("is writable by group or others");
  });

  test.each([
    ["a protected DACL naming the user, SYSTEM and Administrators", `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${SID})`, null],
    ["the long form of the system SIDs", `D:P(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;${SID})`, null],
    ["a SACL after the DACL", `D:P(A;;FA;;;${SID})S:(AU;SA;FA;;;WD)`, null],
    ["a DACL that inherits", `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${SID})`, "inherits"],
    ["an extra Users ACE", `D:PAI(A;;FR;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${SID})`, "FR;;;BU"],
    ["an ACE for another account", `D:P(A;;0x1301bf;;;S-1-5-21-9-9-9-1003)(A;;FA;;;${SID})`, "S-1-5-21-9-9-9-1003"],
    ["a deny ACE", `D:P(D;;FA;;;BU)(A;;FA;;;${SID})`, "D;;FA;;;BU"],
    ["a deny ACE on SYSTEM", `D:P(D;;FA;;;SY)(A;;FA;;;${SID})`, "D;;FA;;;SY"],
    [
      "an object ACE for the user",
      `D:P(OA;;FA;00000000-0000-0000-0000-000000000000;;${SID})(A;;FA;;;${SID})`,
      "OA;;FA",
    ],
    ["a null DACL", "D:NO_ACCESS_CONTROL", "inherits"],
    ["no ACE for the current user", "D:P(A;;FA;;;SY)(A;;FA;;;BA)", "no ACE"],
    ["an empty protected DACL", "D:P", "no ACE"],
    ["no DACL", "O:BAG:SY", "no DACL"],
  ])("the ACL verdict on %s", (_label, sddl, problem) => {
    const verdict = windowsAclVerdict(sddl, SID);
    if (problem === null) expect(verdict).toBeNull();
    else expect(verdict).toContain(problem);
  });

  describe("the SDDL alias LA", () => {
    const ADMIN_SID = "S-1-5-21-1-2-3-500";
    const SDDL = "D:PAI(A;;FA;;;LA)(A;;FA;;;SY)(A;;FA;;;BA)";

    test("is the current user when the user is the built-in Administrator", () => {
      expect(windowsAclVerdict(SDDL, ADMIN_SID)).toBeNull();
      expect(windowsAclVerdict(`D:P(A;;FA;;;${ADMIN_SID})(A;;FA;;;SY)`, ADMIN_SID)).toBeNull();
    });

    test.each(["S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-5000", "S-1-5-21-1-2-3-500-1", "S-1-5-32-500"])(
      "is another account when the user is %s",
      (userSid) => {
        const verdict = windowsAclVerdict(SDDL, userSid);
        expect(verdict).toContain("ACE A;;FA;;;LA is not an allow");
        expect(verdict).toContain("the current user has no ACE");
      },
    );

    test("never turns a deny ACE into an allow", () => {
      expect(windowsAclVerdict("D:P(D;;FA;;;LA)(A;;FA;;;SY)", ADMIN_SID)).toContain("D;;FA;;;LA");
    });
  });

  test("a protected key is accepted, and the tools are only asked to read", () => {
    expect(loadKey(protectedKey(), silent, readOnlyAcl(GOOD)).equals(key)).toBe(true);
  });

  test.each([
    ["inherits its permissions", "D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;S-1-5-21-1-2-3-1001)", "inherits"],
    ["grants Users a right", `D:PAI(A;;FR;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${SID})`, "FR;;;BU"],
    ["carries a deny ACE", `D:PAI(D;;FA;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${SID})`, "D;;FA;;;WD"],
  ])("a key whose ACL %s is refused with the verdict and the rotation advice, with no write call", (_label, sddl, why) => {
    const path = protectedKey();
    let message = "";
    try {
      loadKey(path, silent, readOnlyAcl(sddl));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("ACL is not acceptable");
    expect(message).toContain(why);
    expect(message).toContain("rotate it by deleting the file");
    expect(readFileSync(path, "utf8")).toBe(KEY_HEX);
  });

  test("an ACL that cannot be read is refused, never assumed protected", () => {
    const acl = readOnlyAcl(new Error("icacls /save exited 5"));
    expect(() => loadKey(protectedKey(), silent, acl)).toThrow("the ACL cannot be read: icacls /save exited 5");
  });

  function winTool(exe: string, args: string[]): string {
    const p = Bun.spawnSync([join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", exe), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(`${exe} ${args.join(" ")} exited ${p.exitCode}: ${p.stdout}${p.stderr}`);
    return p.stdout.toString();
  }

  function winSddl(path: string): string {
    const saved = join(root, `acl-${++dirCounter}.txt`);
    winTool("icacls.exe", [path, "/save", saved, "/q"]);
    return readFileSync(saved).toString("utf16le").split(/\r?\n/)[1] ?? "";
  }

  test("the SDDL scratch file is named inside the key's directory, never in the shared temp directory", () => {
    const keyPath = join(root, "peers-dir", "mcp-daemon.key");
    const scratch = aclScratchPath(keyPath);
    expect(dirname(scratch)).toBe(dirname(keyPath));
    expect(basename(scratch)).toMatch(/^kory-acl-[0-9a-f]{12}\.txt$/);
    expect(aclScratchPath(keyPath)).not.toBe(scratch);
  });

  test.skipIf(winOnly)("Windows only: the SDDL scratch file appears in the key's directory and is removed", async () => {
    const keyPath = protectedKey();
    const dir = dirname(keyPath);
    const seen: string[] = [];
    const watcher = watch(dir, (_event, name) => {
      if (name !== null && String(name).startsWith("kory-acl-")) seen.push(String(name));
    });
    try {
      loadKey(keyPath, silent);
      await until(() => seen.length > 0, "the scratch file to appear in the key's directory");
    } finally {
      watcher.close();
    }
    expect(readdirSync(dir).filter((name) => name.startsWith("kory-acl-"))).toEqual([]);
  });

  test.skipIf(winOnly)("Windows only: a key a relay protected is accepted", () => {
    expect(loadKey(protectedKey(), silent).equals(key)).toBe(true);
  });

  test.skipIf(winOnly)("Windows only: a key that inherits its permissions is refused and its ACL is left as it was", () => {
    const { keyPath } = freshDirs();
    mkdirSync(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, KEY_HEX);
    const before = winSddl(keyPath);
    expect(before).not.toMatch(/^D:P/);
    expect(() => loadKey(keyPath, silent)).toThrow("ACL is not acceptable");
    expect(winSddl(keyPath)).toBe(before);
  });

  test.skipIf(winOnly)("Windows only: a protected key with an extra Users ACE is refused and left as it was", () => {
    const keyPath = protectedKey();
    winTool("icacls.exe", [keyPath, "/grant", "*S-1-5-32-545:R", "/q"]);
    const before = winSddl(keyPath);
    expect(() => loadKey(keyPath, silent)).toThrow("FR;;;BU");
    expect(winSddl(keyPath)).toBe(before);
  });

  test("a daemon whose key file is unusable does not start and says why in its log", () => {
    const keyPath = protectedKey("not a key");
    const logDir = join(root, `logs${++dirCounter}`);
    expect(() => startDaemon({ port: 0, keyPath, logDir, codeRoot: CODE_ROOT, families: {} })).toThrow(
      "64 hexadecimal characters",
    );
    expect(logOf(logDir)).toContain("the shared key is unusable, not starting");
  });

  test("a daemon with no key does not start, says so, and creates nothing", () => {
    const { keyPath, logDir } = freshDirs();
    expect(() => startDaemon({ port: 0, keyPath, logDir, codeRoot: CODE_ROOT, families: {} })).toThrow(
      `no shared key at ${keyPath}: a relay creates it`,
    );
    expect(logOf(logDir)).toContain("a relay creates it");
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(join(keyPath, ".."))).toBe(false);
  });

  test.skipIf(winOnly)("Windows only: a daemon whose key ACL is open does not start", () => {
    const { keyPath, logDir } = freshDirs();
    mkdirSync(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, KEY_HEX);
    expect(() => startDaemon({ port: 0, keyPath, logDir, codeRoot: CODE_ROOT, families: {} })).toThrow(
      "ACL is not acceptable",
    );
  });
});
