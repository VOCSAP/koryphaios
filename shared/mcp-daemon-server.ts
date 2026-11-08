import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Socket } from "bun";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, type Logger } from "./logger.ts";
import {
  FRAME_TYPE,
  MAX_PAYLOAD,
  Opener,
  PlainFrameDecoder,
  SealedFrameDecoder,
  Sealer,
  b64u,
  buildAuthOk,
  buildChallenge,
  deriveSessionKeys,
  encodeFrame,
  parseHello,
  verifyAuth,
  type Challenge,
  type Frame,
  type Hello,
} from "./mcp-daemon-protocol.ts";

const STAGE_MS = 3000;
const MAX_UNAUTHENTICATED = 32;
const DEFAULT_MAX_SESSIONS = 512;
// 64 KiB of env can JSON-escape to six bytes per control character, plus a
// cwd of up to 64 KiB with doubled backslashes and a 4 KiB ticket.
const HELLO_MAX_FRAME_PAYLOAD = 512 * 1024;
const TOOLS_PROBE_ID = "kory-daemon-tools-hash";
export const DAEMON_VERSION = "1";

export type FamilyName = "peers" | "roadmap";

export interface FamilyContext {
  sessionId: string;
  log: Logger;
}

export type FamilyFactory = (hello: Hello, ctx: FamilyContext) => Server | Promise<Server>;

export interface DaemonClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: DaemonClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DaemonOptions {
  port: number;
  keyPath: string;
  logDir: string;
  codeRoot: string;
  families: Partial<Record<FamilyName, FamilyFactory>>;
  clock?: DaemonClock;
  maxSessions?: number;
  key?: Buffer;
  control?: ControlHandler;
  onSessions?: (sessions: number) => void;
}

export interface ControlHandler {
  status(): Record<string, unknown>;
  stop(): void;
}

export interface DaemonStats {
  listening: boolean;
  sessions: number;
  unauthenticated: number;
  authenticated: number;
  sessionsOpened: number;
  sessionsClosed: number;
  refusedUnauthenticated: number;
  handshakeTimeouts: number;
  authRefused: number;
  preAuthFailures: number;
}

export interface DaemonHandle {
  port: number;
  instance: string;
  stop(): Promise<void>;
  stats(): DaemonStats;
  /** Stops accepting connections; the sessions already open keep running. */
  pauseListening(): void;
  /** Listens again on the same port; throws when the port was taken meanwhile. */
  resumeListening(): void;
  /** Resolves when no connection is left between accept and WELCOME. */
  waitForHandshakes(): Promise<void>;
}

export function permissionVerdict(mode: number, isDir: boolean): string | null {
  const [forbidden, what] = isDir
    ? [0o022, "is writable by group or others"]
    : [0o077, "grants rights to group or others"];
  return mode & forbidden ? `${what} (mode ${(mode & 0o777).toString(8)})` : null;
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

const WINDOWS_SYSTEM_TRUSTEES = ["SY", "BA", "S-1-5-18", "S-1-5-32-544"];

interface ParsedAce {
  raw: string;
  type: string;
  trustee: string;
}

// `sddl` is the line `icacls /save` writes.
function parseDacl(sddl: string): { flags: string; aces: ParsedAce[] } | null {
  const start = sddl.indexOf("D:");
  if (start < 0) return null;
  let dacl = sddl.slice(start + 2);
  const sacl = dacl.indexOf(")S:");
  if (sacl >= 0) dacl = dacl.slice(0, sacl + 1);
  const firstAce = dacl.indexOf("(");
  const aces = [...dacl.matchAll(/\(([^)]*)\)/g)].map((m) => {
    const raw = m[1] as string;
    const [type = "", , , , , trustee = ""] = raw.split(";");
    return { raw, type, trustee };
  });
  return { flags: firstAce < 0 ? dacl : dacl.slice(0, firstAce), aces };
}

function isOffending(ace: ParsedAce, userSid: string): boolean {
  return ace.type !== "A" || (ace.trustee !== userSid && !WINDOWS_SYSTEM_TRUSTEES.includes(ace.trustee));
}

// A file is acceptable when it does not inherit and every ACE is an allow for
// the current user, SYSTEM or Administrators, the current user being named
// explicitly.
export function windowsAclVerdict(sddl: string, userSid: string): string | null {
  const dacl = parseDacl(sddl);
  if (dacl === null) return "the descriptor has no DACL";
  const problems: string[] = [];
  if (!dacl.flags.includes("P")) problems.push("it inherits permissions");
  for (const ace of dacl.aces) {
    if (isOffending(ace, userSid)) problems.push(`ACE ${ace.raw} is not an allow for the user, SYSTEM or Administrators`);
  }
  if (!dacl.aces.some((ace) => ace.trustee === userSid && ace.type === "A")) problems.push("the current user has no ACE");
  return problems.length > 0 ? problems.join("; ") : null;
}

function system32(exe: string): string {
  return join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", exe);
}

function runTool(exe: string, args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync([system32(exe), ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

let currentUserSid: string | undefined;

function userSid(): string {
  if (currentUserSid === undefined) {
    const { code, out } = runTool("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = out.match(/,"(S-1-[0-9-]+)"/)?.[1];
    if (code !== 0 || sid === undefined) throw new Error(`cannot read the current user SID: ${out.trim()}`);
    currentUserSid = sid;
  }
  return currentUserSid;
}

// Next to the key, in a directory only its owner may write: in the shared temp
// directory another account could rewrite the SDDL between icacls and the read.
export function aclScratchPath(keyPath: string): string {
  return join(dirname(keyPath), `kory-acl-${randomBytes(6).toString("hex")}.txt`);
}

function readSddl(path: string, log: Logger): string {
  const saved = aclScratchPath(path);
  try {
    const { code, out } = runTool("icacls.exe", [path, "/save", saved, "/q"]);
    if (code !== 0) throw new Error(`icacls /save exited ${code}: ${out.trim()}`);
    return readFileSync(saved).toString("utf16le").split(/\r?\n/)[1] ?? "";
  } finally {
    try {
      unlinkSync(saved);
    } catch (e) {
      if (errnoCode(e) !== "ENOENT") log.warn(`cannot remove ${saved}`, e);
    }
  }
}

export interface AclTools {
  userSid(): string;
  readSddl(path: string): string;
}

function windowsAclTools(log: Logger): AclTools {
  return { userSid, readSddl: (path) => readSddl(path, log) };
}

function aclProblem(path: string, acl: AclTools): string | null {
  try {
    return windowsAclVerdict(acl.readSddl(path), acl.userSid());
  } catch (e) {
    return `the ACL cannot be read: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function checkPermissions(path: string, acl: AclTools | undefined): void {
  if (acl !== undefined) {
    const problem = aclProblem(path, acl);
    if (problem !== null) {
      throw new Error(
        `${path} ACL is not acceptable: ${problem}. Another account may have read the key: rotate it by deleting the file, letting a relay create a new one and restarting the daemon`,
      );
    }
    return;
  }
  const uid = process.getuid?.();
  for (const [p, isDir] of [
    [path, false],
    [dirname(path), true],
  ] as const) {
    const st = statSync(p);
    const why = permissionVerdict(st.mode, isDir);
    if (why !== null) throw new Error(`${p} ${why}`);
    if (!isDir && st.uid !== uid) throw new Error(`${p} is not owned by the current user`);
  }
}

/**
 * Reads the key a relay created. The daemon never creates or repairs it: an
 * absent file, an ACL that is open on Windows, or modes that are open on POSIX
 * are refusals. `acl` selects the Windows check; it defaults to the real tools
 * on Windows and to the POSIX mode checks elsewhere.
 */
export function loadKey(
  keyPath: string,
  log: Logger,
  acl: AclTools | undefined = process.platform === "win32" ? windowsAclTools(log) : undefined,
): Buffer {
  let text: string;
  try {
    text = readFileSync(keyPath, "utf8");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") throw new Error(`no shared key at ${keyPath}: a relay creates it`);
    throw e;
  }
  checkPermissions(keyPath, acl);
  const hex = text.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${keyPath} does not hold 64 hexadecimal characters`);
  return Buffer.from(hex, "hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolsHashOf(tools: unknown): string {
  const list = Array.isArray(tools) ? [...tools] : [];
  list.sort((a, b) => String((a as { name?: unknown }).name).localeCompare(String((b as { name?: unknown }).name)));
  return b64u(createHash("sha256").update(canonicalJson(list)).digest());
}

class FrameTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  private closed = false;
  private readonly probes = new Map<string, (reply: JSONRPCMessage | null) => void>();

  constructor(
    private readonly emit: (text: string) => void,
    private readonly onTransportClose: () => void,
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if ("id" in message && typeof message.id === "string") {
      const probe = this.probes.get(message.id);
      if (probe) {
        this.probes.delete(message.id);
        probe(message);
        return;
      }
    }
    if (this.closed) throw new Error("MCP connection closed");
    this.emit(JSON.stringify(message));
  }

  deliver(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  probe(id: string, method: string): Promise<JSONRPCMessage | null> {
    return new Promise((resolve) => {
      this.probes.set(id, resolve);
      this.deliver({ jsonrpc: "2.0", id, method });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.probes.values()) resolve(null);
    this.probes.clear();
    this.onTransportClose();
    this.onclose?.();
  }
}

type CloseReason = "bye" | "socket" | "daemon_stop";

class Session {
  private closed = false;

  constructor(
    readonly id: string,
    readonly server: Server,
    readonly transport: FrameTransport,
    readonly log: Logger,
  ) {}

  async close(reason: CloseReason): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.server.close();
    } catch (e) {
      this.log.error(`closing the MCP server failed (${reason})`, e);
    }
    this.log.info(`session closed reason=${reason}`);
  }
}

const PREAUTH_LOG_INTERVAL_MS = 60_000;

class PreAuthLog {
  private count = 0;
  private first = "";
  private timer: unknown;

  constructor(
    private readonly log: Logger,
    private readonly clock: DaemonClock,
    private readonly total: { preAuthFailures: number },
  ) {}

  note(cause: string): void {
    this.total.preAuthFailures++;
    if (this.count++ > 0) return;
    this.first = cause;
    this.timer = this.clock.setTimeout(() => this.flush(), PREAUTH_LOG_INTERVAL_MS);
  }

  flush(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.count === 0) return;
    this.log.warn(
      `pre-auth: ${this.count} connection(s) refused or failed in the last ${PREAUTH_LOG_INTERVAL_MS / 1000} s, first: ${this.first}`,
    );
    this.count = 0;
  }
}

function notifySettled(ctx: DaemonContext): void {
  if (ctx.all.size !== ctx.live.size) return;
  for (const resolve of ctx.settled.splice(0)) resolve();
}

interface DaemonContext {
  key: Buffer;
  codeRoot: string;
  instance: string;
  families: Partial<Record<FamilyName, FamilyFactory>>;
  log: Logger;
  clock: DaemonClock;
  maxSessions: number;
  preAuth: PreAuthLog;
  control: ControlHandler | undefined;
  onSessions: ((sessions: number) => void) | undefined;
  settled: Array<() => void>;
  listening: boolean;
  stopping: boolean;
  nextConnection: number;
  all: Set<Connection>;
  unauthenticated: Set<Connection>;
  authenticated: Set<Connection>;
  live: Set<Connection>;
  counters: Omit<DaemonStats, "listening" | "sessions" | "unauthenticated" | "authenticated">;
}

type Stage = "auth" | "hello" | "building" | "live";

class Connection {
  private stage: Stage = "auth";
  private decoder: PlainFrameDecoder | SealedFrameDecoder = new PlainFrameDecoder();
  private sealer?: Sealer;
  private proto = 0;
  private role: "relay" | "control" = "relay";
  private stopAfterClose = false;
  private bytesIn = 0;
  private timer: unknown;
  private queue: Buffer[] = [];
  private ending = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private teardownDone?: Promise<void>;
  private session?: Session;
  private log: Logger;
  private readonly challenge: Challenge;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly socket: Socket<Connection>,
    readonly id: number,
  ) {
    this.log = ctx.log.child(`c=${id}`);
    this.challenge = buildChallenge({ daemonInstance: ctx.instance, daemonVersion: DAEMON_VERSION });
  }

  start(): void {
    const { ctx } = this;
    ctx.all.add(this);
    if (ctx.unauthenticated.size >= MAX_UNAUTHENTICATED) {
      ctx.counters.refusedUnauthenticated++;
      ctx.preAuth.note(`${MAX_UNAUTHENTICATED} unauthenticated connections are already pending`);
      void this.teardown("socket");
      return;
    }
    ctx.unauthenticated.add(this);
    this.arm();
    this.writeRaw(encodeFrame(FRAME_TYPE.CHALLENGE, this.challenge.payload));
  }

  onData(chunk: Uint8Array): void {
    if (this.closed || this.ending) return;
    this.bytesIn += chunk.length;
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (e) {
      this.reject("frame rejected", e);
      return;
    }
    if (this.stage === "auth") {
      this.onAuthFrames(frames);
      return;
    }
    for (const frame of frames) {
      this.chain = this.chain.then(() => this.onSealedFrame(frame)).catch((e) => this.reject("frame handler failed", e));
    }
  }

  onDrain(): void {
    this.flush();
  }

  onSocketClosed(): void {
    void this.teardown(this.ctx.stopping ? "daemon_stop" : "socket");
  }

  onSocketError(error: Error): void {
    this.warn(`socket error: ${error.message}`);
    void this.teardown("socket");
  }

  // Before AUTH_OK the peer has not shown the key: its failures are counted and
  // summarised, so that a stranger cannot grow the log.
  private warn(text: string): void {
    if (this.stage === "auth") this.ctx.preAuth.note(text);
    else this.log.warn(text);
  }

  teardown(reason: CloseReason): Promise<void> {
    if (this.teardownDone === undefined) {
      let finished!: () => void;
      this.teardownDone = new Promise<void>((resolve) => (finished = resolve));
      void this.runTeardown(reason).then(finished);
    }
    return this.teardownDone;
  }

  private async runTeardown(reason: CloseReason): Promise<void> {
    const { ctx } = this;
    this.closed = true;
    if (this.timer !== undefined) ctx.clock.clearTimeout(this.timer);
    ctx.all.delete(this);
    ctx.unauthenticated.delete(this);
    ctx.authenticated.delete(this);
    const wasLive = ctx.live.delete(this);
    this.socket.terminate();
    await this.session?.close(reason);
    if (wasLive) {
      ctx.counters.sessionsClosed++;
      this.notifySessions();
    }
    notifySettled(ctx);
    if (this.stopAfterClose) ctx.control?.stop();
  }

  private notifySessions(): void {
    const { ctx } = this;
    try {
      ctx.onSessions?.(ctx.live.size);
    } catch (e) {
      this.log.error("the session-count callback threw", e);
    }
  }

  private arm(): void {
    const { ctx } = this;
    if (this.timer !== undefined) ctx.clock.clearTimeout(this.timer);
    this.timer = ctx.clock.setTimeout(() => {
      ctx.counters.handshakeTimeouts++;
      this.warn(`handshake stage "${this.stage}" exceeded ${STAGE_MS} ms`);
      void this.teardown("socket");
    }, STAGE_MS);
  }

  private reject(why: string, error?: unknown): void {
    this.warn(`closing: ${why}${error instanceof Error ? `: ${error.message}` : ""}`);
    void this.teardown("socket");
  }

  private writeRaw(buf: Buffer): void {
    if (this.closed) return;
    this.queue.push(buf);
    this.flush();
  }

  private flush(): void {
    while (this.queue.length > 0 && !this.closed) {
      const head = this.queue[0] as Buffer;
      const written = this.socket.write(head);
      if (written < head.length) {
        this.queue[0] = head.subarray(Math.max(written, 0));
        return;
      }
      this.queue.shift();
    }
    if (this.ending && !this.closed) this.socket.end();
  }

  private endAfterFlush(): void {
    this.ending = true;
    this.flush();
  }

  private sendSealed(type: number, payload: string | Buffer): void {
    if (this.closed || !this.sealer) return;
    try {
      this.writeRaw(this.sealer.seal(type, typeof payload === "string" ? Buffer.from(payload) : payload));
    } catch (e) {
      this.reject("cannot seal a frame", e);
    }
  }

  private refuseSealed(code: string, message: string): void {
    this.sendSealed(FRAME_TYPE.ERROR, JSON.stringify({ code, message }));
    this.endAfterFlush();
  }

  private onAuthFrames(frames: Frame[]): void {
    const { ctx } = this;
    const frame = frames[0];
    if (frame === undefined) return;
    if (frames.length > 1 || frame.type !== FRAME_TYPE.AUTH || this.bytesIn !== 5 + frame.payload.length) {
      this.reject(`expected exactly one AUTH frame, got frame type ${frame.type}`);
      return;
    }
    // The role is the one whose key-bound MAC verifies: a control client never
    // passes for a relay, nor the other way round.
    let verdict = verifyAuth(ctx.key, this.challenge, frame.payload, "relay");
    if (!verdict.ok && verdict.reason === "bad_mac") {
      const asControl = verifyAuth(ctx.key, this.challenge, frame.payload, "control");
      if (asControl.ok || asControl.reason !== "bad_mac") {
        verdict = asControl;
        this.role = "control";
      }
    }
    if (!verdict.ok) {
      ctx.counters.authRefused++;
      this.warn(`handshake refused (${verdict.reason}): ${verdict.cause}`);
      if (verdict.reason === "proto_mismatch") {
        this.writeRaw(
          encodeFrame(FRAME_TYPE.ERROR, Buffer.from(JSON.stringify({ code: "proto_mismatch", message: verdict.cause }))),
        );
        this.endAfterFlush();
      } else {
        void this.teardown("socket");
      }
      return;
    }
    const authOk = buildAuthOk(ctx.key, this.challenge, frame.payload, verdict.relayNonce, verdict.proto);
    const keys = deriveSessionKeys(ctx.key, this.challenge, frame.payload, authOk, verdict.relayNonce);
    this.sealer = new Sealer(keys.d2r);
    this.decoder = new SealedFrameDecoder(new Opener(keys.r2d), HELLO_MAX_FRAME_PAYLOAD);
    this.proto = verdict.proto;
    ctx.unauthenticated.delete(this);
    ctx.authenticated.add(this);
    this.stage = "hello";
    this.arm();
    this.writeRaw(encodeFrame(FRAME_TYPE.AUTH_OK, authOk));
  }

  private async onSealedFrame(frame: Frame): Promise<void> {
    if (this.closed || this.ending) return;
    if (this.stage === "hello") {
      await this.onHello(frame);
      return;
    }
    switch (frame.type) {
      case FRAME_TYPE.MCP:
        this.deliverMcp(frame.payload);
        return;
      case FRAME_TYPE.PING:
        this.sendSealed(FRAME_TYPE.PONG, "");
        return;
      case FRAME_TYPE.BYE:
        this.log.info(`BYE ${frame.payload.toString("utf8").slice(0, 200)}`);
        await this.teardown("bye");
        return;
      default:
        this.reject(`unexpected frame type ${frame.type} in a live session`);
    }
  }

  private onControl(frame: Frame): void {
    const handler = this.ctx.control;
    let op: unknown;
    try {
      op = (JSON.parse(frame.payload.toString("utf8")) as { op?: unknown }).op;
    } catch (e) {
      this.log.warn(`control request is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (handler === undefined || (op !== "status" && op !== "stop")) {
      this.refuseSealed("control_invalid", "expected {op: status | stop}");
      return;
    }
    this.log.info(`control ${op}`);
    this.sendSealed(FRAME_TYPE.CONTROL, JSON.stringify(op === "status" ? handler.status() : { ok: true }));
    this.stopAfterClose = op === "stop";
    this.endAfterFlush();
  }

  private async onHello(frame: Frame): Promise<void> {
    const { ctx } = this;
    if (this.role === "control") {
      if (frame.type !== FRAME_TYPE.CONTROL) this.reject(`expected CONTROL, got frame type ${frame.type}`);
      else this.onControl(frame);
      return;
    }
    if (frame.type !== FRAME_TYPE.HELLO) {
      this.reject(`expected HELLO, got frame type ${frame.type}`);
      return;
    }
    const parsed = parseHello(frame.payload, this.proto);
    if (!parsed.ok) {
      this.log.warn(`hello refused: ${parsed.cause}`);
      this.refuseSealed(parsed.code, parsed.cause);
      return;
    }
    const hello = parsed.hello;
    if (hello.code_root !== ctx.codeRoot) {
      this.log.warn("hello refused: root_mismatch");
      this.refuseSealed("root_mismatch", "this daemon serves another code root");
      return;
    }
    const factory = ctx.families[hello.family];
    if (factory === undefined) {
      this.log.warn(`hello refused: family ${hello.family} is not served`);
      this.refuseSealed("family_unavailable", `family ${hello.family} is not served by this daemon`);
      return;
    }
    if (ctx.authenticated.size > ctx.maxSessions) {
      this.log.warn(`hello refused: more than ${ctx.maxSessions} sessions`);
      this.refuseSealed("session_limit", `this daemon serves ${ctx.maxSessions} sessions at most`);
      return;
    }
    this.stage = "building";
    this.arm();
    await this.openSession(hello, factory);
  }

  private async openSession(hello: Hello, factory: FamilyFactory): Promise<void> {
    const { ctx } = this;
    const sessionId = randomUUID();
    const log = ctx.log.child(`s=${sessionId.slice(0, 8)}`);
    this.log = log;
    let server: Server;
    try {
      server = await factory(hello, { sessionId, log });
    } catch (e) {
      log.error("family factory failed", e);
      this.refuseSealed("family_unavailable", "the family could not be built");
      return;
    }
    const transport = new FrameTransport(
      (text) => this.sendSealed(FRAME_TYPE.MCP, text),
      () => void this.teardown("socket"),
    );
    transport.onerror = (error) => log.error("MCP transport error", error);
    const session = new Session(sessionId, server, transport, log);
    this.session = session;
    if (this.closed) {
      await session.close("socket");
      return;
    }
    let toolsHash: string;
    try {
      await server.connect(transport);
      const reply = await transport.probe(TOOLS_PROBE_ID, "tools/list");
      const result = reply !== null && "result" in reply ? (reply.result as { tools?: unknown }) : undefined;
      toolsHash = toolsHashOf(result?.tools);
    } catch (e) {
      log.error("cannot start the MCP server", e);
      this.refuseSealed("family_unavailable", "the family could not be started");
      return;
    }
    if (this.closed) return;
    this.sendSealed(
      FRAME_TYPE.WELCOME,
      JSON.stringify({ session_id: sessionId, family: hello.family, tools_hash: toolsHash, resumed: false }),
    );
    if (this.timer !== undefined) ctx.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.decoder.maxPayload = MAX_PAYLOAD;
    this.stage = "live";
    ctx.live.add(this);
    ctx.counters.sessionsOpened++;
    log.info(`session open family=${hello.family} pid=${hello.pid} cwd=${hello.cwd}`);
    this.notifySessions();
    notifySettled(ctx);
  }

  private deliverMcp(payload: Buffer): void {
    const session = this.session;
    if (session === undefined) return;
    let message: JSONRPCMessage;
    try {
      message = JSONRPCMessageSchema.parse(JSON.parse(payload.toString("utf8")));
    } catch (e) {
      this.log.warn(`dropping an MCP frame that is not a JSON-RPC message: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    try {
      session.transport.deliver(message);
    } catch (e) {
      this.log.error("MCP handler threw", e);
    }
  }
}

export function startDaemon(opts: DaemonOptions): DaemonHandle {
  const log = createLogger({ dir: opts.logDir, name: "server", mirrorToConsole: false });
  const daemonLog = log.child("daemon");
  let key: Buffer;
  try {
    key = opts.key ?? loadKey(opts.keyPath, daemonLog);
  } catch (e) {
    daemonLog.error(`the shared key is unusable, not starting: ${opts.keyPath}`, e);
    throw e;
  }
  const clock = opts.clock ?? realClock;
  const counters = {
    sessionsOpened: 0,
    sessionsClosed: 0,
    refusedUnauthenticated: 0,
    handshakeTimeouts: 0,
    authRefused: 0,
    preAuthFailures: 0,
  };
  const ctx: DaemonContext = {
    key,
    codeRoot: opts.codeRoot,
    instance: randomUUID(),
    families: opts.families,
    log,
    clock,
    maxSessions: opts.maxSessions ?? DEFAULT_MAX_SESSIONS,
    preAuth: new PreAuthLog(daemonLog, clock, counters),
    control: opts.control,
    onSessions: opts.onSessions,
    settled: [],
    listening: false,
    stopping: false,
    nextConnection: 0,
    all: new Set(),
    unauthenticated: new Set(),
    authenticated: new Set(),
    live: new Set(),
    counters,
  };
  const bind = (port: number) =>
    Bun.listen<Connection>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          const conn = new Connection(ctx, socket, ++ctx.nextConnection);
          socket.data = conn;
          conn.start();
        },
        data(socket, chunk) {
          socket.data.onData(chunk);
        },
        drain(socket) {
          socket.data.onDrain();
        },
        close(socket) {
          socket.data.onSocketClosed();
        },
        error(socket, error) {
          socket.data.onSocketError(error);
        },
      },
    });
  let listener = bind(opts.port);
  ctx.listening = true;
  const port = listener.port;
  daemonLog.info(`listening on 127.0.0.1:${port} instance=${ctx.instance}`);
  return {
    port,
    instance: ctx.instance,
    async stop() {
      ctx.stopping = true;
      if (ctx.listening) listener.stop(true);
      ctx.listening = false;
      await Promise.all([...ctx.all].map((conn) => conn.teardown("daemon_stop")));
      ctx.preAuth.flush();
      daemonLog.info("stopped");
    },
    pauseListening() {
      if (!ctx.listening) return;
      listener.stop(false);
      ctx.listening = false;
      daemonLog.info(`stopped listening on ${port}`);
    },
    resumeListening() {
      if (ctx.listening) return;
      listener = bind(port);
      ctx.listening = true;
      daemonLog.info(`listening again on ${port}`);
    },
    waitForHandshakes() {
      return ctx.all.size === ctx.live.size ? Promise.resolve() : new Promise<void>((resolve) => ctx.settled.push(resolve));
    },
    stats() {
      return {
        listening: ctx.listening,
        sessions: ctx.live.size,
        unauthenticated: ctx.unauthenticated.size,
        authenticated: ctx.authenticated.size,
        ...ctx.counters,
      };
    },
  };
}
