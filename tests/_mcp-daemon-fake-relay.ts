import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Socket } from "bun";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonClock, FamilyFactory } from "../shared/mcp-daemon-server.ts";
import {
  FRAME_TYPE,
  Opener,
  PlainFrameDecoder,
  Sealer,
  SealedFrameDecoder,
  b64u,
  deriveSessionKeys,
  encodeFrame,
  relayMac,
  type Challenge,
  type Frame,
} from "../shared/mcp-daemon-protocol.ts";
import { reachedWithin } from "./_bounded-await.ts";

export const within = <T>(promise: Promise<T>, what: string) => reachedWithin(promise, what, 2000);

export async function until(condition: () => boolean, what: string): Promise<void> {
  await within(
    (async () => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
    })(),
    what,
  );
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

export class FakeClock implements DaemonClock {
  private now = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    const due = [...this.timers.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.fn();
    }
  }
}

export const KEY_HEX = createHash("sha256").update("kory-mcp-daemon-test-key").digest("hex");
export const key = Buffer.from(KEY_HEX, "hex");
export const CODE_ROOT = "c".repeat(64);

interface Closed {
  cwd: string;
}

export interface Harness {
  created: string[];
  closed: Closed[];
  gates: Map<string, Promise<void>>;
  factory(extraTool?: string): FamilyFactory;
}

export function harness(): Harness {
  const h: Harness = {
    created: [],
    closed: [],
    gates: new Map(),
    factory: (extraTool) => async (hello) => {
      if (hello.cwd === "/work/boom") throw new Error("factory exploded");
      await h.gates.get(hello.cwd);
      h.created.push(hello.cwd);
      const server = new Server({ name: "fake-roadmap", version: "0" }, { capabilities: { tools: {} } });
      let calls = 0;
      const tools = [{ name: "whoami", description: "d", inputSchema: { type: "object" as const } }];
      if (extraTool) tools.push({ name: extraTool, description: "d", inputSchema: { type: "object" as const } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const pad = Number(request.params.arguments?.["reply_pad"] ?? 0);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ cwd: hello.cwd, calls: ++calls, env: hello.env["MARK"], ...(pad > 0 ? { pad: "p".repeat(pad) } : {}) }),
            },
          ],
        };
      });
      server.onclose = () => h.closed.push({ cwd: hello.cwd });
      return server;
    },
  };
  return h;
}

export function helloFor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proto: 1,
    family: "roadmap",
    relay_version: "0.1.0",
    code_root: CODE_ROOT,
    pid: 4242,
    ppid: 100,
    pid_start: "133750000000000000",
    ppid_start: "",
    cwd: "/work/a",
    stdin_is_tty: false,
    env: { MARK: "m" },
    replay: false,
    ...over,
  };
}

export class FakeRelay {
  private queue: Frame[] = [];
  private waiting?: (value: Frame | "closed") => void;
  private decoder: PlainFrameDecoder | SealedFrameDecoder = new PlainFrameDecoder();
  private sealer?: Sealer;
  private socket!: { write(data: Buffer): number; end(): void };
  private pending: Buffer[] = [];
  private ending = false;
  private challenge!: Challenge;
  private authPayload!: Buffer;
  private relayNonce = "";
  closed = false;

  /** `writeCap` makes every socket write offer at most that many bytes, as a full send buffer would accept. */
  static async connect(port: number, opts: { writeCap?: number } = {}): Promise<FakeRelay> {
    const relay = new FakeRelay();
    const real: Socket<undefined> = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data: (_socket, chunk) => relay.onData(chunk),
        drain: () => relay.flush(),
        close: () => relay.onClose(),
        error: () => relay.onClose(),
      },
    });
    const cap = opts.writeCap;
    relay.socket = {
      write(data) {
        const offered = cap === undefined ? data : data.subarray(0, cap);
        const accepted = real.write(offered);
        if (accepted >= offered.length && offered.length < data.length) setTimeout(() => relay.flush(), 0);
        return accepted;
      },
      end: () => void real.end(),
    };
    return relay;
  }

  static async open(port: number, opts: { writeCap?: number } = {}): Promise<FakeRelay> {
    const relay = await FakeRelay.connect(port, opts);
    await relay.sendAuth();
    await relay.finishHandshake();
    return relay;
  }

  private onData(chunk: Uint8Array): void {
    this.queue.push(...this.decoder.push(chunk));
    const waiter = this.waiting;
    const next = waiter ? this.queue.shift() : undefined;
    if (waiter && next) {
      this.waiting = undefined;
      waiter(next);
    }
  }

  private onClose(): void {
    this.closed = true;
    const waiter = this.waiting;
    this.waiting = undefined;
    waiter?.("closed");
  }

  async nextFrame(what: string): Promise<Frame | "closed"> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.closed) return "closed";
    return within(new Promise<Frame | "closed">((resolve) => (this.waiting = resolve)), what);
  }

  async expectFrame(type: number, what: string): Promise<Frame> {
    const frame = await this.nextFrame(what);
    if (frame === "closed") throw new Error(`${what}: connection closed`);
    expect(frame.type).toBe(type);
    return frame;
  }

  async sendAuth(
    opts: { useKey?: Buffer; protoMin?: number; protoMax?: number; trailing?: Buffer; role?: "relay" | "control" } = {},
  ): Promise<void> {
    const challenge = await this.expectFrame(FRAME_TYPE.CHALLENGE, "CHALLENGE");
    const parsed = JSON.parse(challenge.payload.toString());
    this.challenge = {
      payload: challenge.payload,
      daemonNonce: parsed.daemon_nonce,
      protoMin: parsed.proto_min,
      protoMax: parsed.proto_max,
    };
    const [min, max] = [opts.protoMin ?? 1, opts.protoMax ?? 1];
    this.relayNonce = b64u(randomBytes(32));
    this.authPayload = Buffer.from(
      JSON.stringify({
        mac: b64u(relayMac(opts.useKey ?? key, this.challenge, this.relayNonce, min, max, opts.role)),
        proto_max: max,
        proto_min: min,
        relay_nonce: this.relayNonce,
      }),
    );
    this.writeRaw(Buffer.concat([encodeFrame(FRAME_TYPE.AUTH, this.authPayload), opts.trailing ?? Buffer.alloc(0)]));
  }

  async finishHandshake(): Promise<void> {
    const authOk = await this.expectFrame(FRAME_TYPE.AUTH_OK, "AUTH_OK");
    const keys = deriveSessionKeys(key, this.challenge, this.authPayload, authOk.payload, this.relayNonce);
    this.sealer = new Sealer(keys.r2d);
    this.decoder = new SealedFrameDecoder(new Opener(keys.d2r));
  }

  writeRaw(buf: Buffer): void {
    this.pending.push(buf);
    this.flush();
  }

  // Bun buffers nothing: write() returns the bytes it took and the rest is offered again on drain.
  private flush(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0] as Buffer;
      const written = this.socket.write(head);
      if (written < head.length) {
        this.pending[0] = head.subarray(Math.max(written, 0));
        return;
      }
      this.pending.shift();
    }
    if (this.ending) this.socket.end();
  }

  seal(type: number, payload: string | Buffer): Buffer {
    return (this.sealer as Sealer).seal(type, typeof payload === "string" ? Buffer.from(payload) : payload);
  }

  send(type: number, payload: string | Buffer): void {
    this.writeRaw(this.seal(type, payload));
  }

  sendHello(over: Record<string, unknown> = {}): void {
    this.send(FRAME_TYPE.HELLO, JSON.stringify(helloFor(over)));
  }

  async welcome(over: Record<string, unknown> = {}): Promise<{ session_id: string; family: string; tools_hash: string; resumed: boolean }> {
    this.sendHello(over);
    const frame = await this.expectFrame(FRAME_TYPE.WELCOME, "WELCOME");
    return JSON.parse(frame.payload.toString());
  }

  async rpc(id: number, method: string, params?: unknown): Promise<{ result?: any; error?: any }> {
    this.send(FRAME_TYPE.MCP, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    for (;;) {
      const frame = await this.nextFrame(`reply to ${method}`);
      if (frame === "closed") throw new Error(`connection closed while waiting for ${method}`);
      if (frame.type !== FRAME_TYPE.MCP) continue;
      const message = JSON.parse(frame.payload.toString());
      if (message.id === id) return message;
    }
  }

  async whoami(id: number): Promise<{ cwd: string; calls: number; env?: string }> {
    const reply = await this.rpc(id, "tools/call", { name: "whoami", arguments: {} });
    return JSON.parse(reply.result.content[0].text);
  }

  async expectClosed(what: string): Promise<void> {
    expect(await this.nextFrame(what)).toBe("closed");
  }

  close(): void {
    this.ending = true;
    this.flush();
  }
}

function system32Tool(exe: string, args: string[]): string {
  const result = Bun.spawnSync([join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", exe), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`${exe} ${args.join(" ")} exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
  return result.stdout.toString();
}

/** Gives `path` the ACL a relay gives the key: no inheritance, full control for the user, SYSTEM and Administrators only. */
export function protectForTest(path: string): void {
  if (process.platform !== "win32") return;
  const sid = system32Tool("whoami.exe", ["/user", "/fo", "csv", "/nh"]).match(/,"(S-1-[0-9-]+)"/)?.[1];
  if (sid === undefined) throw new Error("cannot read the current user SID");
  system32Tool("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${sid}:F`, "*S-1-5-18:F", "*S-1-5-32-544:F", "/q"]);
}

const masterKeys = new Map<string, string>();

/**
 * Puts the test key at `keyPath` as a hard link to one protected file per
 * `root`: a link shares the ACL of its target, so each daemon fixture costs no
 * icacls call. Nothing writes to the target.
 */
export function linkTestKey(root: string, keyPath: string): void {
  let master = masterKeys.get(root);
  if (master === undefined) {
    master = join(root, "master.key");
    if (existsSync(master)) throw new Error(`${master} already exists`);
    writeFileSync(master, KEY_HEX, { mode: 0o600 });
    protectForTest(master);
    masterKeys.set(root, master);
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  linkSync(master, keyPath);
}
